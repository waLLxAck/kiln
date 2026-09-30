import { MAX_ATTACHMENT_BASE64_LENGTH } from './limits';
import { z } from 'zod';

export const idSchema = z.string().uuid();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** `source` is material an agent analysed into entries (a pasted chat, a page, a video); those entries point back to it through `origin`. */
export const kindSchema = z.enum(['prompt', 'skill', 'agent', 'instruction', 'link', 'insight', 'technique', 'tool', 'resource', 'image', 'file', 'reference', 'source']);
export const statusSchema = z.enum(['captured', 'testing', 'approved', 'rejected', 'archived']);
/** Libraries written before v0.2 stored `inbox`; read it as `captured`. Files are rewritten on their next save. */
const legacyStatuses: Record<string, string> = { inbox: 'captured' };
export const storedStatusSchema = z.preprocess(value => typeof value === 'string' ? legacyStatuses[value] ?? value : value, statusSchema);
export const bundleSchema = z.object({
  content: z.string().max(2_000_000),
  files: z.record(z.string(), z.string().max(MAX_ATTACHMENT_BASE64_LENGTH)).default({}),
});
export const authoringSchema = z.object({
  title: z.string().trim().min(1).max(160), kind: kindSchema,
  /** One or two sentences on when the item is useful; shown under the title. Empty for most hand-captured items. */
  description: z.string().trim().max(600).default(''),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  // Collection paths are JSON metadata, not filesystem paths; nesting must not make stored items unreadable.
  collection: z.string().default('Personal'),
  source: z.string().max(2000).default(''), licence: z.string().max(200).default('Unknown'),
  agent: z.object({ provider: z.enum(['codex', 'claude', 'copilot']), filename: z.string().min(1).max(200) }).optional(),
  ...bundleSchema.shape,
});
export const itemSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, ...authoringSchema.omit({ content: true, files: true }).shape,
  status: storedStatusSchema, revision: hashSchema, favourite: z.boolean(), order: z.number(),
  createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable(),
  origin: z.object({ itemId: idSchema, revision: hashSchema }).nullable(),
  conflictHeads: z.array(hashSchema).optional(),
  /** Set on a copy moved to the trash by consolidation: the item it was merged into. Cleared when it is restored. */
  mergedInto: idSchema.optional(),
});
export const revisionSchema = z.object({
  hashVersion: z.literal(2).optional(),
  schemaVersion: z.literal(1), itemId: idSchema, hash: hashSchema, parent: hashSchema.nullable(),
  createdAt: z.string(), author: z.string(), summary: z.string(), ...authoringSchema.shape,
});
export const approvalSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, itemId: idSchema, revision: hashSchema,
  reviewer: z.string().trim().min(1), scope: z.string().trim().min(1), note: z.string(),
  evidence: z.array(idSchema), waivedChecks: z.string(), createdAt: z.string(),
  trust: z.enum(['local', 'imported']).default('local'),
  revokedAt: z.string().optional(),
  /** Set when Kiln carried an approval over a change that only turned model invocation on or off: the approved revision it came from. */
  carriedFrom: hashSchema.optional(),
});
export const trialSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, itemId: idSchema, revision: hashSchema,
  provider: z.enum(['codex', 'claude', 'manual']), mode: z.enum(['manual', 'codex']),
  variables: z.record(z.string(), z.string()), task: z.string(), rubric: z.array(z.string()),
  case: z.enum(['typical', 'boundary']), workspace: z.string(), machine: z.string(),
  permissionProfile: z.string(), agentVersion: z.string(), model: z.string(),
  status: z.enum(['prepared', 'completed', 'cancelled']), judgement: z.enum(['pass', 'fail', 'uncertain']).nullable(),
  note: z.string(), outputReference: z.string(), createdAt: z.string(), completedAt: z.string().nullable(),
  deletedAt: z.string().optional(),
});
export const targetSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(100), root: z.string().min(1),
  provider: z.enum(['codex', 'claude', 'copilot']), scope: z.enum(['project', 'personal']),
  skillFolder: z.literal('.codex/skills').optional(),
  profile: z.string().trim().min(1).max(80).default('Personal'), machine: z.literal('local'),
});
export const observationSchema = z.object({
  schemaVersion: z.literal(1), eventId: z.string().min(1).max(200), itemId: idSchema.nullable(),
  revision: hashSchema.nullable(), kind: z.enum(['copied', 'opened', 'test_prepared', 'test_completed', 'skill_invocation_observed', 'instruction_load_observed', 'inferred_access']),
  source: z.string().max(100), confidence: z.enum(['observed', 'inferred']),
  sessionId: z.string().max(200).default(''), occurredAt: z.string(),
});
/**
 * What one analysis of a source produced, shared with the library so it shows on every machine. The run itself (steps, commands,
 * session transcript) stays in the machine-private job; nothing here names a path.
 */
