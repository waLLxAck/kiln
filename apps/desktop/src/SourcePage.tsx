import { activeRun } from '../../../packages/agent/run-notice';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowRight, ChevronDown, ChevronRight, CircleSlash, Folder, Github, Layers3, Loader2, MessageSquare, Pencil, RotateCcw, ScanSearch, ScrollText, Sparkles, Star, X, ZoomIn } from 'lucide-react';
import type { AgentJobSummary } from '../../../packages/agent/service';
import { timestamp, youtubeId } from '../../../packages/agent/video-link';
import { entryTypeList, selectedEntryTypes } from '../../../packages/agent/distill';
import { repoSourceOf } from '../../../packages/domain/github-url';
import type { Analysis, Item, ItemDetail, Provider, Snapshot, Trial } from '../../../packages/protocol/schema';
import { AgentPanel, AnalysisRecord } from './AgentPanel';
import { api, date } from './api';
import { KindIcon, Lightbox, imageFile, imageSource, providerName } from './components';
import { Markdown } from './Markdown';
import { UndoToast } from './UndoToast';
import { entrySeconds, markerColumns, minuteTicks, readTranscript, skippedRanges } from './source-timeline';
import './source.css';

export type SourcePageProps = {
  detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; jobs: AgentJobSummary[];
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>;
  /** Opens another item (an entry made from this source). */
  onSelect: (id: string) => void;
  /** Shows the library filtered to what was made from this source. */
  onMadeFrom: (sourceId: string) => void;
  onCollection: (name: string) => void;
  /** The item page's actions, e.g. 'analyze' (analyze again), 'edit'. */
  onAction: (name: string, trial?: Trial) => void;
};

