# ChatPass

Hand a secret (API key, DB URL, token) to an LLM agent running in a cloud sandbox without pasting the secret into the chat.

A Yopass-style one-time secret link, where the reader is an AI agent and the "link" is a ready-to-paste prompt.

## Flow

1. You type the secret into the ChatPass page.
2. **Your browser** generates a random 256-bit key and encrypts the secret with AES-256-GCM (WebCrypto).
3. Only the ciphertext is uploaded. The server stores it **in memory only**, with a short TTL (5 min to 24 h) and a read limit (default 1).
4. The page builds a prompt containing the reveal URL, the key, and a self-contained shell snippet. You paste that prompt into your AI chat.
5. The agent runs the snippet in its sandbox. It `POST`s to the reveal URL (the server returns the ciphertext and deletes it), decrypts locally with `node` or `python3`+`cryptography`, and writes the result to `~/.chatpass/<NAME>` with mode `600`.
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

## Run

```bash
npm start            # http://localhost:3000, no dependencies
npm test             # unit + API + end-to-end (runs the generated prompt script in bash)
docker build -t chatpass . && docker run -p 3000:3000 chatpass
```

Env vars: `PORT`, `HOST`, `MAX_TTL_SECONDS` (default 86400), and `TRUST_PROXY=1` (use `X-Forwarded-For` for rate limiting when behind a reverse proxy).

**Deploying:** serve it over HTTPS behind a reverse proxy. The agent's sandbox must be able to reach your ChatPass host, so if your cloud agent environment uses a network allowlist, add the host to it.

## Roadmap ideas

- Optional passphrase as a second factor, sent to the agent out of band.
- Persistent backend (Redis with TTL) for multi-instance deployments. Still ciphertext only.
- A tiny `chatpass` CLI / MCP tool, so agents don't need the inline snippet.
- File attachments (`.env` files, service-account JSON).
