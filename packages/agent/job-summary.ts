import type { AgentJob, AgentStep } from './service';

/**
 * What `agent.jobs` lists about each run. The desktop polls it every second while anything runs, so it leaves out the parts that grow:
 * the steps and the bulk of the result. `agent.job { id }` returns the full record for the run that is open.
 */

/** The small fields of a run's result that list views, toasts and notifications show. Present when the run has a result. */
export type AgentResultSummary = { /** Experiments. */ judgement?: 'pass' | 'fail' | 'uncertain'; /** Score runs, out of 100. */ score?: number; /** Skill drafts: the drafted skill's name. */ name?: string };
/** A run without its steps (`stepCount` and `lastStep` stand in for them) and with only `AgentResultSummary` of its result. */
export type AgentJobSummary = Omit<AgentJob, 'steps' | 'result'> & { stepCount: number; lastStep?: AgentStep; result?: AgentResultSummary };

/** Lists show the first line of the last step; a streaming message can be thousands of characters. */
const LAST_STEP_TEXT = 500;

export function jobSummary(job: AgentJob): AgentJobSummary {
  const { steps, result, ...rest } = job, last = steps.at(-1), fields = result as Record<string, unknown> | undefined;
  return {
    ...rest, stepCount: steps.length,
    ...(last ? { lastStep: last.text.length > LAST_STEP_TEXT ? { ...last, text: last.text.slice(0, LAST_STEP_TEXT) + '…' } : last } : {}),
    ...(fields ? { result: {
      ...(fields.judgement === 'pass' || fields.judgement === 'fail' || fields.judgement === 'uncertain' ? { judgement: fields.judgement } : {}),
      ...(typeof fields.score === 'number' ? { score: fields.score } : {}),
      ...(typeof fields.name === 'string' ? { name: fields.name } : {}),
    } } : {}),
  };
}

/**
 * Changes whenever what a list shows about a run changes, for a full record and its summary alike: `id:status:phase:stepCount:lastActivityAt`.
 * Every provider event sets `lastActivityAt`, so a running job's signature moves with its steps.
 */
export const jobSignature = (job: AgentJob | AgentJobSummary) => `${job.id}:${job.status}:${job.phase}:${'steps' in job ? job.steps.length : job.stepCount}:${job.lastActivityAt ?? ''}`;
