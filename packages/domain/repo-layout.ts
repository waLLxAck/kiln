import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { ProviderId } from '../protocol/schema';

/** The convention a skill folder was found under. `plugin`: inside a Claude plugin (a folder with `.claude-plugin/plugin.json`, or one a marketplace lists). `folder`: a SKILL.md anywhere else. */
export type SkillLayout = 'skills' | '.claude/skills' | '.agents/skills' | '.cursor/skills' | '.github/skills' | 'plugin' | 'folder';
/** A skill folder in a repository. `path` is relative to the repository root, '' when the root itself holds SKILL.md. */
export type FoundSkill = { path: string; name: string; layout: SkillLayout; plugin: string; /** False when a plugin lists its skills and leaves this one out (a deprecated or example skill): found, but not offered by default. */ listed: boolean };
/** An agent definition file, relative to the repository root, in the client format its location implies. */
export type FoundAgent = { path: string; provider: ProviderId; name: string };
export type RepoLayout = { skills: FoundSkill[]; agents: FoundAgent[]; /** Instruction files such as AGENTS.md and CLAUDE.md: noted, not imported. */ instructions: string[]; plugins: { name: string; path: string }[]; /** Relative path of the README nearest the scanned folder, '' when there is none. */ readme: string; licence: string; /** The walk stopped at its bound; what was found is still listed. */ truncated: boolean };

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.tox', '.next', '.cache']);
const MAX_ENTRIES = 50_000, MAX_DEPTH = 16;
const INSTRUCTIONS = /^(AGENTS|CLAUDE|GEMINI)\.md$/;
const LICENCE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'COPYING', 'COPYING.md'];

