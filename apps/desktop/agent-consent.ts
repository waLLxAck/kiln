import fs from 'node:fs';
import { readJson, writeJson } from '../../packages/storage/files';
import { WorkbenchError } from '../../packages/domain/errors';

/** Only explicit agent actions ask for consent; ordinary desktop mutations never invoke a model. */
export function usesAgent(method: string, args: unknown) {
  const value = (args ?? {}) as Record<string, unknown>;
  return method === 'agent.chat' || method === 'agent.start'
    || method === 'agent.capture' && value.analyze !== false;
}

/**
 * The consent dialog's explanation. Codex's sandbox differs by platform (see codexArguments in packages/agent/codex.ts): on
 * Windows a writing chat runs with `danger-full-access`, elsewhere in Codex's `workspace-write` sandbox limited to the library
 * and the chat's working folder. Claude chat is never confined.
 */
export function agentConsentDetail(platform: NodeJS.Platform = process.platform) {
  const access = platform === 'win32'
    ? 'Chat runs with read/write access and can execute commands. On Windows, Codex chat runs without a sandbox; Claude chat can use Bash, Write and Edit. Access is not confined to this item or to Kiln’s library. The agent can change or delete files your account can access.'
    : 'Chat runs with read/write access and can execute commands. Codex chat runs in Codex’s workspace-write sandbox: it can read files your account can read, but it can only write to Kiln’s library, the chat’s working folder and temporary folders. Claude chat can use Bash, Write and Edit, and its access is not confined to this item or to Kiln’s library: it can change or delete files your account can access.';
  const tune = platform === 'win32'
    ? 'Tune (skills only) also runs with read/write access: it edits a private copy of the skill in its own run folder, runs its measuring script and starts a trial agent. On Windows, Codex runs it without a sandbox; Claude Code can use Bash, Write, Edit and subagents, and its commands are not confined to that folder.'
    : 'Tune (skills only) also runs with read/write access: it edits a private copy of the skill in its own run folder, runs its measuring script and starts a trial agent. Codex runs it in its workspace-write sandbox, writing only to that folder and temporary folders; Claude Code can use Bash, Write, Edit and subagents, and its commands are not confined to that folder.';
  return `Kiln uses your signed-in Codex or Claude Code CLI and sends the selected content and your instructions to that provider. Your account limits and any charges apply.\n\n${access} ${tune} Imported content may contain misleading instructions.\n\nKiln asks the agent to make library edits through its CLI so they become revisions, but this is an instruction, not an enforced restriction. Tune changes reach the library only when you accept its diff. Capture, distillation, tests and scores request read-only access. Raw conversations stay on this machine unless you explicitly export them.\n\nContinue only if you accept these conditions. You can restore this warning in Settings.`;
}

/** Version of the conditions above. 2 added Tune's write access, so an earlier "Don't show again" asks once more. */
export const CONSENT_VERSION = 2;
/** Consent is machine-private and versioned so materially changed conditions can be shown again. */
export class AgentConsent {
  /** A chat message was accepted since Kiln started, which covers later chat messages until it quits. Never written to disk. */
  private chatAccepted = false;
  constructor(private file: string) {}
  reset() { fs.rmSync(this.file, { force: true }); this.chatAccepted = false; }
  /** `chatSession` marks a chat message: one acceptance then covers chat for the rest of this app session. */
  async require(ask: () => Promise<{ response: number; checkboxChecked?: boolean }>, { chatSession = false }: { chatSession?: boolean } = {}) {
    try { if ((readJson(this.file) as { version?: number }).version === CONSENT_VERSION) return; } catch { /* Not accepted yet. */ }
    if (chatSession && this.chatAccepted) return;
    const answer = await ask();
    if (answer.response !== 1) throw new WorkbenchError('AGENT_CANCELLED', 'Agent interaction cancelled. Nothing was sent to the agent.');
    if (answer.checkboxChecked) writeJson(this.file, { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() });
    if (chatSession) this.chatAccepted = true;
  }
}
