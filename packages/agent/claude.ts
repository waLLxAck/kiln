import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectProviders } from '../providers/service';
import type { RunInput } from './codex';

/**
 * Command line for one Claude Code turn. First turns get read-only tools and a JSON schema; a continued conversation (`--resume`) that may
 * change the library additionally gets Bash, Write and Edit with `--add-dir` for the folders it may touch.
 */
export function claudeArguments(input: RunInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--strict-mcp-config'];
  if (input.resume) args.push('--resume', input.resume);
  if (input.schema) args.push('--json-schema', JSON.stringify(input.schema));
  if (input.writable?.length) args.push('--tools', 'Read,Glob,Grep,Bash,Write,Edit', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', ...input.writable.flatMap(dir => ['--add-dir', dir]), '--max-turns', '80');
  else args.push('--tools', 'Read,Glob,Grep,WebFetch,WebSearch', '--allowedTools', 'WebFetch', 'WebSearch', '--permission-mode', 'default', '--max-turns', '40');
  // Repository trials still need read access to their private attachment folder. No write tools are added.
  if (input.workdir && input.workdir !== input.folder && !input.writable?.length) args.push('--add-dir', input.folder);
  if (input.model) args.push('--model', input.model);
  return args;
}
/**
 * Runs one non-interactive Claude Code turn.
 * Uses the user's existing Claude Code sign-in; no API key is read or stored. The user's own settings, hooks and MCP servers are left out
 * so the run sees exactly the job folder. Claude Code keeps its own transcript under ~/.claude/projects, which is what `resume` continues.
 */
/**
 * The command line for running an npm `.cmd` shim through `cmd.exe /d /s /c`. Every argument is encoded the way MSVCRT
 * parses argv, so JSON survives intact. The whole line is wrapped in one more pair of quotes because `/s` strips the first
 * and last quote before running it; without them cmd would eat the quotes around the shim's own path.
 */
export function shimCommandLine(executable: string, args: string[]) {
  const encode = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  return `"${[executable, ...args].map(encode).join(' ')}"`;
}
export async function runClaude(input: RunInput): Promise<unknown> {
  input.onStatus?.('Locating Claude Code');
  const executable = detectProviders().find(p => p.id === 'claude')?.executable;
  if (!executable) throw new Error('Install Claude Code and run `claude` once in a terminal to sign in.');
  if (input.signal.aborted) throw new Error('Cancelled');
  const resultFile = path.join(input.folder, 'response.json'), cwd = input.workdir ?? input.folder;
  const args = claudeArguments(input);
  input.onStatus?.(input.resume ? 'Resuming Claude Code conversation' : 'Starting Claude Code conversation');
  const shim = /\.(cmd|bat)$/i.test(executable);
  const prompt = input.images.length ? `${input.prompt}\n\nAttached images (view them with the Read tool):\n${input.images.map(file => path.relative(cwd, file)).join('\n')}` : input.prompt;
  const result = await new Promise<unknown>((resolve, reject) => {
    const child = shim
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', shimCommandLine(executable, args)], { cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: '' } })
      : spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    if (child.pid) input.onProcess?.(child.pid, true);
    let stderr = '', pending = '', bytes = 0, cancelled = false, final: { is_error?: boolean; result?: string; structured_output?: unknown } | null = null;
    const trace = fs.createWriteStream(path.join(input.folder, 'events.jsonl'));
    const stop = () => { cancelled = true; if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); } else child.kill(); };
    const timeoutMs = input.timeoutMs ?? 300000, timer = setTimeout(stop, timeoutMs);
    input.signal.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length; if (bytes > 8_000_000) { stop(); return; }
      trace.write(data); pending += data.toString();
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') final = event;
          if (typeof event.type === 'string') input.onEvent(event);
        } catch { /* Only complete events update progress. */ }
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); input.signal.removeEventListener('abort', stop); trace.end(); reject(error); });
    child.on('close', code => {
      if (child.pid) input.onProcess?.(child.pid, false); clearTimeout(timer); input.signal.removeEventListener('abort', stop); trace.end();
      if (cancelled) return reject(new Error(input.signal.aborted ? 'Cancelled' : `Claude Code timed out after ${Math.round(timeoutMs / 60000)} minutes. Retry this run.`));
      if (final?.is_error || (code && !final)) return reject(new Error(/authenticat|sign in|login/i.test(final?.result ?? stderr) ? 'Claude Code is not signed in for headless runs. Open a terminal, run `claude`, and sign in, then retry.' : /No conversation found/i.test(final?.result ?? stderr) ? 'Claude Code could not find this session on this machine, so the conversation cannot continue.' : `Claude Code exited (${code ?? 'error'}). ${(final?.result ?? stderr).slice(-1500)}`));
      if (final?.structured_output !== undefined) return resolve(final.structured_output);
      if (!input.schema) return resolve(final?.result ?? '');
      try { resolve(JSON.parse(final?.result ?? '')); } catch { reject(new Error('Claude Code returned no structured result. Check events.jsonl in the run folder.')); }
    });
    child.stdin.end(prompt);
  });
  await fs.promises.writeFile(resultFile, typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  return result;
}
