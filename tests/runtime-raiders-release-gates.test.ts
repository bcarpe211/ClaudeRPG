import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const gate1 = join(root, 'scripts/test/runtime-raiders-lifecycle.sh');
const gate1Sandbox = join(root, 'scripts/test/runtime-raiders-gate1.sb');
const safety = join(root, 'scripts/test/runtime-raiders-gate-safety.sh');
const renderer = join(root, 'scripts/release/render-runtime-raiders-installer.sh');
const installerTemplate = join(root, 'companion/packaging/install.sh');

function executable(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ['#!/bin/sh', 'set -eu', ...lines, ''].join('\n'));
  chmodSync(path, 0o700);
}

function bash(script: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('/bin/bash', ['-c', script], { env, encoding: 'utf8' });
}

describe('Runtime Raiders Gate 1 isolation', () => {
  it('enforces the OS sandbox against absolute live boundaries while preserving local IPC', () => {
    // Catches PATH-only denial that absolute tools or native sockets can bypass.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-gate1-sandbox-'));
    try {
      const inheritedSandbox = process.env.RUNTIME_RAIDERS_GATE1_SANDBOXED === '1';
      let protectedRoot = inheritedSandbox
        ? process.env.RUNTIME_RAIDERS_GATE1_PROTECTED ?? ''
        : join(fixture, 'protected-support');
      let writableRoot = join(fixture, 'scratch');
      const probe = join(fixture, 'network-probe.cjs');
      if (!inheritedSandbox) mkdirSync(protectedRoot);
      expect(protectedRoot).not.toBe('');
      mkdirSync(writableRoot);
      protectedRoot = realpathSync(protectedRoot);
      writableRoot = realpathSync(writableRoot);
      writeFileSync(probe, [
        "const net = require('node:net');",
        "const mode = process.argv[2];",
        "const finish = (code) => process.exit(code);",
        "if (mode === 'outbound') {",
        "  const socket = net.connect({ host: '198.51.100.1', port: 9 });",
        "  socket.setTimeout(500, () => { socket.destroy(); finish(72); });",
        "  socket.on('connect', () => { socket.destroy(); finish(73); });",
        "  socket.on('error', (error) => finish(error.code === 'EPERM' ? 0 : 74));",
        "} else {",
        "  const endpoint = mode === 'unix' ? process.argv[3] : { host: '127.0.0.1', port: 0 };",
        "  const server = net.createServer((socket) => socket.end());",
        "  server.listen(endpoint, () => {",
        "    const address = server.address();",
        "    const client = net.connect(mode === 'unix' ? endpoint : { host: '127.0.0.1', port: address.port });",
        "    client.on('connect', () => finish(0));",
        "    client.on('error', (error) => { console.error(error.code); finish(75); });",
        "  });",
        "  server.on('error', () => finish(76));",
        "}",
        '',
      ].join('\n'));
      const sandbox = (command: string, args: string[] = []) => inheritedSandbox
        ? spawnSync(command, args, { encoding: 'utf8', timeout: 3_000 })
        : spawnSync('/usr/bin/sandbox-exec', [
          '-D', `RUNTIME_RAIDERS_REAL_SUPPORT=${protectedRoot}`,
          '-D', `RUNTIME_RAIDERS_GATE1_PROTECTED=${protectedRoot}`,
          '-f', gate1Sandbox,
          command,
          ...args,
        ], { encoding: 'utf8', timeout: 3_000 });

      expect(existsSync(gate1Sandbox)).toBe(true);
      const protectedWrite = sandbox('/usr/bin/touch', [join(protectedRoot, 'blocked')]);
      expect(protectedWrite.status, protectedWrite.stderr).not.toBe(0);
      expect(existsSync(join(protectedRoot, 'blocked'))).toBe(false);
      expect(sandbox('/usr/bin/touch', [join(writableRoot, 'allowed')]).status).toBe(0);
      expect(sandbox('/bin/launchctl', ['print', `gui/${process.getuid?.() ?? 501}/com.redlattice.runtime-raiders-gate1-probe`]).status)
        .not.toBe(0);
      expect(sandbox('/usr/bin/curl', ['--max-time', '1', 'http://198.51.100.1:9']).status)
        .not.toBe(0);
      expect(sandbox(process.execPath, [probe, 'outbound']).status).toBe(0);
      const loopback = sandbox(process.execPath, [probe, 'loopback']);
      expect(loopback.status, loopback.stderr).toBe(0);
      const unix = sandbox(process.execPath, [probe, 'unix', join(writableRoot, 'probe.sock')]);
      expect(unix.status, unix.stderr).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('runs twice with private homes, offline local tools, explicit scratch, and no package residue', () => {
    // Catches a Gate 1 command reading the caller home, fetching npx packages, or writing companion/.build.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-gate1-behavior-'));
    try {
      const repository = join(fixture, 'repo');
      const outerTmp = join(fixture, 'outer-tmp');
      const originalHome = join(fixture, 'real-home');
      const fakeBin = join(fixture, 'bin');
      const log = join(fixture, 'commands.log');
      mkdirSync(join(repository, 'scripts/test'), { recursive: true });
      mkdirSync(join(repository, 'scripts/release'), { recursive: true });
      mkdirSync(join(repository, 'companion/packaging'), { recursive: true });
      mkdirSync(outerTmp);
      mkdirSync(join(originalHome, 'Library/Application Support/Runtime Raiders'), { recursive: true });
      writeFileSync(join(originalHome, 'Library/Application Support/Runtime Raiders/sentinel'), 'untouched\n');
      copyFileSync(gate1, join(repository, 'scripts/test/runtime-raiders-lifecycle.sh'));
      chmodSync(join(repository, 'scripts/test/runtime-raiders-lifecycle.sh'), 0o700);
      copyFileSync(gate1Sandbox, join(repository, 'scripts/test/runtime-raiders-gate1.sb'));
      copyFileSync(
        join(root, 'scripts/test/runtime-raiders-validator-reproducibility.sh'),
        join(repository, 'scripts/test/runtime-raiders-validator-reproducibility.sh'),
      );
      chmodSync(join(repository, 'scripts/test/runtime-raiders-validator-reproducibility.sh'), 0o700);
      executable(join(repository, 'scripts/release/build-runtime-raiders-release-validator.sh'), [
        'mkdir -p "$2"',
        'printf "reproducible-validator\\n" > "$3"',
        'chmod 755 "$3"',
        'rm -rf "$2"',
      ]);
      writeFileSync(join(repository, 'companion/packaging/install.sh'), '#!/bin/sh\nexit 0\n');
      writeFileSync(join(repository, 'scripts/release/build-runtime-raiders-agent.sh'), '#!/bin/bash\nexit 0\n');
      executable(join(fakeBin, 'swift'), [
        'printf "swift|%s|%s|%s|%s|%s|%s\\n" "$HOME" "$TMPDIR" "$CLANG_MODULE_CACHE_PATH" "$SWIFTPM_MODULECACHE_OVERRIDE" "${RUNTIME_RAIDERS_GATE1_SANDBOXED:-}" "$*" >> "$GATE_LOG"',
        'case "$HOME" in "$GATE_OUTER_TMP"/runtime-raiders-gate1.*/home) ;; *) exit 81;; esac',
        'case "$*" in *"--scratch-path $GATE_OUTER_TMP/runtime-raiders-gate1."*"/swift-scratch"*"--disable-automatic-resolution"*"--skip-update"*) ;; *) exit 82;; esac',
      ]);
      executable(join(fakeBin, 'npx'), [
        'printf "npx|%s|%s|%s|%s\\n" "$HOME" "${npm_config_cache:-}" "${npm_config_offline:-}" "$*" >> "$GATE_LOG"',
        '[ "${npm_config_offline:-}" = true ]',
        '[ "${npm_config_audit:-}" = false ]',
        '[ "${npm_config_fund:-}" = false ]',
        '[ "$1" = --no-install ]',
        '[ "$2" = vitest ]',
      ]);

      const environment = {
        ...process.env,
        HOME: originalHome,
        TMPDIR: realpathSync(outerTmp),
        PATH: `${fakeBin}:/usr/bin:/bin`,
        GATE_LOG: log,
        GATE_OUTER_TMP: realpathSync(outerTmp),
      };
      for (let run = 0; run < 2; run += 1) {
        const result = spawnSync('/bin/bash', [join(repository, 'scripts/test/runtime-raiders-lifecycle.sh')], {
          cwd: repository,
          env: environment,
          encoding: 'utf8',
        });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(readdirSync(outerTmp), `run ${run + 1} leaked its private tree`).toEqual([]);
      }

      expect(existsSync(join(repository, 'companion/.build'))).toBe(false);
      expect(readFileSync(join(originalHome, 'Library/Application Support/Runtime Raiders/sentinel'), 'utf8'))
        .toBe('untouched\n');
      const lines = readFileSync(log, 'utf8').trim().split('\n');
      expect(lines.filter((line) => line.startsWith('swift|'))).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith('npx|'))).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith('swift|')).every((line) => line.split('|')[5] === '1')).toBe(true);
      const homes = lines.map((line) => line.split('|')[1]);
      expect(new Set(homes).size).toBe(2);
      expect(homes.every((home) => home !== originalHome)).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('Runtime Raiders Gate 2 process safety', () => {
  it('binds a spaced executable image and exact argv while rejecting prefix and replaced images', async () => {
    // Catches ps command-prefix parsing and pathname-only checks that miss a replaced executable vnode.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-process-image-'));
    const children: ReturnType<typeof spawn>[] = [];
    try {
      const processRoot = join(fixture, 'processes');
      let expected = join(fixture, 'agent with space');
      let collision = `${expected} evil`;
      const signalLog = join(fixture, 'signals.log');
      const identityHelper = join(fixture, 'process-identity');
      mkdirSync(processRoot, { mode: 0o700 });
      const compile = spawnSync('/usr/bin/clang', [
        '-Wall', '-Wextra', '-Werror',
        join(root, 'scripts/test/runtime-raiders-process-identity.c'),
        '-o', identityHelper,
      ], { encoding: 'utf8' });
      expect(compile.status, compile.stderr).toBe(0);
      copyFileSync('/bin/sleep', expected);
      copyFileSync('/bin/sleep', collision);
      chmodSync(expected, 0o700);
      chmodSync(collision, 0o700);
      expected = realpathSync(expected);
      collision = realpathSync(collision);
      executable(join(fixture, 'signal'), [
        'printf "%s %s\\n" "$1" "$2" >> "$GATE_SIGNAL_LOG"',
      ]);
      const start = (path: string) => {
        const child = spawn(path, ['30'], { stdio: 'ignore' });
        children.push(child);
        return child;
      };
      const exactChild = start(expected);
      const collisionChild = start(collision);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(exactChild.pid).toBeGreaterThan(1);
      expect(collisionChild.pid).toBeGreaterThan(1);
      const env = {
        ...process.env,
        GATE_PROCESS_ROOT: processRoot,
        GATE_PROCESS_SIGNAL: join(fixture, 'signal'),
        GATE_PROCESS_IDENTITY_HELPER: identityHelper,
        GATE_SIGNAL_LOG: signalLog,
        GATE_SAFETY: safety,
        GATE_EXPECTED: expected,
      };

      const capture = bash(
        'source "$GATE_SAFETY"; gate_process_capture exact "$GATE_PID" "$GATE_EXPECTED" 30',
        { ...env, GATE_PID: String(exactChild.pid) },
      );
      expect(capture.status, capture.stderr).toBe(0);
      const collisionCapture = bash(
        'source "$GATE_SAFETY"; gate_process_capture collision "$GATE_PID" "$GATE_EXPECTED" 30',
        { ...env, GATE_PID: String(collisionChild.pid) },
      );
      expect(collisionCapture.status, collisionCapture.stderr).not.toBe(0);

      const replacement = join(fixture, 'replacement');
      copyFileSync('/usr/bin/true', replacement);
      chmodSync(replacement, 0o700);
      renameSync(replacement, expected);
      const validate = bash(
        'source "$GATE_SAFETY"; gate_process_validate_record "$GATE_RECORD"',
        { ...env, GATE_RECORD: capture.stdout.trim() },
      );
      expect(validate.status, validate.stderr).not.toBe(0);
      expect(existsSync(signalLog) ? readFileSync(signalLog, 'utf8') : '').toBe('');
    } finally {
      for (const child of children) child.kill('SIGKILL');
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('formats process start identity separately from its executable command', () => {
    // Catches an exec transition changing the same line that is supposed to pin process start.
    const result = bash('source "$GATE_SAFETY"; gate_process_format_identity "Sun Aug 10 03:00:00 2026" "/tmp/agent daemon"', {
      ...process.env,
      GATE_SAFETY: safety,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('start=Sun Aug 10 03:00:00 2026\ncommand=/tmp/agent daemon\n');
  });

  it('rejects unsafe, corrupted, reused, and wrong-executable records before signaling', () => {
    // Catches PID 0/process-group signaling and stale PID reuse after a cleanup record is captured.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-process-safety-'));
    try {
      const processRoot = join(fixture, 'processes');
      const state = join(fixture, 'state');
      const signalLog = join(fixture, 'signals.log');
      let expected = join(fixture, 'home/agent');
      mkdirSync(processRoot, { mode: 0o700 });
      mkdirSync(state);
      executable(expected, ['exit 0']);
      expected = realpathSync(expected);
      const probe = join(fixture, 'probe');
      const signal = join(fixture, 'signal');
      executable(probe, [
        'file="$GATE_STATE/$1.identity"',
        '[ -f "$file" ] || exit 3',
        'cat "$file"',
      ]);
      executable(signal, [
        'printf "%s %s\\n" "$1" "$2" >> "$GATE_SIGNAL_LOG"',
        'mode="$(cat "$GATE_STATE/mode")"',
        'if [ "$1" = KILL ] || [ "$mode" = terminate ]; then rm -f "$GATE_STATE/$2.identity"; fi',
      ]);
      writeFileSync(join(state, 'mode'), 'terminate\n');
      const env = {
        ...process.env,
        GATE_PROCESS_ROOT: processRoot,
        GATE_PROCESS_PROBE: probe,
        GATE_PROCESS_SIGNAL: signal,
        GATE_PROCESS_SLEEP: '/usr/bin/true',
        GATE_PROCESS_TERM_POLLS: '2',
        GATE_PROCESS_KILL_POLLS: '2',
        GATE_STATE: state,
        GATE_SIGNAL_LOG: signalLog,
      };

      for (const pid of ['0', '-7', 'text', '1']) {
        const record = join(processRoot, `forged-${pid.replaceAll('-', 'n')}`);
        mkdirSync(record, { mode: 0o700 });
        writeFileSync(join(record, 'pid'), `${pid}\n`, { mode: 0o600 });
        writeFileSync(join(record, 'expected'), `${expected}\n`, { mode: 0o600 });
        writeFileSync(join(record, 'identity'), `start=1\ncommand=${expected} daemon\n`, { mode: 0o600 });
        const result = bash(`source "$GATE_SAFETY"; gate_process_stop_record "$GATE_RECORD"`, {
          ...env,
          GATE_SAFETY: safety,
          GATE_RECORD: record,
        });
        expect(result.status, `${pid}: ${result.stderr}`).not.toBe(0);
      }

      writeFileSync(join(state, '44.identity'), `start=100\ncommand=${expected} daemon\n`);
      const capture = bash('source "$GATE_SAFETY"; gate_process_capture child 44 "$GATE_EXPECTED" daemon', {
        ...env,
        GATE_SAFETY: safety,
        GATE_EXPECTED: expected,
      });
      expect(capture.status, capture.stderr).toBe(0);
      const record = capture.stdout.trim();
      writeFileSync(join(state, '44.identity'), `start=101\ncommand=${expected} daemon\n`);
      const reused = bash('source "$GATE_SAFETY"; gate_process_stop_record "$GATE_RECORD"', {
        ...env,
        GATE_SAFETY: safety,
        GATE_RECORD: record,
      });
      expect(reused.status, reused.stderr).not.toBe(0);

      writeFileSync(join(state, '45.identity'), 'start=100\ncommand=/tmp/unrelated daemon\n');
      const wrong = bash('source "$GATE_SAFETY"; gate_process_capture wrong 45 "$GATE_EXPECTED" daemon', {
        ...env,
        GATE_SAFETY: safety,
        GATE_EXPECTED: expected,
      });
      expect(wrong.status, wrong.stderr).not.toBe(0);

      writeFileSync(join(state, '46.identity'), `start=100\ncommand=${expected}.evil daemon\n`);
      const prefixCollision = bash('source "$GATE_SAFETY"; gate_process_capture prefix 46 "$GATE_EXPECTED" daemon', {
        ...env,
        GATE_SAFETY: safety,
        GATE_EXPECTED: expected,
      });
      expect(prefixCollision.status, prefixCollision.stderr).not.toBe(0);
      expect(existsSync(signalLog) ? readFileSync(signalLog, 'utf8') : '').toBe('');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('uses bounded TERM then KILL polling for a recorded TERM-ignoring process', () => {
    // Catches cleanup calling unbounded wait or failing to escalate a verified child.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-process-timeout-'));
    try {
      const processRoot = join(fixture, 'processes');
      const state = join(fixture, 'state');
      let expected = join(fixture, 'home/agent');
      const signalLog = join(fixture, 'signals.log');
      mkdirSync(processRoot, { mode: 0o700 });
      mkdirSync(state);
      executable(expected, ['exit 0']);
      expected = realpathSync(expected);
      executable(join(fixture, 'probe'), ['[ -f "$GATE_STATE/$1.identity" ] || exit 3', 'cat "$GATE_STATE/$1.identity"']);
      executable(join(fixture, 'signal'), [
        'printf "%s %s\\n" "$1" "$2" >> "$GATE_SIGNAL_LOG"',
        '[ "$1" != KILL ] || rm -f "$GATE_STATE/$2.identity"',
      ]);
      writeFileSync(join(state, '55.identity'), `start=200\ncommand=${expected} daemon\n`);
      const env = {
        ...process.env,
        GATE_PROCESS_ROOT: processRoot,
        GATE_PROCESS_PROBE: join(fixture, 'probe'),
        GATE_PROCESS_SIGNAL: join(fixture, 'signal'),
        GATE_PROCESS_SLEEP: '/usr/bin/true',
        GATE_PROCESS_TERM_POLLS: '2',
        GATE_PROCESS_KILL_POLLS: '2',
        GATE_STATE: state,
        GATE_SIGNAL_LOG: signalLog,
        GATE_SAFETY: safety,
        GATE_EXPECTED: expected,
      };
      const result = bash([
        'source "$GATE_SAFETY"',
        'record="$(gate_process_capture stubborn 55 "$GATE_EXPECTED" daemon)"',
        'gate_process_stop_record "$record"',
      ].join('; '), env);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(signalLog, 'utf8')).toBe('TERM 55\nKILL 55\n');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps the captured start identity while admitting one expected launcher exec transition', () => {
    // Catches cleanup either rejecting the real launcher-to-agent exec or accepting a new PID generation.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-process-transition-'));
    try {
      const processRoot = join(fixture, 'processes');
      const state = join(fixture, 'state');
      let launcher = join(fixture, 'home/launcher');
      let agent = join(fixture, 'home/agent');
      mkdirSync(processRoot, { mode: 0o700 });
      mkdirSync(state);
      executable(launcher, ['exit 0']);
      executable(agent, ['exit 0']);
      launcher = realpathSync(launcher);
      agent = realpathSync(agent);
      executable(join(fixture, 'probe'), ['[ -f "$GATE_STATE/$1.identity" ] || exit 3', 'cat "$GATE_STATE/$1.identity"']);
      executable(join(fixture, 'signal'), [
        'printf "%s %s\\n" "$1" "$2" >> "$GATE_SIGNAL_LOG"',
        'rm -f "$GATE_STATE/$2.identity"',
      ]);
      writeFileSync(join(state, '66.identity'), `start=300\ncommand=${launcher} daemon\n`);
      const env = {
        ...process.env,
        GATE_PROCESS_ROOT: processRoot,
        GATE_PROCESS_PROBE: join(fixture, 'probe'),
        GATE_PROCESS_SIGNAL: join(fixture, 'signal'),
        GATE_PROCESS_SLEEP: '/usr/bin/true',
        GATE_STATE: state,
        GATE_SIGNAL_LOG: join(fixture, 'signals.log'),
        GATE_SAFETY: safety,
        GATE_LAUNCHER: launcher,
        GATE_AGENT: agent,
      };
      const capture = bash('source "$GATE_SAFETY"; gate_process_capture launcher 66 "$GATE_LAUNCHER" daemon "$GATE_AGENT" daemon', env);
      expect(capture.status, capture.stderr).toBe(0);
      writeFileSync(join(state, '66.identity'), `start=300\ncommand=${agent} daemon\n`);
      const stop = bash('source "$GATE_SAFETY"; gate_process_stop_record "$GATE_RECORD"', {
        ...env,
        GATE_RECORD: capture.stdout.trim(),
      });
      expect(stop.status, stop.stderr).toBe(0);
      expect(readFileSync(join(fixture, 'signals.log'), 'utf8')).toBe('TERM 66\n');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('Runtime Raiders Gate 2 installer binding', () => {
  it('requires the reviewed local source tree to be clean and at the signed release SHA', () => {
    // Catches content binding against locally modified or wrong-commit renderer/template bytes.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-reviewed-source-'));
    try {
      const repository = join(fixture, 'repository');
      mkdirSync(join(repository, 'companion/packaging'), { recursive: true });
      mkdirSync(join(repository, 'scripts/release'), { recursive: true });
      writeFileSync(join(repository, 'companion/packaging/install.sh'), 'template\n');
      writeFileSync(join(repository, 'scripts/release/render-runtime-raiders-installer.sh'), 'renderer\n');
      execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
      execFileSync('/usr/bin/git', ['config', 'user.email', 'gate@example.invalid'], { cwd: repository });
      execFileSync('/usr/bin/git', ['config', 'user.name', 'Gate Test'], { cwd: repository });
      execFileSync('/usr/bin/git', ['add', '.'], { cwd: repository });
      execFileSync('/usr/bin/git', ['commit', '-qm', 'fixture'], { cwd: repository });
      const sha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
      const verify = (expectedSHA: string) => bash(
        'source "$GATE_SAFETY"; gate_verify_reviewed_source "$GATE_REPOSITORY" "$GATE_SHA" companion/packaging/install.sh scripts/release/render-runtime-raiders-installer.sh',
        {
          ...process.env,
          GATE_SAFETY: safety,
          GATE_REPOSITORY: repository,
          GATE_SHA: expectedSHA,
        },
      );
      expect(verify(sha).status).toBe(0);
      expect(verify('e'.repeat(40)).status).not.toBe(0);
      writeFileSync(join(repository, 'companion/packaging/install.sh'), 'modified\n');
      expect(verify(sha).status).not.toBe(0);
      writeFileSync(join(repository, 'companion/packaging/install.sh'), 'template\n');
      writeFileSync(join(repository, 'untracked'), 'untracked\n');
      expect(verify(sha).status).not.toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('byte-binds the installer to reviewed source, signed facts, and validator bytes', () => {
    // Catches appended comments/dead code, substituted commands, or validator payload replacement.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-installer-binding-'));
    try {
      const validator = join(fixture, 'validator');
      const expected = join(fixture, 'install.sh');
      executable(validator, ['exit 0']);
      const facts = ['ABCDEFGHIJ', '0.3.0', '9', 'd'.repeat(40), '2'];
      const render = spawnSync('/bin/sh', [
        renderer,
        installerTemplate,
        validator,
        ...facts,
        expected,
      ], { encoding: 'utf8' });
      expect(render.status, render.stderr).toBe(0);
      expect(readFileSync(expected, 'utf8')).not.toContain('__RUNTIME_RAIDERS_');

      const variants = [
        ['comment', `${readFileSync(expected, 'utf8')}# reviewed?\n`],
        ['dead-code', `${readFileSync(expected, 'utf8')}\nif false; then /tmp/untrusted; fi\n`],
        ['substitution', readFileSync(expected, 'utf8').replace('curl --silent', '/tmp/untrusted --silent')],
      ] as const;
      for (const [name, contents] of variants) {
        const actual = join(fixture, `${name}.sh`);
        writeFileSync(actual, contents, { mode: 0o700 });
        const check = bash([
          'source "$GATE_SAFETY"',
          'gate_verify_installer_binding "$GATE_ACTUAL" "$GATE_TEMPLATE" "$GATE_RENDERER" "$GATE_VALIDATOR" ABCDEFGHIJ 0.3.0 9 "$GATE_SHA" 2 "$GATE_EXPECTED"',
        ].join('; '), {
          ...process.env,
          GATE_SAFETY: safety,
          GATE_ACTUAL: actual,
          GATE_TEMPLATE: installerTemplate,
          GATE_RENDERER: renderer,
          GATE_VALIDATOR: validator,
          GATE_SHA: 'd'.repeat(40),
          GATE_EXPECTED: join(fixture, `expected-${name}`),
        });
        expect(check.status, `${name}: ${check.stderr}`).not.toBe(0);
      }

      const accepted = bash([
        'source "$GATE_SAFETY"',
        'gate_verify_installer_binding "$GATE_ACTUAL" "$GATE_TEMPLATE" "$GATE_RENDERER" "$GATE_VALIDATOR" ABCDEFGHIJ 0.3.0 9 "$GATE_SHA" 2 "$GATE_EXPECTED"',
      ].join('; '), {
        ...process.env,
        GATE_SAFETY: safety,
        GATE_ACTUAL: expected,
        GATE_TEMPLATE: installerTemplate,
        GATE_RENDERER: renderer,
        GATE_VALIDATOR: validator,
        GATE_SHA: 'd'.repeat(40),
        GATE_EXPECTED: join(fixture, 'expected-accepted'),
      });
      expect(accepted.status, accepted.stderr).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('removes release signing and notarization credentials from child environments', () => {
    // Catches an installer or launcher subprocess inheriting release credentials.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-credential-scrub-'));
    try {
      const resultFile = join(fixture, 'result');
      executable(join(fixture, 'child'), [
        'printf "%s|%s|%s|%s\\n" "${RUNTIME_RAIDERS_CODESIGN_IDENTITY-unset}" "${RUNTIME_RAIDERS_NOTARY_PROFILE-unset}" "${APPLE_ID-unset}" "${APPLE_APP_SPECIFIC_PASSWORD-unset}" > "$RESULT_FILE"',
      ]);
      const result = bash('source "$GATE_SAFETY"; gate_run_without_release_credentials "$GATE_CHILD"', {
        ...process.env,
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'secret identity',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'secret profile',
        APPLE_ID: 'secret account',
        APPLE_APP_SPECIFIC_PASSWORD: 'secret password',
        GATE_SAFETY: safety,
        GATE_CHILD: join(fixture, 'child'),
        RESULT_FILE: resultFile,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(resultFile, 'utf8')).toBe('unset|unset|unset|unset\n');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('Runtime Raiders Gate 2 rollback fingerprint', () => {
  it('ignores only recreated runtime socket and lifetime-lock nodes while retaining other special residue', async () => {
    // Catches both false rollback failures on daemon restart and broad special-node exclusions.
    // Darwin's sockaddr_un.sun_path is 104 bytes including its terminator. Keep
    // this behavioral socket fixture short even when Gate 1 has a deep TMPDIR.
    const fixture = mkdtempSync('/tmp/rrtf-');
    const home = join(fixture, 'home');
    const support = join(home, 'Library/Application Support/Runtime Raiders');
    const socketPath = join(support, 'agent.sock');
    const lockPath = join(support, '.agent.sock.runtime-raiders.lock');
    const replacementSocketPath = join(support, 'replacement.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThan(104);
    expect(Buffer.byteLength(replacementSocketPath)).toBeLessThan(104);
    const servers: ReturnType<typeof createServer>[] = [];
    const listen = async (path: string) => {
      const server = createServer((client) => client.end());
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
      servers.push(server);
    };
    const closeAll = async () => {
      while (servers.length > 0) {
        const server = servers.pop()!;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };
    const fingerprint = (name: string) => {
      const destination = join(fixture, name);
      const result = bash('source "$GATE_SAFETY"; gate_fingerprint_migration_surface "$GATE_HOME" "$GATE_DESTINATION"', {
        ...process.env,
        GATE_SAFETY: safety,
        GATE_HOME: home,
        GATE_DESTINATION: destination,
      });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(destination, 'utf8');
    };
    try {
      mkdirSync(support, { recursive: true });
      writeFileSync(lockPath, '');
      chmodSync(lockPath, 0o600);
      await listen(socketPath);
      const before = fingerprint('before');
      rmSync(socketPath);
      rmSync(lockPath);
      writeFileSync(lockPath, '');
      chmodSync(lockPath, 0o600);
      await listen(replacementSocketPath);
      renameSync(replacementSocketPath, socketPath);
      expect(fingerprint('recreated')).toBe(before);

      const rogue = join(support, 'rollback-residue.pipe');
      execFileSync('/usr/bin/mkfifo', [rogue]);
      const rogueResult = bash(
        'source "$GATE_SAFETY"; gate_fingerprint_migration_surface "$GATE_HOME" "$GATE_DESTINATION"',
        {
          ...process.env,
          GATE_SAFETY: safety,
          GATE_HOME: home,
          GATE_DESTINATION: join(fixture, 'rogue-special'),
        },
      );
      expect(rogueResult.status, rogueResult.stderr).not.toBe(0);
    } finally {
      await closeAll();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('detects residue, inode replacement, and xattr mutation without following symlinks', () => {
    // Catches rollback proof that ignores metadata/evidence or hashes through a symlink target.
    const fixture = mkdtempSync(join(tmpdir(), 'runtime-raiders-fingerprint-'));
    try {
      const home = join(fixture, 'home');
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const outside = join(fixture, 'outside');
      mkdirSync(join(support, 'state'), { recursive: true });
      mkdirSync(join(support, 'rollback'), { recursive: true });
      mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
      mkdirSync(join(home, '.local/bin'), { recursive: true });
      writeFileSync(join(support, 'state/enrollment.json'), '{}\n');
      writeFileSync(join(support, 'rollback/evidence'), 'evidence\n');
      writeFileSync(join(home, 'Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist'), 'plist\n');
      writeFileSync(outside, 'outside-one\n');
      execFileSync('/bin/ln', ['-s', outside, join(home, '.local/bin/raiders')]);
      execFileSync('/usr/bin/xattr', ['-w', 'com.redlattice.runtime-raiders-test', 'one', join(support, 'rollback/evidence')]);

      const fingerprint = (name: string) => {
        const destination = join(fixture, name);
        const result = bash('source "$GATE_SAFETY"; gate_fingerprint_migration_surface "$GATE_HOME" "$GATE_DESTINATION"', {
          ...process.env,
          GATE_SAFETY: safety,
          GATE_HOME: home,
          GATE_DESTINATION: destination,
        });
        expect(result.status, result.stderr).toBe(0);
        return readFileSync(destination, 'utf8');
      };

      const baseline = fingerprint('baseline');
      expect(baseline).toContain('ABSENT Library/Application Support/Runtime Raiders/launcher');
      expect(baseline).toContain('ABSENT Library/Application Support/Runtime Raiders/releases');
      expect(baseline).toContain('ABSENT Library/Application Support/Runtime Raiders/installation');
      writeFileSync(outside, 'outside-two\n');
      expect(fingerprint('outside-mutated')).toBe(baseline);

      const evidence = join(support, 'rollback/evidence');
      const original = readFileSync(evidence);
      rmSync(evidence);
      writeFileSync(evidence, original);
      execFileSync('/usr/bin/xattr', ['-w', 'com.redlattice.runtime-raiders-test', 'one', evidence]);
      expect(fingerprint('inode-mutated')).not.toBe(baseline);

      const inodeBaseline = fingerprint('inode-baseline');
      execFileSync('/usr/bin/xattr', ['-w', 'com.redlattice.runtime-raiders-test', 'two', evidence]);
      expect(fingerprint('xattr-mutated')).not.toBe(inodeBaseline);

      const xattrBaseline = fingerprint('xattr-baseline');
      mkdirSync(join(support, 'launcher'));
      expect(fingerprint('residue')).not.toBe(xattrBaseline);
      expect(statSync(evidence).isFile()).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
