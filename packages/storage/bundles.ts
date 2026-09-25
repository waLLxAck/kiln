import { MAX_ATTACHMENT_BYTES } from '../protocol/limits';
import fs from 'node:fs';
import path from 'node:path';
import { invariant } from '../domain/errors';
import { atomicWrite, bundleFiles, contained, noLinks, safeRelative } from './files';

export function readFiles(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {};
  noLinks(root); const files: Record<string, string> = {}; let size = 0;
  const visit = (relative: string) => {
    const directory = relative ? contained(root, relative) : root;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      safeRelative(name); invariant(!entry.isSymbolicLink(), 'SYMLINK_REJECTED', `Linked bundle file: ${name}`);
      const file = contained(root, name);
      if (entry.isDirectory()) visit(name);
      else {
        invariant(entry.isFile(), 'INVALID_ASSET', 'Only regular bundle files are supported.');
        size += fs.statSync(file).size; invariant(size <= MAX_ATTACHMENT_BYTES, 'ASSET_TOO_LARGE', 'Bundle exceeds 25 MB.');
        files[name] = fs.readFileSync(file).toString('base64');
      }
    }
  };
  visit(''); bundleFiles(files); return files;
}
export function writeWorkingFiles(root: string, files: Record<string, string>) {
  noLinks(root); const previous = readFiles(root);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, value] of Object.entries(files)) atomicWrite(contained(root, name), Buffer.from(value, 'base64'));
  for (const name of Object.keys(previous)) if (!Object.hasOwn(files, name)) fs.unlinkSync(contained(root, name));
}
