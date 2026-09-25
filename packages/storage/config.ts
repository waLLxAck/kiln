import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './files';
export const privateRoot = () => process.env.KILN_LOCAL ?? path.join(os.homedir(), '.kiln');
const configFile = () => path.join(privateRoot(), 'library.json');
export function defaultLibrary() {
  if (process.env.KILN_LIBRARY) return process.env.KILN_LIBRARY;
  const config = fs.existsSync(configFile()) ? readJson(configFile()) as { root?: string } : null;
  return config?.root ?? path.join(os.homedir(), '.kiln', 'library');
}
export function selectLibrary(root: string) { writeJson(configFile(), { root }); }
