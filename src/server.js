import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretStore } from './store.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_FILES = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/crypto.js': 'crypto.js',
  '/prompt.js': 'prompt.js',
  '/style.css': 'style.css',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// base64url, 12-byte IV + >=1 byte ciphertext + 16-byte tag
const CIPHERTEXT_RE = /^[A-Za-z0-9_-]{39,}$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_CIPHERTEXT_CHARS = 64 * 1024;
const MAX_BODY_BYTES = MAX_CIPHERTEXT_CHARS + 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Fixed-window per-IP rate limiter. */
function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  const timer = setInterval(() => hits.clear(), windowMs);
  timer.unref();
  return {
    check(key) {
      const n = (hits.get(key) || 0) + 1;
      hits.set(key, n);
      return n <= limit;
    },
    close: () => clearInterval(timer),
  };
}

export function createApp({
  trustProxy = false,
  maxTtlSeconds = 24 * 3600,
  maxReadsLimit = 10,
  createLimit = 30,
  revealLimit = 120,
  store = new SecretStore(),
} = {}) {
  const createRl = rateLimiter({ limit: createLimit, windowMs: 60_000 });
  const revealRl = rateLimiter({ limit: revealLimit, windowMs: 60_000 });

  const clientIp = (req) =>
    (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return reject(new HttpError(415, 'Content-Type must be application/json'));
      }
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
        req.resume();
        return reject(new HttpError(413, 'Payload too large'));
      }
      let size = 0;
      let tooLarge = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) tooLarge = true; // keep draining, but stop buffering
        else chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return reject(new HttpError(413, 'Payload too large'));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;

    if (req.method === 'GET' && STATIC_FILES[path]) {
      const file = STATIC_FILES[path];
      return send(res, 200, await readFile(join(PUBLIC_DIR, file)), MIME[extname(file)]);
    }

    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });

    if (path === '/api/secrets' && req.method === 'POST') {
      if (!createRl.check(clientIp(req))) throw new HttpError(429, 'Too many requests');
      const body = await readJson(req);
      const { ciphertext } = body ?? {};
      const ttlSeconds = body?.ttlSeconds ?? 3600;
      const maxReads = body?.maxReads ?? 1;
      if (typeof ciphertext !== 'string' || !CIPHERTEXT_RE.test(ciphertext)) {
        throw new HttpError(400, 'ciphertext must be base64url (iv || ciphertext || tag)');
      }
      if (ciphertext.length > MAX_CIPHERTEXT_CHARS) throw new HttpError(413, 'Secret too large');
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > maxTtlSeconds) {
        throw new HttpError(400, `ttlSeconds must be an integer between 60 and ${maxTtlSeconds}`);
      }
      if (!Number.isInteger(maxReads) || maxReads < 1 || maxReads > maxReadsLimit) {
        throw new HttpError(400, `maxReads must be an integer between 1 and ${maxReadsLimit}`);
      }
      const created = store.put(ciphertext, { ttlSeconds, maxReads });
      if (!created) throw new HttpError(507, 'Server is at capacity, try again later');
      return send(res, 201, { ...created, expiresAt: new Date(created.expiresAt).toISOString() });
    }

    const m = path.match(/^\/api\/secrets\/([^/]+)(\/reveal)?$/);
    if (m) {
      const [, id, reveal] = m;
      if (!ID_RE.test(id)) throw new HttpError(404, 'Not found');

      // Reveal is POST-only so link unfurlers / previewers (which GET) cannot burn the secret.
      if (reveal && req.method === 'POST') {
        if (!revealRl.check(clientIp(req))) throw new HttpError(429, 'Too many requests');
        const ciphertext = store.take(id);
        if (!ciphertext) throw new HttpError(404, 'Secret not found: it expired, was already retrieved, or was revoked');
        return send(res, 200, ciphertext, 'text/plain; charset=utf-8');
      }

      if (!reveal && req.method === 'GET') {
        const st = store.status(id);
        if (!st) throw new HttpError(404, 'Not found');
        return send(res, 200, { expiresAt: new Date(st.expiresAt).toISOString(), readsLeft: st.readsLeft });
      }

      if (!reveal && req.method === 'DELETE') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!store.delete(id, token)) throw new HttpError(404, 'Not found');
        res.writeHead(204, SECURITY_HEADERS);
        return res.end();
      }

      throw new HttpError(405, reveal ? 'Use POST to reveal a secret' : 'Method not allowed');
    }

    throw new HttpError(404, 'Not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('internal error:', err.message);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : err.message });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  return {
    server,
    store,
    close() {
      createRl.close();
      revealRl.close();
      store.close();
      server.close();
    },
  };
}
