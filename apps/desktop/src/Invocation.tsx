import type { MouseEvent } from 'react';
import type { Item, SkillListing } from '../../../packages/protocol/schema';
import type { InvocationResult } from '../../../packages/domain/router';
import { updateMessage } from './InstallUpdates';
import './invocation.css';

/**
 * Whether a model may invoke a skill on its own, and the one-click switch that changes it (docs/SKILL_INVOCATION.md). The
 * switch edits the skill itself: `disable-model-invocation` in SKILL.md for Claude Code and Copilot, `agents/openai.yaml` for
 * Codex. An approved skill keeps its approval and Kiln's installed copies follow at once; a draft stays a draft.
 */
export type Invocation = 'model' | 'user' | 'mixed';
export const invocationOf = (listing: SkillListing): Invocation => listing.claude && listing.codex ? 'model' : !listing.claude && !listing.codex ? 'user' : 'mixed';
const words: Record<Invocation, string> = { model: 'Model & you', user: 'You only', mixed: 'Mixed' };
/** About four characters per token: what one skill's entry adds to each new session, for the tooltip. */
const cost = (listing: SkillListing) => `≈ ${Math.max(1, Math.round(listing.chars / 4))} tokens`;
export function invocationHint(listing: SkillListing) {
  const state = invocationOf(listing);
  if (state === 'model') return `Claude Code, Copilot and Codex may invoke it on their own, so its description (${cost(listing)}) loads in every new session. Click to make it you-only.`;
  if (state === 'user') return 'Only you can invoke it, by name (/name or $name). It adds nothing to new sessions. Click to let the model invoke it.';
  const model = [listing.claude && 'Claude Code and Copilot', listing.codex && 'Codex'].filter(Boolean).join(', ');
  const you = [!listing.claude && 'Claude Code and Copilot', !listing.codex && 'Codex'].filter(Boolean).join(', ');
  return `${model}: the model may invoke it (${cost(listing)} per session) · ${you}: you only. Click to make it you-only everywhere.`;
}

/**
 * The switch itself: "Model & you", "You only" or "Mixed" (the clients' flags differ). Clicking turns model invocation off,
 * or on again from "You only". Only live skills have one; everything else shows a dash in the library.
 */
export function InvocationToggle({ item, listing, onToggle, disabled = false, compact = false, note = '' }: { item: Item; listing?: SkillListing; onToggle: (item: Item, model: boolean) => void; disabled?: boolean; compact?: boolean; /** Added to the tooltip. */ note?: string }) {
  if (item.kind !== 'skill' || !listing) return <span className="faint" title="Only skills have a model-invocation switch">—</span>;
  const state = invocationOf(listing);
  const click = (event: MouseEvent) => { event.stopPropagation(); onToggle(item, state === 'user'); };
  return <button type="button" className={`inv-toggle ${state} ${compact ? 'compact' : ''}`} aria-pressed={state === 'model' ? true : state === 'user' ? false : 'mixed'}
    aria-label={`Model can invoke ${item.title}`} title={[invocationHint(listing), note].filter(Boolean).join(' ')} disabled={disabled || Boolean(item.deletedAt)} onClick={click} onKeyDown={event => event.stopPropagation()}>
    <i className="inv-switch" aria-hidden="true" /><span>{words[state]}</span>
  </button>;
}

/** What turning model invocation on or off did, for the toast. */
export function invocationMessage(result: InvocationResult, /** An earlier revision is approved, so installed copies keep that one. */ earlier = false) {
  const turned = result.invocation.claude || result.invocation.codex ? 'on' : 'off';
  if (!result.changed) return `${result.title}: model invocation is already ${turned}.`;
  if (result.approval === 'draft') return `${result.title}: model invocation turned ${turned} in a new draft revision.${earlier ? ' Installed copies keep the approved revision until you approve it.' : ''}`;
  const update = result.update ? updateMessage('', { ...result.update, approved: false }, true) : 'New agent sessions pick up the change.';
  return `${result.title}: model invocation turned ${turned}; approval carried over, as only the flag changed. ${update}`;
}
