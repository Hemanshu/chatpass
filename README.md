# ChatPass

Hand a secret (API key, DB URL, token) to an LLM agent running in a cloud sandbox without pasting the secret into the chat.

A Yopass-style one-time secret link, where the reader is an AI agent and the "link" is a ready-to-paste prompt.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Hemanshu/chatpass)

Three ways to use it:

- **Web UI**: type the secret, copy the prompt, paste it into your AI chat.
- **CLI**: `npx chatpass share OPENAI_API_KEY --server https://your-chatpass` (also `get`, `list`, `rm`, `serve`).
- **MCP server**: `chatpass mcp` gives agents a `retrieve_secret` tool, so they never handle the key in shell commands.

## Flow

1. You type the secret into the ChatPass page.
2. **Your browser** generates a random 256-bit key and encrypts the secret with AES-256-GCM (WebCrypto).
3. Only the ciphertext is uploaded. The server stores it **in memory only**, with a short TTL (1 to 5 minutes) and a read limit (default 1).
4. The page builds a prompt containing a one-time link (`https://host/api/secrets/<id>/reveal#<key>`) and a self-contained shell snippet. You paste that prompt into your AI chat.
5. The agent either calls the `retrieve_secret` MCP tool, if it has it, or runs the snippet in its sandbox. It `POST`s to the reveal URL (the server returns the ciphertext and deletes it), decrypts locally with `node` or `python3`+`cryptography`, and writes the result to `~/.chatpass/<NAME>` with mode `600`.
6. The prompt tells the agent never to echo the value, never to commit it, and to delete the file when done.

The page polls the status endpoint and shows when the secret has been retrieved. You can revoke it at any time before that.

## Threat model

| Who can see what | Ciphertext | Key | Plaintext |
| --- | --- | --- | --- |
| ChatPass server / operator | yes, briefly | **never** | **never** |
| Chat transcript / LLM provider | no | yes | only if the agent misbehaves |
| Agent sandbox | yes | yes | yes (intended) |

- **Server compromise** alone reveals nothing: there is no key, and secrets vanish after TTL or first read. A restart wipes everything.
- **Chat transcript leak** after retrieval reveals nothing: the link is already burned. A transcript leaked *before* retrieval plus network access to ChatPass would let an attacker race the agent. If that happens, the agent gets a 404 and tells you, so you know.
- **Link unfurlers / web-fetch tools** can't burn the secret by accident: reveal is `POST`-only, and a `GET` returns 405.
- **Not protected against:** a malicious or compromised agent or sandbox (it is the intended recipient), or a malicious ChatPass deployment serving tampered JavaScript. That second one applies to every browser-based E2E tool, Yopass included, so self-host it.
- The secret's **name** and your **instructions** are in the prompt in cleartext. Don't put sensitive information there.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/secrets` | JSON `{ ciphertext, ttlSeconds?, maxReads? }` → `201 { id, deleteToken, expiresAt }` |
| `POST` | `/api/secrets/:id/reveal` | → `200 text/plain` ciphertext, consumes one read; `404` if gone |
| `GET` | `/api/secrets/:id` | → `{ expiresAt, readsLeft }`, no ciphertext |
| `DELETE` | `/api/secrets/:id` | `Authorization: Bearer <deleteToken>` → `204` |

Ciphertext format: `base64url(iv[12] ‖ ciphertext ‖ tag[16])`. Limits: 64 KB per secret, 50 MB total in memory, and per-IP rate limits of 30 creates/min and 120 reveals/min.

## CLI

```bash
npm install -g chatpass            # or: npx chatpass ...
export CHATPASS_SERVER=https://your-chatpass.onrender.com

# Share (secret read hidden from the TTY, or from stdin)
chatpass share OPENAI_API_KEY --note "Add it to .env and run the tests"
cat sa.json | chatpass share GCP_SA_JSON --link      # print just the one-time link

# Retrieve (what an agent or a teammate runs)
chatpass get 'https://.../api/secrets/<id>/reveal#<key>' --name OPENAI_API_KEY
chatpass list
chatpass rm OPENAI_API_KEY

chatpass serve --port 3000         # run your own server
```

## MCP server

Add it to any MCP client (Claude Code, Claude Desktop, Cursor, …):

```bash
claude mcp add chatpass -- npx -y chatpass mcp
```

```json
{ "mcpServers": { "chatpass": { "command": "npx", "args": ["-y", "chatpass", "mcp"] } } }
```

Tools (none of them return secret values):

| Tool | Does |
| --- | --- |
| `retrieve_secret(link, name)` | Fetch, decrypt and save to `~/.chatpass/<name>` (mode 600). Returns the path. |
| `list_secrets()` | Names and sizes of retrieved secrets. |
| `delete_secret(name)` | Remove one when done. |

Set `CHATPASS_DIR` to change the storage directory.

## Claude Code plugin (skill + subagent + MCP)

This repo is also a Claude Code plugin marketplace:

```
/plugin install chatpass --marketplace Hemanshu/chatpass
```

On older Claude Code versions, run `/plugin marketplace add Hemanshu/chatpass` first, then `/plugin install chatpass@chatpass`. Self-hosting? Point `marketplace add` at your own git URL or a local path.

| Component | Path | Purpose |
| --- | --- | --- |
| Skill `chatpass` | `skills/chatpass/SKILL.md` | Teaches the agent to retrieve once, use secrets without echoing them, handle errors, and clean up. |
| Subagent `chatpass-secrets` | `agents/chatpass-secrets.md` | Handles retrieval and wiring in its own context, then reports back only the path and size. |
| MCP server `chatpass` | `.claude-plugin/plugin.json` | Runs `bin/chatpass.js mcp` from the plugin, so no npm install is needed. |

To use the skill or agent without the plugin, copy them into `.claude/skills/chatpass/` and `.claude/agents/` (project) or `~/.claude/...` (user).

## Run / deploy

```bash
npm start            # http://localhost:3000, no dependencies
npm test             # unit, API, CLI, MCP and end-to-end (runs the generated prompt script in bash)
docker build -t chatpass . && docker run -p 3000:3000 chatpass
```

Env vars: `PORT`, `HOST`, `MAX_TTL_SECONDS` (default 300), and `TRUST_PROXY=1` (use `X-Forwarded-For` for rate limiting when behind a reverse proxy).

**Render (free):** click the button above, or go to New → Blueprint and pick this repo. `render.yaml` sets everything up. Free instances sleep after 15 minutes idle, which is harmless because no secret lives longer than 5 minutes. The first request after a sleep can take about 30 seconds.

**Network allowlists:** the agent's sandbox must be able to reach your ChatPass host. If your cloud agent environment restricts egress, add the host to its allowed domains.

## Publishing

- **npm:** add an `NPM_TOKEN` repo secret, bump `version` in `package.json`, then `git tag v0.2.0 && git push --tags`. `.github/workflows/publish.yml` runs the tests and publishes with provenance.
- **Homebrew:** `packaging/homebrew/chatpass.rb` is a formula template that wraps the npm tarball. Put it in a `homebrew-tap` repo after the first npm release.
- **pip:** not yet. It would need a small Python port of the `get`/`mcp` side. The wire format is plain AES-256-GCM, so that's straightforward.

## Roadmap ideas

- Persistent backend (Redis with TTL) for multi-instance deployments. Still ciphertext only.
- `share_secret` MCP tool, so an agent can hand a generated credential back to a human.
- File attachments (`.env` files, service-account JSON).
