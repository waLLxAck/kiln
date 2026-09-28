// What the Config files view needs to know about a file without reading it (agent, purpose), and the edits the structured
// settings editor makes. Edits are applied to the JSON text itself, so unknown keys, key order and indentation survive.
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type JSONPath, type ParseError } from 'jsonc-parser/lib/esm/main';
import type { HomeFile, HomeFileKind } from '../../../packages/home/service';

export type Purpose = 'instructions' | 'settings' | 'hooks' | 'mcp' | 'profile';
export const purposeLabel: Record<Purpose, string> = { instructions: 'Instructions', settings: 'Permissions & settings', hooks: 'Hooks', mcp: 'MCP', profile: 'Shell profile' };
/** Agent groups in the tree, in display order. */
export const agentOrder: HomeFileKind[] = ['claude', 'codex', 'copilot', 'vscode', 'agents', 'powershell', 'custom'];
export const agentLabel: Record<HomeFileKind, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot', vscode: 'VS Code', agents: 'Shared', powershell: 'Shell profiles', custom: 'Added by you' };

type FileRef = Pick<HomeFile, 'kind' | 'path'>;
const base = (file: string) => file.split(/[\\/]/).at(-1) ?? file;
/** What a file is for, from its name alone: the tree's purpose icon and filter chips. */
export function purposeOf(file: FileRef): Purpose {
  const name = base(file.path).toLowerCase();
  if (file.kind === 'powershell' || /\.(ps1|psm1|sh)$|^\.(bash|zsh)rc$|^\.profile$/.test(name)) return 'profile';
  if (name.endsWith('.md')) return 'instructions';
  if (/mcp[\w.-]*\.json$/.test(name)) return 'mcp';
  if (/hooks/.test(name) || /[\\/]hooks[\\/][^\\/]+$/i.test(file.path)) return 'hooks';
  return 'settings';
}
/** Claude Code settings files (personal, project shared and project local): they get the Permissions and Hooks editors. */
export function isClaudeSettings(file: FileRef & { key?: string }): boolean {
  if (file.key === 'claude-settings') return true;
  const settings = /[\\/]\.claude[\\/]settings(\.local)?\.json$/i.test(file.path);
  return settings && (file.kind === 'claude' || file.kind === 'custom');
}
/** The folder name for a project scope ("Project · /home/me/app" → "app"); "Personal" otherwise. */
export function scopeName(scope: string | undefined): string {
  if (!scope?.startsWith('Project · ')) return scope ?? 'Personal';
  return base(scope.slice('Project · '.length).replace(/[\\/]+$/, ''));
}

export const columns = ['allow', 'ask', 'deny'] as const;
export type Column = typeof columns[number];
export type HookRow = { event: string; group: number; index: number; matcher: string; type: string; command: string };
export type HookInput = { event: string; matcher: string; command: string };
/** The parts of a settings file the structured tabs show. A null section means its shape is not one Kiln edits safely. */
export type ClaudeSettings = { rules: Record<Column, string[]> | null; rulesProblem?: string; otherPermissions: string[]; hooks: HookRow[] | null; hooksProblem?: string };
export type Parsed = { ok: true; data: Record<string, unknown>; settings: ClaudeSettings } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Strict JSON, like the save check for these files, with the position of the first problem when there is one. */
export function parseSettings(text: string): Parsed {
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) {
    const errors: ParseError[] = []; parseJsonc(text, errors, { allowTrailingComma: false, disallowComments: true });
    if (errors[0]) { const before = text.slice(0, errors[0].offset).split('\n'); return { ok: false, error: `${readable(printParseErrorCode(errors[0].error))} at line ${before.length}, column ${before.at(-1)!.length + 1}` }; }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!isObject(data)) return { ok: false, error: 'The file must hold a JSON object ({ … })' };
  return { ok: true, data, settings: readSettings(data) };
}
const readable = (code: string) => code.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()).replace(/ (\w)/g, (_, c: string) => ` ${c.toLowerCase()}`);

