import { Bot, Check, CircleAlert, Code2, Terminal, User, Wrench, X } from 'lucide-react';
import type { RelayEvent } from '@/types/relay';

interface Props {
  events: RelayEvent[];
  running: boolean;
  confirming: string | null;
  onConfirm: (eventId: string, result: 'allow' | 'deny') => void;
}

const textOf = (event: RelayEvent) => (event.content || []).map((block) => block.text || '').join('').trim();
const timeOf = (event: RelayEvent) => event.processed_at ? new Date(event.processed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const toolInput = (event: RelayEvent) => {
  const raw = JSON.stringify(event.input || {}, null, 2);
  return raw.length > 5000 ? `${raw.slice(0, 5000)}\n…` : raw;
};

function ToolEvent({ event, confirming, onConfirm }: { event: RelayEvent; confirming: string | null; onConfirm: Props['onConfirm'] }) {
  const needsApproval = event.evaluated_permission === 'ask';
  return (
    <article className={`tool-event ${needsApproval ? 'needs-approval' : ''}`}>
      <div className="tool-heading">
        <span className="tool-icon">{event.name === 'bash' ? <Terminal size={15} /> : <Wrench size={15} />}</span>
        <strong>{event.name || event.type}</strong>
        <span className="event-kind">tool call</span>
        {needsApproval && <span className="approval-label">Approval required</span>}
      </div>
      <pre>{toolInput(event)}</pre>
      {needsApproval && event.id && (
        <div className="approval-actions">
          <button className="button approve" disabled={confirming === event.id} onClick={() => onConfirm(event.id!, 'allow')}><Check size={15} />Allow once</button>
          <button className="button deny" disabled={confirming === event.id} onClick={() => onConfirm(event.id!, 'deny')}><X size={15} />Deny</button>
        </div>
      )}
    </article>
  );
}

export function EventTimeline({ events, running, confirming, onConfirm }: Props) {
  const visible = events.filter((event) => [
    'user.message', 'agent.message', 'agent.tool_use', 'agent.custom_tool_use',
    'agent.mcp_tool_use', 'agent.tool_result', 'agent.mcp_tool_result', 'session.error',
  ].includes(event.type));
  if (!visible.length) {
    return (
      <div className="conversation-empty">
        <Code2 size={28} strokeWidth={1.5} />
        <h2>Give this agent its first milestone.</h2>
        <p>The conversation resumes in place. Reusable decisions are written to the attached memory store for future sessions.</p>
      </div>
    );
  }
  return (
    <div className="timeline-list">
      {visible.map((event, index) => {
        const key = event.id || `${event.type}-${index}`;
        if (event.type === 'user.message') return (
          <article className="message user-message" key={key}>
            <div className="message-avatar"><User size={16} /></div>
            <div className="message-body"><div className="message-meta"><strong>You</strong><span>{timeOf(event)}</span></div><p>{textOf(event)}</p></div>
          </article>
        );
        if (event.type === 'agent.message') return (
          <article className="message agent-message" key={key}>
            <div className="message-avatar"><Bot size={16} /></div>
            <div className="message-body"><div className="message-meta"><strong>Agent</strong><span>{timeOf(event)}</span></div><p>{textOf(event)}</p></div>
          </article>
        );
        if (event.type.includes('tool_use')) return <ToolEvent key={key} event={event} confirming={confirming} onConfirm={onConfirm} />;
        if (event.type.includes('tool_result')) return (
          <details className="tool-result" key={key}>
            <summary>Tool result {event.is_error ? '· error' : ''}</summary>
            <pre>{textOf(event).slice(0, 6000) || 'No text output'}</pre>
          </details>
        );
        return <div className="session-error" key={key}><CircleAlert size={17} /><span>{event.error?.message || 'The session reported an error.'}</span></div>;
      })}
      {running && <div className="working-indicator"><span /><span /><span />Agent is working</div>}
    </div>
  );
}
