import type { Installation, Item, ItemDetail } from '../../../packages/protocol/schema';
import { experimentsOf, reviews, verdictOf } from './trial-verdicts';

/**
 * Leading YAML front-matter (`---` … `---`) as ordered key/value pairs plus the body after it. Only the flat `key: value`
 * shape SKILL.md and agent files use is read; indented or continued lines join the value before them, so nothing is
 * dropped from the table even when the YAML is richer than that.
 */
export function splitFrontMatter(text: string): { properties: [string, string][]; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { properties: [], body: text };
  const properties: [string, string][] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w.-]*)\s*:(.*)$/.exec(line);
    if (pair) properties.push([pair[1], pair[2].trim()]);
    else if (line.trim() && properties.length) { const last = properties[properties.length - 1]; last[1] = `${last[1]} ${line.trim()}`.trim(); }
  }
  return { properties, body: text.slice(match[0].length) };
}

export type PrimaryAction = 'restore' | 'open-original' | 'analyze' | 'resolve' | 'test' | 'approve' | 'approve-install' | 'approve-update-installs' | 'update-installs' | 'install' | 'open-link' | 'open-file' | 'copy';

/** Kinds that are used by copying their text into a session. */
const copied = (item: Item) => !['skill', 'agent', 'instruction', 'link', 'file', 'image', 'reference', 'source'].includes(item.kind);
export const firstLineIsUrl = (content: string) => /^https?:\/\/\S+$/i.test(content.trim().split('\n')[0]);

/** Copies Kiln installed, unchanged since, that are behind the approved revision: what Update installs writes over. */
export const outdatedCopies = (itemId: string, installations: Installation[]) => installations.filter(copy => copy.itemId === itemId && copy.state === 'installed' && copy.outdated);

/**
 * The one step the header offers as its primary button, from the item's state. Everything else stays in the ⋯ menu.
 * Changed copies come first because they are a problem on disk; then an untested draft is tested, a passing draft is
 * approved (and installed, for a skill nobody has installed, or its installed copies updated to it), copies behind the
 * approved revision are updated, and a finished item is used: copied, opened or installed.
 */
export function primaryAction({ detail, installations, locations }: { detail: ItemDetail; installations: Installation[]; /** Configured install locations on this machine. */ locations: number }): PrimaryAction {
  const { item, revision } = detail;
  if (item.deletedAt) return 'restore';
  if (item.kind === 'source') return firstLineIsUrl(revision.content) ? 'open-original' : 'analyze';
  if (item.kind === 'link' || (['tool', 'resource'].includes(item.kind) && firstLineIsUrl(revision.content))) return 'open-link';
  if (['file', 'image', 'reference'].includes(item.kind)) return 'open-file';
  const copies = installations.filter(copy => copy.itemId === item.id);
  const installable = ['skill', 'agent'].includes(item.kind);
  if (installable && copies.some(copy => copy.state === 'drifted')) return 'resolve';
  const approved = detail.approvals.some(a => a.revision === item.revision && a.trust === 'local');
  const finished = experimentsOf(detail.trials).filter(t => t.revision === item.revision && t.status === 'completed');
  // Your own verdict on an experiment counts over the agent's.
  const judged = reviews(detail.trials), passed = finished.some(t => verdictOf(t, judged) === 'pass');
  if (!approved && !['archived', 'rejected'].includes(item.status)) {
    if (passed) return installable && copies.some(copy => copy.state === 'installed') ? 'approve-update-installs' : installable && !copies.length && locations > 0 ? 'approve-install' : 'approve';
    // A prompt is used by copying it, tested or not; everything else is tested before it is trusted.
    if (!copied(item)) return 'test';
  }
  if (installable && outdatedCopies(item.id, copies).length) return 'update-installs';
  if (installable && !copies.length && locations > 0) return approved ? 'install' : 'approve-install';
  return 'copy';
}

/** Changed copies, as the header says it: "Resolve 1 changed copy". */
export const changedCopiesLabel = (count: number) => `Resolve ${count} changed ${count === 1 ? 'copy' : 'copies'}`;
/** Outdated copies, as the header says it: "Update installs (2)". */
export const updateInstallsLabel = (count: number) => `Update installs (${count})`;
