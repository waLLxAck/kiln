import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { detectProviders } from '../providers/service';
/** One JSONL event from `codex exec --json`. Only the fields Kiln reads are typed; everything else is passed through. */
export type CodexEvent = { type: string; thread_id?: string; usage?: Record<string, number>; error?: { message?: string }; message?: string; item?: { id: string; type: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; status?: string; query?: string; message?: string; server?: string; tool?: string; changes?: { path: string; kind: string }[]; items?: { text: string; completed: boolean }[] } };
export type CodexModel = { slug: string; name: string; description: string; defaultEffort: string; efforts: string[] };
/** Progress events are the provider's own parsed JSONL objects (Codex `codex exec --json`, Claude `--output-format stream-json`); the service maps them to job steps. */
export type AgentEvent = { type: string; [key: string]: unknown };
export type RunInput = {
  /** Kiln's folder for this run: schema, trace and result files are written here. */
  folder: string;
  prompt: string;
  /** JSON Schema the final answer must satisfy. Absent means a free-text reply, returned as a string. */
  schema?: object;
  images: string[];
  /** Provider model slug; empty means the CLI default. */
  model?: string;
  /** Reasoning effort for providers that support it; empty means the model default. */
  effort?: string;
  /** Wall-clock limit for the CLI run; providers apply their own default when omitted. */
  timeoutMs?: number;
  /** Folder the CLI works in; defaults to `folder`. Continued conversations reuse the first run's folder so the CLI finds its session. */
  workdir?: string;
  /** Keep the CLI's own transcript on disk so the conversation can be resumed later. Default: discard it when the run ends. */
  persist?: boolean;
  /** Continue this earlier session (Codex thread id or Claude session id) instead of starting a new one. */
  resume?: string;
  /** Folders the agent may write to besides its working folder. Absent means a read-only run. */
  writable?: string[];
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onProcess?: (pid: number, running: boolean) => void;
  onStatus?: (phase: string) => void;
};
function codexExecutable() {
  const executable = detectProviders().find(p => p.id === 'codex')?.executable;
  if (!executable || /\.(cmd|bat)$/i.test(executable)) throw new Error('Install the native Codex CLI, then sign in with ChatGPT.');
  return executable;
}
function run(executable: string, args: string[], timeout: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, timeout }); let output = '', errors = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
    // Codex writes `login status` to stderr, so a successful run returns both streams together.
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output + errors) : reject(new Error(errors.trim() || `codex ${args[0]} exited (${code})`)));
  });
}
/** Models the installed Codex CLI offers, most capable first. Hidden catalog entries (internal review models) are excluded. */
export async function codexModels(): Promise<CodexModel[]> {
  const raw = JSON.parse(await run(codexExecutable(), ['debug', 'models'], 20000)) as { models?: Record<string, unknown>[] };
  return (raw.models ?? []).filter(m => m.visibility === 'list' && typeof m.slug === 'string').sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0)).map(m => ({
    slug: String(m.slug), name: String(m.display_name ?? m.slug), description: String(m.description ?? ''), defaultEffort: String(m.default_reasoning_level ?? ''),
    efforts: Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as { effort?: string }[]).map(level => level.effort).filter((e): e is string => typeof e === 'string') : [],
  }));
}
/** TOML array of paths for a `-c` override. Forward slashes keep the TOML string free of escapes and are accepted by Windows. */
const tomlPaths = (paths: string[]) => `[${paths.map(p => JSON.stringify(p.replaceAll('\\', '/'))).join(',')}]`;
/**
 * Command line for one Codex turn. A first turn is `codex exec`; a continued conversation is `codex exec resume <thread>`, which
 * lacks the `-C`, `--sandbox` and `--color` flags, so the working folder is set on the process and the sandbox through `-c` overrides.
 */
