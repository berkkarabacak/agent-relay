import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, LoaderCircle, X } from 'lucide-react';
import type { NewAgentInput } from '@/types/relay';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewAgentInput) => Promise<void>;
}

const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export function NewAgentDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState('Game Director');
  const [key, setKey] = useState('game-director');
  const [keyEdited, setKeyEdited] = useState(false);
  const [project, setProject] = useState('Build a GTA-scale open-world game with a playable, tested vertical slice.');
  const [model, setModel] = useState('claude-opus-5-5');
  const [toolPolicy, setToolPolicy] = useState('auto');
  const [budget, setBudget] = useState(10);
  const [system, setSystem] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (!keyEdited) setKey(slugify(name)); }, [name, keyEdited]);
  useEffect(() => { if (open) setError(''); }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (key.length < 2 || !name.trim() || budget < 0) {
      setError('Enter a name, a valid sticky key, and a non-negative budget.');
      return;
    }
    setBusy(true);
    try {
      await onCreate({ key, name: name.trim(), model, toolPolicy, budgetCents: Math.round(budget * 100), project, system: system || undefined });
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the agent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" onClick={() => !busy && onOpenChange(false)} />
        <Dialog.Content className="dialog-content" onEscapeKeyDown={(event) => busy && event.preventDefault()}>
          <div className="dialog-heading">
            <div>
              <Dialog.Title>New sticky agent</Dialog.Title>
              <Dialog.Description>One identity, one live session, one durable project memory.</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close dialog" disabled={busy}><X size={18} /></Dialog.Close>
          </div>
          <form onSubmit={submit} className="agent-form">
            <div className="form-grid">
              <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required autoFocus /></label>
              <label>Sticky key<input className="mono" value={key} onChange={(event) => { setKeyEdited(true); setKey(slugify(event.target.value)); }} pattern="[a-z0-9][a-z0-9-]{1,47}" required /></label>
            </div>
            <label>Project objective<textarea value={project} onChange={(event) => setProject(event.target.value)} rows={3} required /></label>
            <div className="form-grid three">
              <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}><option value="claude-opus-5-5">Opus 5.5</option><option value="claude-sonnet-5-5">Sonnet 5.5</option></select></label>
              <label>Tool policy<select value={toolPolicy} onChange={(event) => setToolPolicy(event.target.value)}><option value="auto">Smart review</option><option value="always_ask">Always ask</option><option value="always_allow">Autonomous</option></select></label>
              <label>Session cap (USD)<input type="number" min="0" max="1000" step="1" value={budget} onChange={(event) => setBudget(Number(event.target.value))} required /></label>
            </div>
            <label>Custom system prompt <span className="optional">optional</span><textarea value={system} onChange={(event) => setSystem(event.target.value)} rows={3} placeholder="Leave blank to use the long-running game development prompt." /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Dialog.Close className="button secondary" disabled={busy}>Cancel</Dialog.Close>
              <button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{busy ? 'Provisioning…' : 'Create agent'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
