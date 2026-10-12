// Builds the prompt the user pastes into an LLM chat. The agent runs the
// embedded shell snippet in its own environment to fetch + decrypt.

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Both decryptors read base64url(iv || ct || tag) on stdin and the key from $CHATPASS_KEY.
// They must not contain single quotes (they are embedded in single-quoted shell strings).
const NODE_DECRYPT =
  'const c=require("crypto"),fs=require("fs");' +
  'const b=Buffer.from(fs.readFileSync(0,"utf8").trim(),"base64url");' +
  'const d=c.createDecipheriv("aes-256-gcm",Buffer.from(process.env.CHATPASS_KEY,"base64url"),b.subarray(0,12));' +
  'd.setAuthTag(b.subarray(-16));' +
  'process.stdout.write(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]))';

const PY_DECRYPT =
  'import os,sys,base64;' +
  'from cryptography.hazmat.primitives.ciphers.aead import AESGCM;' +
  'f=lambda s:base64.urlsafe_b64decode(s+"="*(-len(s)%4));' +
  'b=f(sys.stdin.read().strip());' +
  'sys.stdout.buffer.write(AESGCM(f(os.environ["CHATPASS_KEY"])).decrypt(b[:12],b[12:],None))';

/** The self-contained retrieval script. Writes the secret to ~/.chatpass/<NAME> (mode 600). */
export function buildScript({ revealUrl, key, name }) {
  if (!NAME_RE.test(name)) throw new Error('Invalid secret name');
  if (!/^https?:\/\/[A-Za-z0-9.:\[\]-]+\/api\/secrets\/[A-Za-z0-9_-]{22}\/reveal$/.test(revealUrl)) {
    throw new Error('Invalid reveal URL');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid key');
  return [
    `( set -eu; umask 077; mkdir -p "$HOME/.chatpass"; out="$HOME/.chatpass/${name}"`,
    `  enc="$(curl -fsS -X POST '${revealUrl}')"`,
    `  export CHATPASS_KEY='${key}'`,
    `  if command -v node >/dev/null 2>&1; then dec() { node -e '${NODE_DECRYPT}'; }`,
    `  else dec() { python3 -c '${PY_DECRYPT}'; }; fi`,
    `  printf %s "$enc" | dec > "$out.tmp" || { rm -f "$out.tmp"; echo "chatpass: decryption failed" >&2; exit 1; }`,
    `  mv "$out.tmp" "$out"; echo "chatpass: saved ${name} to $out ($(wc -c < "$out") bytes)" )`,
  ].join('\n');
}

export function buildPrompt({ revealUrl, key, name, expiresAt, maxReads = 1, instructions = '' }) {
  const script = buildScript({ revealUrl, key, name });
  const expires = new Date(expiresAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const reads = maxReads === 1 ? 'can be retrieved exactly once' : `can be retrieved ${maxReads} times`;
  const task = instructions.trim()
    ? `\nWhat I want you to do with it:\n${instructions.trim()}\n`
    : '';

  return `I'm sharing a secret named \`${name}\` with you via ChatPass, an end-to-end encrypted, self-destructing link. It expires at ${expires} and ${reads}.

Retrieve it by running this exact command in your shell/sandbox environment. Do NOT open the URL in a browser or web-fetch tool: retrieval requires a POST, and a failed attempt may burn the secret.

\`\`\`bash
${script}
\`\`\`

The secret is now in \`~/.chatpass/${name}\` (permissions 600). Use it by reading the file only where it is needed, e.g. \`${name}="$(cat ~/.chatpass/${name})" some-command\` or \`export ${name}="$(cat ~/.chatpass/${name})"\` inside the same command.
${task}
Rules for handling this secret:
- Never print, echo, cat to output, log, or repeat the secret value in this chat, in tool output, or in commit messages.
- Never commit it to version control or write it into files that are tracked by git. If it must go into a config file, make sure the file is git-ignored.
- Do not send it anywhere other than the service it is meant for.
- If the command fails with HTTP 404, the secret has expired, was already retrieved, or was revoked. Tell me and do not retry. If it fails for any other reason (e.g. network blocked), tell me the error.
- When the task is done, delete it with \`rm -f ~/.chatpass/${name}\` unless I ask you to keep it.`;
}
