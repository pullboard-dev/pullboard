/** Accept from the review packet: a fully covered packet records the verdict with no checkout or test run [V4,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { TIMING_RUN_ID_ENV } from '../packages/gate/index.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import * as store from '../packages/store/index.js';
import { reviewPacketRerun } from '../packages/verify/index.js';

const helpers = createE2eHelpers();
// A green submit starts the detached verification comparison, which can still be writing the board directory.
after(() => {
  for (const dir of helpers.sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
});

/** Run the actual CLI and keep its complete output when an assertion fails. */
function ok(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return result;
}

/** Commit fixture bytes through the installed native Git hooks. */
function commit(box, cwd, message) {
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', message);
}

/** A `git` on the PATH that logs every call before running the real one. */
function loggingGit(box) {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: box.env }).stdout.trim();
  const bin = join(box.dir, 'logging-git');
  const log = join(box.dir, 'git-calls.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { bin, log };
}

/** The repo runner's reporter shape: TAP plus native per-test outcome frames, so receipts record each test. */
function outcomeReporter(box) {
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), `import { tap } from 'node:test/reporters';
import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(new URL('../packages/gate/index.js', import.meta.url).href)};
export default async function* report(events) {
  const collector = testOutcomeCollector(process.cwd());
  let count = null;
  async function* observe() {
    for await (const event of events) {
      collector.observe(event);
      if (event.type === 'test:summary') count = event.data.counts.tests;
      yield event;
    }
  }
  for await (const chunk of tap(observe())) yield chunk;
  yield formatTestOutcomes(process.env[${JSON.stringify(TIMING_RUN_ID_ENV)}], collector.finish(count !== null, count));
}
`);
}

/** The Git subcommand of one logged call, after any -C, -c and other global options. */
function subcommand(call) {
  const parts = call.split(' ');
  let index = 0;
  while (parts[index]?.startsWith('-')) index += ['-C', '-c', '--git-dir', '--work-tree'].includes(parts[index]) ? 2 : 1;
  return parts.slice(index, index + 2).join(' ');
}

const RUN = 'node --test --test-reporter=./web/outcome-reporter.js';

/**
 * A real repo and board with a web item submitted green; every test run appends to a marker file.
 * With `uncovered`, clause 3 has only a skipped test, so the packet marks it no recorded run.
 */
