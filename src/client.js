// Node-side client used by the CLI and the MCP server.
import { mkdir, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateKey, encrypt, decryptBytes } from '../public/crypto.js';
import { buildPrompt, buildShareLink, parseShareLink, NAME_RE } from '../public/prompt.js';

export const defaultDir = () => process.env.CHATPASS_DIR || join(homedir(), '.chatpass');

function checkName(name) {
  if (!NAME_RE.test(name || '')) throw new Error('name must match [A-Za-z_][A-Za-z0-9_]{0,63}');
}

/** Fetches + decrypts a share link and writes it to <dir>/<name> (mode 600). Never returns the value. */
export async function retrieve({ link, name, dir = defaultDir(), fetchImpl = fetch }) {
  checkName(name);
  const { revealUrl, key } = parseShareLink(link);
  const res = await fetchImpl(revealUrl, { method: 'POST' });
  if (res.status === 404) throw new Error('Secret not found (HTTP 404): it expired, was already retrieved, or was revoked');
  if (!res.ok) throw new Error(`Retrieval failed: HTTP ${res.status}`);
  let bytes;
  try {
    bytes = await decryptBytes((await res.text()).trim(), key);
  } catch {
    throw new Error('Decryption failed: wrong key or corrupted data (the one-time link has now been used)');
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  await writeFile(`${path}.tmp`, bytes, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return { path, bytes: bytes.length };
}

/** Encrypts locally, uploads ciphertext, returns the share link and a ready-to-paste prompt. */
export async function share({ server, secret, name, ttlSeconds = 300, maxReads = 1, instructions = '', fetchImpl = fetch }) {
  checkName(name);
  if (!server) throw new Error('No server: pass --server or set CHATPASS_SERVER');
  if (!secret) throw new Error('Secret is empty');
  const origin = new URL(server).origin;
  const key = await generateKey();
  const res = await fetchImpl(`${origin}/api/secrets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext: await encrypt(secret, key), ttlSeconds, maxReads }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed: HTTP ${res.status}`);
  const revealUrl = `${origin}/api/secrets/${data.id}/reveal`;
  return {
    link: buildShareLink({ revealUrl, key }),
    prompt: buildPrompt({ revealUrl, key, name, maxReads, expiresAt: data.expiresAt, instructions }),
    expiresAt: data.expiresAt,
    revoke: () => fetchImpl(`${origin}/api/secrets/${data.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${data.deleteToken}` } }),
  };
}

/** Lists stored secret names and sizes (never values). */
export async function list({ dir = defaultDir() } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names.filter((n) => NAME_RE.test(n))) {
    const st = await stat(join(dir, name));
    out.push({ name, bytes: st.size, modified: st.mtime.toISOString() });
  }
  return out;
}

export async function remove({ name, dir = defaultDir() }) {
  checkName(name);
  await rm(join(dir, name), { force: true });
}
