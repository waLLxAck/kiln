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
  return `Kiln uses your signed-in Codex or Claude Code CLI and sends the selected content and your instructions to that provider. Your account limits and any charges apply.\n\n${access} Imported content may contain misleading instructions.\n\nKiln asks the agent to make library edits through its CLI so they become revisions, but this is an instruction, not an enforced restriction. Capture, distillation and tests request read-only access. Raw conversations stay on this machine unless you explicitly export them.\n\nContinue only if you accept these conditions. You can restore this warning in Settings.`;
}

/** Consent is machine-private and versioned so materially changed conditions can be shown again. */
export class AgentConsent {
  constructor(private file: string) {}
  reset() { fs.rmSync(this.file, { force: true }); }
  async require(ask: () => Promise<{ response: number; checkboxChecked?: boolean }>) {
    try { if ((readJson(this.file) as { version?: number }).version === 1) return; } catch { /* Not accepted yet. */ }
    const answer = await ask();
    if (answer.response !== 1) throw new WorkbenchError('AGENT_CANCELLED', 'Agent interaction cancelled. Nothing was sent to the agent.');
    if (answer.checkboxChecked) writeJson(this.file, { version: 1, acceptedAt: new Date().toISOString() });
  }
}
