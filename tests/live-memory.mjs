import assert from 'node:assert/strict';

process.env.API_ONLY = '1';
const { createServer } = await import('../server/index.mjs');
const app = createServer();
const port = 8799;
const server = await new Promise((resolve) => {
  const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${port}`;

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `${response.status}`);
  return body;
}

async function stream(key, message) {
  const response = await fetch(`${base}/v1/agents/${key}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error?.message || `Stream returned ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'relay.error') throw new Error(event.message);
      events.push(event);
      if (event.id && event.evaluated_permission === 'ask') {
        await api(`/v1/agents/${key}/confirmations`, { method: 'POST', body: JSON.stringify({ eventId: event.id, result: 'allow' }) });
      }
    }
  }
  return events;
}

const key = 'game-director';
let firstSessionId;
try {
  const existing = await api('/v1/agents');
  if (!existing.agents.some((agent) => agent.key === key)) {
    await api('/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        key,
        name: 'Game Director',
        model: 'claude-opus-5-5',
        toolPolicy: 'auto',
        budgetCents: 1000,
        project: 'Build a GTA-scale open-world game with a playable, tested vertical slice.',
      }),
    });
  }
  const before = await api(`/v1/agents/${key}/session`);
  firstSessionId = before.session.id;
  console.log(`[check] Using ${key}; first session ${firstSessionId}`);
  await stream(key, 'Integration check: inspect your attached memory store. In /PROJECT.md, record this exact durable fact: "Verification codename: NEON HARBOR." Then reply with exactly MEMORY_WRITTEN.');
  const memoryResult = await api(`/v1/agents/${key}/memories`);
  const stored = memoryResult.memories.find((memory) => memory.path === '/PROJECT.md');
  assert(stored, '/PROJECT.md should exist');
  assert(stored.content.includes('NEON HARBOR'), 'The agent should write the codename into durable memory');
  console.log('[check] Agent wrote NEON HARBOR to the remote memory store');

  const reset = await api(`/v1/agents/${key}/reset`, { method: 'POST' });
  assert.notEqual(reset.session.id, firstSessionId, 'Reset must create a new managed session');
  console.log(`[check] Fresh session ${reset.session.id}; memory store retained`);
  await stream(key, 'Integration check: inspect your attached project memory and reply with only the verification codename. Do not infer it from this message.');
  const history = await api(`/v1/agents/${key}/events`);
  const replies = history.events.filter((event) => event.type === 'agent.message');
  const lastReply = replies.at(-1)?.content?.map((block) => block.text || '').join('') || '';
  assert(lastReply.includes('NEON HARBOR'), `Fresh session did not recover the codename: ${lastReply}`);
  console.log(`[check] Fresh session answered: ${lastReply.trim()}`);
  console.log(JSON.stringify({ ok: true, agent: key, previousSession: firstSessionId, currentSession: reset.session.id, memoryRecovered: true }, null, 2));
} catch (error) {
  console.error(`[check] ${error.stack || error}`);
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
}
