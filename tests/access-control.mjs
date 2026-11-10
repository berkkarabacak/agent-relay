import assert from 'node:assert/strict';

process.env.AGENT_RELAY_ACCESS_TOKEN = 'test-family-token';
const { createServer } = await import('../server/index.mjs');
const app = createServer();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const basic = `Basic ${Buffer.from('family:test-family-token').toString('base64')}`;

try {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const anonymous = await fetch(`${base}/v1/agents`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') || '', /Basic/);

  const wrong = await fetch(`${base}/v1/agents`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(wrong.status, 401);

  const bearer = await fetch(`${base}/v1/agents`, { headers: { Authorization: 'Bearer test-family-token' } });
  assert.equal(bearer.status, 200);

  const basicResponse = await fetch(`${base}/api/status`, { headers: { Authorization: basic } });
  assert.equal(basicResponse.status, 200);
  console.log('Access control: health is public; UI/API require Bearer or Basic credentials when configured.');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
