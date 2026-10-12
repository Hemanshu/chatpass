// Minimal MCP server (stdio, newline-delimited JSON-RPC 2.0). No dependencies.
// Tools never return secret values, only where they were stored.
import { createInterface } from 'node:readline';
import { retrieve, list, remove, defaultDir } from './client.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'retrieve_secret',
    description:
      'Retrieve a one-time ChatPass secret the user shared with you. Decrypts locally and saves it to ~/.chatpass/<name> (mode 600). ' +
      'Returns only the file path, never the value. The link works once: call this a single time per link. ' +
      'Afterwards, read the file only inside commands that need it, and never print the value.',
    inputSchema: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'ChatPass link: https://<host>/api/secrets/<id>/reveal#<key>' },
        name: { type: 'string', description: 'File / env var name to store it under, e.g. OPENAI_API_KEY' },
      },
      required: ['link', 'name'],
      additionalProperties: false,
    },
    annotations: { title: 'Retrieve ChatPass secret', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'list_secrets',
    description: 'List secrets previously retrieved into ~/.chatpass (names and sizes only, never values).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List ChatPass secrets', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'delete_secret',
    description: 'Delete a retrieved secret from ~/.chatpass once you no longer need it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { title: 'Delete ChatPass secret', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

async function callTool(name, args = {}, opts) {
  switch (name) {
    case 'retrieve_secret': {
      const { path, bytes } = await retrieve({ link: args.link, name: args.name, ...opts });
      return `Saved secret ${args.name} to ${path} (${bytes} bytes, mode 600). ` +
        `Use it via e.g. ${args.name}="$(cat ${path})" <command>. Do not print it.`;
    }
    case 'list_secrets': {
      const items = await list(opts);
      return items.length ? items.map((i) => `${i.name}\t${i.bytes} bytes\t${i.modified}`).join('\n') : `No secrets in ${opts.dir || defaultDir()}`;
    }
    case 'delete_secret':
      await remove({ name: args.name, ...opts });
      return `Deleted ${args.name}`;
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
}

export async function handleMessage(msg, { version, opts = {} } = {}) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'chatpass', version },
        instructions: 'Use retrieve_secret when the user gives you a ChatPass link. Never echo secret values.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const text = await callTool(params?.name, params?.arguments, opts);
        return reply({ content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        if (err.rpcCode) return fail(err.rpcCode, err.message);
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    default:
      if (id === undefined) return null; // notification (e.g. notifications/initialized)
      return fail(-32601, `Method not found: ${method}`);
  }
}

export function runMcpServer({ version, input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => output.write(JSON.stringify(obj) + '\n');
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const res = await handleMessage(msg, { version });
    if (res) write(res);
  });
  return rl;
}
