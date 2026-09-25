import fs from 'node:fs';
import { readJson, writeJson } from '../../packages/storage/files';
import { WorkbenchError } from '../../packages/domain/errors';

/** Only explicit agent actions ask for consent; ordinary desktop mutations never invoke a model. */
export function usesAgent(method: string, args: unknown) {
  const value = (args ?? {}) as Record<string, unknown>;
  return method === 'agent.chat' || method === 'agent.start'
    || method === 'agent.capture' && value.analyze !== false;
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
