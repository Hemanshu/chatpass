import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../src/server.js';
import { generateKey, encrypt, decrypt } from '../public/crypto.js';
import { buildPrompt, buildScript } from '../public/prompt.js';

const run = promisify(execFile);
let app, base;

before(async () => {
  app = createApp({ createLimit: 1000, revealLimit: 1000 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const create = (body) =>
  fetch(`${base}/api/secrets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function share(secret, opts = {}) {
  const key = await generateKey();
  const res = await create({ ciphertext: await encrypt(secret, key), ttlSeconds: 300, ...opts });
  assert.equal(res.status, 201);
  return { key, ...(await res.json()) };
}

test('crypto roundtrip', async () => {
  const key = await generateKey();
  assert.equal(await decrypt(await encrypt('héllo 🔐', key), key), 'héllo 🔐');
});

test('reveal is one-time and POST-only', async () => {
  const { id, key } = await share('s3cret');
  assert.equal((await fetch(`${base}/api/secrets/${id}/reveal`)).status, 405);
  const res = await fetch(`${base}/api/secrets/${id}/reveal`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(await decrypt(await res.text(), key), 's3cret');
  assert.equal((await fetch(`${base}/api/secrets/${id}/reveal`, { method: 'POST' })).status, 404);
});

test('status and revoke', async () => {
  const { id, deleteToken } = await share('x', { maxReads: 2 });
  assert.equal((await (await fetch(`${base}/api/secrets/${id}`)).json()).readsLeft, 2);
  assert.equal((await fetch(`${base}/api/secrets/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer nope' } })).status, 404);
  assert.equal((await fetch(`${base}/api/secrets/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${deleteToken}` } })).status, 204);
  assert.equal((await fetch(`${base}/api/secrets/${id}`)).status, 404);
});

test('rejects bad input', async () => {
  assert.equal((await create({ ciphertext: 'not base64!' })).status, 400);
  assert.equal((await create({ ciphertext: 'A'.repeat(50), ttlSeconds: 10 })).status, 400);
  assert.equal((await create({ ciphertext: 'A'.repeat(50), maxReads: 0 })).status, 400);
  assert.equal((await create({ ciphertext: 'A'.repeat(70_000) })).status, 413);
  const res = await fetch(`${base}/api/secrets`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 415);
});

test('security headers on static page', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('prompt builder rejects shell-unsafe values', () => {
  const ok = { revealUrl: 'https://x.dev/api/secrets/AAAAAAAAAAAAAAAAAAAAAA/reveal', key: 'k'.repeat(43), name: 'TOKEN' };
  assert.doesNotThrow(() => buildScript(ok));
  assert.throws(() => buildScript({ ...ok, name: 'A; rm -rf /' }));
  assert.throws(() => buildScript({ ...ok, key: "'" + 'k'.repeat(42) }));
  assert.throws(() => buildScript({ ...ok, revealUrl: "https://x.dev/'$(id)'/api/secrets/AAAAAAAAAAAAAAAAAAAAAA/reveal" }));
});

// Runs the exact script embedded in the prompt, the way an agent would.
async function runPromptScript(decryptor) {
  const secret = 'postgres://user:p@ss w0rd"\'$`@db/x\nline2';
  const { id, key, expiresAt } = await share(secret);
  const prompt = buildPrompt({ revealUrl: `${base}/api/secrets/${id}/reveal`, key, name: 'DATABASE_URL', expiresAt });
  const script = prompt.match(/```bash\n([\s\S]*?)\n```/)[1];
  assert.ok(!prompt.includes(secret));

  const home = await mkdtemp(join(tmpdir(), 'chatpass-'));
  const env = { HOME: home, PATH: process.env.PATH };
  if (decryptor === 'python') {
    // PATH with only the tools the script needs, and no node, so the python fallback is taken.
    const bin = join(home, 'bin');
    await mkdir(bin);
    for (const tool of ['bash', 'curl', 'python3', 'mkdir', 'mv', 'rm', 'wc']) {
      const { stdout } = await run('bash', ['-c', `command -v ${tool}`]);
      await symlink(stdout.trim(), join(bin, tool));
    }
    env.PATH = bin;
  }
  try {
    const { stdout } = await run('bash', ['-c', script], { env });
    assert.match(stdout, /saved DATABASE_URL/);
    const file = join(home, '.chatpass', 'DATABASE_URL');
    assert.equal(await readFile(file, 'utf8'), secret);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(run('bash', ['-c', script], { env }), /404/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('e2e: agent runs prompt script (node)', () => runPromptScript('node'));

test('e2e: agent runs prompt script (python fallback)', async (t) => {
  try {
    await run('python3', ['-c', 'import cryptography']);
  } catch {
    return t.skip('python3 cryptography not installed');
  }
  await runPromptScript('python');
});