function readSettings(data: Record<string, unknown>): ClaudeSettings {
  const result: ClaudeSettings = { rules: null, otherPermissions: [], hooks: null };
  const permissions = data.permissions;
  if (permissions === undefined || isObject(permissions)) {
    const rules = { allow: [], ask: [], deny: [] } as Record<Column, string[]>;
    const bad = columns.find(column => { const value = permissions?.[column]; return value !== undefined && !(Array.isArray(value) && value.every(rule => typeof rule === 'string')); });
    if (bad) result.rulesProblem = `permissions.${bad} is not a list of rules.`;
    else { for (const column of columns) rules[column] = (permissions?.[column] as string[] | undefined) ?? []; result.rules = rules; }
    result.otherPermissions = Object.keys(permissions ?? {}).filter(key => !(columns as readonly string[]).includes(key));
  } else result.rulesProblem = 'permissions is not an object.';
  const hooks = data.hooks;
  if (hooks === undefined) result.hooks = [];
  else if (!isObject(hooks)) result.hooksProblem = 'hooks is not an object.';
  else {
    const rows: HookRow[] = [];
    const ok = Object.entries(hooks).every(([event, groups]) => Array.isArray(groups) && groups.every((group, g) => {
      if (!isObject(group) || (group.matcher !== undefined && typeof group.matcher !== 'string') || !Array.isArray(group.hooks)) return false;
      return group.hooks.every((hook, index) => {
        if (!isObject(hook)) return false;
        const command = typeof hook.command === 'string' ? hook.command : typeof hook.prompt === 'string' ? hook.prompt : '';
        rows.push({ event, group: g, index, matcher: (group.matcher as string | undefined) ?? '', type: typeof hook.type === 'string' ? hook.type : 'command', command });
        return true;
      });
    }));
    if (ok) result.hooks = rows; else result.hooksProblem = 'hooks has a shape Kiln does not edit.';
  }
  return result;
}

/** Indentation as the file already uses it, so structured edits look hand-written. */
function formatting(text: string) {
  const indent = /^([ \t]+)["}\]]/m.exec(text)?.[1] ?? '  ';
  return { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 1 : indent.length, eol: '\n' };
}
function edit(text: string, path: JSONPath, value: unknown, getInsertionIndex?: (properties: string[]) => number) {
  return applyEdits(text, modify(text, path, value, { formattingOptions: formatting(text), getInsertionIndex }));
}
/** A new permission list goes next to its neighbours (allow, ask, deny) rather than at the end of the object. */
const columnSlot = (column: Column) => (properties: string[]) => {
  const before = columns.slice(0, columns.indexOf(column)).map(c => properties.indexOf(c)).filter(i => i >= 0);
  if (before.length) return Math.max(...before) + 1;
  const after = columns.slice(columns.indexOf(column) + 1).map(c => properties.indexOf(c)).filter(i => i >= 0);
  return after.length ? Math.min(...after) : properties.length;
};

const RULE = /^[A-Za-z][\w.-]*(\(.+\))?$/;
/** Light format check for a permission rule: `Tool` or `Tool(specifier)`. Returns a message when the rule looks wrong. */
export function checkRule(rule: string, rules: Record<Column, string[]>): string | null {
  if (!RULE.test(rule)) return 'Use Tool or Tool(pattern), for example Bash(npm run build:*)';
  const existing = columns.find(column => rules[column].includes(rule));
  return existing ? `Already in ${columnLabel[existing]}` : null;
}
export const columnLabel: Record<Column, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };

function rulesOf(text: string): Record<Column, string[]> {
  const parsed = parseSettings(text);
  if (!parsed.ok || !parsed.settings.rules) throw new Error('The permissions in this file cannot be edited here.');
  return parsed.settings.rules;
}
export function addRule(text: string, column: Column, rule: string): string {
  const rules = rulesOf(text);
  const present = (JSON.parse(text).permissions ?? {})[column] !== undefined;
  return present ? edit(text, ['permissions', column, -1], rule) : edit(text, ['permissions', column], [...rules[column], rule], columnSlot(column));
}
export function removeRule(text: string, column: Column, rule: string): string {
  const index = rulesOf(text)[column].indexOf(rule);
  return index < 0 ? text : edit(text, ['permissions', column, index], undefined);
}
export function moveRule(text: string, from: Column, to: Column, rule: string): string {
  return from === to ? text : addRule(removeRule(text, from, rule), to, rule);
}

