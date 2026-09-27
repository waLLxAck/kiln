import type { AgentJob } from '../../../packages/agent/service';
import type { Trial } from '../../../packages/protocol/schema';

/**
 * Where each experiment ran, by trial id. Canonical trial records only say "machine-private"; the folder is in this
 * machine's job record, so runs from other machines (and manual handoffs) have no folder name here.
 */
export const trialPlaces = (jobs: AgentJob[]) => new Map(jobs.filter(j => j.kind === 'trial' && j.trialId).map(j => [j.trialId!, j.workspace ? j.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? j.workspace : 'Isolated example']));
export const trialPlace = (trial: Trial, places: Map<string, string>) => places.get(trial.id) ?? (trial.mode === 'manual' ? 'Manual handoff' : 'Unknown project');