export const analysisSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, itemId: idSchema, revision: hashSchema, provider: z.enum(['codex', 'claude']),
  model: z.string().max(200), effort: z.string().max(40), usage: z.object({ input: z.number(), cached: z.number(), output: z.number(), reasoning: z.number() }).optional(),
  startedAt: z.string(), finishedAt: z.string(), summary: z.string().max(2000), takeaway: z.string().max(600), skipped: z.string().max(2000),
  counts: z.record(z.string(), z.number().int().nonnegative()), created: z.array(idSchema).max(200), collection: z.string(),
});
export type Analysis = z.infer<typeof analysisSchema>;
/** One change a score suggests. `line` is 1-based in the scored revision's content; absent when it applies to the whole document. */
export const scoreImprovementSchema = z.object({
  title: z.string().min(1).max(200), why: z.string().max(2000), severity: z.enum(['high', 'medium', 'low']),
  line: z.number().int().positive().optional(), suggestion: z.string().max(4000),
});
/**
 * One score of an exact revision against Kiln's writing-for-agents guidance, shared with the library like `analysisSchema`. The run
 * itself stays in the machine-private job. A score of an earlier revision is stale: it says nothing about the current one.
 */
export const scoreSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, itemId: idSchema, revision: hashSchema, provider: z.enum(['codex', 'claude']),
  model: z.string().max(200), effort: z.string().max(40), usage: z.object({ input: z.number(), cached: z.number(), output: z.number(), reasoning: z.number() }).optional(),
  startedAt: z.string(), finishedAt: z.string(), score: z.number().int().min(0).max(100), summary: z.string().max(2000),
  improvements: z.array(scoreImprovementSchema).max(50),
});
export type Score = z.infer<typeof scoreSchema>;
export type ScoreImprovement = z.infer<typeof scoreImprovementSchema>;
/** The latest score of a live item, for the library: the number and the revision it scored. */
export type ScoreSummary = { score: number; revision: string; finishedAt: string };
export type Item = z.infer<typeof itemSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type Authoring = z.infer<typeof authoringSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Trial = z.infer<typeof trialSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type Bundle = z.infer<typeof bundleSchema>;
/**
 * Items that look like copies of one another: same kind, and the same text, or the same name with mostly the same text.
 * `match` is the loosest link in the group: identical (text and bundled files), same-text (bundled files differ) or similar.
 * `similarity` is the lowest estimated overlap of the text between linked copies, 0 to 1.
 */
