import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { capture } from '../agent/process';
import { detectProviders, resetProviderDetection } from './service';
import type { Provider, RunProviderId } from '../protocol/schema';
import { mergePath } from './path';
import { invariant } from '../domain/errors';
import { writeJson } from '../storage/files';

const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' };
export type ClientUpdate = { provider: RunProviderId; latestVersion?: string; updateAvailable: boolean; error?: string };
const version = (value: string) => value.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
/** Compare stable releases without offering a downgrade to users already on a newer prerelease. */
export function isNewerClient(latest: string, installed: string) {
  const current = version(installed); if (!current || !/^\d+\.\d+\.\d+$/.test(latest)) return false;
  const left = latest.split('.').map(Number), right = current.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return current.includes('-');
}
type Options = { fetch?: typeof fetch; run?: typeof capture; detect?: typeof detectProviders; reset?: () => void; platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; stateFile?: string; onProcess?: (pid: number, running: boolean) => void };
/** Explicit Settings actions only: checking metadata never installs or executes an installer. */
export class OfficialClients {
  private latest = new Map<RunProviderId, { at: number; version: string }>();
  private busy = false;
  private request: typeof fetch;
  private run: typeof capture;
  get installing() { return this.busy; }
  constructor(private options: Options = {}) {
    this.request = options.fetch ?? fetch; this.run = options.run ?? capture;
    // Remember native installers selected from Kiln, so an older npm shim cannot win again on restart.
    if (options.stateFile) try {
      const { bins } = z.object({ bins: z.array(z.string().refine(path.isAbsolute)).max(4) }).parse(JSON.parse(fs.readFileSync(options.stateFile, 'utf8')));
      const env = options.env ?? process.env;
      env.PATH = mergePath([...bins.filter(bin => fs.existsSync(bin)), env.PATH ?? env.Path], (options.platform ?? process.platform) === 'win32' ? ';' : ':');
      (options.reset ?? resetProviderDetection)();
    } catch { /* No prior Kiln installation, or a stale private record. */ }
  }
  async updates(force = false): Promise<ClientUpdate[]> {
    const providers = await (this.options.detect ?? detectProviders)();
    return Promise.all((['codex', 'claude'] as const).map(async provider => {
      try {
        let hit = this.latest.get(provider);
        if (force || !hit || Date.now() - hit.at > 10 * 60_000) {
          const response = await this.request(`https://registry.npmjs.org/${packages[provider]}/latest`, { signal: AbortSignal.timeout(15_000) });
          invariant(response.ok, 'UPDATE_CHECK_FAILED', 'Could not check the latest CLI version. Try again.');
          const data = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(await response.json());
          hit = { at: Date.now(), version: data.version }; this.latest.set(provider, hit);
        }
        const installed = providers.find(p => p.id === provider);
        return { provider, latestVersion: hit.version, updateAvailable: Boolean(installed?.available && isNewerClient(hit.version, installed.version)) };
      } catch { return { provider, updateAvailable: false, error: 'Could not check for updates. Try again.' }; }
    }));
  }
  async install(input: unknown): Promise<Provider[]> {
    const { provider } = z.object({ provider: z.enum(['codex', 'claude']), confirm: z.literal(true) }).parse(input);
    invariant(!this.busy, 'INSTALL_BUSY', 'Wait for the current CLI installation to finish.');
    this.busy = true;
    let folder: string | undefined;
    try {
      const platform = this.options.platform ?? process.platform, home = this.options.home ?? os.homedir();
      invariant(['win32', 'darwin', 'linux'].includes(platform), 'UNSUPPORTED_PLATFORM', 'CLI installation supports Windows, macOS and Linux.');
      const windows = platform === 'win32', env = this.options.env ?? process.env;
      const url = provider === 'codex' ? `https://chatgpt.com/codex/install.${windows ? 'ps1' : 'sh'}` : `https://claude.ai/install.${windows ? 'ps1' : 'sh'}`;
      const response = await this.request(url, { signal: AbortSignal.timeout(30_000) });
      invariant(response.ok, 'INSTALL_DOWNLOAD_FAILED', 'Could not download the official installer. Try again.');
      const script = await response.text();
      invariant(script.length > 50 && Buffer.byteLength(script) < 4_000_000 && !/^\s*<(?:!doctype\s+html|html)\b/i.test(script), 'INVALID_INSTALLER', 'The official installer download was invalid. Try again.');
      folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-cli-install-'));
      const file = path.join(folder, `install.${windows ? 'ps1' : 'sh'}`); fs.writeFileSync(file, script);
      const executable = windows ? path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : provider === 'claude' ? '/bin/bash' : '/bin/sh';
      const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] : [file];
      const result = await this.run(executable, args, { timeoutMs: 10 * 60_000, cwd: home, env: { ...env, CODEX_NON_INTERACTIVE: '1', CODEX_RELEASE: 'latest' }, limit: 12_000, onProcess: this.options.onProcess });
      invariant(!result.timedOut && result.code === 0, 'INSTALL_FAILED', result.timedOut ? 'The installation timed out. Check your connection and try again.' : `The official installer failed. ${result.output.trim().slice(-2000)}`);
      // Native installers can add a new bin directory. Make it usable in this process without restarting Kiln.
      const bins = windows ? [path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin'), path.join(home, '.local', 'bin')] : [path.join(home, '.local', 'bin')];
      env.PATH = mergePath([...bins, env.PATH ?? env.Path], windows ? ';' : ':');
      (this.options.reset ?? resetProviderDetection)();
      const providers = await (this.options.detect ?? detectProviders)();
      invariant(providers.some(p => p.id === provider && p.available), 'INSTALL_NOT_FOUND', 'The installer finished, but the CLI could not be detected. Restart Kiln, then detect again.');
      if (this.options.stateFile) writeJson(this.options.stateFile, { bins });
      return providers;
    } finally { if (folder) try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* A locked temporary file must not hide the installation result. */ } this.busy = false; }
  }
}
