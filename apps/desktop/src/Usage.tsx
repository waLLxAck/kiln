import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, BarChart3, Download, Loader2, RefreshCw } from 'lucide-react';
import type { ItemUsage, SkillRow, UsageReport } from '../../../packages/usage/service';
import type { Price, PriceTable } from '../../../packages/usage/prices';
import { totalTokens } from '../../../packages/usage/prices';
import { api, date } from './api';
import { Empty } from './components';
import { dollars, filterSkills, lastUsed, nextSort, projectName, size, sortSkills, sortSpend, sortUnused, tokens, trend, unapproved, unmanaged, windowLabel, type SkillFilter, type SkillSortKey, type Sort, type SpendSortKey } from './usage-model';
import './usage.css';

type Props = {
  onOpenItem: (id: string) => void;
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>;
  refresh: () => Promise<void>;
};
type Tab = 'skills' | 'spend';
type Group = 'model' | 'project' | 'harness' | 'month' | 'kind' | 'item';
const windows = [7, 30, 90, 0];
const groups: { id: Group; label: string }[] = [{ id: 'model', label: 'Model' }, { id: 'project', label: 'Project' }, { id: 'harness', label: 'Harness' }, { id: 'month', label: 'Month' }, { id: 'kind', label: 'Kiln runs' }, { id: 'item', label: 'Kiln runs by item' }];
const harnessName = { claude: 'Claude', codex: 'Codex' } as const;
const priceFields: { key: keyof Price; label: string }[] = [{ key: 'input', label: 'Input' }, { key: 'cached', label: 'Cache read' }, { key: 'cacheWrite', label: 'Write 5m' }, { key: 'cacheWrite1h', label: 'Write 1h' }, { key: 'output', label: 'Output' }];
const remembered = (key: string, fallback: string) => localStorage.getItem(`kiln-usage-${key}`) ?? fallback;
const remember = (key: string, value: string) => localStorage.setItem(`kiln-usage-${key}`, value);