export type DuplicateGroup = { ids: string[]; match: 'identical' | 'same-text' | 'similar'; similarity: number };
/** Pairs of items the user said are not duplicates, stored in the library (`workbench/distinct.json`) so every machine agrees. */
export const distinctSchema = z.object({ schemaVersion: z.literal(1), pairs: z.array(z.tuple([idSchema, idSchema])).max(20_000) });
export type ItemDetail = { item: Item; revision: Revision; revisions: Revision[]; approvals: Approval[]; trials: Trial[]; observations: Observation[]; validation: string[]; duplicates: Item[]; /** Recorded analyses of this source, newest first. */ analyses: Analysis[]; /** Recorded scores of this item, newest first, any revision. */ scores?: Score[] };
export type Plan = { id: string; itemId: string; revision: string; targetId: string; destination: string; operation: 'create' | 'replace'; expectedState: string | null; proposedHash: string; files: Record<string, string>; createdAt: string; expiresAt: string; blocked: string | null };
export type Receipt = { id: string; planId: string; itemId: string; revision: string; targetId: string; destination: string; hash: string; previousHash: string | null; previousFiles: Record<string, string> | null; previousRevision: string | null; status: 'applied' | 'rolled_back' | 'uninstalled' | 'partial'; createdAt: string; newSessionRequired: true; error?: string };
export type Activity = { id: string; at: string; itemId: string | null; kind: string; message: string; revision?: string };
export type RunProviderId = 'codex' | 'claude';
export type ProviderId = RunProviderId | 'copilot';
export type Provider = { id: ProviderId; label: string; available: boolean; executable: string | null; version: string; authentication: 'owned by official client'; modes: ['manual']; skillsRoot: string; personalRoot: string; error?: string };
/** One skill folder inside an enrolled environment. `external` folders exist but were not written by Kiln; `matches` says whether their bytes equal the current library revision. */
export type Installation = { location?: 'agents' | 'claude' | 'codex' | 'copilot'; scope?: 'personal' | 'project'; itemId: string; targetId: string; provider: ProviderId; destination: string; state: 'installed' | 'external' | 'drifted'; linked: boolean; matches: boolean; receiptId: string | null; /** Set on an `installed` copy that is unchanged since Kiln wrote it but behind the approved revision, which Update would write. */ outdated?: true };
/** Desired personal installs, stored in the library so another machine can reproduce them. */
export type Installs = Record<string, (ProviderId | 'codex-native')[]>;
/** `codexModel`/`codexEffort` empty means "the CLI catalog default"; the resolved values are recorded on each agent job. */
export type Settings = { shortcut: string; launchAtLogin: boolean; theme: 'light' | 'dark' | 'system'; agentProvider: RunProviderId; codexModel: string; codexEffort: string; /** Codex model and effort that write commit messages when an approval is pushed. Cheaper than the main model; a failure falls back to a plain generated message. */ commitModel: string; commitEffort: string; /** Local folder scanned for newer `Kiln Setup <version>.exe` installers (normally the repository's `release` output). Empty disables update checks. */ updateSource: string };
/** Whether this library is a Kiln repository that can publish approvals: standard layout, Git, and a GitHub remote. Anything short of `ready` sends the desktop app to setup. */
export type RepositoryState = { standard: boolean; /** Created by Kiln to be nothing but a library. A skills repository that adopted the layout in place is an import source instead. */ dedicated: boolean; git: boolean; remote: boolean; ready: boolean };
/** `organise` (background sync): moves, collection changes and desired installs of items already on GitHub. */
export type PublishAction = 'approve' | 'unapprove' | 'organise';
export type PublishStatus = 'queued' | 'composing' | 'committing' | 'pushing' | 'done' | 'failed';
/** One approval (or withdrawal) on its way to GitHub. Approve returns immediately; this record tells the UI how far the commit and push got. */
export type PublishJob = { id: string; itemId: string; revision: string; title: string; action: PublishAction; status: PublishStatus; /** Final commit message; empty until composed. */ message: string; /** 'agent' when the model wrote the message, 'fallback' for the deterministic one. */ composer: 'agent' | 'fallback' | ''; commit: string; error?: string; startedAt: string; finishedAt?: string };
/** Result of a local update check. `available` is the newest installer in the update source whose version is above the running app. */
export type UpdateStage = { state: 'idle' } | { state: 'preparing'; version: string; progress: number } | { state: 'ready'; version: string } | { state: 'failed'; message: string };
export type UpdateStatus = { current: string; source: string; /** github: published releases (the default for published builds); setting: a folder chosen in Settings; build: the release folder of the repository this build came from; off: checks disabled; none: nothing to watch. */ sourceKind: 'github' | 'setting' | 'build' | 'off' | 'none'; packaged: boolean; /** For GitHub, `path` is the release page. */ available: { version: string; path: string } | null; stage: UpdateStage; /** Git commit this build was made from, when known. */ commit: string; /** False for a watched folder on macOS and Linux: that path runs the Windows installer. */ supported?: boolean; /** GitHub only. app: downloads and installs in place; download: the new version is downloaded from the release page by hand. */ install?: 'app' | 'download'; /** GitHub only: when the last check finished. */ checkedAt?: string; error?: string };
export type Snapshot = { schemaVersion: 1; root: string; items: Item[]; trials: Trial[]; approvals: Approval[]; targets: Target[]; receipts: Receipt[]; activity: Activity[]; warnings: string[]; collections: string[]; git: { attached: boolean; branch: string; changes: string[]; commit: string; remote: string; ahead: number; /** Commits on GitHub, as of the last fetch, that this machine has not pulled. */ behind: number; error?: string }; repository: RepositoryState; /** Approvals on their way to GitHub, newest first. Filled by the router; the bare workbench reports none. */ publish: PublishJob[]; settings: Settings; installs: Installs; coverage: string; /** Per item id: times copied, and every usage observation (copies, opens, tests, agent use). Items never used are absent. */ usage: Usage; /** Likely duplicates among live items, not counting pairs marked as distinct. */ duplicates: DuplicateGroup[]; /** Per live skill id: whether its current revision lets each client's model invoke it (packages/domain/invocation.ts). */ invocation: Record<string, SkillListing>; /** Per live item id: its latest score (stale when `revision` is not the item's). Items never scored are absent. */ scores?: Record<string, ScoreSummary> };
export type Usage = Record<string, { copied: number; used: number }>;
/**
 * Whether a skill's own files let the model invoke it on its own (packages/domain/invocation.ts). `claude`: no
 * `disable-model-invocation: true` in SKILL.md (Claude Code, and clients reading the same key). `codex`: no
 * `policy.allow_implicit_invocation: false` in `agents/openai.yaml` (Codex only).
 */