/** A short licence name for common licence texts; anything else points at the file. */
export function licenceName(text: string, file: string) {
  const checks: [RegExp, string][] = [[/MIT License|Permission is hereby granted, free of charge/i, 'MIT'], [/Apache License,?\s+Version 2\.0/i, 'Apache-2.0'], [/Mozilla Public License,?\s+(?:Version|v\.)\s*2\.0/i, 'MPL-2.0'], [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL'], [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'AGPL-3.0'], [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, 'GPL-3.0'], [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, 'GPL-2.0'], [/Attribution-ShareAlike 4\.0/i, 'CC-BY-SA-4.0'], [/Attribution 4\.0 International/i, 'CC-BY-4.0'], [/CC0 1\.0|No Copyright/i, 'CC0-1.0'], [/This is free and unencumbered software released into the public domain/i, 'Unlicense'], [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i, 'ISC'], [/Redistribution and use in source and binary forms/i, /Neither the name/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause']];
  return checks.find(([pattern]) => pattern.test(text))?.[1] ?? `See ${file}`;
}
/** The licence of a folder from its own LICENSE file, or '' when it has none. */
export function folderLicence(root: string, relative: string) {
  const name = LICENCE_FILES.find(file => { try { return fs.statSync(path.join(root, ...relative.split('/').filter(Boolean), file)).isFile(); } catch { return false; } });
  if (!name) return '';
  const file = [relative, name].filter(Boolean).join('/');
  return licenceName(fs.readFileSync(path.join(root, ...file.split('/'))).subarray(0, 20_000).toString('utf8'), file);
}
const frontmatter = (file: string) => { try { const text = fs.readFileSync(file, 'utf8').slice(0, 20_000); const meta = parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''); return meta && typeof meta === 'object' ? meta as Record<string, unknown> : {}; } catch { return {}; } };
const readJson = (file: string): Record<string, unknown> => { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
const clean = (relative: string) => path.posix.normalize(relative.replace(/\\/g, '/')).replace(/^\.\/?/, '').replace(/\/$/, '');
const within = (child: string, parent: string) => !parent || child === parent || child.startsWith(parent + '/');

/**
 * Finds what a checked-out repository offers, without running anything: every SKILL.md folder (under `skills/`, `.claude/skills`,
 * `.agents/skills`, `.cursor/skills`, `.github/skills`, Claude plugins, or anywhere), agent definitions (`.claude/agents`, plugin
 * `agents/`, `.github/agents`, `*.agent.md`, `.codex/agents/*.toml`, and a top-level `agents/` folder of Claude definitions), and
 * instruction files. `scope` limits the walk to one folder of the repository (a `/tree/<ref>/<path>` link). Symlinks are never
 * followed. A SKILL.md inside another skill's folder belongs to that skill's bundle and is not listed separately.
 */
export function detectLayout(root: string, scope = ''): RepoLayout {
  const start = clean(scope);
  const skillDirs: string[] = [], agentFiles: string[] = [], instructions: string[] = [], manifests: string[] = [];
  let count = 0, truncated = false;
  const walk = (relative: string, depth: number) => {
    if (depth > MAX_DEPTH) { truncated = true; return; }
    let entries: fs.Dirent[]; try { entries = fs.readdirSync(path.join(root, ...relative.split('/').filter(Boolean)), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > MAX_ENTRIES) { truncated = true; return; }
      if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(name, depth + 1); continue; }
      if (!entry.isFile()) continue;
      if (entry.name === 'SKILL.md') skillDirs.push(relative);
      else if (/\.(md|toml)$/i.test(entry.name)) agentFiles.push(name);
      if (INSTRUCTIONS.test(entry.name) || name.endsWith('.github/copilot-instructions.md')) instructions.push(name);
      if (/(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(name)) manifests.push(name);
    }
  };
  walk(start, 0);
  // Plugins: folders with .claude-plugin/plugin.json, and local sources listed by a marketplace.
  const plugins = new Map<string, { name: string; path: string; skills: string[] | null; agents: string[] }>();
  const addPlugin = (folder: string, fallback: string) => {
    const manifest = readJson(path.join(root, ...folder.split('/').filter(Boolean), '.claude-plugin', 'plugin.json'));
    const list = (value: unknown) => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter((v): v is string => typeof v === 'string').map(v => clean([folder, v].filter(Boolean).join('/')));
    if (!plugins.has(folder)) plugins.set(folder, { name: typeof manifest.name === 'string' ? manifest.name : fallback, path: folder, skills: manifest.skills === undefined ? null : list(manifest.skills), agents: list(manifest.agents) });
  };
  for (const file of manifests) {
    const folder = clean(path.posix.dirname(path.posix.dirname(file)));
    if (file.endsWith('plugin.json')) addPlugin(folder, path.basename(folder || root));
    else for (const plugin of (readJson(path.join(root, ...file.split('/'))).plugins as unknown[] | undefined) ?? []) {
      const source = (plugin as { source?: unknown; name?: unknown }).source, name = (plugin as { name?: unknown }).name;
      if (typeof source !== 'string' || /^[a-z]+:/i.test(source)) continue; // A plugin fetched from elsewhere is not in this repository.
      const target = clean([folder, source].filter(Boolean).join('/'));
      if (target === '..' || target.startsWith('../') || !within(target, start) && !within(start, target)) continue;
      if (fs.existsSync(path.join(root, ...target.split('/').filter(Boolean)))) addPlugin(target, typeof name === 'string' ? name : path.basename(target || root));
    }
  }
  const pluginOf = (relative: string) => [...plugins.values()].filter(p => within(relative, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
  // Outer skills own their subfolders.
  const outer = [...new Set(skillDirs)].sort((a, b) => a.length - b.length).filter((dir, i, all) => !all.slice(0, i).some(other => within(dir, other)));
  const skills: FoundSkill[] = outer.map(dir => {
    const plugin = pluginOf(dir), inPlugin = plugin && dir.slice(plugin.path.length).replace(/^\//, '').startsWith('skills/');
    const layout: SkillLayout = (['.claude/skills', '.agents/skills', '.cursor/skills', '.github/skills'] as const).find(prefix => within(dir, prefix) || dir.includes(`/${prefix}/`)) ?? (inPlugin || plugin?.skills?.includes(dir) ? 'plugin' : dir.split('/').includes('skills') ? 'skills' : 'folder');
    const meta = frontmatter(path.join(root, ...dir.split('/').filter(Boolean), 'SKILL.md'));
    return { path: dir, name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : path.posix.basename(dir || root), layout, plugin: plugin?.name ?? '', listed: !plugin?.skills || plugin.skills.includes(dir) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const skillOwned = (file: string) => outer.some(dir => within(file, dir));
  const agents: FoundAgent[] = [];
  for (const file of agentFiles) {
    if (skillOwned(file) || INSTRUCTIONS.test(path.posix.basename(file))) continue;
    const parts = file.split('/'), folder = parts.slice(0, -1).join('/'), plugin = pluginOf(file);
    let provider: ProviderId | null = null;
    if (file.endsWith('.toml')) provider = /(^|\/)\.codex\/agents$/.test(folder) ? 'codex' : null;
    else if (/\.agent\.md$/i.test(file) || /(^|\/)\.(github|copilot)\/agents$/.test(folder)) provider = 'copilot';
    else if (/(^|\/)\.claude\/agents(\/|$)/.test(folder) || (plugin && (folder === [plugin.path, 'agents'].filter(Boolean).join('/') || plugin.agents.includes(file)))) provider = 'claude';
    // A top-level agents/ folder only counts when the file is a Claude definition, so a folder of notes is not mistaken for agents.
    else if (folder === [start, 'agents'].filter(Boolean).join('/')) { const meta = frontmatter(path.join(root, ...parts)); if (typeof meta.name === 'string' && typeof meta.description === 'string') provider = 'claude'; }
    if (!provider) continue;
    const meta = provider === 'codex' ? {} : frontmatter(path.join(root, ...parts));
    agents.push({ path: file, provider, name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : path.posix.basename(file).replace(/(?:\.agent)?\.(md|toml)$/i, '') });
  }
  const readme = [start, ''].map(folder => ['README.md', 'readme.md', 'Readme.md', 'README'].map(name => [folder, name].filter(Boolean).join('/'))).flat().find(file => { try { return fs.statSync(path.join(root, ...file.split('/'))).isFile(); } catch { return false; } }) ?? '';
  return { skills, agents: agents.sort((a, b) => a.path.localeCompare(b.path)), instructions: instructions.filter(file => !skillOwned(file)).slice(0, 40), plugins: [...plugins.values()].map(({ name, path }) => ({ name, path })), readme, licence: folderLicence(root, start) || folderLicence(root, '') || 'Unknown', truncated };
}
