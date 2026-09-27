import type { AgentJob } from '../../../packages/agent/service';
import type { ItemDetail, Provider, Snapshot, Trial } from '../../../packages/protocol/schema';

export type ExperimentsGridProps = {
  detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; jobs: AgentJob[];
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>;
  /** The item page's actions: 'approve', 'trial' (the full run dialog), 'manual-trial', 'result' (record a manual result), 'delete-trial'. */
  onAction: (name: string, trial?: Trial) => void;
};
/** An item's experiments as a revision × project grid with a verdict-first result panel. */
export function ExperimentsGrid(_props: ExperimentsGridProps) { return null; }
