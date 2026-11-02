import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Replay the release's real shell orchestration with OS commands at its boundary replaced.
// A failed cross-architecture launch leaves the mounted DMG busy, as in the release log.
function inspect(native: string, failure = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-release-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'commands');
  const commands: Record<string, string> = {
    uname: 'echo "$NATIVE_ARCH"',
    node: `if [ "$1" = -p ]; then echo 0.25.8; exit; fi
echo "launch $2" >> "$COMMAND_LOG"
if [[ "$2" = *"$FAIL_ARCH"* ]] && [ -n "$FAIL_ARCH" ]; then echo 'native startup failed' >&2; exit 1; fi
if [[ "$2" != *"kiln-$NATIVE_APP/"* ]]; then touch "$BUSY_FILE"; echo "TimeoutError: Timeout 90000ms exceeded." >&2; exit 1; fi`,
    hdiutil: `echo "hdiutil $*" >> "$COMMAND_LOG"
if [ "$1" = detach ] && [ -f "$BUSY_FILE" ]; then echo 'hdiutil: Resource busy' >&2; exit 16; fi`,
    lipo: 'echo "lipo $*" >> "$COMMAND_LOG"',
    codesign: `echo "codesign $*" >> "$COMMAND_LOG"
if [ "$1" = -dv ]; then echo Signature=adhoc; fi
if [ "$FAIL_ARCH" = signature ] && [ "$1" = --verify ]; then echo 'invalid signature' >&2; exit 1; fi`,
    spctl: 'exit 1', // Ad-hoc signed builds are expected to fail Gatekeeper assessment.
  };
  for (const [name, body] of Object.entries(commands)) fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  try {
    const result = spawnSync('bash', ['scripts/inspect-macos.sh'], {
      encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: root,
        COMMAND_LOG: log, BUSY_FILE: path.join(root, 'busy'), NATIVE_ARCH: native,
        NATIVE_APP: native === 'arm64' ? 'arm64' : 'x64', FAIL_ARCH: failure },
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr, commands: fs.readFileSync(log, 'utf8') };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('macOS release verifies both DMGs and launches only the native app, without a Rosetta timeout holding the mount', { skip: process.platform === 'win32' }, () => {
  for (const arch of ['arm64', 'x86_64']) {
    const result = inspect(arch);
    assert.equal(result.status, 0, result.output);
    const launches = result.commands.split('\n').filter(line => line.startsWith('launch '));
    assert.equal(launches.length, 1, result.commands);
    assert.match(launches[0], new RegExp(`kiln-${arch === 'arm64' ? 'arm64' : 'x64'}/`));
    for (const app of ['arm64', 'x64']) {
      assert.match(result.commands, new RegExp(`codesign --verify .*kiln-${app}/Kiln.app`));
      assert.match(result.commands, new RegExp(`hdiutil detach .*kiln-${app}`));
    }
  }
});

test('macOS release still fails for a native app startup failure or invalid signature', { skip: process.platform === 'win32' }, () => {
  for (const [arch, failure] of [['arm64', 'arm64'], ['x86_64', 'x64'], ['arm64', 'signature']]) {
    const result = inspect(arch, failure);
    assert.equal(result.status, 1, `${arch} ${failure} must block publication`);
    assert.match(result.output, failure === 'signature' ? /invalid signature/ : /native startup failed/);
  }
});
