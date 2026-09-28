/**
 * Machines' filter: state chips (the matrix legend), a name filter, and which kind and columns to show. Kept free of React so
 * it can be tested. Chosen states combine with OR: a row stays when any of its shown cells is in one of them. The name,
 * kind, model-invocation and column filters narrow rows first, so each chip's count says what it would show among them.
 */
import { z } from 'zod';
import type { CellState } from '../../../packages/fleet/model';

/** Every cell state, in the order the chips show them. */
export const cellStates = ['installed', 'changed', 'outdated', 'external', 'marked', 'off', 'unavailable'] as const satisfies readonly CellState[];
/** The Needs attention preset: copies someone should look at on this machine. */
export const attention: CellState[] = ['changed', 'outdated', 'external'];

export type KindFilter = 'all' | 'skill' | 'agent';
export type ColumnFilter = 'all' | 'personal' | 'projects';
/** Skills a model may invoke on its own (`model`, as the library's `is:model-invoked`) or only you can (`user`). */
export type InvocationFilter = 'all' | 'model' | 'user';
export type MachinesFilter = { states: CellState[]; text: string; kind: KindFilter; columns: ColumnFilter; invocation: InvocationFilter };
export const noFilter: MachinesFilter = { states: [], text: '', kind: 'all', columns: 'all', invocation: 'all' };

/** Keeps states known, unique and in chip order, so the same choice always reads the same way. */
const ordered = (states: readonly string[]) => cellStates.filter(s => states.includes(s));
export const filterSchema: z.ZodType<MachinesFilter> = z.object({
  states: z.array(z.string()).catch([]).transform(ordered),
  text: z.string().max(200).catch(''),
  kind: z.enum(['all', 'skill', 'agent']).catch('all'),
  columns: z.enum(['all', 'personal', 'projects']).catch('all'),
  invocation: z.enum(['all', 'model', 'user']).catch('all'),
});

/** Which quick preset the chosen states are, if any. */
export function preset(filter: MachinesFilter): 'all' | 'attention' | null {
  if (!filter.states.length) return 'all';
  return filter.states.length === attention.length && attention.every(s => filter.states.includes(s)) ? 'attention' : null;
}
export const toggleState = (filter: MachinesFilter, state: CellState): MachinesFilter =>
  ({ ...filter, states: ordered(filter.states.includes(state) ? filter.states.filter(s => s !== state) : [...filter.states, state]) });

/** Drops the kind, column or invocation choice when the view has nothing to choose between, so a stale choice can't hide every row. */
export const applicable = (filter: MachinesFilter, choices: { kinds: boolean; columns: boolean; invocation?: boolean }): MachinesFilter =>
  ({ ...filter, kind: choices.kinds ? filter.kind : 'all', columns: choices.columns ? filter.columns : 'all', invocation: choices.invocation ? filter.invocation : 'all' });
export const isFiltered = (filter: MachinesFilter) => filter.states.length > 0 || filter.text.trim() !== '' || filter.kind !== 'all' || filter.columns !== 'all' || filter.invocation !== 'all';
export const showsColumn = (columns: ColumnFilter, project: boolean) => columns === 'all' || (columns === 'projects') === project;

/** Every word typed appears in the title, ignoring case. */
export function matchesText(title: string, text: string) {
  const lower = title.toLocaleLowerCase();
  return text.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => lower.includes(word));
}

/** One matrix row: the item's title and kind, the states of its shown cells (on every shown machine), and for a skill who may invoke it. */
export type FilterRow = { title: string; kind: string; states: CellState[]; invocation?: 'model' | 'user' | 'mixed' };
const invoked = (row: FilterRow, filter: MachinesFilter) => filter.invocation === 'all' || (filter.invocation === 'user' ? row.invocation === 'user' : row.invocation === 'model' || row.invocation === 'mixed');
const narrowed = (row: FilterRow, filter: MachinesFilter) => (filter.kind === 'all' || row.kind === filter.kind) && invoked(row, filter) && matchesText(row.title, filter.text);
const anyOf = (row: FilterRow, states: CellState[]) => !states.length || row.states.some(s => states.includes(s));
export const rowMatches = (row: FilterRow, filter: MachinesFilter) => narrowed(row, filter) && anyOf(row, filter.states);

/** Cells in each state, and rows for the two presets, among the rows the name and kind filters keep. */
export function counts(rows: FilterRow[], filter: MachinesFilter) {
  const states = Object.fromEntries(cellStates.map(s => [s, 0])) as Record<CellState, number>;
  let all = 0, needsAttention = 0;
  for (const row of rows) {
    if (!narrowed(row, filter)) continue;
    all++;
    if (anyOf(row, attention)) needsAttention++;
    for (const state of row.states) states[state]++;
  }
  return { states, all, attention: needsAttention };
}