function hooksOf(text: string): { rows: HookRow[]; data: Record<string, unknown> } {
  const parsed = parseSettings(text);
  if (!parsed.ok || !parsed.settings.hooks) throw new Error('The hooks in this file cannot be edited here.');
  return { rows: parsed.settings.hooks, data: parsed.data };
}
/** Adds a command hook, joining an existing group with the same event and matcher when there is one. */
export function addHook(text: string, hook: HookInput, body: Record<string, unknown> = { type: 'command', command: hook.command }): string {
  const { data } = hooksOf(text);
  const groups = (data.hooks as Record<string, { matcher?: string; hooks: unknown[] }[]> | undefined)?.[hook.event];
  if (!groups) return edit(text, ['hooks', hook.event], [{ ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [body] }]);
  const same = groups.findIndex(group => (group.matcher ?? '') === hook.matcher);
  if (same >= 0) return edit(text, ['hooks', hook.event, same, 'hooks', -1], body);
  return edit(text, ['hooks', hook.event, -1], { ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [body] });
}
/** Removes one hook, then its group and its event when they become empty. */
export function removeHook(text: string, row: Pick<HookRow, 'event' | 'group' | 'index'>): string {
  const { data } = hooksOf(text);
  const hooks = data.hooks as Record<string, { hooks: unknown[] }[]>;
  const groups = hooks[row.event];
  if (!groups?.[row.group]?.hooks[row.index]) return text;
  if (groups[row.group].hooks.length > 1) return edit(text, ['hooks', row.event, row.group, 'hooks', row.index], undefined);
  if (groups.length > 1) return edit(text, ['hooks', row.event, row.group], undefined);
  const next = edit(text, ['hooks', row.event], undefined);
  // An emptied object is left as "{\n  }" by the edit; write it back as {} instead.
  return Object.keys(hooks).length === 1 ? edit(next, ['hooks'], {}) : next;
}
/** Changes a hook's command in place; a new event or matcher moves it to the matching group, keeping its other fields (timeout…). */
export function updateHook(text: string, row: HookRow, next: HookInput): string {
  if (next.event === row.event && next.matcher === row.matcher) return edit(text, ['hooks', row.event, row.group, 'hooks', row.index, row.type === 'command' ? 'command' : 'prompt'], next.command);
  const { data } = hooksOf(text);
  const original = (data.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>)[row.event][row.group].hooks[row.index];
  return addHook(removeHook(text, row), next, { ...original, [row.type === 'command' ? 'command' : 'prompt']: next.command });
}

/** How many rules and hooks differ between two versions: the count in the unsaved bar. */
export function countSettingsChanges(a: ClaudeSettings, b: ClaudeSettings): number {
  let n = 0;
  if (a.rules && b.rules) {
    const where = (rules: Record<Column, string[]>) => new Map(columns.flatMap(column => rules[column].map(rule => [rule, column] as const)));
    const wa = where(a.rules), wb = where(b.rules);
    for (const rule of new Set([...wa.keys(), ...wb.keys()])) if (wa.get(rule) !== wb.get(rule)) n++;
  }
  if (a.hooks && b.hooks) {
    const key = (hook: HookRow) => `${hook.event}\n${hook.matcher}\n${hook.type}\n${hook.command}`;
    const left = a.hooks.map(key), right = b.hooks.map(key);
    let removed = 0, added = 0;
    for (const k of new Set([...left, ...right])) { const d = right.filter(x => x === k).length - left.filter(x => x === k).length; if (d > 0) added += d; else removed -= d; }
    // An edited hook is one removal plus one addition; count it once.
    n += Math.max(removed, added);
  }
  return n;
}
