/** Real private flake projects own their counter and native board evidence bytes [C7,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../../../apps/cli/tests/fixtures/child.js';
import { runCliInProcess } from '../../../../apps/cli/tests/fixtures/process.js';
import { fixtureSettledMachine } from '../../../../apps/cli/tests/fixtures/testkit.js';
import { HOST } from '../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { evidenceReader } from './evidence.js';

const BIN = resolve(import.meta.dirname, '../../../../apps/cli/pullboard.js');
export const TITLE = 'a controlled intermittent assertion [C7]';

/** Initialize a real private board and Git history; optional pre-init source seeding can return the fixture CLI path. */
export function flakyProject(t, { rerun = true, reporter = 'tap', alwaysPass = false, beforeInit } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-native-flake-')));
  // A Submit leaves detached diagnostics and workers that still write under the scratch; wait for them before removing it.
  t.after(() => {
    // The pattern rides in the environment so the waiting shell's own arguments never match it; capped at 90 s.
    runFixtureChild('/bin/sh', ['-c', 'n=0; while pgrep -f "$PB_SCRATCH" >/dev/null && [ $n -lt 180 ]; do sleep 0.5; n=$((n+1)); done'],
      { env: { ...process.env, PB_SCRATCH: scratch }, encoding: 'utf8' });
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const root = join(scratch, 'repo'); mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Agent', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture Agent', GIT_COMMITTER_EMAIL: 'fixture@example.com',
    PULLBOARD_HOME: join(scratch, 'home'), PULLBOARD_MACHINE_HOME: join(scratch, 'machine'), PULLBOARD_VIEW_BACKGROUND: '0',
    // A claim starts no detached beater bound to the test process, which the scratch wait below would sit out (#5726).
    PULLBOARD_CLAIM_BEATER: '0' };
  delete env.PULLBOARD_RELAY_TOKEN; delete env.NODE_TEST_CONTEXT;
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL']) delete env[key]; // the host agent's session must not make builder and reviewer one session [V4]
  /** Run Git only within this fixture with a private deterministic identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  let cliBin = BIN;
  /** Exercise the real CLI, retaining only its structured receipt for assertions. */
  const cliAt = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [cliBin, ...args, '--json'], { cwd, env, encoding: 'utf8' });
    return { code: result.status, document: result.stdout?.trim() ? JSON.parse(result.stdout) : null, failure: result.failure, stderr: result.stderr };
  };
  /** The same receipt as cliAt, from an awaited in-process run of the production dispatch; the fixture's own binary is not used. */
  const callAt = async (cwd, ...args) => {
    const result = await runCliInProcess([...args, '--json'], { cwd, env });
    return { code: result.status, document: result.stdout?.trim() ? JSON.parse(result.stdout) : null, failure: result.failure, stderr: result.stderr };
  };
  /** Keep the coordinator's normal command path separate from its actual joined worktrees. */
  const cli = (...args) => cliAt(root, ...args);
  const call = (...args) => callAt(root, ...args);
  git('init', '-q', '-b', 'main');
  cliBin = beforeInit?.({ root, scratch, env, git }) ?? BIN;
  assert.equal(cli('init').code, 0);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(cliBin, join(root, 'node_modules/.bin/pullboard'));
  appendFileSync(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  const file = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = `node --test --test-reporter=${reporter} test/alternating.test.mjs`;
  config.flakes = rerun === null ? undefined : { rerun };
  // These fixtures test coupled gate-before-push, independently of init's no-remote default.
  // Automatic landing is the default, so the fixture's manual landing steps need the accepted-policy override.
  config.landing = { manualOverride: true };
  // These synthetic checks intentionally match the already-configured gate; a private warning policy permits the controlled failure to be armed after submission.
  config.checks = { ...config.checks, provesNothing: 'warn' };
  config.lanes = { build: { owns: ['src/', 'test/'], specs: [] } };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  mkdirSync(join(root, 'test'));
  const counter = join(scratch, 'observed-target-runs');
  if (alwaysPass === 'controlled') writeFileSync(counter + '.mode', 'pass');
  writeTarget(root, counter, alwaysPass);
  git('add', '-A'); git('commit', '-q', '-m', 'chore: prepare private flake fixture');
  const readData = evidenceReader({ scratch, root, counter });
  return { root, scratch, env, git, cli, cliAt, call, callAt, counter, readData, lane: 'build' };
}

