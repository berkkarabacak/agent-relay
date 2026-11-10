import type { ManagedSession, MemoryDocument, NewAgentInput, RelayEvent, RelayStatus, StickyAgent } from '@/types/relay';

async function errorFrom(response: Response) {
  try {
    const body = await response.json();
    return new Error(body.error?.message || body.message || `Request failed (${response.status})`);
  } catch {
    return new Error(`Request failed (${response.status})`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw await errorFrom(response);
  return response.json() as Promise<T>;
}

export const relayApi = {
  status: () => request<RelayStatus>('/api/status'),
  agents: () => request<{ agents: StickyAgent[] }>('/v1/agents'),
  createAgent: (input: NewAgentInput) => request<{ agent: StickyAgent }>('/v1/agents', { method: 'POST', body: JSON.stringify(input) }),
  session: (key: string) => request<{ session: ManagedSession }>(`/v1/agents/${key}/session`),
  events: (key: string) => request<{ sessionId: string; events: RelayEvent[] }>(`/v1/agents/${key}/events`),
  interrupt: (key: string) => request(`/v1/agents/${key}/interrupt`, { method: 'POST' }),
  reset: (key: string) => request<{ agent: StickyAgent; session: ManagedSession }>(`/v1/agents/${key}/reset`, { method: 'POST' }),
  confirm: (key: string, eventId: string, result: 'allow' | 'deny') => request(`/v1/agents/${key}/confirmations`, {
    method: 'POST', body: JSON.stringify({ eventId, result }),
  }),
  memories: (key: string) => request<{ memoryStoreId: string; memories: MemoryDocument[] }>(`/v1/agents/${key}/memories`),
  createMemory: (key: string, input: { path: string; content: string }) => request<{ memory: MemoryDocument }>(`/v1/agents/${key}/memories`, {
    method: 'POST', body: JSON.stringify(input),
  }),
  updateMemory: (key: string, memory: MemoryDocument, path: string, content: string) => request<{ memory: MemoryDocument }>(`/v1/agents/${key}/memories/${memory.id}`, {
    method: 'PUT', body: JSON.stringify({ path, content, contentSha256: memory.content_sha256 }),
  }),
  deleteMemory: (key: string, memoryId: string) => request(`/v1/agents/${key}/memories/${memoryId}`, { method: 'DELETE' }),
};

export async function streamAgentMessage(
  key: string,
  message: string,
  onEvent: (event: RelayEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetch(`/v1/agents/${key}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    signal,
  });
  if (!response.ok) throw await errorFrom(response);
  if (!response.body) throw new Error('This browser does not support streaming responses.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const data = chunk.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
      if (!data) continue;
      const event = JSON.parse(data) as RelayEvent;
      if (event.type === 'relay.error') throw new Error(event.message || 'The agent stream failed.');
      onEvent(event);
    }
  }
}
