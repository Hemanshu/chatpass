#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { share, retrieve, list, remove } from '../src/client.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `chatpass ${version} - share secrets with AI agents via one-time, end-to-end encrypted links

Usage:
  chatpass share <NAME> [options]   Encrypt a secret locally and print a prompt to paste into an AI chat.
                                    Reads the secret from stdin if piped, otherwise prompts (hidden).
      --server <url>                ChatPass server (default: $CHATPASS_SERVER)
      --ttl <seconds>               Expiry, 60-300 (default 300)
      --reads <n>                   Allowed retrievals (default 1)
      --note <text>                 Instructions for the assistant (not encrypted)
      --link                        Print only the one-time link instead of the full prompt

  chatpass get <LINK> --name <NAME> Retrieve + decrypt a link into ~/.chatpass/<NAME> (mode 600)
      --dir <path>                  Store directory (default: $CHATPASS_DIR or ~/.chatpass)
  chatpass list                     List retrieved secrets (names only)
  chatpass rm <NAME>                Delete a retrieved secret

  chatpass mcp                      Run the MCP server (stdio) exposing retrieve_secret / list_secrets / delete_secret
  chatpass serve [--port <n>]       Run a ChatPass server (web UI + API)

  chatpass --version | --help`;

const OPTIONS = {
  server: { type: 'string' },
  ttl: { type: 'string' },
  reads: { type: 'string' },
  note: { type: 'string' },
  link: { type: 'boolean' },
  name: { type: 'string' },
  dir: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function readHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Aborted'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, arg] = positionals;
  if (o.version) return console.log(version);
  if (o.help || !cmd || cmd === 'help') return console.log(HELP);

  switch (cmd) {
    case 'share': {
      const server = o.server || process.env.CHATPASS_SERVER;
      if (!server) throw new Error('No server: pass --server or set CHATPASS_SERVER');
      const secret = process.stdin.isTTY ? await readHidden(`Secret for ${arg}: `) : await readStdin();
      const res = await share({
        server,
        secret,
        name: arg,
        ttlSeconds: o.ttl ? Number(o.ttl) : 300,
        maxReads: o.reads ? Number(o.reads) : 1,
        instructions: o.note || '',
      });
      console.log(o.link ? res.link : res.prompt);
      console.error(`\n[chatpass] expires ${res.expiresAt}. The output contains the decryption key; treat it as secret until it's retrieved.`);
      return;
    }
    case 'get': {
      const { path, bytes } = await retrieve({ link: arg, name: o.name, dir: o.dir });
      return console.log(`chatpass: saved ${o.name} to ${path} (${bytes} bytes)`);
    }
    case 'list':
    case 'ls':
      for (const i of await list({ dir: o.dir })) console.log(`${i.name}\t${i.bytes} bytes\t${i.modified}`);
      return;
    case 'rm':
      await remove({ name: arg, dir: o.dir });
      return console.log(`chatpass: deleted ${arg}`);
    case 'mcp': {
      const { runMcpServer } = await import('../src/mcp.js');
      runMcpServer({ version });
      return;
    }
    case 'serve': {
      const { createApp } = await import('../src/server.js');
      const port = Number(o.port || process.env.PORT) || 3000;
      const host = o.host || process.env.HOST || '127.0.0.1';
      const app = createApp({ trustProxy: process.env.TRUST_PROXY === '1' });
      app.server.listen(port, host, () => console.error(`chatpass listening on http://${host}:${port}`));
      return;
    }
    default:
      throw new Error(`Unknown command: ${cmd}. Run "chatpass --help".`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`chatpass: ${err.message}`);
  process.exit(1);
});
