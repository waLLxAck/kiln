import { skillLocationLabel } from '../../../packages/providers/skill-locations';
import { FileDiff, PackageCheck, Trash2 } from 'lucide-react';
import { Badge, providerName } from './components';
import type { Installation, Snapshot } from '../../../packages/protocol/schema';
export function installationLabel(i: Installation) {
  if (i.state === 'installed') return 'installed by Kiln';
  if (i.state === 'drifted') return 'edited outside Kiln';
  if (i.linked) return 'linked folder';
  return i.matches ? 'identical copy, not managed' : 'differs from the approved version';
}
export function Installations({ snapshot, installations, itemId, onUninstall, onCompare }: { snapshot: Snapshot; installations: Installation[]; itemId?: string; onUninstall: (id: string) => void; onCompare: (installation: Installation) => void }) {
  const items = installations.filter(i => !itemId || i.itemId === itemId);
  return <section className="content-section"><div className="section-heading"><h3><PackageCheck size={16} />{itemId ? 'Where this skill is installed' : 'Skill folders found in your environments'}</h3><span className="muted small">{items.length} folder{items.length === 1 ? '' : 's'}</span></div>{items.length ? <div className="installation-list">{items.map((i, n) => <div className="installation-row" key={`${i.itemId}-${i.targetId}-${n}`}><div><b>{snapshot.items.find(item => item.id === i.itemId)?.title}</b><p>{i.location ? skillLocationLabel[i.location] : snapshot.targets.find(t => t.id === i.targetId)?.name ?? providerName[i.provider]}</p><code className="path-text">{i.destination}</code></div><Badge status={i.state === 'installed' ? 'installed' : i.state === 'drifted' ? 'drifted' : i.matches ? 'found' : 'differs'} />{i.receiptId && i.state === 'installed' && <button className="button danger-text" onClick={() => onUninstall(i.receiptId!)}><Trash2 size={13} />Remove</button>}{i.targetId && (i.state === 'drifted' || !i.matches) && <button className="button" title="See which files differ and how" onClick={() => onCompare(i)}><FileDiff size={13} />Compare</button>}<span className="muted small">{installationLabel(i)}</span></div>)}</div> : <p className="muted small">No skill folders match library items in the enrolled environments.</p>}<p className="muted small">Folders are matched by skill name. “Identical copy” means the bytes equal your current library revision; Install lets Kiln take it over without rewriting anything.</p></section>;
}
