import { diffLines, diffWordsWithSpace } from 'diff';

/** A run of text inside one line; `changed` marks the words that differ from the paired line on the other side. */
export type Segment = { text: string; changed: boolean };
export type DiffRow =
  | { kind: 'context' | 'removed' | 'added'; text: string; segments?: Segment[] }
  | { kind: 'collapsed'; lines: string[] };
export type LineEnding = 'LF' | 'CRLF' | 'mixed' | 'none';
export type DiffModel = {
  rows: DiffRow[];
  /** Both texts are equal once line endings are normalised. */
  identical: boolean;
  /** The bytes differ but nothing except line endings does, so the diff itself would be empty. */
  lineEndingsOnly: boolean;
  endings: { before: LineEnding; after: LineEnding };
};

/** Above this many characters per side, word-level marking of a paired hunk costs more than it explains. */
const WORD_DIFF_LIMIT = 20_000;
/** Paired hunks whose words differ more than this are unrelated text; marking every word only adds noise. */
const WORD_DIFF_MAX_CHANGED_RATIO = 0.6;

export const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, '\n');
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length, lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf === 0 && lf === 0 ? 'none' : crlf === 0 ? 'LF' : lf === 0 ? 'CRLF' : 'mixed';
}

/** Splits a text ending in a newline into its lines, without the phantom empty line after the final newline. */
const splitLines = (text: string) => text.replace(/\n$/, '').split('\n');
/** Gives every non-empty text a final newline; without it the last line would show as both removed and added. */
const terminated = (text: string) => text === '' ? '' : text.replace(/\n?$/, '\n');

/**
 * Word marks for a removed hunk and the added hunk that replaced it. Returns one segment list per line on each side,
 * or null when the two hunks are too different (or too long) for word marks to help.
 */
export function markWords(removed: string, added: string): { removed: Segment[][]; added: Segment[][] } | null {
  if (removed.length > WORD_DIFF_LIMIT || added.length > WORD_DIFF_LIMIT) return null;
  const words = diffWordsWithSpace(removed, added);
  const changed = words.reduce((n, w) => n + (w.added || w.removed ? w.value.length : 0), 0);
  if (changed / Math.max(1, removed.length + added.length) > WORD_DIFF_MAX_CHANGED_RATIO) return null;
  const side = (keep: 'added' | 'removed') => {
    const lines: Segment[][] = [[]];
    for (const w of words) {
      if (keep === 'added' ? w.removed : w.added) continue;
      const pieces = w.value.split('\n');
      pieces.forEach((piece, i) => {
        if (i > 0) lines.push([]);
        if (piece) lines[lines.length - 1].push({ text: piece, changed: Boolean(w.added || w.removed) });
      });
    }
    if (lines[lines.length - 1].length === 0) lines.pop(); // the trailing newline opens an empty line we never render
    return lines;
  };
  const result = { removed: side('removed'), added: side('added') };
  const count = (text: string) => splitLines(text).length;
  // Words spanning a line break can shift the split; fall back rather than mark the wrong line.
  if (result.removed.length !== count(removed) || result.added.length !== count(added)) return null;
  return result;
}

/**
 * Line diff from `before` to `after` with unchanged runs collapsed to `context` lines on either side of a change.
 * Line endings are normalised first so a CRLF copy of an LF file does not show every line as replaced; the model
 * reports that case separately so the caller can explain it. Removed and added hunks that sit next to each other are
 * paired and their differing words marked.
 */
export function buildDiff(before: string, after: string, context = 3): DiffModel {
  const a = normalizeLineEndings(before), b = normalizeLineEndings(after);
  const endings = { before: detectLineEnding(before), after: detectLineEnding(after) };
  const identical = a === b;
  if (identical) return { rows: a === '' ? [] : splitLines(terminated(a)).map(text => ({ kind: 'context', text })), identical, lineEndingsOnly: before !== after, endings };
  const parts = diffLines(terminated(a), terminated(b));
  const rows: DiffRow[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.removed && parts[i + 1]?.added) {
      const next = parts[++i], marks = markWords(part.value, next.value);
      splitLines(part.value).forEach((text, n) => rows.push({ kind: 'removed', text, segments: marks?.removed[n] }));
      splitLines(next.value).forEach((text, n) => rows.push({ kind: 'added', text, segments: marks?.added[n] }));
      continue;
    }
    if (part.added || part.removed) { splitLines(part.value).forEach(text => rows.push({ kind: part.added ? 'added' : 'removed', text })); continue; }
    const lines = splitLines(part.value);
    if (lines.length <= context * 2 + 1) { lines.forEach(text => rows.push({ kind: 'context', text })); continue; }
    const head = i === 0 ? [] : lines.slice(0, context), tail = i === parts.length - 1 ? [] : lines.slice(-context);
    head.forEach(text => rows.push({ kind: 'context', text }));
    rows.push({ kind: 'collapsed', lines: lines.slice(head.length, lines.length - tail.length) });
    tail.forEach(text => rows.push({ kind: 'context', text }));
  }
  return { rows, identical, lineEndingsOnly: false, endings };
}
