import type { Trial } from '../../../packages/protocol/schema';

/** The user's verdicts on agent experiments are separate manual trials that point at the experiment they judged (see Workbench.judgeTrial). */
export const reviewOf = (t: Trial) => t.outputReference.startsWith('review-of:') ? t.outputReference.slice('review-of:'.length) : null;
export const experimentsOf = (trials: Trial[]) => trials.filter(t => !reviewOf(t));
/** The newest human judgement of each experiment, by experiment id. */
export function reviews(trials: Trial[]) {
  const latest = new Map<string, Trial>();
  for (const t of trials) { const id = reviewOf(t); if (id && (!latest.get(id) || latest.get(id)!.createdAt < t.createdAt)) latest.set(id, t); }
  return latest;
}
/** The verdict that counts: the user's own judgement when there is one, else the experiment's. */
export const verdictOf = (t: Trial, judged: Map<string, Trial>) => judged.get(t.id)?.judgement ?? t.judgement;
