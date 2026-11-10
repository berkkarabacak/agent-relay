export type AgentStatus = 'idle' | 'running' | 'rescheduling' | 'terminated' | 'error';

export interface StickyAgent {
  key: string;
  name: string;
  system: string;
  model: string;
  toolPolicy: 'auto' | 'always_allow' | 'always_ask';
  budgetCents: number;
  remoteAgentId: string;
  environmentId: string;
  memoryStoreId: string;
  sessionId: string | null;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface RelayStatus {
  ok: boolean;
  service: string;
  keyConfigured: boolean;
  model: string;
  environmentId: string | null;
  agentCount: number;
  localOnly: boolean;
}

export interface ManagedSession {
  id: string;
  status: AgentStatus;
  title?: string;
  created_at?: string;
  archived_at?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    active_seconds?: number;
    list_cost?: { amount: string; currency: string } | null;
  };
  budget?: { max_list_cost: { amount: string; currency: string } } | null;
}

export interface MemoryDocument {
  id: string;
  type: 'memory';
  path: string;
  content: string;
  content_sha256: string;
  content_size_bytes: number;
  updated_at: string;
}

export interface RelayEvent {
  id?: string;
  type: string;
  processed_at?: string | null;
  content?: Array<{ type: string; text?: string }>;
  name?: string;
  input?: Record<string, unknown>;
  evaluated_permission?: 'allow' | 'ask' | 'deny';
  stop_reason?: { type: string; event_ids?: string[] };
  error?: { message?: string };
  message?: string;
  session_id?: string;
  agent_key?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface NewAgentInput {
  key: string;
  name: string;
  model: string;
  toolPolicy: string;
  budgetCents: number;
  project: string;
  system?: string;
}
