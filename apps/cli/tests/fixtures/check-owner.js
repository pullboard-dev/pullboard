/** The isolated check-ownership project the baseline journeys share, so splitting a journey file copies no prelude [V2,N23,C7]. */
import { runFixtureGit } from './child.js';
import { runCliInProcess } from './process.js';
import { HOST } from './runner/ssh.js';
import { installSshStandIn } from './runner/ssh.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { removeFixtureDirectory } from '../../../../packages/gate/tests/fixtures/diagnostics.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
export const TEMP_DIRS = [];
const SPEC = `# Check ownership fixture

## G · Goals
- G1 [approved, must] The fixture keeps its board. | gate: true
`;

/** Remove every fixture directory the sandboxes created. */
export function removeSandboxes() {
  for (const dir of TEMP_DIRS) removeFixtureDirectory(dir);
}

/** Quote a literal executable path for the fixture hook's POSIX shim. */
export function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Create an isolated Git fixture with a real CLI process runner. */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-check-owner-'));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Check owner test',
    GIT_AUTHOR_EMAIL: 'check-owner@example.invalid',
    GIT_COMMITTER_NAME: 'Check owner test',
    GIT_COMMITTER_EMAIL: 'check-owner@example.invalid',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  /** Run Git with private fixture identity and config. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the production dispatcher in this process, optionally with stdin; the same answer without a node start-up. */
  const runLocal = async (cwd, args, input) => runCliInProcess(args, { cwd, env, ...(input === undefined ? {} : { input }) });
  return { dir, env, git, runLocal };
}

/** Initialize the board and register a real worktree joined to the web lane. */
export async function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(repo, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  // Baseline --wait needs a registered runner; the isolated machine home starts without one.
  const worker = join(box.dir, 'worker');
  const remoteHome = join(box.dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  for (const folder of [worker, remoteHome, remoteMachineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin: join(box.dir, 'bin'), worker, home: remoteHome, machineHome: remoteMachineHome,
    requests: join(box.dir, 'ssh-requests.jsonl') });
  const registered = await box.runLocal(repo, ['runner', 'add', HOST, '--slots', '1', '--browser', '0', '--json']);
  assert.equal(registered.status, 0, registered.stderr);
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({
    ...config,
    gate: 'true',
    spec: 'SPEC.md',
    lanes: { web: { owns: ['web/'], specs: ['G1'] } },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up check ownership fixture');
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const joined = await box.runLocal(web, ['join', 'web']);
  assert.equal(joined.status, 0, joined.stderr);
  return { ...box, repo, web };
}
