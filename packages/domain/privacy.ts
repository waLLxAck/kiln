import path from 'node:path';
import type { Authoring, Trial } from '../protocol/schema';

export const privateAttachment = (name: string) => /(^|\/)session\.jsonl$/i.test(name);
export function portableSource(source: string) {
  if (/^(?:local|home):/i.test(source) || /^(?:[A-Za-z]:[\\/]|\/|\\\\|file:\/\/)/.test(source)) {
    return `local-import:${path.posix.basename(source.replaceAll('\\', '/'))}`;
  }
  return source;
}
export function shareableAuthoring<T extends Authoring>(value: T): T {
  const source = portableSource(value.source);
  const originalPath = value.source.replace(/^(?:home|local):/i, '');
  const description = source !== value.source && value.description === `Copy of ${originalPath}` ? `Copy of ${source.slice('local-import:'.length)}` : value.description;
  return { ...value, description, source, files: Object.fromEntries(Object.entries(value.files).filter(([name]) => !privateAttachment(name))) };
}
export function shareableTrial(trial: Trial): Trial {
  return { ...trial, variables: {}, task: 'Private input excluded', rubric: [], workspace: 'Machine-private', machine: 'local', note: '', outputReference: '' };
}
