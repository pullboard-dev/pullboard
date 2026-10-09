/** Durable check observations retry delivery without running their shell again [V2,H16]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { addItem, closeBoard, events, getItem, openBoard } from '../src/board.js';
import { prepareCheckBaseline } from '../src/check-baseline.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const WORKER_MODULE = new URL('../src/check-baseline-worker.js', import.meta.url).href;
const BOARD_FILE = '.git/pullboard/board.sqlite';
const TEMP_DIRS = [];
const SPEC = `# Delivery fixture\n\n## G · Goals\n- G1 [approved, must] The board retains the worker result. | gate: true\n`;

/** Remove each isolated repository after all child processes have exited. */
function cleanupFixtures() {
  for (const directory of TEMP_DIRS) rmSync(directory, { recursive: true, force: true });
}

after(cleanupFixtures);

/** Quote a shell word without allowing fixture paths or commands to become syntax. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Create private Git, CLI and machine-home settings without inherited Git repository selectors. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-baseline-delivery-'));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Baseline delivery fixture',
    GIT_AUTHOR_EMAIL: 'baseline-delivery@example.invalid',
    GIT_COMMITTER_NAME: 'Baseline delivery fixture',
    GIT_COMMITTER_EMAIL: 'baseline-delivery@example.invalid',
  });
  /** Run Git with only this private fixture's configuration and identity. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env });
  }
  /** Run the real CLI in a child whose lifetime is bounded by the test runner. */
  function run(cwd, args) {
    return runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  }
  return { dir, env, git, run };
}

/** Initialize and commit a real private Git repository with one configured lane. */
function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'result.txt'), 'baseline fixture\n');
  const initialized = box.run(repo, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const configFile = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, `${JSON.stringify({
    ...config,
    gate: 'true',
    spec: 'SPEC.md',
    lanes: { web: { owns: ['web/'], specs: ['G1'] } },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up baseline delivery fixture');
  return { ...box, repo };
}

/** Make a passing check whose only observable effect is one line outside the isolated clone. */
function markerCheck(marker) {
  const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n')`;
  return `${shellWord(process.execPath)} -e ${shellWord(script)}`;
}

/** Add one pending coordinator check to the fixture's real SQLite board. */
function addPendingItem(box, command) {
  const baseline = prepareCheckBaseline(box.repo, command);
  assert.equal(baseline.result, 'pending');
  const board = openBoard(join(box.repo, BOARD_FILE));
  try {
    const id = addItem(board, {
      by: 'coordinator', lane: 'web', title: 'Retryable background check',
      criterion: 'the pending check result is delivered once', check: command, checkBaseline: baseline,
    });
    return { id, baseline };
  } finally { closeBoard(board); }
}

/** Count baseline completion events in a board snapshot while its connection is open. */
function completionCount(board, id) {
  return events(board, { itemId: id }).filter((event) => event.event_kind === 'check-baseline').length;
}

/** Run the actual worker function in a clean child process using the fixture environment. */
function runWorker(box, id, request) {
  const source = `import { runCheckBaselineWorker } from ${JSON.stringify(WORKER_MODULE)};\nawait runCheckBaselineWorker(process.cwd(), Number(process.argv[1]), process.argv[2]);`;
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', source, String(id), request], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 45_000,
  });
}

test('[V2,H16] a saved worker receipt retries after relay metadata is repaired without rerunning its check', () => {
  const box = project();
  const marker = join(box.dir, 'check-runs.txt');
  const command = markerCheck(marker);
  const { id, baseline } = addPendingItem(box, command);
  const privateDir = join(box.repo, '.git', 'pullboard');
  const relayFile = join(privateDir, 'relay.json');
  const receiptDir = join(privateDir, 'baseline-results');
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(relayFile, JSON.stringify({ version: 1, board: 'invalid' }), { mode: 0o600 });
  assert.equal(statSync(relayFile).mode & 0o777, 0o600, 'the malformed relay fixture is still private');

  const worker = runWorker(box, id, baseline.request);
  assert.equal(worker.status, 0, `${worker.stdout}${worker.stderr}`);
  assert.equal(readFileSync(marker, 'utf8'), 'ran\n', 'the isolated check ran exactly once');
  const receiptNames = readdirSync(receiptDir);
  assert.deepEqual(receiptNames, [`${baseline.request}.json`], 'failed delivery retains its request receipt');
  const receiptFile = join(receiptDir, receiptNames[0]);
  assert.equal(statSync(receiptDir).mode & 0o777, 0o700);
  assert.equal(statSync(receiptFile).mode & 0o777, 0o600);
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.id, id);
  assert.deepEqual(receipt.expected, baseline);
  assert.equal(receipt.baseline.command, command);
  assert.equal(receipt.baseline.main, baseline.main);
  assert.equal(receipt.baseline.result, 'green');
  assert.ok(Number.isFinite(receipt.baseline.seconds));

  const pendingBoard = openBoard(join(box.repo, BOARD_FILE));
  try {
    assert.equal(getItem(pendingBoard, id).item_check_baseline.result, 'pending', 'the rejected linked delivery leaves the board pending');
    assert.equal(completionCount(pendingBoard, id), 0, 'no completion event exists until delivery succeeds');
  } finally { closeBoard(pendingBoard); }

  rmSync(relayFile);
  const retried = box.run(box.repo, ['show', String(id), '--json']);
  assert.equal(retried.status, 0, `${retried.stdout}${retried.stderr}`);
  const shown = JSON.parse(retried.stdout);
  assert.equal(shown.item_check_baseline.command, command);
  assert.equal(shown.item_check_baseline.main, baseline.main);
  assert.equal(shown.item_check_baseline.result, 'green');
  assert.equal(shown.item_check_baseline.request, baseline.request);
  assert.equal(shown.item_check_baseline.warning, 'CRITERION_PROVES_NOTHING');
  assert.match(retried.stdout, /CRITERION_PROVES_NOTHING/u);
  assert.deepEqual(readdirSync(receiptDir), [], 'successful retry removes the durable receipt');
  assert.equal(readFileSync(marker, 'utf8'), 'ran\n', 'receipt retry does not execute the check again');

  const repeated = box.run(box.repo, ['show', String(id), '--json']);
  assert.equal(repeated.status, 0, `${repeated.stdout}${repeated.stderr}`);
  assert.equal(readFileSync(marker, 'utf8'), 'ran\n');
  const finalBoard = openBoard(join(box.repo, BOARD_FILE));
  try {
    assert.equal(completionCount(finalBoard, id), 1, 'repeated reads do not duplicate the terminal event');
    assert.equal(getItem(finalBoard, id).item_check_baseline.result, 'green');
  } finally { closeBoard(finalBoard); }
});
