import { FlaskRound } from 'lucide-react';
import { experimentOn, experiments, type ExperimentId } from '../../../packages/protocol/experiments';
import type { Snapshot } from '../../../packages/protocol/schema';

export { experimentOn };
/** Settings → Experimental features: one switch per flag in experiments.ts, all off until turned on on this machine. */
export function ExperimentsPanel({ settings, onChange }: { settings: Snapshot['settings']; onChange: (id: ExperimentId, enabled: boolean) => void }) {
  const on = experiments.filter(e => experimentOn(settings, e.id)).length;
  return <section className="settings-card experiments-card" aria-labelledby="experiments-heading">
    <div className="section-heading"><h3 id="experiments-heading"><FlaskRound size={18} />Experimental features</h3><span className="badge">{on ? `${on} on` : 'all off'}</span></div>
    <p>New changes to try one at a time before they become the default. Each switch applies to this machine only and takes effect straight away; turn it off to go back to how Kiln worked before.</p>
    <div className="experiment-list">{experiments.map(e => <label className="experiment-row" key={e.id}>
      <input type="checkbox" role="switch" aria-label={e.title} checked={experimentOn(settings, e.id)} onChange={event => onChange(e.id, event.target.checked)} />
      <span><b>{e.title}</b><small>{e.description}</small></span>
    </label>)}</div>
  </section>;
}