/** A column header that sorts; the arrow shows on the active column only. */
function Th<K extends string>({ id, sort, onSort, children, title, text = false }: { id: K; sort: Sort<K>; onSort: (key: K) => void; children: ReactNode; title?: string; text?: boolean }) {
  const active = sort.key === id;
  return <th className={text ? '' : 'num'} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className={`usage-sort ${active ? 'on' : ''}`} title={title} onClick={() => onSort(id)}>{children}{active && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button>
  </th>;
}
/** Daily uses as thin bars, one hue, zero days as a baseline tick; each bar says its day and count on hover. */
function Spark({ daily }: { daily: number[] }) {
  const max = Math.max(1, ...daily);
  return <span className="usage-spark" role="img" aria-label={`${daily.reduce((a, b) => a + b, 0)} uses in the last 30 days`}>
    {daily.map((n, i) => <span key={i} className={n ? 'on' : ''} style={{ height: n ? `${Math.max(18, (n / max) * 100)}%` : undefined }} title={`${new Date(Date.now() - (daily.length - 1 - i) * 86_400_000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${n}`} />)}
  </span>;
}

/**
 * Usage: which skills this machine's agents used and what the sessions cost, read from Claude Code's and Codex's own logs by the
 * backend worker (packages/usage). The first visit reads the logs in capped passes and asks again until done; later visits only
 * read what was added. Two tabs: Skills (uses, trend, last use, where; plus unmanaged, unapproved and installed-but-unused
 * filters) and Spend (tokens and estimated dollars by model, project, harness, month, and Kiln's own runs).
 */
export function UsageView({ onOpenItem, perform, refresh }: Props) {
  const [days, setDays] = useState(() => Number(remembered('days', '30')));
  const [tab, setTab] = useState<Tab>(() => remembered('tab', 'skills') as Tab);
  const [filter, setFilter] = useState<SkillFilter>('all');
  const [group, setGroup] = useState<Group>(() => remembered('group', 'model') as Group);
  const [skillSort, setSkillSort] = useState<Sort<SkillSortKey>>({ key: 'uses', dir: 'desc' });
  const [spendSort, setSpendSort] = useState<Sort<SpendSortKey>>({ key: 'cost', dir: 'desc' });
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [again, setAgain] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // One capped pass per request; while logs remain, ask again so the page fills in as they are read. Half a second apart while a
  // pass makes progress, backing off (to 10 s) while it does not, such as a log an agent keeps writing. A failed request leaves
  // the last report on screen with the error and a Retry; it is not asked again on its own.
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, delay = 500, pending = Infinity;
    const load = () => void api<UsageReport>('usage.report', { days }).then(next => {
      if (!active) return;
      setReport(next); setError('');
      if (next.scan.complete) return;
      delay = next.scan.pending < pending ? 500 : Math.min(delay * 2, 10_000); pending = next.scan.pending;
      timer = setTimeout(load, delay);
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    load();
    return () => { active = false; clearTimeout(timer); };
  }, [days, again]);
  const choose = <T extends string | number>(key: string, set: (v: T) => void) => (value: T) => { remember(key, String(value)); set(value); };

  const skills = useMemo(() => report ? sortSkills(filterSkills(report.skills, filter === 'unused' ? 'all' : filter), skillSort) : [], [report, filter, skillSort]);
  const spendRows = useMemo(() => {
    if (!report) return [];
    const s = report.spend, rows = { model: s.byModel, project: s.byProject, harness: s.byHarness, month: s.byMonth, kind: s.kiln.byKind, item: s.kiln.byItem }[group];
    return group === 'month' && spendSort.key === 'cost' && spendSort.dir === 'desc' ? rows : sortSpend(rows, spendSort);
  }, [report, group, spendSort]);
  if (!report) return error ? <div className="notice warning">{error}</div> : <div className="usage-loading"><Loader2 className="spin" size={16} />Reading session logs…</div>;

  const scan = report.scan, read = scan.bytes ? Math.round(((scan.bytes - scan.pending) / scan.bytes) * 100) : 100;
  const counts = { all: report.skills.length, unmanaged: report.skills.filter(unmanaged).length, unapproved: report.skills.filter(unapproved).length, unused: report.unused.length };
  const importSkill = (row: SkillRow) => void perform(async () => {
    const result = await api<{ imported: string[]; unchanged: string[]; failed: { error: string }[] }>('skills.importLocal', { paths: [row.folder], confirm: true });
    if (result.failed.length) throw new Error(result.failed[0].error);
    await refresh(); if (alive.current) setAgain(n => n + 1);
    if (result.imported[0]) onOpenItem(result.imported[0]);
  }, `Imported “${row.name}” as a draft`);

  const status = <span className="usage-scan muted small">{error && !scan.complete ? <>Reading session logs stopped at {read}%</> : scan.complete
    ? <>{scan.files.toLocaleString()} log{scan.files === 1 ? '' : 's'} · {size(scan.bytes)}{scan.scannedAt ? ` · read ${date(scan.scannedAt)}` : ''}</>
    : <><Loader2 className="spin" size={12} />Reading session logs… {read}%</>}</span>;
  const head = <div className="usage-bar">
    <div className="usage-tabs" role="tablist">{(['skills', 'spend'] as Tab[]).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => choose<Tab>('tab', setTab)(t)}>{t === 'skills' ? 'Skills' : 'Spend'}</button>)}</div>
    <div className="usage-windows" role="group" aria-label="Period">{windows.map(d => <button key={d} className={`chip ${days === d ? 'active' : ''}`} aria-pressed={days === d} onClick={() => choose<number>('days', setDays)(d)}>{d ? `${d} days` : 'All time'}</button>)}</div>
    {status}
    <button className="icon-button" aria-label="Read new log entries" title="Read what the agents logged since" onClick={() => setAgain(n => n + 1)}><RefreshCw size={15} /></button>
  </div>;

  const failed = error && <div className="notice warning" role="alert">Kiln could not read the session logs: {error} <button type="button" className="text-button" onClick={() => setAgain(n => n + 1)}>Retry</button></div>;
  if (!scan.files) return <>{head}{failed}<Empty icon={<BarChart3 size={30} />} title="No session logs on this machine yet.">Kiln reads Claude Code's logs in <code>{scan.roots.claude}</code> and Codex's in <code>{scan.roots.codex}</code>. They appear after your first session.</Empty></>;

  const skillTable = <table className="usage-table">
    <thead><tr>
      <Th id="title" sort={skillSort} onSort={k => setSkillSort(s => nextSort(s, k, ['title']))} text>Skill</Th>
      <Th id="uses" sort={skillSort} onSort={k => setSkillSort(s => nextSort(s, k, ['title']))} title={`Uses in the last ${windowLabel(days)}`}>Uses</Th>
      {days > 0 && <Th id="trend" sort={skillSort} onSort={k => setSkillSort(s => nextSort(s, k, ['title']))} title={`Against the ${days} days before`}>Trend</Th>}
      <th className="spark-col" title="Uses per day, last 30 days">30 days</th>
      <Th id="lastUsed" sort={skillSort} onSort={k => setSkillSort(s => nextSort(s, k, ['title']))}>Last used</Th>
      <Th id="activeDays" sort={skillSort} onSort={k => setSkillSort(s => nextSort(s, k, ['title']))} title="Days with at least one use">Days</Th>
      <Th id="projects" sort={skillSort} onSort={k => setSkillSort(s => nextSort(s, k, ['title']))}>Projects</Th>
      <Th id="cost" sort={skillSort} onSort={k => setSkillSort(s => nextSort(s, k, ['title']))} title="Attributed, not exact: each session's tokens split evenly among the skills used in it, priced at the estimate table">Attributed</Th>
      <th />
    </tr></thead>
    <tbody>{skills.map(row => <tr key={row.key}>
      <td className="usage-name">
        {row.itemId ? <button type="button" className="text-button" onClick={() => onOpenItem(row.itemId!)} title="Open in the library">{row.title}</button> : <b title={row.folder ?? undefined}>{row.name}</b>}
        {!row.itemId ? <span className="usage-tag warn" title="Used, but not in your library">not in library</span> : row.status !== 'approved' ? <span className="usage-tag" title="In your library, not approved">{row.status === 'captured' ? 'draft' : row.status}</span> : null}
        <span className="usage-where faint">{row.harnesses.map(h => harnessName[h]).join(' · ')}</span>
      </td>
      <td className="num" title={row.inferred ? `${row.inferred} inferred: the agent read its SKILL.md, not a skill invocation the log names` : `${row.total} all time`}>{row.uses}{row.inferred > 0 && <span className="usage-inferred" aria-label={`${row.inferred} inferred`}>{row.inferred === row.uses ? ' inferred' : ` (${row.inferred} inferred)`}</span>}</td>
      {days > 0 && <td className={`num trend ${row.uses > row.previous ? 'up' : row.uses < row.previous ? 'down' : ''}`}>{trend(row)}</td>}
      <td className="spark-col"><Spark daily={row.daily} /></td>
      <td className="num" title={row.lastUsed ? date(row.lastUsed) : undefined}>{lastUsed(row.lastUsed)}</td>
      <td className="num">{row.activeDays || ''}</td>
      <td className="num" title={row.projects.join('\n')}>{row.projects.length === 1 ? projectName(row.projects[0]) : row.projects.length || ''}</td>
      <td className="num" title={`≈ ${tokens(totalTokens(row.attributed))} tokens attributed`}>{row.attributedCost !== null ? `≈ ${dollars(row.attributedCost)}` : totalTokens(row.attributed) ? `≈ ${tokens(totalTokens(row.attributed))} tok` : ''}</td>
      <td className="usage-action">{row.importable && <button className="button small" onClick={() => importSkill(row)} title={`Import ${row.folder} into the library as a draft`}><Download size={13} />Import</button>}</td>
    </tr>)}</tbody>
  </table>;
  const unusedTable = <table className="usage-table">
    <thead><tr><th>Skill</th><th className="num">Copies here</th><th className="num">Last used</th></tr></thead>
    <tbody>{sortUnused(report.unused).map(row => <tr key={row.itemId}>
      <td className="usage-name"><button type="button" className="text-button" onClick={() => onOpenItem(row.itemId)}>{row.title}</button>{row.status !== 'approved' && <span className="usage-tag">{row.status === 'captured' ? 'draft' : row.status}</span>}</td>
      <td className="num">{row.copies}</td><td className="num">{lastUsed(row.lastUsed)}</td>
    </tr>)}</tbody>
  </table>;

  const spend = report.spend, s = spendSort, onSpend = (k: SpendSortKey) => setSpendSort(c => nextSort(c, k, ['label']));
  const top = Math.max(0, ...spendRows.map(r => r.cost ?? 0)), topTokens = Math.max(1, ...spendRows.map(r => totalTokens(r.tokens))), byCost = top > 0;
  const kilnGroup = group === 'kind' || group === 'item';
  const spendTable = <table className="usage-table">
    <thead><tr>
      <Th id="label" sort={s} onSort={onSpend} text>{groups.find(g => g.id === group)!.label.replace(' by item', '')}</Th>
      <Th id="count" sort={s} onSort={onSpend}>{kilnGroup ? 'Runs' : 'Sessions'}</Th>
      <Th id="input" sort={s} onSort={onSpend} title="Input tokens not read from a cache">Input</Th>
      <Th id="cached" sort={s} onSort={onSpend}>Cache read</Th>
      <Th id="write" sort={s} onSort={onSpend} title="Cache writes (5-minute and 1-hour)">Cache write</Th>
      <Th id="output" sort={s} onSort={onSpend} title="Output, reasoning included">Output</Th>
      <Th id="cost" sort={s} onSort={onSpend} title="Estimate at API list prices">Est. $</Th>
      <th className="share-col" aria-hidden="true" />
    </tr></thead>
    <tbody>{spendRows.map(row => <tr key={row.key}>
      <td className="usage-name" title={row.key}>{group === 'project' ? projectName(row.label) : group === 'kind' ? row.label.replace(/^\w/, c => c.toUpperCase()) : row.label}</td>
      <td className="num">{(kilnGroup ? row.runs : row.sessions) ?? ''}</td>
      <td className="num">{tokens(row.tokens.input)}</td><td className="num">{tokens(row.tokens.cached)}</td><td className="num">{tokens(row.tokens.cacheWrite + row.tokens.cacheWrite1h)}</td>
      <td className="num" title={row.tokens.reasoning ? `${tokens(row.tokens.reasoning)} of it reasoning` : undefined}>{tokens(row.tokens.output)}</td>
      <td className="num" title={row.unpriced ? `${tokens(row.unpriced)} tokens have no price in the table` : undefined}>{row.cost === null ? '—' : `${dollars(row.cost)}${row.unpriced ? '+' : ''}`}</td>
      <td className="share-col"><span className="usage-share"><span style={{ width: `${Math.max(1, (byCost ? (row.cost ?? 0) / top : totalTokens(row.tokens) / topTokens) * 100)}%` }} /></span></td>
    </tr>)}</tbody>
  </table>;

  return <div className="usage-page">
    {head}
    {failed}
    {tab === 'skills' ? <>
      <div className="usage-filters">{(['all', 'unmanaged', 'unapproved', 'unused'] as SkillFilter[]).map(f => <button key={f} className={`chip ${filter === f ? 'active' : ''}`} aria-pressed={filter === f} disabled={f !== 'all' && !counts[f]} onClick={() => setFilter(f)}
        title={f === 'unmanaged' ? 'Used, but not in your library' : f === 'unapproved' ? 'Used, in your library, not approved' : f === 'unused' ? `Installed on this machine, no use in the last ${windowLabel(days)}` : undefined}>
        {{ all: 'All', unmanaged: 'Not in library', unapproved: 'Not approved', unused: 'Installed, unused' }[f]}<span>{counts[f]}</span></button>)}</div>
      {filter === 'unused' ? (report.unused.length ? unusedTable : <p className="muted small">Every installed skill was used in the last {windowLabel(days)}.</p>)
        : skills.length ? skillTable : <p className="muted small">No skill use in these logs{days ? ` in the last ${days} days` : ''}.</p>}
      <p className="usage-note faint">From your own session logs, read on this machine and kept in its private folder. Claude Code logs each skill it loads; for Codex, a skill you named with $ is logged, and one the agent chose is <i>inferred</i> from it reading the SKILL.md.</p>
    </> : <>
      <div className="usage-summary">
        <b>{spend.total.cost === null ? '—' : `≈ ${dollars(spend.total.cost)}`}</b><span className="muted">estimated</span>
        <span>{tokens(totalTokens(spend.total.tokens))} tokens</span><span className="muted">{spend.total.sessions ?? 0} session{spend.total.sessions === 1 ? '' : 's'} · {windowLabel(days)}</span>
        {spend.kiln.total.runs ? <span className="muted">Kiln's runs {dollars(spend.kiln.total.cost)} ({spend.kiln.total.runs})</span> : null}
      </div>
      <div className="usage-filters">{groups.map(g => <button key={g.id} className={`chip ${group === g.id ? 'active' : ''}`} aria-pressed={group === g.id} onClick={() => choose<Group>('group', setGroup)(g.id)}>{g.label}</button>)}</div>
      {spendRows.length ? spendTable : <p className="muted small">{kilnGroup ? 'No Kiln agent runs with token counts in this period.' : 'No tokens logged in this period.'}</p>}
      <p className="usage-note faint">Dollar figures are estimates at API list prices{group === 'month' ? '; months are all time' : ''}. With a subscription (Claude Pro or Max, ChatGPT Plus or Pro) you pay a flat fee: this is what the same tokens would cost on the API. Tokens of models with no price are left out of the dollars (marked +). Kiln's own runs are also in the session logs when the CLI saved them.</p>
      <PriceEditor prices={report.prices} perform={perform} onSaved={() => setAgain(n => n + 1)} models={spend.byModel.map(r => r.key)} />
    </>}
  </div>;
}

