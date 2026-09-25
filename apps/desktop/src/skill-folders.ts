import type { Provider, ProviderId, Target } from '../../../packages/protocol/schema';
import { skillLocation, targetSkillsFolder, type SkillLocation } from '../../../packages/providers/skill-locations';

/** The personal environment for a provider: the personal-scope target rooted at the home folder, else the first personal-scope target. Mirrors DeploymentService.personalTarget. */
export function personalTarget(targets: Target[], providers: Provider[], id: ProviderId, native = false) {
  const home = providers.find(p => p.id === id)?.personalRoot.toLowerCase();
  const personal = targets.filter(t => t.provider === id && t.scope === 'personal' && Boolean(t.skillFolder) === native);
  return personal.find(t => t.root.toLowerCase() === home) ?? personal[0];
}

export type SourceFolder = { provider: Provider; native: boolean; location: SkillLocation; folder: string };
const normal = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
/**
 * The personal skill folders (Agents, Claude, Copilot-specific, Codex-specific) that directly hold one of these imported skill
 * folders but that Kiln does not manage yet. Until a folder is managed, the imported skills read "Not installed" even though a
 * copy sits there. Skills nested deeper (such as `.system/<name>`) are not where Kiln installs, so they don't count.
 */
export function unmanagedSourceFolders(paths: string[], providers: Provider[], targets: Target[]): SourceFolder[] {
  const parents = new Set(paths.map(p => normal(p).split('/').slice(0, -1).join('/')));
  const candidates = [...providers.map(provider => ({ provider, native: false })), ...providers.filter(p => p.id === 'codex').map(provider => ({ provider, native: true }))];
  return candidates.map(({ provider, native }) => {
    const shape = { provider: provider.id, scope: 'personal' as const, skillFolder: native ? '.codex/skills' as const : undefined };
    return { provider, native, location: skillLocation(shape), folder: `${provider.personalRoot}/${targetSkillsFolder(shape)}` };
  }).filter(candidate => parents.has(normal(candidate.folder)) && !personalTarget(targets, providers, candidate.provider.id, candidate.native));
}
