import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from './process';
import { youtubeAuthSchema, type YouTubeAuth } from '../protocol/schema';

/** Everything Kiln keeps from a video before asking an agent to distill it. */
export type VideoTranscript = { id: string; url: string; title: string; channel: string; durationSeconds: number; uploadDate: string; description: string; chapters: { title: string; start: number }[]; transcript: string; language: string };
export type TranscriptInput = { url: string; folder: string; signal: AbortSignal; onPhase: (phase: string) => void; auth?: Partial<YouTubeAuth> };
export type TranscriptFetcher = (input: TranscriptInput) => Promise<VideoTranscript>;

import { timestamp, youtubeId } from './video-link';
export { timestamp, youtubeId };

const CUE = /^(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+/;
/**
 * Turns a YouTube VTT caption file into plain text. Mirrors the shell `yt` helper: drops headers, cue numbers, timing
 * lines and inline tags, decodes entities. Auto-captions repeat each line in the following cue, so identical
 * consecutive lines collapse to one. A `[m:ss]` marker precedes the text every `markerEverySeconds` of video so a
 * reader (or agent) can point back into the video; pass 0 for a bare transcript.
 */
export function cleanVtt(vtt: string, markerEverySeconds = 30): string {
  const out: string[] = []; let cueStart = 0, nextMarker = 0, lastText = '';
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line) || /^NOTE\b/.test(line) || /^(Kind|Language):/.test(line)) continue;
    const cue = line.match(CUE); if (cue) { cueStart = (cue[1] ? Number(cue[1].slice(0, -1)) * 3600 : 0) + Number(cue[2]) * 60 + Number(cue[3]); continue; }
    const text = line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '’').replace(/\s+/g, ' ').trim();
    if (!text || text === lastText) continue;
    if (markerEverySeconds > 0 && cueStart >= nextMarker) { out.push(`[${timestamp(cueStart)}]`); nextMarker = cueStart - (cueStart % markerEverySeconds) + markerEverySeconds; }
    out.push(text); lastText = text;
  }
  return out.join('\n');
}
/** Runs yt-dlp. Cancelling or timing out stops its whole tree, and the run settles even if something it started keeps the pipes open. */
async function run(executable: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs: number) {
  const result = await capture(executable, args, { cwd, signal, timeoutMs, limit: 8000 }).catch(error => { throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('yt-dlp was not found on PATH. Install it (pip install yt-dlp) so Kiln can read video transcripts.') : error; });
  if (result.cancelled || signal.aborted) throw new Error('Cancelled');
  if (result.timedOut) throw new Error(`yt-dlp did not finish within ${Math.round(timeoutMs / 60000)} minutes.`);
  return { code: result.code, output: result.output };
}
/** An explicitly chosen browser takes precedence over the legacy home cookie file. No browser is read by default. */
export function youtubeCookieArgs(auth: Partial<YouTubeAuth> = {}, home = os.homedir()): string[] {
  const { youtubeBrowser, youtubeBrowserProfile } = youtubeAuthSchema.parse(auth);
  if (youtubeBrowser) return ['--cookies-from-browser', `${youtubeBrowser}${youtubeBrowserProfile ? `:${youtubeBrowserProfile}` : ''}`];
  const cookies = path.join(home, 'cookies.txt');
  return fs.existsSync(cookies) ? ['--cookies', cookies] : [];
}
/** Authentication failures should say how to recover inside Kiln, instead of exposing yt-dlp's command-line help. */
export function youtubeDownloadError(code: number | null, output: string, browser = ''): Error {
  if (/sign in to confirm.*not a bot/i.test(output)) return new Error(
    'YouTube requires verification before Kiln can fetch this video’s captions. ' +
    (browser ? `Open the video in ${browser}, sign in and complete any verification, then retry. Check Settings → YouTube for the correct browser and profile. ` : 'Open the video in your browser, sign in and complete any verification. In Settings → YouTube, choose that browser, save, then retry. ') +
    'If browser cookies cannot be read, export YouTube cookies to cookies.txt in your home folder and select “No browser” in Settings. See https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies.'
  );
  return new Error(`yt-dlp exited (${code}). ${output.slice(-1200).trim()}`);
}
/** Fetches English captions and metadata with yt-dlp, using the chosen browser or ~/cookies.txt when present. Nothing but subtitles and the info JSON is downloaded. */
export const fetchTranscript: TranscriptFetcher = async ({ url, folder, signal, onPhase, auth }) => {
  const id = youtubeId(url); if (!id) throw new Error('Not a YouTube link.');
  const out = path.join(folder, 'video'); fs.mkdirSync(out, { recursive: true });
  onPhase('Fetching transcript with yt-dlp');
  const args = ['--write-auto-subs', '--write-subs', '--write-info-json', '--skip-download', '--sub-langs', 'en-orig,en,en-US,en-GB', '--sub-format', 'vtt', '--js-runtimes', 'node', '--remote-components', 'ejs:github', '--quiet', '--no-warnings', '-o', '%(id)s.%(ext)s'];
  args.push(...youtubeCookieArgs(auth));
  args.push(`https://www.youtube.com/watch?v=${id}`);
  const result = await run('yt-dlp', args, out, signal, 180_000);
  if (result.code !== 0) throw youtubeDownloadError(result.code, result.output, auth?.youtubeBrowser);
  const files = fs.readdirSync(out);
  const vtt = ['.en-orig.vtt', '.en.vtt', '.en-US.vtt', '.en-GB.vtt'].map(suffix => files.find(f => f.endsWith(suffix))).find(Boolean) ?? files.find(f => f.endsWith('.vtt'));
  if (!vtt) throw new Error('No English captions are available for this video, so there is nothing to distill.');
  const infoFile = files.find(f => f.endsWith('.info.json'));
  const info = infoFile ? JSON.parse(fs.readFileSync(path.join(out, infoFile), 'utf8')) as Record<string, unknown> : {};
  const transcript = cleanVtt(fs.readFileSync(path.join(out, vtt), 'utf8'));
  if (!transcript.trim()) throw new Error('The captions were empty after cleaning.');
  fs.writeFileSync(path.join(out, 'transcript.txt'), transcript);
  const chapters = Array.isArray(info.chapters) ? (info.chapters as { title?: string; start_time?: number }[]).map(c => ({ title: String(c.title ?? ''), start: Number(c.start_time ?? 0) })) : [];
  return { id, url: String(info.webpage_url ?? `https://www.youtube.com/watch?v=${id}`), title: String(info.title ?? id), channel: String(info.channel ?? info.uploader ?? ''), durationSeconds: Number(info.duration ?? 0), uploadDate: String(info.upload_date ?? ''), description: String(info.description ?? ''), chapters, transcript, language: vtt.replace(/^.*?\.([a-zA-Z-]+)\.vtt$/, '$1') };
};
/** Markdown attachment stored with the video item: metadata, chapters, then the full transcript. */
export function transcriptMarkdown(video: VideoTranscript): string {
  const meta = [`# ${video.title}`, '', `- Channel: ${video.channel || 'unknown'}`, `- Duration: ${timestamp(video.durationSeconds)}`, video.uploadDate ? `- Published: ${video.uploadDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}` : '', `- URL: ${video.url}`, `- Captions: ${video.language}`].filter(Boolean);
  const chapters = video.chapters.length ? ['', '## Chapters', ...video.chapters.map(c => `- ${timestamp(c.start)} ${c.title}`)] : [];
  return [...meta, ...chapters, '', '## Transcript', '', video.transcript, ''].join('\n');
}
