import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findExecutable } from '../providers/service';
import { killTree, settled, treeOptions } from './process';
import type { RunInput } from './codex';

/**
 * Command line for one Claude Code turn. First turns get read-only tools and a JSON schema; a continued conversation (`--resume`) that may
 * change the library additionally gets Bash, Write and Edit with `--add-dir` for the folders it may touch. A Tune run (`workspaceWrite`)
 * gets those in its working folder plus the Agent tool for its field trial.
 */
export function claudeArguments(input: RunInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--strict-mcp-config'];
  if (input.resume) args.push('--resume', input.resume);
  if (input.schema) args.push('--json-schema', JSON.stringify(input.schema));
  if (input.writable?.length) args.push('--tools', 'Read,Glob,Grep,Bash,Write,Edit', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', ...input.writable.flatMap(dir => ['--add-dir', dir]), '--max-turns', '80');
  // Tune: edits and commands in its working folder and a subagent for the field trial. No --add-dir: the file tools stay in the folder.
  else if (input.workspaceWrite) args.push('--tools', 'Read,Glob,Grep,Bash,Write,Edit,Agent', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', 'Agent', '--max-turns', '200');
  else args.push('--tools', 'Read,Glob,Grep,WebFetch,WebSearch', '--allowedTools', 'WebFetch', 'WebSearch', '--permission-mode', 'default', '--max-turns', '40');
  // Repository trials still need read access to their private attachment folder. No write tools are added.
  if (input.workdir && input.workdir !== input.folder && !input.writable?.length && !input.workspaceWrite) args.push('--add-dir', input.folder);
  if (input.model) args.push('--model', input.model);
  return args;
}
/**
 * Runs one non-interactive Claude Code turn.
 * Uses the user's existing Claude Code sign-in; no API key is read or stored. The user's own settings, hooks and MCP servers are left out
 * so the run sees exactly the job folder. Claude Code keeps its own transcript under ~/.claude/projects, which is what `resume` continues.
 */
/**
 * The command line for running an npm `.cmd` shim through `cmd.exe /d /s /c`, escaped the way cross-spawn does it.
 * Each argument is quoted for MSVCRT's argv parser, then every cmd metacharacter (quotes included) is caret-escaped, so
 * cmd never enters quote mode and `&`, `|`, `%` or `(` in JSON or folder names stay literal. Arguments are escaped twice
 * because the shim hands `%*` to a second round of cmd parsing. The outer quotes are the pair `/s` strips.
 */
export function shimCommandLine(executable: string, args: string[]) {
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const argument = (value: string) => `"${value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')}"`.replace(meta, '^$1').replace(meta, '^$1');
  return `"${[executable.replace(meta, '^$1'), ...args.map(argument)].join(' ')}"`;
}
export async function runClaude(input: RunInput): Promise<unknown> {
  input.onStatus?.('Locating Claude Code');
  const executable = findExecutable('claude');
  if (!executable) throw new Error('Install Claude Code and run `claude` once in a terminal to sign in.');
  if (input.signal.aborted) throw new Error('Cancelled');
  const resultFile = path.join(input.folder, 'response.json'), cwd = input.workdir ?? input.folder;
  const args = claudeArguments(input);
  input.onStatus?.(input.resume ? 'Resuming Claude Code conversation' : 'Starting Claude Code conversation');
  const shim = /\.(cmd|bat)$/i.test(executable);
  const prompt = input.images.length ? `${input.prompt}\n\nAttached images (view them with the Read tool):\n${input.images.map(file => path.relative(cwd, file)).join('\n')}` : input.prompt;
  const result = await new Promise<unknown>((resolve, reject) => {
    const child = shim
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', shimCommandLine(executable, args)], { cwd, ...treeOptions(), windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: '' } })
      : spawn(executable, args, { cwd, ...treeOptions(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    if (child.pid) input.onProcess?.(child.pid, true);
    let stderr = '', pending = '', bytes = 0, cancelled = false, final: { is_error?: boolean; result?: string; structured_output?: unknown } | null = null;
    const trace = fs.createWriteStream(path.join(input.folder, 'events.jsonl'));
    const stop = () => { if (cancelled) return; cancelled = true; killTree(child); };
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
    const close = () => { clearTimeout(timer); input.signal.removeEventListener('abort', stop); trace.end(); };
    // Settles when Claude Code exits, even if a process it started keeps the output pipes open.
    settled(child).then(({ code }) => {
      if (child.pid) input.onProcess?.(child.pid, false); close();
      if (cancelled) return reject(new Error(input.signal.aborted ? 'Cancelled' : `Claude Code timed out after ${Math.round(timeoutMs / 60000)} minutes. Retry this run.`));
      if (final?.is_error || (code && !final)) return reject(new Error(/authenticat|sign in|login/i.test(final?.result ?? stderr) ? 'Claude Code is not signed in for headless runs. Open a terminal, run `claude`, and sign in, then retry.' : /No conversation found/i.test(final?.result ?? stderr) ? 'Claude Code could not find this session on this machine, so the conversation cannot continue.' : `Claude Code exited (${code ?? 'error'}). ${(final?.result ?? stderr).slice(-1500)}`));
      if (final?.structured_output !== undefined) return resolve(final.structured_output);
      if (!input.schema) return resolve(final?.result ?? '');
      try { resolve(JSON.parse(final?.result ?? '')); } catch { reject(new Error('Claude Code returned no structured result. Check events.jsonl in the run folder.')); }
    }, error => { close(); reject(error); });
    child.stdin.end(prompt);
  });
  await fs.promises.writeFile(resultFile, typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  return result;
}
