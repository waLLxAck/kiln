import type { AgentJob } from '../../../packages/agent/service';
import type { ItemDetail, Provider, Snapshot, Trial } from '../../../packages/protocol/schema';

export type SourcePageProps = {
  detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; jobs: AgentJob[];
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>;
  /** Opens another item (an entry made from this source). */
  onSelect: (id: string) => void;
  /** Shows the library filtered to what was made from this source. */
  onMadeFrom: (sourceId: string) => void;
  onCollection: (name: string) => void;
  /** The item page's actions, e.g. 'analyze' (analyze again), 'edit'. */
  onAction: (name: string, trial?: Trial) => void;
};
/** The page for a source (a video, page, pasted chat or files an analysis read), built around what was made from it. */
export function SourcePage(_props: SourcePageProps) { return null; }
