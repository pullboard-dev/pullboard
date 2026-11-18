/** The CLI adapter uses production dispatch; only its wiring contract launches the binary [C7,A1,P4,N37]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  captureCommandInProcess,
  runCliInProcess,
} from '../../tests/fixtures/process.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

/** Give parity commands the same real working directory without initializing an unrelated board. */
function directory(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'pullboard-cli-adapter-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('cli.journeys-fact-process.in-process-production-commands-match-real: in-process production commands match real binary output and exit codes [C7,A1,P4,N37]', async t => {
  const cwd = directory(t);
  const bin = resolve(import.meta.dirname, '../../pullboard.js');
  // These five are adapter wiring contracts, not one subprocess per command in the help catalog.
  for (const argv of [['--version'], ['help', 'add'], ['help', 'milestone', 'bogus'],
    ['--unknown-option'], ['--json', 'help', 'milestone', 'bogus']]) {
    const actual = await runCliInProcess(argv, { cwd });
    const binary = runFixtureChild(process.execPath, [bin, ...argv], { cwd, env: process.env, encoding: 'utf8' });
    assert.equal(actual.status, binary.status, JSON.stringify(argv));
    assert.equal(actual.stdout, binary.stdout, JSON.stringify(argv));
    assert.equal(actual.stderr, binary.stderr, JSON.stringify(argv));
  }
});

test('cli.journeys-fact-process.production-help-dispatch-creates-no-child: production help dispatch creates no child process and keeps argument ownership [C7,N37]', async t => {
  const cwd = directory(t);
  /** A help command has no external boundary to delegate to a process. */
  const forbid = () => { throw new Error('the in-process command attempted a subprocess'); };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) t.mock.method(childProcess, name, forbid);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const argv = Object.freeze(['help', 'next']);
  const result = await runCliInProcess(argv, { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: pullboard next/mu);
  assert.equal(result.stderr, '');
  assert.deepEqual(argv, ['help', 'next']);
});

test('cli.journeys-fact-process.the-in-process-adapter-serializes-environment: the in-process adapter serializes environment and restores globals after failure [C7,H2,P4]', async t => {
  const cwd = directory(t);
  const original = { ...process.env };
  const originalCwd = process.cwd();
  const originalCode = process.exitCode;
  const observations = [];
  const failure = new Error('intentional adapter contract exception');
  /** Observe the exact caller environment, streams and cwd, including an unremoved agent marker. */
  async function refusing(args, io) {
    observations.push([process.env.PULLBOARD_ADAPTER_VALUE, process.env.CODEX_THREAD_ID, io.cwd, io.personChannel]);
    io.stdout.write(args.join('|'));
    io.stderr.write('before exception');
    process.env.PULLBOARD_ADAPTER_LEAK = 'must be restored';
    process.exitCode = 79;
    process.chdir(cwd);
    await Promise.resolve();
    throw failure;
  }
  /** A queued command must see its own supplied environment, not the failed predecessor's globals. */
  async function next(args, io) {
    observations.push([process.env.PULLBOARD_ADAPTER_VALUE, process.env.CODEX_THREAD_ID, io.cwd, io.personChannel]);
    assert.equal(process.env.PULLBOARD_ADAPTER_LEAK, undefined);
    let input = '';
    for await (const chunk of io.stdin) input += chunk;
    io.stdout.write(input + args[0]);
    io.stderr.write('diagnostic');
    return 2;
  }
  const env = { ...original, PULLBOARD_ADAPTER_VALUE: 'first', CODEX_THREAD_ID: 'retained-agent-marker' };
  delete env.PULLBOARD_ADAPTER_LEAK;
  const first = captureCommandInProcess(refusing, ['literal', '--argument'], { cwd, env });
  const second = captureCommandInProcess(next, ['tail'], { cwd, env: { ...env, PULLBOARD_ADAPTER_VALUE: 'second' }, input: 'head' });
  await assert.rejects(first, error => error === failure);
  const captured = await second;
  assert.deepEqual(observations, [
    ['first', 'retained-agent-marker', cwd, undefined],
    ['second', 'retained-agent-marker', cwd, undefined],
  ]);
  assert.equal(captured.status, 2);
  assert.equal(captured.stdout, 'headtail');
  assert.equal(captured.stderr, 'diagnostic');
  assert.deepEqual({ ...process.env }, original);
  assert.equal(process.cwd(), originalCwd);
  assert.equal(process.exitCode, originalCode);
});


test('cli.journeys-fact-process.in-process-dispatch-retains-the-production: in-process dispatch retains the production person-channel refusal [H2,B26,C7]', async t => {
  const cwd = directory(t);
  const result = await runCliInProcess(['relay', 'members', 'set', 'alice', '--json'], {
    cwd, env: { ...process.env, CODEX_THREAD_ID: 'adapter-contract-agent' },
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'B26_PERSON_CHANNEL');
});


test('cli.journeys-fact-process.in-process-writes-use-the-private: in-process writes use the private board and fresh reads match the binary [C7,A1,B1,B3]', async t => {
  const fixtures = createE2eHelpers();
  t.after(fixtures.cleanup);
  const box = fixtures.project('true', undefined, { withWorktree: false });
  const argv = ['add', 'web', 'Created without a CLI child', '--specs', 'G1', '--criterion', 'The handler writes the native item.', '--json'];
  const created = await runCliInProcess(argv, { cwd: box.repo, env: box.env });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  // @pullboard-board-file journey: inspect the durable board written by production in-process dispatch before comparing binary reads
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const item = store.getItem(board, 1);
    assert.equal(item.item_title, 'Created without a CLI child');
    assert.equal(item.item_created_by, 'coordinator');
    assert.equal(store.events(board, { itemId: 1 }).filter(event => event.event_kind === 'add').length, 1);
  } finally { store.closeBoard(board); }
  // Stable read output has no relative ages or fresh UUIDs: compare every byte, not selected fields.
  const read = ['lanes', '--json'];
  const direct = await runCliInProcess(read, { cwd: box.repo, env: box.env });
  const binary = box.run(box.repo, ...read);
  assert.equal(direct.status, binary.code);
  assert.equal(direct.stdout, binary.out);
  assert.equal(direct.stderr, binary.err);
  const identity = await runCliInProcess(['whoami', '--json'], { cwd: box.repo, env: box.env });
  assert.equal(identity.status, 0, identity.stderr);
  assert.equal(JSON.parse(identity.stdout).lane, 'coordinator');
  assert.equal(JSON.parse(identity.stdout).path, box.repo);
  const other = fixtures.project('true', undefined, { withWorktree: false });
  const empty = await runCliInProcess(['list', '--all', '--json'], { cwd: other.repo, env: other.env });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).items.length, 0, 'a fresh command scope does not reuse the previous board');
});
