import { Fragment, useMemo, useState } from 'react';
import { buildDiff, type DiffRow, type Segment } from './diffModel';

const Line = ({ text, segments }: { text: string; segments?: Segment[] }) => segments ? <>{segments.map((s, i) => s.changed ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>)}</> : <>{text}</>;

/**
 * Line diff from `before` to `after`: red lines exist only in `before`, green only in `after`, and within a replaced
 * block the words that actually differ are highlighted. Long unchanged runs collapse to a marker that expands on
 * click. When only line endings differ the diff is empty, so a note names the two conventions instead.
 */
export function LineDiff({ before, after, names, className = '' }: { before: string; after: string; names: { before: string; after: string }; className?: string }) {
  const model = useMemo(() => buildDiff(before, after), [before, after]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const row = (r: DiffRow, i: number) => {
    if (r.kind === 'collapsed') {
      if (expanded.has(i)) return r.lines.map((text, n) => <pre key={`${i}-${n}`}>{text}</pre>);
      return <pre key={i} className="collapsed" role="button" tabIndex={0} title="Show these lines" onClick={() => setExpanded(new Set(expanded).add(i))} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(new Set(expanded).add(i)); } }}>… {r.lines.length} unchanged line{r.lines.length === 1 ? '' : 's'}</pre>;
    }
    return <pre key={i} className={r.kind === 'context' ? '' : r.kind}><Line text={r.text} segments={r.segments} /></pre>;
  };
  return <div className={`diff ${className}`}>
    {model.lineEndingsOnly && <p className="diff-note">Only line endings differ: {names.before} uses {model.endings.before}, {names.after} uses {model.endings.after}. The text is the same.</p>}
    {!model.lineEndingsOnly && model.endings.before !== model.endings.after && model.endings.before !== 'none' && model.endings.after !== 'none' && <p className="diff-note">Line endings also differ ({names.before} {model.endings.before}, {names.after} {model.endings.after}); they are ignored below.</p>}
    {model.rows.map(row)}
  </div>;
}