export type SkillInvocation = { claude: boolean; codex: boolean };
/** A live skill's invocation switches and the size (characters) of the entry harnesses list for it at session start. */
export type SkillListing = SkillInvocation & { chars: number };
/**
 * Where a copy sits, as a key that means the same thing on every machine and names no path: a personal skill location
 * (`agents`, `claude`, `codex`, `copilot`) or an enrolled project folder by its folder name (`project:<name>`, plus `:<location>`
 * when the project is enrolled for a location other than the shared Agents one).
 */
export const locationKeySchema = z.string().regex(/^(?:agents|claude|codex|copilot|project:[^/\\:\u0000-\u001f]{1,120}(?::(?:agents|claude|codex|copilot))?)$/);
export const copyStateSchema = z.enum(['installed', 'changed', 'external', 'outdated']);
/**
 * One machine's installs, committed to the library as `workbench/machines/<id>.json` so every machine can see the fleet. Written
 * by its owner, except `wanted`, which any machine may edit to ask the owner to install something the next time it syncs.
 */
export const machineReportSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, name: z.string().trim().min(1).max(80), platform: z.string().max(20), appVersion: z.string().max(40), reportedAt: z.string().max(40),
  locations: z.array(z.object({ key: locationKeySchema, label: z.string().max(160), scope: z.enum(['personal', 'project']), /** False for a folder that holds copies but that Kiln does not manage on that machine. */ managed: z.boolean() })).max(500),
  /** Per item id, per location key: the revision in the folder (null when it matches none Kiln knows) and how it compares. */
  copies: z.record(idSchema, z.record(locationKeySchema, z.object({ revision: hashSchema.nullable(), state: copyStateSchema }))),
  /** Per item id: the location keys marked for this machine. */
  wanted: z.record(idSchema, z.array(locationKeySchema).max(200)),
});
export const machineIdentitySchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(80), platform: z.string().max(20) });
export type LocationKey = z.infer<typeof locationKeySchema>;
export type CopyState = z.infer<typeof copyStateSchema>;
export type MachineReport = z.infer<typeof machineReportSchema>;
export type MachineIdentity = z.infer<typeof machineIdentitySchema>;
/** A change to a machine's `wanted` list (another machine's or this one's) that has not reached GitHub yet. */
export type WantedEdit = { machineId: string; itemId: string; location: LocationKey; wanted: boolean; at: string };
/**
 * How far this machine's report got. shared: GitHub has it; queued/publishing: on its way; behind: GitHub moved ahead, so the
 * report and any marks wait for a pull; failed: the last attempt failed for another reason; unavailable: the library has no
 * GitHub remote to share through.
 */
export type FleetPublish = { state: 'idle' | 'queued' | 'publishing' | 'shared' | 'behind' | 'failed' | 'unavailable'; /** reportedAt of this machine's report on GitHub, if any. */ sharedAt: string | null; commit: string; error?: string; finishedAt?: string };
/** What the Machines view needs besides the snapshot: who this machine is, what it was asked to install, and the other machines' reports. */
export type FleetView = { self: MachineIdentity; /** This machine's wanted list: the committed one with unsent local edits applied. */ wanted: MachineReport['wanted']; publish: FleetPublish; /** Other machines only; this machine is always computed live. */ machines: MachineReport[]; /** Where the reports were read from: the fetched GitHub branch, this checkout, or nowhere (no Git). */ source: 'upstream' | 'head' | 'none'; fetchedAt: string | null; fetchError?: string; pending: WantedEdit[]; appVersion: string; ready: boolean };
export type RpcResponse = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
export interface Bridge { call<T = unknown>(method: string, args?: unknown): Promise<T>; /** `process.platform` of the desktop app, for platform-specific wording and controls. */ platform?: string; }