function submittedItem({ uncovered }) {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  // Runners set no model; the fixture's seats declare one.
  box.env.PULLBOARD_MODEL = 'fixture-model';
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = RUN;
  config.gate = `${RUN} web/packet.test.js`;
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  outcomeReporter(box);
  commit(box, box.repo, 'chore: seed accept fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  ok(box, builder, 'join', 'web');
  const criterion = uncovered
    ? 'The page shows a greeting. The greeting names the visitor by first name. Old browsers fall back to plain text.'
    : 'The page shows a greeting. The greeting names the visitor by first name.';
  const added = JSON.parse(ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--criterion', criterion,
    '--check', `${RUN} web/packet.test.js`, '--json').out);
  const id = added.item.item_id;
  ok(box, builder, 'claim', String(id));
  const marker = join(box.dir, 'test-ran.log');
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/packet.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    `appendFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
    "test('clause 1: the page shows a greeting [G1]', () => assert.match(greet('Ada Lovelace'), /^Hello/u));",
    "test('clause 2: the visitor is named [G1]', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));",
    ...(uncovered ? ["test('clause 3: old browsers fall back to plain text [G1]', { skip: true }, () => {});"] : []),
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): greet the visitor by first name [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  const submitted = JSON.parse(ok(box, builder, 'submit', String(id), '--no-next', '--json').out);
  assert.equal(submitted.gate.green, true, 'the fixture gate is green');
  const packet = JSON.parse(ok(box, box.repo, 'show', String(id), '--review', '--json').out);
  rmSync(marker, { force: true });
  // The reviewer's seat sits on main, not on the submitted commit.
  const reviewer = join(box.dir, 'api-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  ok(box, reviewer, 'join', 'api');
  return { box, id, head, packet, marker, reviewer };
}

test('a fully covered packet accepts in under 10 s with no checkout, test process or main merge, and landing still runs its gate [V4,C7]', { timeout: 240_000 }, () => {
  const { box, id, head, packet, marker, reviewer } = submittedItem({ uncovered: false });
  assert.deepEqual(packet.clauses.filter(clause => !clause.runs.length).map(clause => clause.n), [], 'every clause cites a recorded run');
  const git = loggingGit(box);
  const path = box.env.PATH;
  box.env.PATH = `${git.bin}:${path}`;
  const started = performance.now();
  const accepted = ok(box, reviewer, 'verify', String(id), 'accept', '--note', 'read the packet');
  const elapsedMs = performance.now() - started;
  box.env.PATH = path;
  assert.ok(elapsedMs < 10_000, `accept took ${Math.round(elapsedMs)} ms`); // budget: declared ceiling of the frozen bar
  assert.match(accepted.out, new RegExp(`accepted from review packet ${head.slice(0, 12)}`, 'u'));
  assert.equal(existsSync(marker), false, 'no test process ran the frozen check');
  const calls = readFileSync(git.log, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(calls.map(subcommand).filter(call => /^(?:checkout|switch|clone|merge|read-tree)(?: |$)|^worktree add/u.test(call)), [],
  'no checkout, worktree or merge of its own');
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD').trim(), box.git(box.repo, 'rev-parse', 'main').trim(), 'the reviewer checkout never moved');
  const verdict = JSON.parse(ok(box, box.repo, 'show', String(id), '--json').out).verdicts.at(-1);
  assert.equal(verdict.verdict_decision, 'ACCEPT');
  assert.match(verdict.verdict_note, /every clause is covered by a recorded green run/u);
  // The landing step still composes main and runs the landing gate, which runs the item's test.
  box.git(box.dir, 'init', '-q', '--bare', join(box.dir, 'origin.git'));
  box.git(box.repo, 'remote', 'add', 'origin', join(box.dir, 'origin.git'));
  const landed = JSON.parse(ok(box, box.repo, 'land', '--json').out);
  assert.deepEqual(landed.landed, [id], JSON.stringify(landed));
  assert.ok(existsSync(marker), 'the landing gate ran the item test');
});

test('a packet with one uncovered clause runs the frozen check and names the clause that forced it [V4,C7]', { timeout: 240_000 }, () => {
  const { box, id, head, packet, marker } = submittedItem({ uncovered: true });
  assert.deepEqual(packet.clauses.filter(clause => !clause.runs.length).map(clause => clause.n), [3]);
  // The full path checks the submitted commit out, as today.
  const reviewer = join(box.dir, 'api-review-at-head');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  ok(box, reviewer, 'join', 'api');
  const accepted = ok(box, reviewer, 'verify', String(id), 'accept', '--note', 'reran clause 3');
  assert.match(accepted.out, new RegExp(`review packet ${head.slice(0, 12)}: clause 3 has no recorded run; running the frozen check`, 'u'));
  assert.doesNotMatch(accepted.out, /accepted from review packet/u);
  assert.ok(existsSync(marker), 'the frozen check ran its test');
});

test('a same-head refreeze cannot reuse coverage from the prior criterion digest [V4,C7]', { timeout: 240_000 }, () => {
  const { box, id, head } = submittedItem({ uncovered: false });
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const before = store.getItem(board, id);
    const priorDigest = before.item_frozen_digest;
    store.refreeze(board, id, { agentId: 'coordinator', freeze: () => ({ text: `${before.item_frozen}\nCorrection: revised criterion.`, digest: 'd'.repeat(64) }) });
    const refrozen = store.getItem(board, id);
    assert.equal(refrozen.item_commit, head, 'the source head is unchanged');
    assert.notEqual(refrozen.item_frozen_digest, priorDigest, 'refreeze changes only the criterion digest');
    assert.equal(reviewPacketRerun(join(box.repo, '.git'), refrozen), null,
      'the packet for the same commit is stale and cannot authorize skipping the current frozen check');
  } finally { closeBoard(board); }
});
