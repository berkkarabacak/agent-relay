import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.mjs';
import { store } from './db.mjs';

// The SDK appends the one required beta for each endpoint. Adding managed-agents
// explicitly to memory calls would combine two incompatible memory contracts.
const betas = [];
let client;
let environmentPromise;
const sessionLocks = new Map();

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const error = new Error('ANTHROPIC_API_KEY is not configured. Run npm run setup, then restart AgentRelay.');
    error.status = 503;
    throw error;
  }
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
  return client;
}

export function agentKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(key)) {
    const error = new Error('Agent key must be 2–48 characters using lowercase letters, numbers, and hyphens.');
    error.status = 400;
    throw error;
  }
  return key;
}

function requiredAgent(key) {
  const agent = store.getAgent(agentKey(key));
  if (!agent) {
    const error = new Error(`No sticky agent named “${key}”.`);
    error.status = 404;
    throw error;
  }
  return agent;
}

async function withSessionLock(key, operation) {
  const previous = sessionLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  sessionLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (sessionLocks.get(key) === current) sessionLocks.delete(key);
  }
}

async function ensureEnvironment() {
  if (environmentPromise) return environmentPromise;
  environmentPromise = (async () => {
    const anthropic = getClient();
    const configuredId = config.environmentId || store.getSetting('environment_id');
    if (configuredId) {
      const environment = await anthropic.beta.environments.retrieve(configuredId, { betas });
      store.setSetting('environment_id', environment.id);
      return environment;
    }
    const environment = await anthropic.beta.environments.create({
      name: 'agent-relay-local',
      description: 'Local AgentRelay managed-agent sessions',
      config: {
        type: 'cloud',
        networking: { type: 'limited', allow_package_managers: true },
      },
      metadata: { created_by: 'agent-relay' },
      betas,
    });
    store.setSetting('environment_id', environment.id);
    return environment;
  })().catch((error) => {
    environmentPromise = undefined;
    throw error;
  });
  return environmentPromise;
}

const defaultSystem = `You are a senior game development agent contributing to an ambitious, long-running open-world game. Work autonomously, verify changes with real builds and tests, and keep the project maintainable as it grows.

At the start of every session, inspect the attached memory store before making decisions. Use it for durable project architecture, conventions, assets, completed work, known defects, and next steps. Update it after meaningful milestones. Do not store secrets in memory. Keep the current task in the conversation; keep reusable knowledge in memory.`;

async function createRemoteSession(agent) {
  const session = await getClient().beta.sessions.create({
    agent: agent.remoteAgentId,
    environment_id: agent.environmentId,
    title: `${agent.name} · sticky session`,
    metadata: { agent_relay_key: agent.key },
    budget: agent.budgetCents > 0 ? {
      type: 'limit',
      max_list_cost: { amount: String(agent.budgetCents), currency: 'USD' },
    } : undefined,
    resources: [{
      type: 'memory_store',
      memory_store_id: agent.memoryStoreId,
      access: 'read_write',
      instructions: 'This is your persistent project memory. Read relevant notes before starting work. Record durable decisions, milestones, and follow-up work here so future sessions can continue without losing context.',
    }],
    betas,
  });
  return session;
}