/** Keep the exact same test identity on main and a candidate, with independently controlled behavior. */
export function writeTarget(root, counter, alwaysPass = false, mutate = false) {
  const assertion = "assert.equal(readFileSync(marker, 'utf8').trim().split('\\n').length % 2, 0);";
  writeFileSync(join(root, 'test/alternating.test.mjs'), `import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record real executions; the fixture controls whether the assertion is passing or intermittent. */
test(${JSON.stringify(TITLE)}, () => {
  const marker = ${JSON.stringify(counter)};
  appendFileSync(marker, 'run\\n');
  ${mutate ? (mutate === 'controlled' ? "if (readFileSync(marker + '.mode', 'utf8') !== 'pass') " : '') + 'appendFileSync(new URL(import.meta.url), ' + JSON.stringify('\n// fixture source changed\n') + ');' : ''}
  ${alwaysPass === 'controlled' ? "if (readFileSync(marker + '.mode', 'utf8') !== 'pass') " + assertion : alwaysPass ? 'assert.ok(true);' : assertion}
});\n`);
}

/** Count the target's actual executions independently of any agent's reported verdict. */
export function targetRuns(box) { return box.readData(box.counter, 'utf8').trim().split('\n').length; }

/** Verify the whole immutable evidence, including profiles, before the private fixture is removed. */
export function assertReceipts(box, observation) {
  for (const value of [observation.original, observation.paired, observation.mainReceipt].filter(Boolean)) {
    const file = join(box.root, '.git/pullboard', value.artifact);
    const bytes = box.readData(file);
    assert.equal(bytes.length, value.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256);
    if (value.profileSha256 !== null) assert.equal(createHash('sha256').update(box.readData(file.replace(/\.log$/u, '.profile.json'))).digest('hex'), value.profileSha256);
  }
}

/** Join through the actual CLI, using a separate session-bound worktree for a candidate. */
export function privateBuilder(box) {
  const made = box.cli('worktree', box.lane, '--model', 'Flake fixture model');
  assert.equal(made.code, 0, JSON.stringify(made.document));
  const root = made.document.path;
  /** Run a candidate command without taking the coordinator's seat. */
  const cli = (...args) => box.cliAt(root, ...args);
  const call = (...args) => box.callAt(root, ...args);
  /** Commit only this private candidate's source. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  return { root, cli, call, git };
}

/** Commit one real file change in a private candidate, because submit refuses a head with no change against main. */
export function commitCandidate(builder, message) {
  mkdirSync(join(builder.root, 'test'), { recursive: true });
  writeFileSync(join(builder.root, 'test/candidate-note.txt'), message + '\n');
  builder.git('add', '-A');
  builder.git('commit', '-q', '-m', message);
}

/** Await the real baseline, then start each later controlled assertion with a fresh execution counter. */
export function checkedItem(box) {
  writeFileSync(box.counter, ''); // Earlier real push guards may have executed the same controlled target.
  const check = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).gate;
  const bin = join(box.scratch, 'baseline-bin'), worker = join(box.scratch, 'baseline-worker');
  const home = join(box.scratch, 'baseline-home'), machine = box.env.PULLBOARD_MACHINE_HOME;
  for (const path of [bin, worker, home, join(home, '.pullboard'), machine]) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests: join(box.scratch, 'baseline-ssh.jsonl'), nodeCommand: process.execPath });
  const settings = join(machine, 'settings.json'), previous = existsSync(settings) ? readFileSync(settings) : null;
  const previousPath = box.env.PATH;
  box.env.PATH = `${bin}:${previousPath}`;
  fixtureSettledMachine(machine, { gateSlots: 0, browserSlots: 0, gate: { browserFreeChecks: true, timingRunner: false },
    runners: [{ host: HOST, slots: 1, browser: 0, node: process.execPath, root: join(home, '.pullboard-runner') }] });
  // Mid route: a light item now needs a recorded diagnosis (DIAGNOSIS_REQUIRED), which this fixture does not exercise.
  let added;
  try {
    added = box.cli('add', box.lane, 'Controlled Native check', '--criterion', 'The controlled target passes without accepting retries.',
      '--route', 'mid', '--brief', 'Files: test/alternating.test.mjs\nTest: run its configured Node TAP check. Preserve the original failed verdict while retaining exact diagnostic receipts.', '--check', check, '--wait');
  } finally {
    box.env.PATH = previousPath;
    if (previous === null) unlinkSync(settings); else writeFileSync(settings, previous);
  }
  assert.equal(added.code, 0, JSON.stringify(added.document));
  assert.ok(['red', 'green'].includes(added.document.item.item_check_baseline.result), 'baseline setup finished before the measured check');
  assert.equal(targetRuns(box), 1, 'the baseline really executed the controlled command once');
  writeFileSync(box.counter, '');
  return added.document.item.item_id;
}
