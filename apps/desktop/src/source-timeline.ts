/** Pure helpers for the source page: reading a video's transcript attachment and placing entries on its timeline. */

/** Seconds from `m:ss` or `h:mm:ss`; null for anything else. */
export function clockSeconds(text: string): number | null {
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(text.trim())) return null;
  return text.trim().split(':').map(Number).reduce((total, n) => total * 60 + n, 0);
}

/** The second an entry points at. Distillation stores it on the entry's source link as `&t=<seconds>s`. */
export function entrySeconds(source: string): number | null {
  const match = source.match(/[?&#]t=(?:(\d+)h)?(?:(\d+)m)?(\d+)s?(?:&|$)/);
  if (!match || !/youtu\.?be/i.test(source)) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3]);
}

export type VideoTranscript = { channel: string; duration: number | null; published: string; url: string; captions: string; chapters: { title: string; start: number }[]; lines: { at: number; text: string }[] };
/**
 * Reads the `transcript.md` Kiln attaches to a video (see transcriptMarkdown): the metadata list, the chapters and the
 * transcript, whose `[m:ss]` markers start each block of text.
 */
export function readTranscript(markdown: string): VideoTranscript {
  const out: VideoTranscript = { channel: '', duration: null, published: '', url: '', captions: '', chapters: [], lines: [] };
  let section = '';
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('## ')) { section = line.slice(3).toLowerCase(); continue; }
    if (section === 'transcript') {
      const marker = line.match(/^\[(\d{1,2}(?::\d{2}){1,2})\]$/);
      if (marker) out.lines.push({ at: clockSeconds(marker[1]) ?? 0, text: '' });
      else if (line) { const last = out.lines.at(-1) ?? (out.lines.push({ at: 0, text: '' }), out.lines[0]); last.text = last.text ? `${last.text} ${line}` : line; }
      continue;
    }
    if (section === 'chapters') { const chapter = line.match(/^- (\d{1,2}(?::\d{2}){1,2}) (.+)$/); if (chapter) out.chapters.push({ start: clockSeconds(chapter[1]) ?? 0, title: chapter[2] }); continue; }
    const field = line.match(/^- (Channel|Duration|Published|URL|Captions): (.*)$/);
    if (!field) continue;
    const value = field[2].trim();
    if (field[1] === 'Channel') out.channel = value === 'unknown' ? '' : value;
    else if (field[1] === 'Duration') out.duration = clockSeconds(value) || null;
    else if (field[1] === 'Published') out.published = value;
    else if (field[1] === 'URL') out.url = value;
    else out.captions = value;
  }
  out.lines = out.lines.filter(line => line.text);
  return out;
}

export type SkippedRange = { from: number; to: number; label: string };
const TIME = String.raw`\d{1,2}(?::\d{2}){1,2}`;
/**
 * Time ranges an analysis says it skipped, when its note names them ("Sponsor segment (2:05 to 3:10)", "the outro from
 * 17:42 to the end"). Best effort: notes without times give no ranges.
 */
export function skippedRanges(text: string, duration: number): SkippedRange[] {
  const ranges: SkippedRange[] = [];
  const pattern = new RegExp(`(${TIME})\\s*(?:–|—|-|to|until|through)\\s*(?:(${TIME})|(?:the\\s+)?end\\b)`, 'gi');
  for (const match of text.matchAll(pattern)) {
    const from = clockSeconds(match[1]), to = match[2] ? clockSeconds(match[2]) : duration;
    if (from === null || to === null || to <= from || from >= duration) continue;
    // The label is the words just before the range, within the same clause.
    const clause = text.slice(0, match.index).split(/[.;,]|\band\b/).at(-1) ?? '';
    const words = clause.replace(/[(\[]/g, ' ').replace(/\b(from|at|between|the)\s*$/i, '').trim().replace(/^the\s+/i, '');
    const label = words ? (words[0].toUpperCase() + words.slice(1)).slice(0, 40) : 'Skipped';
    ranges.push({ from, to: Math.min(to, duration), label });
  }
  return ranges;
}

/** Minute ticks for a timeline: a labelled tick every `step` minutes (at most about ten labels) and a minor tick every minute on shorter videos. */
export function minuteTicks(duration: number): { at: number; label: boolean }[] {
  const minutes = duration / 60;
  const step = [1, 2, 5, 10, 15, 20, 30, 60, 120].find(s => minutes / s <= 10) ?? 240;
  const ticks: { at: number; label: boolean }[] = [];
  const every = minutes <= 40 ? 1 : step;
  for (let m = 0; m * 60 < duration; m += every) ticks.push({ at: m * 60, label: m % step === 0 });
  return ticks;
}

/** Groups timed items into marker columns, merging ones closer than `gap` (a fraction of the duration) so markers never overlap. */
export function markerColumns<T extends { at: number }>(entries: T[], duration: number, gap = 0.03): { at: number; entries: T[] }[] {
  const columns: { at: number; entries: T[] }[] = [];
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    const last = columns.at(-1);
    if (last && (entry.at - last.at) / duration < gap) last.entries.push(entry);
    else columns.push({ at: entry.at, entries: [entry] });
  }
  return columns;
}
