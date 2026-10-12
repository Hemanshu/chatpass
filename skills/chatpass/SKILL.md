---
name: chatpass
description: Retrieve and safely handle secrets shared through ChatPass one-time encrypted links. Use when the user pastes a ChatPass prompt or a link like https://<host>/api/secrets/<id>/reveal#<key>, asks you to fetch a shared secret/API key/token/credential, or wants to securely send a secret to someone with chatpass.
---

# ChatPass secrets

ChatPass delivers a secret to you without the value ever appearing in the chat. The user's browser encrypted it with AES-256-GCM. The server holds only ciphertext, for 5 minutes at most, and deletes it on the first retrieval. The link carries the key in its `#fragment`.

**The link works once.** Every retrieval attempt, failed or not, may consume it. Pick one method and run it once.

## Retrieve

Use the first of these that is available:

1. **MCP tool `retrieve_secret`** (from the `chatpass` MCP server). Call it with `link` (the full URL, including `#key`) and `name` (for example `OPENAI_API_KEY`). It returns only the path where the secret was saved.
2. **CLI**, if `chatpass` is on PATH: `chatpass get '<link>' --name NAME`
3. **The bash snippet in the user's prompt.** Run it exactly as given, once. It needs `curl`, plus `node` or `python3` with the `cryptography` package.

Never open the link in a browser or with a web-fetch tool. Retrieval is a `POST`, and a `GET` returns 405.

In every case the secret ends up in `~/.chatpass/NAME` with mode 600 (or in `$CHATPASS_DIR/NAME`).

## Use

Read the file only inside the command that needs it, so the value never shows up in tool output:

```bash
OPENAI_API_KEY="$(cat ~/.chatpass/OPENAI_API_KEY)" npm test
export GITHUB_TOKEN="$(cat ~/.chatpass/GITHUB_TOKEN)"; gh auth status   # same command only
```

If it has to go into a config file (such as `.env`), first confirm the file is git-ignored (`git check-ignore -q .env`). Write it without echoing:

```bash
printf 'OPENAI_API_KEY=%s\n' "$(cat ~/.chatpass/OPENAI_API_KEY)" >> .env
```

## Rules

- Never print, `cat` to output, echo, log, or repeat the value, in chat, tool output, commit messages, PR text or test snapshots.
- Never commit it, and never write it to tracked files.
- Send it only to the service it's meant for.
- Don't put it in command-line arguments that get logged or shown. Prefer environment variables or stdin.
- When the task is done, delete it: `rm -f ~/.chatpass/NAME`, or the `delete_secret` tool. Skip this only if the user asks you to keep it.

## Errors

| Symptom | Meaning | Action |
| --- | --- | --- |
| HTTP 404 | Expired (max 5 min), already retrieved, or revoked | Tell the user and ask for a new link. Do not retry. |
| HTTP 405 | A GET was used | Wrong method; the link is probably still valid. Use one of the methods above. |
| HTTP 429 | Rate limited | Wait about a minute, then try once more. |
| Connection refused / proxy 403 / DNS failure | Your sandbox can't reach the ChatPass host | Tell the user the host must be allowed in the environment's network settings. The link is probably still unused. |
| "Decryption failed" | Wrong or truncated key (the `#fragment` was lost) | The link has been consumed. Ask for a new one. |

## Sending a secret to the user

If you need to hand a credential you generated back to the user, don't paste it in chat. Use:

```bash
chatpass share NAME --server "$CHATPASS_SERVER" --link < /path/to/secret-file
```

Then give the user the printed one-time link and tell them it expires within 5 minutes. They can retrieve it with `chatpass get`.
