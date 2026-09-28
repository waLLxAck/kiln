import { skillLocationLabel } from '../../../packages/providers/skill-locations';
import { providerName } from './components';
import type { Installation, Item, Snapshot } from '../../../packages/protocol/schema';

/** A copy's state in a few words; "update available" when Kiln's unchanged copy is behind the approved revision. */
export function installationLabel(i: Installation) {
  if (i.state === 'installed') return i.outdated ? 'update available' : 'installed by Kiln';
  if (i.state === 'drifted') return 'edited outside Kiln';
  if (i.linked) return 'linked folder';
  return i.matches ? 'identical copy, not managed' : 'differs from the approved version';
}
const within = (file: string, root: string) => file.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/').replace(/\/+$/, '') + '/');
/** The project a project copy is in: its own target, or for a folder Kiln doesn't manage there, a target of the same project. */
export const projectOf = (copy: Installation, snapshot: Snapshot) => copy.scope !== 'project' ? undefined : snapshot.targets.find(t => t.id === copy.targetId) ?? snapshot.targets.find(t => t.scope === 'project' && within(copy.destination, t.root));
/** Where a copy is: "Claude" for a personal folder; "Web app · Claude" in a project, since every project has its own folders. */
export function copyName(copy: Installation, snapshot: Snapshot, kind: Item['kind']) {
  const where = kind === 'agent' ? providerName[copy.provider] : copy.location ? skillLocationLabel[copy.location] : providerName[copy.provider];
  if (copy.scope !== 'project') return where;
  return `${projectOf(copy, snapshot)?.name ?? 'Project'} · ${where}`;
}
