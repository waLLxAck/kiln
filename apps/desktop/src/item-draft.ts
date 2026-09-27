/**
 * Private item drafts in localStorage (`kiln-draft:<id>`). The original format is `{ content, base }`; the code editor
 * (`codeEditor` flag) adds `meta` (the form's text fields) and `files` (edited bundled text files by path). Readers that
 * only know the original format keep working, and drafts in it still restore.
 */
export const draftMetaKeys = ['title', 'agentFilename', 'collection', 'tags', 'source', 'licence', 'summary'] as const;
export type DraftMeta = Partial<Record<typeof draftMetaKeys[number], string>>;
export type ItemDraft = { content: string; base: string; meta?: DraftMeta; files?: Record<string, string> };
export const draftKey = (id: string) => `kiln-draft:${id}`;

const strings = (value: unknown, keys?: readonly string[]) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([key, v]) => typeof v === 'string' && (!keys || keys.includes(key)))) as Record<string, string> : undefined;

export function parseDraft(raw: string | null): ItemDraft | null {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || typeof value.content !== 'string' || typeof value.base !== 'string') return null;
    const meta = strings(value.meta, draftMetaKeys), files = strings(value.files);
    return { content: value.content, base: value.base, ...(meta && Object.keys(meta).length ? { meta } : {}), ...(files && Object.keys(files).length ? { files } : {}) };
  } catch { return null; }
}
export function serialiseDraft(draft: ItemDraft): string {
  const { content, base, meta, files } = draft;
  return JSON.stringify({ content, base, ...(meta && Object.keys(meta).length ? { meta } : {}), ...(files && Object.keys(files).length ? { files } : {}) });
}
/**
 * The draft the plain editor writes: exactly `{ content, base }` as before, but keeping any metadata and file edits the
 * code editor stored, so turning the flag off mid-edit never drops them.
 */
export function withDraftContent(raw: string | null, content: string, base: string): string {
  const previous = raw && (raw.includes('"meta"') || raw.includes('"files"')) ? parseDraft(raw) : null;
  return previous && (previous.meta || previous.files) ? serialiseDraft({ ...previous, content, base }) : JSON.stringify({ content, base });
}
