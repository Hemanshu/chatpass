import { createApp } from './src/server.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const app = createApp({
  trustProxy: process.env.TRUST_PROXY === '1',
  maxTtlSeconds: Number(process.env.MAX_TTL_SECONDS) || undefined,
});

app.server.listen(port, host, () => {
  console.log(`chatpass listening on http://${host}:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.close();
    process.exit(0);
  });
}
