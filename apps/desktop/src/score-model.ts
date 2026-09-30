import type { Item, Score, ScoreImprovement, ScoreSummary } from '../../../packages/protocol/schema';

/** Pure pieces of Score and Tune for the item page, the library and tests: staleness, tone and the Apply improvements message. */

/** A score says something about the current revision only when it scored that revision; otherwise it is stale. */
export const scoreStale = (score: Pick<ScoreSummary, 'revision'>, item: Pick<Item, 'revision'>) => score.revision !== item.revision;
/** good 80+, fair 55 to 79, poor below: the badge colour. */
export const scoreTone = (score: number) => score >= 80 ? 'good' : score >= 55 ? 'fair' : 'poor';
export const severityOrder: Record<ScoreImprovement['severity'], number> = { high: 0, medium: 1, low: 2 };
/** Improvements most severe first, then by line, keeping each one's index in the record so selections survive the sort. */
export const sortedImprovements = (score: Score) => score.improvements.map((improvement, index) => ({ improvement, index })).sort((a, b) => severityOrder[a.improvement.severity] - severityOrder[b.improvement.severity] || (a.improvement.line ?? 1e9) - (b.improvement.line ?? 1e9));

/**
 * What Apply improvements types into the item chat: the chosen improvements, each with its line and suggestion, and the rule
 * that the change is a new draft revision made through Kiln's CLI (the chat path), so the approved revision stays as it is.
 */
export function applyMessage(item: Pick<Item, 'kind' | 'revision'>, score: Score, chosen: number[]) {
  const picked = chosen.map(i => score.improvements[i]).filter(Boolean);
  const stale = scoreStale(score, item);
  return [
    `Please apply ${picked.length === 1 ? 'this improvement' : `these ${picked.length} improvements`} from Kiln’s writing-for-agents score (${score.score}/100) to this ${item.kind}. Save the result as a new revision with Kiln’s CLI, then tell me what you changed.${stale ? ' The score was of an earlier revision, so check each one still applies and skip any that no longer do.' : ''}`,
    '',
    ...picked.flatMap((p, n) => [`${n + 1}. ${p.title} (${p.severity}${p.line ? `, line ${p.line}` : ''})`, `   Why: ${p.why}`, `   Suggestion: ${p.suggestion}`]),
  ].join('\n');
}