export async function createStickyAgent(input) {
  const key = agentKey(input.key || input.name);
  if (store.getAgent(key)) {
    const error = new Error(`Sticky agent “${key}” already exists.`);
    error.status = 409;
    throw error;
  }
  const name = String(input.name || key).trim().slice(0, 100);
  const model = String(input.model || config.model);
  const toolPolicy = ['auto', 'always_allow', 'always_ask'].includes(input.toolPolicy) ? input.toolPolicy : 'auto';
  const budgetCents = Math.max(0, Math.min(100000, Number(input.budgetCents ?? config.budgetCents)));
  const environment = await ensureEnvironment();
  const anthropic = getClient();
  const remoteAgent = await anthropic.beta.agents.create({
    name: `AgentRelay · ${name}`,
    description: 'Sticky local agent managed through AgentRelay',
    model,
    system: String(input.system || defaultSystem).slice(0, 100000),
    tools: [{
      type: 'agent_toolset_20260401',
      default_config: { permission_policy: { type: toolPolicy } },
    }],
    metadata: { agent_relay_key: key },
    betas,
  });
  const memoryStore = await anthropic.beta.memoryStores.create({
    name: `${name} Project Memory`,
    description: 'Durable architecture, conventions, decisions, milestones, and follow-up work for this sticky agent. Read before work and update after milestones.',
    metadata: { agent_relay_key: key },
    betas,
  });
  await anthropic.beta.memoryStores.memories.create(memoryStore.id, {
    path: '/PROJECT.md',
    content: `# ${name} project memory\n\n## Current objective\n${String(input.project || 'Define the project objective with the operator.').trim()}\n\n## Architecture\nNo durable architecture decisions recorded yet.\n\n## Milestones\nNo milestones recorded yet.\n\n## Next steps\nClarify the first task and establish the project baseline.\n`,
    betas,
  });
  const draft = {
    key,
    name,
    system: String(input.system || defaultSystem),
    model,
    toolPolicy,
    budgetCents,
    remoteAgentId: remoteAgent.id,
    environmentId: environment.id,
    memoryStoreId: memoryStore.id,
    sessionId: null,
  };
  const session = await createRemoteSession(draft);
  draft.sessionId = session.id;
  return store.createAgent(draft);
}

export function listStickyAgents() {
  return store.listAgents();
}

export async function getStickyAgent(key, refresh = false) {
  const agent = requiredAgent(key);
  if (!refresh || !agent.sessionId) return agent;
  return getRemoteSession(key);
}

async function ensureSession(key) {
  return withSessionLock(agentKey(key), async () => {
    let agent = requiredAgent(key);
    if (agent.sessionId) {
      try {
        const existing = await getClient().beta.sessions.retrieve(agent.sessionId, { betas });
        if (existing.status !== 'terminated' && !existing.archived_at) {
          if (existing.status !== agent.status) store.updateAgent(key, { status: existing.status });
          return { agent: { ...agent, status: existing.status }, session: existing };
        }
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    const session = await createRemoteSession(agent);
    agent = store.updateAgent(key, { sessionId: session.id, status: session.status });
    return { agent, session };
  });
}

export async function getRemoteSession(key) {
  const agent = requiredAgent(key);
  if (!agent.sessionId) return (await ensureSession(key)).session;
  const session = await getClient().beta.sessions.retrieve(agent.sessionId, { betas });
  store.updateAgent(key, { status: session.status });
  return session;
}

export async function sendMessage(key, message) {
  const text = String(message || '').trim();
  if (!text) {
    const error = new Error('Message cannot be empty.');
    error.status = 400;
    throw error;
  }
  const { session } = await ensureSession(key);
  const result = await getClient().beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: text.slice(0, 100000) }] }],
    betas,
  });
  store.updateAgent(key, { status: 'running', lastUsedAt: new Date().toISOString() });
  return { sessionId: session.id, result };
}

export async function streamMessage(key, message, onEvent, signal) {
  const text = String(message || '').trim();
  if (!text) {
    const error = new Error('Message cannot be empty.');
    error.status = 400;
    throw error;
  }
  const { session } = await ensureSession(key);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const streamPromise = getClient().beta.sessions.events.stream(
    session.id, { betas }, { signal: controller.signal },
  );
  try {
    await onEvent({ type: 'relay.session', session_id: session.id, agent_key: agentKey(key) });
    await getClient().beta.sessions.events.send(session.id, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: text.slice(0, 100000) }] }],
      betas,
    });
    store.updateAgent(key, { status: 'running', lastUsedAt: new Date().toISOString() });
    const stream = await streamPromise;
    for await (const event of stream) {
      await onEvent(event);
      if (event.type === 'session.status_running') store.updateAgent(key, { status: 'running' });
      if (event.type === 'session.status_idle') {
        store.updateAgent(key, { status: 'idle' });
        break;
      }
      if (event.type === 'session.status_terminated' || event.type === 'session.error') {
        store.updateAgent(key, { status: event.type === 'session.error' ? 'error' : 'terminated' });
        break;
      }
    }
  } catch (error) {
    controller.abort();
    await streamPromise.catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!signal?.aborted) {
      try {
        const latest = await getClient().beta.sessions.retrieve(session.id, { betas });
        store.updateAgent(key, { status: latest.status });
      } catch { /* The persisted local state remains usable on the next refresh. */ }
    }
  }
}

