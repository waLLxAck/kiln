import { useCallback, useEffect, useState } from 'react';
import type { AgentJob } from '../../../packages/agent/service';
import type { KnownProject, ProjectSource } from '../../../packages/deployment/projects';
import { api } from './api';

export type { KnownProject };
export const sourceLabel: Record<ProjectSource, string> = { installs: 'installs', experiments: 'experiments', config: 'config files' };
/**
 * Every project folder Kiln knows on this machine, one entry per folder, most recently used first: folders skills are installed
 * into, folders experiments ran in, and Config files projects. Shared by Install into project and the Test dialog's project picker,
 * so a folder used for one is offered for the other. Does nothing while `enabled` is false.
 */
export function useKnownProjects(enabled: boolean) {
  const [projects, setProjects] = useState<KnownProject[] | null>(null), [error, setError] = useState('');
  const reload = useCallback(async () => {
    if (!enabled) { setProjects(null); return; }
    try {
      const jobs = await api<AgentJob[]>('agent.jobs');
      const recent = jobs.filter(job => job.kind === 'trial' && job.workspace).map(job => ({ path: job.workspace!, at: job.startedAt }));
      setProjects(await api<KnownProject[]>('projects.known', { recent })); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [enabled]);
  useEffect(() => { void reload(); }, [reload]);
  return { projects, error, reload };
}
