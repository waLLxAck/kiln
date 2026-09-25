import type { Authoring } from './schema';

/** Shared by the app and the standalone repository validator. Keep this function self-contained. */
export function revisionIdentity(value: Authoring, version: number) {
  return { title: value.title, kind: value.kind, tags: [...value.tags].sort(), collection: value.collection,
    source: value.source, licence: value.licence, content: value.content, files: value.files,
    ...(value.kind === 'agent' ? { agent: value.agent } : {}),
    ...(version >= 2 ? { description: value.description ?? '' } : {}) };
}