export async function listSessionEvents(key) {
  const { session } = await ensureSession(key);
  const events = [];
  for await (const event of getClient().beta.sessions.events.list(session.id, { betas })) events.push(event);
  return { sessionId: session.id, events };
}

export async function interruptSession(key) {
  const { session } = await ensureSession(key);
  const result = await getClient().beta.sessions.events.send(session.id, {
    events: [{ type: 'user.interrupt' }], betas,
  });
  return result;
}

export async function confirmTool(key, input) {
  const { session } = await ensureSession(key);
  if (!input.eventId || !['allow', 'deny'].includes(input.result)) {
    const error = new Error('A tool event ID and allow/deny result are required.');
    error.status = 400;
    throw error;
  }
  return getClient().beta.sessions.events.send(session.id, {
    events: [{
      type: 'user.tool_confirmation',
      tool_use_id: input.eventId,
      result: input.result,
      deny_message: input.result === 'deny' ? String(input.message || 'Denied by the local operator.') : undefined,
    }],
    betas,
  });
}

export async function resetStickySession(key) {
  return withSessionLock(agentKey(key), async () => {
    let agent = requiredAgent(key);
    if (agent.sessionId) {
      const previous = await getClient().beta.sessions.retrieve(agent.sessionId, { betas });
      if (previous.status === 'running') {
        const error = new Error('Interrupt the running session before resetting it.');
        error.status = 409;
        throw error;
      }
      if (!previous.archived_at && previous.status !== 'terminated') {
        await getClient().beta.sessions.archive(previous.id, { betas });
      }
      store.recordSessionHistory(key, previous.id);
    }
    const session = await createRemoteSession(agent);
    agent = store.updateAgent(key, { sessionId: session.id, status: session.status });
    return { agent, session };
  });
}

export async function listMemories(key) {
  const agent = requiredAgent(key);
  const memories = [];
  for await (const memory of getClient().beta.memoryStores.memories.list(agent.memoryStoreId, {
    path_prefix: '/', view: 'full', betas,
  })) {
    if (memory.type === 'memory') memories.push(memory);
  }
  return { memoryStoreId: agent.memoryStoreId, memories };
}

function validMemoryPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..') || path.length > 1024) {
    const error = new Error('Memory path must be an absolute path such as /notes/architecture.md.');
    error.status = 400;
    throw error;
  }
  return path;
}

export async function createMemory(key, input) {
  const agent = requiredAgent(key);
  return getClient().beta.memoryStores.memories.create(agent.memoryStoreId, {
    path: validMemoryPath(input.path),
    content: String(input.content || ''),
    view: 'full',
    betas,
  });
}

export async function updateMemory(key, memoryId, input) {
  const agent = requiredAgent(key);
  return getClient().beta.memoryStores.memories.update(memoryId, {
    memory_store_id: agent.memoryStoreId,
    path: input.path ? validMemoryPath(input.path) : undefined,
    content: String(input.content || ''),
    precondition: input.contentSha256 ? { type: 'content_sha256', content_sha256: input.contentSha256 } : undefined,
    view: 'full',
    betas,
  });
}

export async function deleteMemory(key, memoryId) {
  const agent = requiredAgent(key);
  return getClient().beta.memoryStores.memories.delete(memoryId, {
    memory_store_id: agent.memoryStoreId, betas,
  });
}

export function relayStatus() {
  return {
    ok: true,
    service: 'AgentRelay',
    keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    model: config.model,
    environmentId: config.environmentId || store.getSetting('environment_id'),
    agentCount: store.listAgents().length,
    localOnly: config.host === '127.0.0.1' || config.host === 'localhost',
  };
}
