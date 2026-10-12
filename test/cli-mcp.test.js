import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../src/server.js';
import { share, retrieve, list, remove } from '../src/client.js';
import { parseShareLink } from '../public/prompt.js';

const run = promisify(execFile);
const CLI = new URL('../bin/chatpass.js', import.meta.url).pathname;
let app, base, dir;

before(async () => {
  app = createApp({ createLimit: 1000, revealLimit: 1000 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  dir = await mkdtemp(join(tmpdir(), 'chatpass-cli-'));
});
after(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test('ttl is capped at 5 minutes', async () => {
  await assert.rejects(share({ server: base, secret: 'x', name: 'X', ttlSeconds: 301 }), /between 60 and 300/);
});

test('parseShareLink', () => {
  const link = `https://h.dev/api/secrets/${'A'.repeat(22)}/reveal#${'k'.repeat(43)}`;
  assert.equal(parseShareLink(link).key, 'k'.repeat(43));
  assert.throws(() => parseShareLink('https://h.dev/api/secrets/x/reveal#k'));
  assert.throws(() => parseShareLink(link.split('#')[0]));
});

test('client share -> retrieve -> list -> remove', async () => {
  const secret = 'multi\nline "secret" ✓';
  const { link, prompt } = await share({ server: base, secret, name: 'API_KEY' });
  assert.ok(prompt.includes(link) && !prompt.includes(secret));
  const { path, bytes } = await retrieve({ link, name: 'API_KEY', dir });
  assert.equal(await readFile(path, 'utf8'), secret);
  assert.equal(bytes, Buffer.byteLength(secret));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(retrieve({ link, name: 'API_KEY', dir }), /404/);
  assert.deepEqual((await list({ dir })).map((i) => i.name), ['API_KEY']);
  await remove({ name: 'API_KEY', dir });
  assert.deepEqual(await list({ dir }), []);
});

test('wrong key burns link and reports decryption failure', async () => {
  const { link } = await share({ server: base, secret: 's', name: 'S' });
  const bad = link.replace(/#.*/, '#' + 'A'.repeat(43));
  await assert.rejects(retrieve({ link: bad, name: 'S', dir }), /Decryption failed/);
});

test('CLI: piped share --link, then get', async () => {
  const child = spawn(process.execPath, [CLI, 'share', 'DB_URL', '--server', base, '--link']);
  child.stdin.end('postgres://u:p@h/db\n');
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  const link = out.trim();
  const { stdout } = await run(process.execPath, [CLI, 'get', link, '--name', 'DB_URL', '--dir', dir]);
  assert.match(stdout, /saved DB_URL/);
  assert.equal(await readFile(join(dir, 'DB_URL'), 'utf8'), 'postgres://u:p@h/db');
  await assert.rejects(run(process.execPath, [CLI, 'get', link, '--name', 'DB_URL', '--dir', dir]), /404/);
});

test('MCP over stdio: initialize, list tools, retrieve without leaking value', async () => {
  const secret = 'sk-mcp-test-value';
  const { link } = await share({ server: base, secret, name: 'MCP_KEY' });
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, CHATPASS_DIR: dir } });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'chatpass');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tools = await rpc('tools/list', {});
    assert.deepEqual(tools.result.tools.map((t) => t.name), ['retrieve_secret', 'list_secrets', 'delete_secret']);

    const call = await rpc('tools/call', { name: 'retrieve_secret', arguments: { link, name: 'MCP_KEY' } });
    assert.equal(call.result.isError, false);
    assert.ok(!JSON.stringify(call).includes(secret));
    assert.equal(await readFile(join(dir, 'MCP_KEY'), 'utf8'), secret);

    const again = await rpc('tools/call', { name: 'retrieve_secret', arguments: { link, name: 'MCP_KEY' } });
    assert.equal(again.result.isError, true);
    assert.match(again.result.content[0].text, /404/);

    const ls = await rpc('tools/call', { name: 'list_secrets', arguments: {} });
    assert.match(ls.result.content[0].text, /MCP_KEY/);
    assert.ok(!ls.result.content[0].text.includes(secret));

    await rpc('tools/call', { name: 'delete_secret', arguments: { name: 'MCP_KEY' } });
    await assert.rejects(stat(join(dir, 'MCP_KEY')));

    assert.equal((await rpc('nope/method', {})).error.code, -32601);
  } finally {
    child.kill();
  }
});
