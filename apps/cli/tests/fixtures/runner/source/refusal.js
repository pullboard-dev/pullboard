/** Exercise source privacy and shape refusals before a runner transport can start [C7,S1]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../../child.js';
import { shellQuote } from '../ssh.js';

/** Run isolated Git commands and keep fixture setup failures actionable. */
function git(root, env, ...args) {
  const result = runFixtureChild('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  return result.stdout.trim();
}

/** Create one committed source tree with the requested private or unsupported entry. */
function sourceCase(root, env, kind) {
  git(root, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a-safe.txt'), 'ordinary committed source\n');
  git(root, env, 'add', 'a-safe.txt');
  git(root, env, 'commit', '-q', '-m', 'test: safe source base');
  if (kind === 'later-secret') {
    writeFileSync(join(root, 'b-empty.bin'), Buffer.alloc(0));
    writeFileSync(join(root, 'c-binary.bin'), Buffer.from([0, 255, 10, 128]));
    writeFileSync(join(root, 'm-at-limit.bin'), Buffer.alloc(8 * 1024 * 1024));
    writeFileSync(join(root, 'z-private.txt'), 'PULLBOARD_FIXTURE_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaa\n');
  } else if (kind === 'blocked-env') {
    writeFileSync(join(root, '.env'), 'ordinary fixture value\n');
    git(root, env, 'add', '-f', '.env');
  } else if (kind === 'oversized-blob') {
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  } else if (kind === 'gitlink') {
    const moduleRoot = join(root, '..', 'gitlink-source');
    mkdirSync(moduleRoot, { recursive: true });
    git(moduleRoot, env, 'init', '-q', '-b', 'main');
    writeFileSync(join(moduleRoot, 'module.txt'), 'committed submodule fixture\n');
    git(moduleRoot, env, 'add', 'module.txt');
    git(moduleRoot, env, 'commit', '-q', '-m', 'test: gitlink fixture source');
    git(root, env, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', moduleRoot, 'nested-module');
  }
  git(root, env, 'add', '-A');
  git(root, env, 'commit', '-q', '-m', 'test: committed runner source refusal fixture');
}

/** Ask the production runner API to prepare the committed source in a subprocess. */
function invokeRunner(root, env, runnerModule) {
  const moduleUrl = pathToFileURL(runnerModule).href;
  const script = `import { runOnRunnerAsync } from ${JSON.stringify(moduleUrl)};
try {
  await runOnRunnerAsync(process.argv[1], 'true', { runner: { host: 'fixture.invalid', slots: 1, browser: 0 } });
  process.stdout.write(JSON.stringify({ code: 'NO_REFUSAL' }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code ?? error.name }));
}
`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script, root], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000, // Budget: scan the 8 MiB boundary fixture within a bounded child lifetime.
  });
  assert.equal(result.status, 0, result.context);
  return JSON.parse(result.stdout);
}

/** Prove four committed-source refusals happen before SSH, using a fresh real Git repository each. */
export async function runnerSourceRefusalCases(t, runnerModule = resolve(import.meta.dirname, '../../../../../../packages/runners/src/io/main.js')) {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-runner-source-refusal-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const cases = [
    ['later-secret', 'RUNNER_SECRET'],
    ['blocked-env', 'RUNNER_SECRET'],
    ['oversized-blob', 'RUNNER_SCAN_LIMIT'],
    ['gitlink', 'RUNNER_SOURCE'],
  ];
  for (const [kind, expected] of cases) {
    const root = join(scratch, kind), bin = join(scratch, `${kind}-bin`), marker = join(scratch, `${kind}-ssh-invoked`);
    mkdirSync(root, { recursive: true }); mkdirSync(bin, { recursive: true });
    const ssh = join(bin, 'ssh');
    writeFileSync(ssh, `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 97\n`);
    chmodSync(ssh, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Runner Privacy Fixture',
      GIT_AUTHOR_EMAIL: 'runner-privacy@example.invalid',
      GIT_COMMITTER_NAME: 'Runner Privacy Fixture',
      GIT_COMMITTER_EMAIL: 'runner-privacy@example.invalid',
    };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS']) delete env[name];
    sourceCase(root, env, kind);
    assert.deepEqual(invokeRunner(root, env, runnerModule), { code: expected }, `${kind} refuses before SSH`);
    assert.equal(existsSync(marker), false, `${kind} never invokes the SSH stand-in`);
  }
}
