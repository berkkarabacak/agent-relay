import { useCallback, useEffect, useState } from 'react';
import { FilePlus2, LoaderCircle, RefreshCw, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { relayApi } from '@/lib/relay';
import type { MemoryDocument } from '@/types/relay';

export function MemoryPanel({ agentKey, refreshToken }: { agentKey: string; refreshToken: number }) {
  const [memories, setMemories] = useState<MemoryDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const selected = memories.find((memory) => memory.id === selectedId) || null;

  const load = useCallback(async (preserveSelection = true) => {
    setLoading(true);
    try {
      const result = await relayApi.memories(agentKey);
      setMemories(result.memories);
      const nextId = preserveSelection && result.memories.some((memory) => memory.id === selectedId)
        ? selectedId : result.memories[0]?.id || null;
      setSelectedId(nextId);
      const next = result.memories.find((memory) => memory.id === nextId);
      setPath(next?.path || '');
      setContent(next?.content || '');
      setCreating(false);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load memory.');
    } finally {
      setLoading(false);
    }
  }, [agentKey, selectedId]);

  useEffect(() => { setSelectedId(null); void load(false); }, [agentKey, refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectMemory(memory: MemoryDocument) {
    setSelectedId(memory.id);
    setPath(memory.path);
    setContent(memory.content || '');
    setCreating(false);
  }

  async function save() {
    if (!path.startsWith('/')) return toast.error('Memory paths must start with /.');
    setSaving(true);
    try {
      if (creating) await relayApi.createMemory(agentKey, { path, content });
      else if (selected) await relayApi.updateMemory(agentKey, selected, path, content);
      else return;
      toast.success(creating ? 'Memory created.' : 'Memory saved with a new version.');
      await load(false);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not save memory.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected || !window.confirm(`Delete ${selected.path}? Its retained version history will remain.`)) return;
    setSaving(true);
    try {
      await relayApi.deleteMemory(agentKey, selected.id);
      toast.success('Memory deleted.');
      await load(false);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not delete memory.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="memory-panel">
      <div className="inspector-actions">
        <span>{memories.length} {memories.length === 1 ? 'document' : 'documents'}</span>
        <div>
          <button className="icon-button" aria-label="Refresh memories" title="Refresh memories" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
          <button className="icon-button" aria-label="New memory" title="New memory" onClick={() => { setCreating(true); setSelectedId(null); setPath('/notes/new-note.md'); setContent(''); }}><FilePlus2 size={16} /></button>
        </div>
      </div>
      <div className="memory-list">
        {memories.map((memory) => <button key={memory.id} className={selectedId === memory.id ? 'active' : ''} onClick={() => selectMemory(memory)}><span>{memory.path}</span><small>{memory.content_size_bytes} bytes</small></button>)}
        {!loading && !memories.length && !creating && <p className="muted-copy">No memories yet. Create one to seed this agent’s knowledge.</p>}
      </div>
      {(selected || creating) && <div className="memory-editor">
        <label>Path<input className="mono" value={path} onChange={(event) => setPath(event.target.value)} /></label>
        <label>Content<textarea className="mono" value={content} onChange={(event) => setContent(event.target.value)} rows={12} maxLength={102400} /></label>
        <div className="memory-save-row">
          {!creating && <button className="button danger-ghost" onClick={() => void remove()} disabled={saving}><Trash2 size={14} />Delete</button>}
          <button className="button primary small" onClick={() => void save()} disabled={saving || !path.trim()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{creating ? 'Create' : 'Save'}</button>
        </div>
      </div>}
    </section>
  );
}
