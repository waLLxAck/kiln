import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../storage/files';

const lf = (text: string) => text.replaceAll('\r\n', '\n');
function lfBytes(bytes: Buffer) {
  if (!bytes.includes(13)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length); let length = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 13 || bytes[i + 1] !== 10) out[length++] = bytes[i];
  return out.subarray(0, length);
}
/**
 * Working text equal to the stored text once CRLF is read as LF. Git for Windows checks text out with CRLF by default
 * (core.autocrlf), which must not turn every item of a fresh clone or pull into an external edit.
 */
export const sameText = (working: string, stored: string) => working === stored || lf(working) === lf(stored);
/** The same for a bundled file, both as base64: the bytes differ at most in CRLF against LF. */
export function sameBytes(working: string, stored: string) {
  if (working === stored) return true;
  return lfBytes(Buffer.from(working, 'base64')).equals(lfBytes(Buffer.from(stored, 'base64')));
}

/** What Kiln adds to a checkout's own attributes: its files keep LF here whatever core.autocrlf says. Binary files are left alone. */
const ATTRIBUTES = ['workbench/** text=auto eol=lf', 'kiln.json text=auto eol=lf', 'KILN.md text=auto eol=lf', '.kiln/** text=auto eol=lf', '.github/workflows/kiln.yml text=auto eol=lf'];
const HEADER = '# Kiln: library files keep LF line endings in this checkout (revision hashes cover the exact text).';
/**
 * Writes those lines into the repository's `info/attributes`, which belongs to this checkout and is never committed, so later
 * checkouts and pulls bring library files with LF. Files already checked out with CRLF stay as they are; reconciliation reads
 * them as unchanged (`sameText`). Returns whether anything was added. Not a Git checkout, or not writable: nothing happens.
 */
export function keepLibraryLf(root: string) {
  try {
    let gitDir = path.join(root, '.git');
    const stat = fs.lstatSync(gitDir);
    if (stat.isFile()) {
      // A linked worktree or submodule: `.git` names the real folder, whose `commondir` holds the shared info/.
      const named = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))?.[1].trim(); if (!named) return false;
      gitDir = path.resolve(root, named);
      const common = path.join(gitDir, 'commondir');
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim());
    } else if (!stat.isDirectory()) return false;
    const file = path.join(gitDir, 'info', 'attributes');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const lines = new Set(current.split(/\r?\n/)), missing = ATTRIBUTES.filter(line => !lines.has(line));
    if (!missing.length) return false;
    const header = lines.has(HEADER) ? '' : `${HEADER}\n`;
    atomicWrite(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${header}${missing.join('\n')}\n`);
    return true;
  } catch { return false; }
}