export function codexArguments(input: RunInput, files: { schema: string; result: string }): string[] {
  const args = input.resume ? ['exec', 'resume', input.resume, '--all'] : ['exec', '-C', input.workdir ?? input.folder, '--color', 'never'];
  args.push('--ignore-user-config', '--skip-git-repo-check', '--json', '--output-last-message', files.result, '-c', 'approval_policy="never"', '-c', 'web_search="live"');
  if (!input.persist) args.push('--ephemeral');
  // Codex has no Windows sandbox: workspace-write there rejects every command once approvals are off, so a run that must write goes unsandboxed.
  if (input.writable?.length) args.push('-c', process.platform === 'win32' ? 'sandbox_mode="danger-full-access"' : 'sandbox_mode="workspace-write"', '-c', `sandbox_workspace_write.writable_roots=${tomlPaths(input.writable)}`);
  else args.push('-c', 'sandbox_mode="read-only"');
  if (input.schema) args.push('--output-schema', files.schema);
  if (input.model) args.push('-m', input.model);
  if (input.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(input.effort)}`);
  for (const image of input.images) args.push('--image', image);
  args.push('-');
  return args;
}
export async function runCodex(input: RunInput): Promise<unknown> {
  input.onStatus?.('Locating Codex');
  const executable = codexExecutable();
  input.onStatus?.('Checking Codex sign-in');
  const auth = await run(executable, ['login', 'status'], 10000).catch(() => { throw new Error('Run codex login and sign in with ChatGPT.'); });
  if (!/ChatGPT/i.test(auth)) throw new Error('Codex must be signed in with ChatGPT for subscription-backed runs. Run codex login.');
  if (input.signal.aborted) throw new Error('Cancelled');
  const schemaFile = path.join(input.folder, 'schema.json'), resultFile = path.join(input.folder, 'response.json');
  if (input.schema) await fs.promises.writeFile(schemaFile, JSON.stringify(input.schema));
  await fs.promises.rm(resultFile, { force: true });
  const args = codexArguments(input, { schema: schemaFile, result: resultFile });
  input.onStatus?.(input.resume ? 'Resuming Codex conversation' : 'Starting Codex conversation');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: input.workdir ?? input.folder, windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...process.env, OPENAI_API_KEY: '', CODEX_API_KEY: '' } });
    if (child.pid) input.onProcess?.(child.pid, true);
    let stderr = '', pending = '', bytes = 0, cancelled = false, failure = '';
    const decoder = new StringDecoder('utf8');
    const trace = fs.createWriteStream(path.join(input.folder, 'events.jsonl'));
    const diagnostics = fs.createWriteStream(path.join(input.folder, 'stderr.log'));
    const stop = () => { cancelled = true; if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); } else child.kill(); };
    const timeoutMs = input.timeoutMs ?? 180000, timer = setTimeout(stop, timeoutMs);
    input.signal.addEventListener('abort', stop, { once: true });
    if (input.signal.aborted) stop();
    child.stdin.on('error', () => {});
    const receive = (line: string) => {
      if (!line.trim()) return;
      let event: CodexEvent;
      try { event = JSON.parse(line) as CodexEvent; }
      catch { input.onEvent({ type: 'kiln.diagnostic', message: line.slice(-1000) }); return; }
      if (typeof event.type === 'string') input.onEvent(event);
    };
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length; if (bytes > 8_000_000) { failure = 'Codex activity exceeded the 8 MB run log limit. Open Run files for the saved activity.'; stop(); return; }
      trace.write(data); pending += decoder.write(data);
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      try { for (const line of lines) receive(line); }
      catch (error) { failure = `Could not record Codex activity: ${String(error)}`; stop(); }
    });
    child.stderr.on('data', data => {
      stderr = (stderr + data).slice(-4000); diagnostics.write(data);
      const message = String(data).replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (message) { try { input.onEvent({ type: 'kiln.diagnostic', message: message.slice(-1000) }); } catch (error) { failure = `Could not record Codex activity: ${String(error)}`; stop(); } }
    });
    child.on('error', error => { clearTimeout(timer); input.signal.removeEventListener('abort', stop); trace.end(); diagnostics.end(); reject(error); });
    child.on('close', code => {
      try { receive(pending + decoder.end()); } catch (error) { failure = `Could not record Codex activity: ${String(error)}`; }
      if (child.pid) input.onProcess?.(child.pid, false); clearTimeout(timer); input.signal.removeEventListener('abort', stop); trace.end(); diagnostics.end();
      if (failure) reject(new Error(failure));
      else if (cancelled) reject(new Error(input.signal.aborted ? 'Cancelled' : `Codex timed out after ${Math.round(timeoutMs / 60000)} minutes. Retry this run.`));
      else if (code !== 0) reject(new Error(`Codex exited (${code ?? 'signal'}). ${stderr.slice(-1500)}`)); else resolve();
    });
    child.stdin.end(input.prompt);
  });
  const text = await fs.promises.readFile(resultFile, 'utf8').catch(() => { throw new Error(input.resume ? 'Codex could not continue this session. Its transcript may have been removed; check events.jsonl in the run folder.' : 'Codex returned no final message. Check events.jsonl in the run folder.'); });
  return input.schema ? JSON.parse(text) : text;
}
