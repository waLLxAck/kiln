import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { agentFolder, agentMetadata } from './agent-format';
import { authoringSchema, type ProviderId } from '../protocol/schema';
import type { Workbench } from './workbench';
import { digest } from '../storage/files';
import { invariant } from './errors';
import { validateContent } from './content';

const providerSchema = z.enum(['codex', 'claude', 'copilot']);
export type AgentFile = { path: string; provider: ProviderId; name: string; imported: boolean; validation: string[]; error: string };
function bundle(file: string, provider: ProviderId) {
  invariant(path.isAbsolute(file) && fs.statSync(file).isFile() && fs.statSync(file).size <= 2_000_000, 'INVALID_AGENT', 'Choose an agent definition file smaller than 2 MB.');
  const content = fs.readFileSync(file, 'utf8');
  let meta: Record<string, unknown> = {}; try { meta = agentMetadata(content, provider); } catch { /* Invalid files can be imported as drafts for repair. */ }
  return authoringSchema.parse({ kind: 'agent', agent: { provider, filename: path.basename(file) }, title: typeof meta.name === 'string' ? meta.name : path.basename(file).replace(/(?:\.agent)?\.(md|toml)$/, ''), description: typeof meta.description === 'string' ? meta.description.slice(0, 600) : '', content, source: `local:${file}`, collection: 'Imported agents', tags: ['imported'] });
}
const key = (value: { content: string; agent?: { provider: ProviderId } }) => digest({ content: value.content.replace(/\r\n/g, '\n'), provider: value.agent?.provider });
function known(wb: Workbench) { return new Set(wb.listItems().filter(i => i.kind === 'agent').map(i => key(wb.getRevision(i.id)))); }
export function scanAgents(wb: Workbench, input: unknown) {
  const data = z.object({ root: z.string().optional(), provider: providerSchema.optional() }).parse(input);
  const home = process.env.KILN_HOME ?? os.homedir();
  const roots = data.root ? [{ root: data.root, provider: data.provider ?? 'copilot' }] : [
    ...(['codex', 'claude', 'copilot'] as const).map(provider => ({ provider, root: path.join(home, agentFolder(provider)) })),
    ...wb.targets().filter(t => t.scope === 'project').map(t => ({ provider: t.provider, root: path.join(t.root, agentFolder(t.provider, t.scope)) })),
  ];
  const entries: AgentFile[] = [], seen = new Set<string>(), existing = known(wb);
  const visit = (root: string, provider: ProviderId, depth = 0) => {
    if (!fs.existsSync(root) || depth > 8) return;
    const real = fs.realpathSync(root); if (seen.has(`${provider}:${real}`)) return; seen.add(`${provider}:${real}`);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) visit(file, provider, depth + 1);
      else if (entry.isFile() && (provider === 'codex' ? /\.toml$/i : /\.md$/i).test(entry.name)) {
        try { const value = bundle(file, provider); entries.push({ path: file, provider, name: value.title, imported: existing.has(key(value)), validation: validateContent(value), error: '' }); }
        catch (e) { entries.push({ path: file, provider, name: entry.name, imported: false, validation: [], error: String(e) }); }
      }
    }
  };
  for (const { root, provider } of roots) { invariant(path.isAbsolute(root), 'INVALID_PATH', 'Choose an absolute folder path.'); visit(root, provider); }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
export function importAgents(wb: Workbench, input: unknown) {
  const data = z.object({ files: z.array(z.object({ path: z.string(), provider: providerSchema })).min(1).max(2000), confirm: z.literal(true) }).parse(input);
  const existing = known(wb), imported: string[] = [], failed: string[] = [];
  for (const file of data.files) {
    try { const value = bundle(file.path, file.provider), hash = key(value); if (existing.has(hash)) continue; imported.push(wb.create(value).id); existing.add(hash); }
    catch (e) { failed.push(`${file.path}: ${String(e)}`); }
  }
  return { imported, failed };
}