const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
const kindPlural: Record<string, string> = { prompt: 'Prompts', skill: 'Skills', agent: 'Agents', instruction: 'Instructions', link: 'Links', insight: 'Insights', technique: 'Techniques', tool: 'Tools', resource: 'Resources', image: 'Images', file: 'Files', reference: 'References', source: 'Sources', mcp: 'MCP servers' };
const kindName: Record<string, string> = { instruction: 'Instruction', prompt: 'Prompt', insight: 'Insight', technique: 'Technique', tool: 'Tool', resource: 'Resource', skill: 'Skill', link: 'Link' };
const kindOrder = ['prompt', 'instruction', 'technique', 'insight', 'tool', 'resource', 'skill', 'link'];
const tokens = (n: number) => n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();
const took = (a: Analysis) => { const s = Math.max(0, Math.round((Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 1000)); return Number.isFinite(s) ? s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s` : ''; };
const gone = (i: Item) => ['archived', 'rejected'].includes(i.status);
// The distillation's private CLI session (SESSION_FILE in the agent service, which the renderer cannot import).
const SESSION_FILE = 'session.jsonl';
const collectionName = (name: string) => name.replaceAll('/', ' / ') || 'Unfiled';

type Entry = { item: Item; at: number | null };

/** The page for a source (a video, page, pasted chat or files an analysis read), built around what was made from it. */
export function SourcePage({ detail, snapshot, jobs, perform, refresh, onSelect, onMadeFrom, onCollection, onAction }: SourcePageProps) {
  const { item, revision } = detail;
  const [hot, setHot] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [formatted, setFormatted] = useState(false);
  const [zoom, setZoom] = useState<{ name: string; src: string } | null>(null);
  const [undo, setUndo] = useState<{ item: Item; previous: Item['status'] } | null>(null);
  const rows = useRef<Record<string, HTMLElement | null>>({});
  const timer = useRef<number>(0);
  useEffect(() => { setTranscriptOpen(false); setArchivedOpen(false); setHistoryOpen(false); setHot(null); }, [item.id]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const firstLine = revision.content.trim().split('\n')[0] ?? '';
  const videoId = youtubeId(firstLine) ?? youtubeId(item.source);
  const transcriptFile = revision.files['transcript.md'];
  // The attachment is already in memory with the revision; decode it once per revision, not per render.
  const video = useMemo(() => transcriptFile ? readTranscript(decode(transcriptFile)) : null, [revision.hash]);
  const files = Object.keys(revision.files).filter(name => name !== 'transcript.md' && name !== SESSION_FILE);
  // A GitHub repository Kiln scanned: its skills were imported from it, and Dig deeper reads its checkout.
  const repo = repoSourceOf(item);
  const sourceKind = repo ? 'GitHub repository' : videoId ? 'YouTube' : /^https?:\/\/\S+$/i.test(firstLine) ? 'Web page' : files.length ? 'Files' : 'Text';
  const at = (seconds: number) => `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(seconds)}s`;
  const openUrl = (url: string) => void perform(() => api('desktop.openContentUrl', { url }));

  const made: Entry[] = snapshot.items.filter(i => i.origin?.itemId === item.id && !i.deletedAt).map(i => ({ item: i, at: videoId ? entrySeconds(i.source) : null }));
  const active = made.filter(e => !gone(e.item)), archived = made.filter(e => gone(e.item));
  const timed = made.filter((e): e is Entry & { at: number } => e.at !== null);
  const duration = video?.duration ?? (timed.length ? Math.ceil((Math.max(...timed.map(e => e.at)) + 30) / 60) * 60 : 0);
  const showTimeline = Boolean(videoId && duration && (timed.length || video));
  const latest = detail.analyses[0];
  const skipped = showTimeline && latest ? skippedRanges(latest.skipped, duration) : [];
  const chapterAt = (seconds: number) => video?.chapters.filter(c => c.start <= seconds).at(-1)?.title;

  // Entries line up with the timeline by minute; sources without minutes group them by kind.
  const byMinute = active.some(e => e.at !== null);
  const groups: { key: string; at: number | null; label: string; entries: Entry[] }[] = [];
  if (byMinute) {
    for (const entry of [...active].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))) {
      const key = entry.at === null ? 'untimed' : `m${Math.floor(entry.at / 60)}`;
      const group = groups.find(g => g.key === key);
      if (group) group.entries.push(entry);
      else groups.push({ key, at: entry.at, label: entry.at === null ? 'No timestamp' : chapterAt(entry.at) ?? '', entries: [entry] });
    }
  } else {
    const kinds = [...new Set(active.map(e => e.item.kind))].sort((a, b) => (kindOrder.indexOf(a) + 1 || 99) - (kindOrder.indexOf(b) + 1 || 99));
    for (const kind of kinds) groups.push({ key: kind, at: null, label: kindPlural[kind] ?? kind, entries: active.filter(e => e.item.kind === kind) });
  }
  const kept = active.filter(e => e.item.favourite).length;

  // Running or waiting its turn: either way the source is being analysed and Analyze again waits.
  const running = jobs.find(j => j.itemId === item.id && activeRun(j) && ['capture', 'distill', 'distill-repo'].includes(j.kind));
  const localJob = latest ? jobs.find(j => j.id === latest.id) : undefined;
  // A run on this machine shows as its live card (steps, run files, retry); others show the record kept in the library.
  const recorded = detail.analyses.filter(a => !jobs.some(j => j.id === a.id));
  const unfinished = jobs.filter(j => j.itemId === item.id && j.status !== 'completed');
  const finished = jobs.filter(j => j.itemId === item.id && j.status === 'completed');
  const runCount = recorded.length + finished.filter(j => ['capture', 'distill', 'distill-repo', 'derive'].includes(j.kind)).length;
  const deleted = Boolean(item.deletedAt);

  const jump = (id: string) => {
    const entry = made.find(e => e.item.id === id); if (!entry) return;
    if (gone(entry.item)) setArchivedOpen(true);
    // Wait a frame so a just-opened Archived list has its rows.
    requestAnimationFrame(() => rows.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    setFlash(id); clearTimeout(timer.current); timer.current = window.setTimeout(() => setFlash(null), 1400);
  };
  const setStatus = (entry: Item, status: Item['status']) => perform(async () => { await api('items.meta', { id: entry.id, expect: entry.revision, status }); await refresh(); });
  const archive = (entry: Item) => void perform(async () => { await api('items.meta', { id: entry.id, expect: entry.revision, status: 'archived' }); await refresh(); setUndo({ item: entry, previous: entry.status }); });
  const keep = (entry: Item) => void perform(async () => { await api('items.meta', { id: entry.id, expect: entry.revision, favourite: !entry.favourite }); await refresh(); });

  const images = Object.entries(revision.files).filter(([name]) => imageFile(name));
  // The eyebrow already says Source and the rail says when it was captured.
  const byline = [sourceKind, video?.channel, video?.duration ? timestamp(video.duration) : '', video?.published ? `Published ${video.published}` : ''].filter(Boolean);
  const legendKinds = [...new Set(timed.map(e => e.item.kind))].sort((a, b) => (kindOrder.indexOf(a) + 1 || 99) - (kindOrder.indexOf(b) + 1 || 99));
  const pct = (seconds: number) => `${Math.min(100, (seconds / duration) * 100)}%`;

  const entryRow = (entry: Entry, archivedRow = false) => {
    const { item: e } = entry;
    return <div key={e.id} ref={el => { rows.current[e.id] = el; }} className={`source-entry ${archivedRow ? 'archived' : ''} ${hot === e.id ? 'hot' : ''} ${flash === e.id ? 'flash' : ''}`} onMouseEnter={() => setHot(e.id)} onMouseLeave={() => setHot(null)}>
      <span className={`item-kind ${e.kind}`}><KindIcon kind={e.kind} size={15} /></span>
      <div className="source-entry-text">
        <div className="source-entry-title">
          <button type="button" className="source-entry-name" title="Open it" onClick={() => onSelect(e.id)}>{e.title}</button>
          <span className="source-entry-kind">{kindName[e.kind] ?? e.kind}{entry.at !== null && archivedRow ? ` · ${timestamp(entry.at)}` : ''}</span>
        </div>
        {!archivedRow && e.description && <p>{e.description}</p>}
        {/* Only where it differs: most entries sit in the source's own collection, which the header names. */}
        {!archivedRow && e.collection !== item.collection && <button type="button" className="source-entry-collection" title={`Filed in “${collectionName(e.collection)}”`} onClick={() => e.collection ? onCollection(e.collection) : undefined} disabled={!e.collection}><Folder size={12} />{collectionName(e.collection)}</button>}
      </div>
      <div className="source-entry-actions">
        {archivedRow ? <button className="button small" onClick={() => void setStatus(e, 'captured')} disabled={deleted}><RotateCcw size={13} />Restore</button> : <>
          <button className={`button small ${e.favourite ? 'on' : ''}`} aria-pressed={e.favourite} onClick={() => keep(e)} disabled={deleted} title={e.favourite ? 'Kept in Favourites. Click to unstar.' : 'Keep it: stars it so it shows in Favourites'}><Star size={13} fill={e.favourite ? 'currentColor' : 'none'} />{e.favourite ? 'Kept' : 'Keep'}</button>
          <button className="button small" onClick={() => archive(e)} disabled={deleted} title="Move to Archive. It keeps its link to this source."><Archive size={13} />Archive</button>
        </>}
      </div>
    </div>;
  };

  return <section className="source-page" aria-label="Source">
    <div className={`source-layout ${transcriptOpen && video ? 'with-transcript' : ''}`}>
      <header className="source-head">
        {/* The item page's header above already names the source, its collection and its Open action. */}
        <div className="source-byline">{byline.map((part, i) => <span key={part}>{i > 0 && <span className="dot">·</span>}{part}</span>)}</div>

        {latest && (latest.summary !== item.description || latest.takeaway) && <div className="source-callout">
          {latest.summary !== item.description && <p>{latest.summary}</p>}
          {latest?.takeaway && <p className="source-takeaway"><Sparkles size={14} /><span><strong>Takeaway</strong> {latest.takeaway}</span></p>}
        </div>}

        {!deleted && <div className="source-actions">
          <button className="button" onClick={() => onAction('analyze')} disabled={Boolean(running)} title={`${repo ? 'The agent reads the repository read-only, past its packaged skills: README, docs, scripts and CI. ' : ''}${latest ? 'Run the analysis again; new entries are added beside the earlier ones. ' : ''}Produces ${entryTypeList(selectedEntryTypes(snapshot.settings))}${repo ? ' and new skills' : ''} (Settings → Distillation).`}>{running ? <Loader2 size={15} className="spin" /> : <ScanSearch size={15} />}{repo ? running ? 'Digging deeper…' : latest ? 'Dig deeper again' : 'Dig deeper' : running ? 'Analyzing…' : latest ? 'Analyze again' : 'Analyze'}</button>
          {repo && <button className="button" onClick={() => onAction('repo-scan')} title="Fetch the latest commit and compare its skills and agents with your library"><Github size={15} />Scan again</button>}
          <button className="button" onClick={() => onAction('ask')}><MessageSquare size={15} />{videoId ? 'Ask about this video' : 'Ask about this source'}</button>
          {video && <button className={`button ${transcriptOpen ? 'on' : ''}`} aria-pressed={transcriptOpen} onClick={() => setTranscriptOpen(open => !open)}><ScrollText size={15} />{transcriptOpen ? 'Hide transcript' : 'Show transcript'}</button>}
        </div>}

        {(latest || runCount > 0) && <div className="source-analysis">
          {running ? <span className="source-analysis-line"><Loader2 size={12} className="spin" />{providerName[running.provider]} · {running.status === 'queued' ? 'Queued' : running.phase}</span>
            : latest && !historyOpen && <span className="source-analysis-line" title={latest.usage ? `Input ${latest.usage.input.toLocaleString()} (cached ${latest.usage.cached.toLocaleString()}) · output ${latest.usage.output.toLocaleString()}` : undefined}>
              {[providerName[latest.provider], latest.model || 'CLI default model', latest.effort ? `${latest.effort} effort` : '', latest.usage ? `${tokens(latest.usage.input)} in · ${tokens(latest.usage.output)} out` : '', took(latest), date(latest.finishedAt)].filter(Boolean).join(' · ')}
              {localJob && <> · <button className="source-link" onClick={() => void perform(() => api('desktop.openAgentJob', { id: localJob.id }))}>Run files</button></>}
            </span>}
          {runCount > 0 && <button type="button" className="source-link" aria-expanded={historyOpen} onClick={() => setHistoryOpen(open => !open)}>{historyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{historyOpen ? 'Hide analysis details' : runCount === 1 ? 'Analysis details' : `All ${runCount} analyses`}</button>}
        </div>}
        {historyOpen && <div className="source-history">
          <AgentPanel itemId={item.id} jobs={finished} kinds={['capture', 'derive', 'distill', 'distill-repo']} onOpen={onSelect} />
          {recorded.map(a => <AnalysisRecord key={a.id} analysis={a} />)}
        </div>}
      </header>
      <div className="source-main">
        <AgentPanel itemId={item.id} jobs={unfinished} kinds={['capture', 'derive', 'distill', 'distill-repo']} onOpen={onSelect} onOpenCollection={onCollection} collections={snapshot.collections} />
        {detail.duplicates.length > 0 && <div className="notice warning"><b>Similar content already in your library</b>{detail.duplicates.map(d => <button key={d.id} className="text-button" onClick={() => onSelect(d.id)}>{d.title} <ArrowRight size={12} /></button>)}</div>}

        {showTimeline && <section className="source-timeline" aria-label="Timeline">
          <div className="source-tl-head">
            <h3>Timeline</h3>
            <div className="source-legend">{legendKinds.map(kind => <span key={kind} className={`k-${kind}`}><i className="source-swatch" />{kindPlural[kind] ?? kind}</span>)}{skipped.length > 0 && <span><i className="source-swatch skip" />Skipped</span>}</div>
          </div>
          <div className="source-track-wrap">
            <div className="source-markers">
              {markerColumns(timed, duration).map(column => <div key={column.at} className={`source-marker-col ${column.entries.some(e => e.item.id === hot) ? 'hot' : ''}`} style={{ left: pct(column.at) }}>
                {column.entries.map(e => <button key={e.item.id} type="button" className={`source-marker k-${e.item.kind} ${gone(e.item) ? 'faded' : ''} ${hot === e.item.id ? 'hot' : ''}`} aria-label={`${timestamp(e.at)} · ${e.item.title}`} onMouseEnter={() => setHot(e.item.id)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(e.item.id)} onBlur={() => setHot(null)} onClick={() => jump(e.item.id)}><KindIcon kind={e.item.kind} size={12} /></button>)}
                <span className="source-stem" />
                {column.entries.some(e => e.item.id === hot) && (() => { const e = column.entries.find(x => x.item.id === hot)!; return <span className={`source-flag ${column.at > duration * .7 ? 'left' : column.at < duration * .15 ? 'right' : ''}`}><b>{timestamp(e.at)}</b>{e.item.title}</span>; })()}
              </div>)}
            </div>
            <div className="source-track">
              {skipped.map(s => <div key={`${s.from}-${s.to}`} className="source-skip" style={{ left: pct(s.from), width: pct(s.to - s.from) }} title={`${s.label} · ${timestamp(s.from)}–${timestamp(s.to)}, skipped`}>{(s.to - s.from) / duration > .09 && <span>{s.label}</span>}</div>)}
              {video?.chapters.filter(c => c.start > 0 && c.start < duration).map(c => <span key={c.start} className="source-chapter-tick" style={{ left: pct(c.start) }} title={`${timestamp(c.start)} · ${c.title}`} />)}
              {timed.map(e => <span key={e.item.id} className={`source-entry-tick k-${e.item.kind} ${hot === e.item.id ? 'hot' : ''}`} style={{ left: pct(e.at) }} />)}
            </div>
            <div className="source-ticks">
              {/* A label too close to the end would collide with the duration. */}
              {minuteTicks(duration).map(t => { const label = t.label && t.at < duration * .95; return <span key={t.at} className={label ? '' : 'minor'} style={{ left: pct(t.at) }}>{label ? timestamp(t.at) : ''}</span>; })}
              <span className="end" style={{ left: '100%' }}>{timestamp(duration)}</span>
            </div>
          </div>
          {latest?.skipped && <p className="source-skipnote"><CircleSlash size={13} />Skipped: {latest.skipped}</p>}
        </section>}
        {!showTimeline && latest?.skipped && <p className="source-skipnote plain"><CircleSlash size={13} />Skipped: {latest.skipped}</p>}

        <section className="source-entries" aria-label="Made from this source">
          <div className="source-entries-head">
            <h3>Made from this</h3>
            <span className="muted small">{made.length ? `${active.length} entr${active.length === 1 ? 'y' : 'ies'}${kept ? ` · ${kept} kept` : ''}${archived.length ? ` · ${archived.length} archived` : ''}` : ''}</span>
            <button className="button small" disabled={!made.length} onClick={() => onMadeFrom(item.id)} title="The library filtered to items made from this source, wherever they are filed"><Layers3 size={13} />Show in library</button>
          </div>
          {!made.length && <p className="muted">Nothing made from it yet. {repo ? 'Scan it again to import its skills, or dig deeper' : 'Analyze it'} to distill {entryTypeList(selectedEntryTypes(snapshot.settings))}.</p>}
          <ol className={`source-groups ${byMinute ? 'timed' : ''}`}>
            {groups.map(group => <li key={group.key} className={`source-group ${group.entries.some(e => e.item.id === hot) ? 'hot' : ''}`}>
              {byMinute && <div className="source-time">{group.at !== null && videoId ? <button type="button" title={`Open the video at ${timestamp(group.at)}`} onClick={() => openUrl(at(group.at!))}>{timestamp(group.at)}</button> : <span>–</span>}</div>}
              {byMinute && <div className="source-rail"><span className="source-node" /></div>}
              <div className="source-group-body">
                {group.label && <div className="source-group-title">{group.label}{!byMinute && <small>{group.entries.length}</small>}</div>}
                {group.entries.map(entry => entryRow(entry))}
              </div>
            </li>)}
          </ol>
          {active.length === 0 && made.length > 0 && <p className="muted">Every entry made from it is archived.</p>}
          {archived.length > 0 && <div className="source-archived">
            <button type="button" className="source-archived-toggle" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(open => !open)}>{archivedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}Archived ({archived.length})</button>
            {archivedOpen && archived.map(entry => entryRow(entry, true))}
          </div>}
        </section>

        <section className="content-section source-original">
          <div className="section-heading"><h3>Original material</h3><span className="source-grow" /><button className="text-button" aria-pressed={formatted} onClick={() => setFormatted(!formatted)}>{formatted ? 'Raw text' : 'Formatted'}</button>{!deleted && <button className="text-button" onClick={() => onAction('edit')}><Pencil size={13} />Edit</button>}</div>
          {images.length > 0 && <div className="asset-gallery">{images.map(([name, content]) => <button key={name} type="button" className="asset-button" title={`Enlarge ${name}`} onClick={() => setZoom({ name, src: imageSource(name, content) })}><img className="asset-preview" alt={name} src={imageSource(name, content)} /><span><ZoomIn size={13} />{name}</span></button>)}</div>}
          {formatted ? <Markdown>{revision.content}</Markdown> : <pre className="content-preview">{revision.content}</pre>}
        </section>
      </div>

      {transcriptOpen && video && <aside className="source-transcript" aria-label="Transcript">
        <div className="source-tr-head"><h3>Transcript</h3><span className="muted small">{video.captions ? `Captions · ${video.captions}` : 'Captions'}</span><span className="source-grow" /><button className="icon-button" aria-label="Close transcript" onClick={() => setTranscriptOpen(false)}><X size={16} /></button></div>
        <div className="source-tr-lines">{video.lines.length ? video.lines.map((line, i) => {
          const next = video.lines[i + 1]?.at ?? Infinity;
          const here = timed.filter(e => e.at >= line.at && e.at < next);
          const skip = skipped.some(s => line.at >= s.from && line.at < s.to);
          return <div key={`${line.at}-${i}`} className={`source-line ${skip ? 'skipped' : ''} ${here.some(e => e.item.id === hot) ? 'hot' : ''}`}>
            <button type="button" className="source-ts" title={`Open the video at ${timestamp(line.at)}`} onClick={() => openUrl(at(line.at))}>{timestamp(line.at)}</button>
            <span>{line.text}{here.map(e => <button key={e.item.id} type="button" className={`source-line-entry k-${e.item.kind}`} aria-label={`Show ${e.item.title}`} title={e.item.title} onMouseEnter={() => setHot(e.item.id)} onMouseLeave={() => setHot(null)} onClick={() => jump(e.item.id)}><KindIcon kind={e.item.kind} size={11} /></button>)}</span>
          </div>;
        }) : <p className="muted">The transcript is empty.</p>}</div>
      </aside>}
    </div>
    {zoom && <Lightbox src={zoom.src} name={zoom.name} onClose={() => setZoom(null)} />}
    {undo && <UndoToast key={undo.item.id} title={undo.item.title} onUndo={() => { const last = undo; setUndo(null); void perform(async () => { await api('items.meta', { id: last.item.id, expect: last.item.revision, status: last.previous }); await refresh(); }, `${last.item.title} is back`); }} onExpire={() => setUndo(null)} />}
  </section>;
}