/**
 * The item page's use count for a skill, one line in its header: "Used 12× in 30 days", or when it was last used. From the usage
 * cache only (no log reading), so it shows once the Usage page has read the logs; nothing when the logs never saw the skill.
 */
export function ItemUsageLine({ itemId, onOpen }: { itemId: string; onOpen: () => void }) {
  const [usage, setUsage] = useState<ItemUsage | null>(null);
  useEffect(() => { let active = true; setUsage(null); void api<ItemUsage>('usage.item', { itemId }).then(u => { if (active) setUsage(u); }).catch(() => {}); return () => { active = false; }; }, [itemId]);
  if (!usage?.total) return null;
  const detail = `${usage.activeDays} active day${usage.activeDays === 1 ? '' : 's'} and ${usage.projects} project${usage.projects === 1 ? '' : 's'} in ${usage.days} days · ${usage.total} all time${usage.inferred ? ` · ${usage.inferred} inferred` : ''}. From this machine's session logs; open Usage for more.`;
  return <button type="button" className="text-button detail-usage" title={detail} onClick={onOpen}>{usage.uses ? `Used ${usage.uses}× in ${usage.days} days` : `Last used ${lastUsed(usage.lastUsed)}`}</button>;
}

/** The estimate price table, $ per million tokens, with this machine's overrides; unpriced models seen in the logs are offered as rows. */
function PriceEditor({ prices, models, perform, onSaved }: { prices: UsageReport['prices']; models: string[]; perform: Props['perform']; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, Record<keyof Price, string>> | null>(null);
  const table = prices.table, rows = [...new Set([...Object.keys(table), ...models])];
  const current = draft ?? Object.fromEntries(rows.map(model => [model, Object.fromEntries(priceFields.map(f => [f.key, table[model] ? String(table[model][f.key]) : ''])) as Record<keyof Price, string>]));
  const save = () => void perform(async () => {
    const set: PriceTable = {};
    for (const [model, value] of Object.entries(current)) {
      if (priceFields.every(f => value[f.key].trim() === '')) continue;
      const price = Object.fromEntries(priceFields.map(f => [f.key, Number(value[f.key]) || 0])) as Price;
      if (!prices.edited.includes(model) && table[model] && priceFields.every(f => table[model][f.key] === price[f.key])) continue;
      set[model] = price;
    }
    await api('usage.prices', { set }); setDraft(null); onSaved();
  }, 'Prices saved on this machine');
  return <details className="usage-prices">
    <summary>Price table (estimate, $ per million tokens, checked {prices.checked}){prices.edited.length ? ` · ${prices.edited.length} edited here` : ''}</summary>
    <table className="usage-table compact"><thead><tr><th>Model</th>{priceFields.map(f => <th key={f.key} className="num">{f.label}</th>)}</tr></thead>
      <tbody>{rows.map(model => <tr key={model}><td className="usage-name">{model}{prices.edited.includes(model) && <span className="usage-tag">edited</span>}</td>
        {priceFields.map(f => <td key={f.key} className="num"><input aria-label={`${model} ${f.label}`} inputMode="decimal" value={current[model]?.[f.key] ?? ''} placeholder="—" onChange={e => setDraft({ ...current, [model]: { ...current[model], [f.key]: e.target.value } })} /></td>)}</tr>)}</tbody></table>
    <div className="wrap-actions"><button className="button small primary" disabled={!draft} onClick={save}>Save prices</button>{prices.edited.length > 0 && <button className="button small" onClick={() => void perform(async () => { await api('usage.prices', { set: {} }); setDraft(null); onSaved(); }, 'Default prices restored')}>Restore defaults</button>}</div>
  </details>;
}
