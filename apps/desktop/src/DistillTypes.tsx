import { ScanSearch } from 'lucide-react';
import { entryTypeInfo, entryTypes, selectedEntryTypes, type EntryType } from '../../../packages/agent/distill';
import type { Settings } from '../../../packages/protocol/schema';
import { api } from './api';

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Settings → Distillation: which entry types Analyze and Distill ask the agent for. One checkbox per type in `entryTypes`, so new types appear here by themselves; the last one checked cannot be cleared. */
export function DistillTypesSettings({ settings, perform, refresh }: { settings: Settings; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void> }) {
  const on = selectedEntryTypes(settings);
  const set = (type: EntryType, checked: boolean) => void perform(async () => { await api('settings.distill', { types: checked ? [...on, type] : on.filter(t => t !== type) }); await refresh(); });
  return <section className="settings-card distill-types"><div className="section-heading"><h3><ScanSearch size={18} />Distillation</h3></div>
    <p>What analyzing a source asks your agent for. Other material is left out and noted as skipped.</p>
    {entryTypes.map(type => { const checked = on.includes(type), last = checked && on.length === 1; return <label key={type} className="check-row" title={last ? 'Keep at least one type' : undefined}>
      <input type="checkbox" checked={checked} disabled={last} onChange={event => set(type, event.target.checked)} />
      <span><b>{capital(entryTypeInfo[type].plural)}</b> <span className="muted">{entryTypeInfo[type].hint}</span></span>
    </label>; })}
  </section>;
}
