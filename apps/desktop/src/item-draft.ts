import type { Item, Revision } from '../../../packages/protocol/schema';
import { mergeTextEdits } from './bundled-text';

/**
 * Private item drafts in localStorage (`kiln-draft:<id>`): `{ content, base }`, plus `meta` (the edited fields, only those
 * that differ from the item) and `files` (edited or new bundled text files by path). Drafts written by older versions,
 * with only content and base, still restore.
 */
export const draftMetaKeys = ['title', 'agentFilename', 'collection', 'tags', 'source', 'licence', 'summary'] as const;
export type DraftField = typeof draftMetaKeys[number];
export type DraftMeta = Partial<Record<DraftField, string>>;
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

/** What each field holds for this item before any edit; the draft keeps only fields that differ from these. */
export const fieldValues = (item: Item): Record<DraftField, string> => ({ title: item.title, agentFilename: item.agent?.filename ?? '', collection: item.collection, tags: item.tags.join(', '), source: item.source, licence: item.licence, summary: '' });
/** `meta` with one field set, dropping it again when it is back to the item's own value. */
export function withField(meta: DraftMeta, item: Item, key: DraftField, value: string): DraftMeta {
  const next = { ...meta };
  if (value === fieldValues(item)[key]) delete next[key]; else next[key] = value;
  return next;
}
/** Whether the draft changes anything; the revision note alone doesn't count. */
export const draftChanges = (revision: Pick<Revision, 'content'>, draft: Pick<ItemDraft, 'content' | 'meta' | 'files'>) =>
  draft.content !== revision.content || Object.keys(draft.meta ?? {}).some(key => key !== 'summary') || Object.keys(draft.files ?? {}).length > 0;
export const splitTags = (text: string) => [...new Set(text.split(',').map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))];

/**
 * The value `items.update` saves for a draft. Fields the draft didn't touch come from the item, whose collection may have
 * moved without a new revision; bundled text edits are merged into the revision's files (agents have none).
 */
export function draftValue(revision: Revision, item: Item, draft: ItemDraft) {
  const meta = draft.meta ?? {}, values = { ...fieldValues(item), ...meta };
  return {
    ...revision, title: values.title, source: values.source, licence: values.licence, collection: values.collection,
    tags: meta.tags === undefined ? item.tags : splitTags(meta.tags), content: draft.content,
    files: item.kind === 'agent' ? revision.files : mergeTextEdits(revision.files, draft.files ?? {}),
    ...(item.kind === 'agent' && item.agent ? { agent: { provider: item.agent.provider, filename: values.agentFilename } } : {}),
  };
}
