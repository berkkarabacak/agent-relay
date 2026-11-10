import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowUp, BookOpen, Bot, Check, CircleStop, Clipboard, Cloud,
  Cpu, Database, KeyRound, Network, Plus, RefreshCw, RotateCcw,
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { EventTimeline } from '@/components/EventTimeline';
import { MemoryPanel } from '@/components/MemoryPanel';
import { NewAgentDialog } from '@/components/NewAgentDialog';
import { relayApi, streamAgentMessage } from '@/lib/relay';
import type { ManagedSession, NewAgentInput, RelayEvent, RelayStatus, StickyAgent } from '@/types/relay';
import './App.css';

const money = (cents?: string | number) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const shortId = (id?: string | null) => id ? `${id.slice(0, 15)}…${id.slice(-5)}` : 'Not created';

export default function App() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [agents, setAgents] = useState<StickyAgent[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [session, setSession] = useState<ManagedSession | null>(null);
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [composer, setComposer] = useState('');
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'memory' | 'session' | 'api'>('memory');
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const selectedKeyRef = useRef(selectedKey);
  const requestRef = useRef(0);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  selectedKeyRef.current = selectedKey;
  const selectedAgent = agents.find((agent) => agent.key === selectedKey) || null;

  const refreshAgents = useCallback(async () => {
    const result = await relayApi.agents();
    setAgents(result.agents);
    return result.agents;
  }, []);

  const loadConversation = useCallback(async (key: string, quiet = false) => {
    const requestId = ++requestRef.current;
    if (!quiet) setConversationLoading(true);
    try {
      const [sessionResult, eventResult] = await Promise.all([relayApi.session(key), relayApi.events(key)]);
      if (selectedKeyRef.current !== key || requestRef.current !== requestId) return;
      setSession(sessionResult.session);
      setEvents(eventResult.events);
      setRunning(sessionResult.session.status === 'running' || sessionResult.session.status === 'rescheduling');
    } catch (reason) {
      if (!quiet) toast.error(reason instanceof Error ? reason.message : 'Could not load the session.');
    } finally {
      if (!quiet && requestRef.current === requestId) setConversationLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([relayApi.status(), relayApi.agents()]).then(([nextStatus, nextAgents]) => {
      setStatus(nextStatus);
      setAgents(nextAgents.agents);
      if (nextAgents.agents[0]) setSelectedKey(nextAgents.agents[0].key);
    }).catch((reason) => toast.error(reason instanceof Error ? reason.message : 'The local relay is unavailable.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedKey) { setSession(null); setEvents([]); return; }
    abortRef.current?.abort();
    streamingRef.current = false;
    setRunning(false);
    void loadConversation(selectedKey);
    void refreshAgents();
  }, [selectedKey, loadConversation, refreshAgents]);

  useEffect(() => {
    if (!running || !selectedKey) return;
    const timer = window.setInterval(() => {
      if (!streamingRef.current) void loadConversation(selectedKey, true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [running, selectedKey, loadConversation]);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, running]);

  async function createAgent(input: NewAgentInput) {
    const result = await relayApi.createAgent(input);
    await refreshAgents();
    setSelectedKey(result.agent.key);
    setStatus((current) => current ? { ...current, keyConfigured: true, agentCount: agents.length + 1, environmentId: result.agent.environmentId } : current);
    toast.success(`${result.agent.name} is ready with persistent memory.`);
  }

  function mergeEvent(event: RelayEvent) {
    if (event.type === 'relay.done') return;
    if (event.type === 'relay.session') {
      if (event.session_id) setSession((current) => current ? { ...current, id: event.session_id! } : current);
      return;
    }
    if (event.type === 'session.status_running') setRunning(true);
    if (event.type === 'session.status_idle') {
      setRunning(false);
      if (event.stop_reason?.type === 'budget_reached') toast.warning('The session reached its spend cap.');
    }
    if (!event.id) return;
    setEvents((current) => {
      const index = current.findIndex((item) => item.id === event.id);
      if (index === -1) return [...current, event];
      const next = [...current];
      next[index] = event;
      return next;
    });
  }

  async function send() {
    const key = selectedKey;
    const message = composer.trim();
    if (!key || !message || running) return;
    setComposer('');
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    streamingRef.current = true;
    try {
      await streamAgentMessage(key, message, mergeEvent, controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setComposer(message);
        toast.error(reason instanceof Error ? reason.message : 'Message failed.');
      }
    } finally {
      streamingRef.current = false;
      abortRef.current = null;
      if (selectedKeyRef.current === key) setRunning(false);
      await loadConversation(key, true);
      await refreshAgents();
      setMemoryRefresh((value) => value + 1);
    }
  }

  async function interrupt() {
    if (!selectedKey) return;
    try {
      await relayApi.interrupt(selectedKey);
      toast.success('Interrupt queued. The current tool call may take a moment to stop.');
      await loadConversation(selectedKey, true);
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : 'Could not interrupt.'); }
  }

  async function confirmTool(eventId: string, result: 'allow' | 'deny') {
    if (!selectedKey) return;
    setConfirming(eventId);
    try {
      await relayApi.confirm(selectedKey, eventId, result);
      toast.success(result === 'allow' ? 'Tool call allowed.' : 'Tool call denied.');
      setRunning(true);
      await loadConversation(selectedKey, true);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not answer the tool call.');
    } finally { setConfirming(null); }
  }

  async function resetSession() {
    if (!selectedAgent || !window.confirm(`Start a fresh session for ${selectedAgent.name}? Its memory store will be preserved.`)) return;
    try {
      const result = await relayApi.reset(selectedAgent.key);
      setAgents((current) => current.map((agent) => agent.key === result.agent.key ? result.agent : agent));
      setSession(result.session);
      setEvents([]);
      setRunning(false);
      toast.success('Fresh session started. Project memory is unchanged.');
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : 'Could not reset the session.'); }
  }

  async function copy(value: string, label = 'Copied to clipboard.') {
    try { await navigator.clipboard.writeText(value); toast.success(label); }
    catch { toast.error('Clipboard access is unavailable.'); }
  }

  const curlExample = selectedAgent ? `curl ${window.location.origin}/v1/agents/${selectedAgent.key}/messages \\\n  -H "content-type: application/json" \\\n  -d '{"message":"Continue from the project memory and build the next milestone."}'` : '';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Network size={20} /></span><div><strong>AgentRelay</strong><span>Local control plane</span></div></div>
        <div className="topbar-status">
          <span className={`connection-pill ${status?.keyConfigured ? 'online' : 'setup'}`}><span />{status?.keyConfigured ? 'API configured' : 'Setup required'}</span>
          <span className="topbar-detail"><Cloud size={14} />{status?.environmentId ? 'Environment linked' : 'Cloud environment'}</span>
          <span className="topbar-detail"><Database size={14} />SQLite + memory stores</span>
        </div>
      </header>

      {status && !status.keyConfigured && <div className="setup-banner"><KeyRound size={17} /><span>Configure the local API credential with <code>npm run setup</code>, then restart the relay.</span></div>}

      <div className="workspace-grid">
        <aside className="agent-sidebar">
          <div className="sidebar-heading"><div><span className="section-label">Sticky agents</span><span className="count-badge">{agents.length}</span></div><button className="icon-button accent" aria-label="Create sticky agent" title="Create sticky agent" onClick={() => setNewAgentOpen(true)}><Plus size={18} /></button></div>
          <div className="agent-list">
            {agents.map((agent) => <button key={agent.key} className={`agent-list-item ${selectedKey === agent.key ? 'active' : ''}`} onClick={() => setSelectedKey(agent.key)}>
              <span className="agent-list-icon"><Bot size={17} /></span>
              <span className="agent-list-copy"><strong>{agent.name}</strong><small>{agent.key}</small></span>
              <span className={`status-dot ${agent.status}`} title={agent.status} />
            </button>)}
          </div>
          {!loading && !agents.length && <div className="sidebar-empty"><p>No agents yet.</p><button className="text-button" onClick={() => setNewAgentOpen(true)}>Create the first one <ArrowUp size={14} /></button></div>}
          <div className="sidebar-foot"><Cpu size={15} /><div><strong>{status?.model || 'claude-opus-5-5'}</strong><span>Persistent managed sessions</span></div></div>
        </aside>

        <main className="conversation-panel">
          {selectedAgent ? <>
            <div className="conversation-header">
              <div><div className="agent-title-row"><h1>{selectedAgent.name}</h1><span className={`session-state ${running ? 'running' : ''}`}><span />{running ? 'Running' : session?.status || 'Idle'}</span></div><p><span className="mono">{selectedAgent.key}</span><span className="divider">/</span>{selectedAgent.model}</p></div>
              <div className="conversation-actions">
                <button className="button secondary compact" onClick={() => { void loadConversation(selectedAgent.key); void refreshAgents(); }} disabled={conversationLoading}><RefreshCw size={15} className={conversationLoading ? 'spin' : ''} /><span>Refresh</span></button>
                {running && <button className="button secondary compact" onClick={() => void interrupt()}><CircleStop size={15} /><span>Interrupt</span></button>}
                <button className="icon-button" title="Reset conversation, keep memory" aria-label="Reset conversation, keep memory" onClick={() => void resetSession()} disabled={running}><RotateCcw size={16} /></button>
              </div>
            </div>
            <div className="timeline-scroll">
              {conversationLoading && !events.length ? <div className="conversation-empty"><RefreshCw className="spin" size={24} /><p>Restoring session history…</p></div> : <EventTimeline events={events} running={running} confirming={confirming} onConfirm={(eventId, result) => void confirmTool(eventId, result)} />}
              <div ref={timelineEndRef} />
            </div>
            <div className="composer-wrap">
              <div className={`composer ${running ? 'disabled' : ''}`}>
                <textarea aria-label="Message the sticky agent" placeholder={running ? 'Agent is working…' : 'Describe the next milestone…'} value={composer} onChange={(event) => setComposer(event.target.value)} disabled={running} rows={3} onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
                }} />
                <div className="composer-bottom"><span><BookOpen size={14} />Memory attached<span className="enter-hint"><span className="composer-separator">·</span><kbd>Enter</kbd> to send</span></span><button className="send-button" aria-label="Send message" onClick={() => void send()} disabled={running || !composer.trim()}>{running ? <Activity size={18} className="pulse" /> : <ArrowUp size={19} />}</button></div>
              </div>
            </div>
          </> : <div className="welcome-state">
            <div className="welcome-symbol"><Network size={38} strokeWidth={1.3} /></div>
            <span className="section-label">Long-running agents, without amnesia</span>
            <h1>Build the team once.<br />Resume the work anytime.</h1>
            <p>AgentRelay gives every developer agent a stable API identity, a persistent managed session, and project memory that survives conversation resets.</p>
            <button className="button primary large" onClick={() => setNewAgentOpen(true)}><Plus size={17} />Create your first sticky agent</button>
            <div className="welcome-facts"><span><Check size={15} />Local loopback API</span><span><Check size={15} />Session spend caps</span><span><Check size={15} />Versioned project memory</span></div>
          </div>}
        </main>

        <aside className="inspector-panel">
          <div className="inspector-tabs" role="tablist" aria-label="Agent details">
            <button role="tab" aria-selected={inspectorTab === 'memory'} className={inspectorTab === 'memory' ? 'active' : ''} onClick={() => setInspectorTab('memory')}>Memory</button>
            <button role="tab" aria-selected={inspectorTab === 'session'} className={inspectorTab === 'session' ? 'active' : ''} onClick={() => setInspectorTab('session')}>Session</button>
            <button role="tab" aria-selected={inspectorTab === 'api'} className={inspectorTab === 'api' ? 'active' : ''} onClick={() => setInspectorTab('api')}>API</button>
          </div>
          {!selectedAgent ? <div className="inspector-empty"><Database size={25} /><p>Select an agent to inspect its memory, session, and integration API.</p></div> : <>
            {inspectorTab === 'memory' && <MemoryPanel agentKey={selectedAgent.key} refreshToken={memoryRefresh} />}
            {inspectorTab === 'session' && <section className="session-panel">
              <div className="usage-block"><span className="section-label">Current spend</span><strong>{money(session?.usage?.list_cost?.amount || 0)}</strong><span>of {money(selectedAgent.budgetCents)} session cap</span></div>
              <dl className="details-list">
                <div><dt>Status</dt><dd>{session?.status || 'Unknown'}</dd></div>
                <div><dt>Input tokens</dt><dd>{Number(session?.usage?.input_tokens || 0).toLocaleString()}</dd></div>
                <div><dt>Output tokens</dt><dd>{Number(session?.usage?.output_tokens || 0).toLocaleString()}</dd></div>
                <div><dt>Active time</dt><dd>{Math.round(session?.usage?.active_seconds || 0)} sec</dd></div>
              </dl>
              <div className="id-list">
                {[['Session', selectedAgent.sessionId], ['Agent', selectedAgent.remoteAgentId], ['Memory store', selectedAgent.memoryStoreId], ['Environment', selectedAgent.environmentId]].map(([label, value]) => <button key={label} onClick={() => value && void copy(value, `${label} ID copied.`)}><span>{label}</span><code>{shortId(value)}</code><Clipboard size={13} /></button>)}
              </div>
              <div className="session-note"><RotateCcw size={16} /><p>Resetting archives this conversation and starts another with the same memory store.</p></div>
            </section>}
            {inspectorTab === 'api' && <section className="api-panel">
              <div><span className="section-label">Sticky endpoint</span><p>Other agents reuse the same URL. AgentRelay resolves the persisted session on every call.</p></div>
              <div className="code-block"><button className="icon-button" aria-label="Copy API example" title="Copy API example" onClick={() => void copy(curlExample, 'API example copied.')}><Clipboard size={14} /></button><pre>{curlExample}</pre></div>
              <div className="api-flow"><div><span>01</span><p>Send a message to the sticky key.</p></div><div><span>02</span><p>Poll <code>GET /events</code> for history.</p></div><div><span>03</span><p>Read or edit durable notes at <code>/memories</code>.</p></div></div>
              <a className="docs-link" href="https://platform.claude.com/docs/en/managed-agents/quickstart" target="_blank" rel="noreferrer">Managed Agents documentation <ArrowUp size={14} /></a>
            </section>}
          </>}
        </aside>
      </div>
      <NewAgentDialog open={newAgentOpen} onOpenChange={setNewAgentOpen} onCreate={createAgent} />
      <Toaster theme="dark" position="bottom-right" closeButton toastOptions={{ className: 'relay-toast' }} />
    </div>
  );
}
