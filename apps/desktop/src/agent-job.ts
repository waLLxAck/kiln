import { useEffect, useState } from 'react';
import type { AgentJob, AgentJobSummary } from '../../../packages/agent/service';
import { activeRun } from '../../../packages/agent/run-notice';
import { jobSignature } from '../../../packages/agent/job-summary';
import { api } from './api';

/** A run as a list gives it: a summary from `agent.jobs`, or a full record from `agent.job` or `agent.chatHistory`. */
export type JobLike = AgentJob | AgentJobSummary;
export const isFullJob = (job: JobLike): job is AgentJob => 'steps' in job;
/** How often an open run's full record is read again while it runs. */
const POLL_MS = 1000;

/**
 * The full record (steps and result) behind a run that is on screen. A summary is read with `agent.job` whenever it changes and every
 * second while the run is active; a full record is returned as it is. `full` is the last record read for this run, so the steps never
 * blink while a newer one loads; `settled` turns true once a read has answered or failed.
 */
export function useAgentJobRead(job: JobLike | undefined): { full?: AgentJob; settled: boolean } {
  const given = job && isFullJob(job) ? job : undefined;
  const [read, setRead] = useState<{ id: string; full?: AgentJob }>();
  const key = job && !given ? jobSignature(job) : '', active = Boolean(job && activeRun(job));
  useEffect(() => {
    if (!key || !job) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => void api<AgentJob>('agent.job', { id: job.id }).then(full => { if (live) setRead({ id: job.id, full }); }, () => { if (live) setRead(current => current?.id === job.id ? current : { id: job.id }); }).finally(() => { if (live && active) timer = setTimeout(load, POLL_MS); });
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [key]);
  if (given) return { full: given, settled: true };
  return read && read.id === job?.id ? { full: read.full, settled: true } : { settled: false };
}
/** The full record behind a run on screen, or nothing until it is read. See `useAgentJobRead`. */
export const useAgentJob = (job: JobLike | undefined) => useAgentJobRead(job).full;
