/** A green gate stores a review packet a reviewer reads instead of checking out and rerunning [V4,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { TIMING_RUN_ID_ENV } from '../../../../packages/gate/index.js';
import { testTierReport } from '../../../../packages/gate/index.js';

const helpers = createE2eHelpers();
// A green submit starts the detached verification comparison, which can still be writing the board directory;
// rmSync's own bounded retries wait out its ENOTEMPTY instead of a timer in the test.
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

/**
 * A fixture reporter that prints TAP and the gate's native per-test outcome frames, the way the repo's own runner
 * does, so the gate's receipt records which tests executed, passed or were skipped.
 */
function outcomeReporter(box) {
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), `import { tap } from 'node:test/reporters';
import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(new URL('../../../../packages/gate/index.js', import.meta.url).href)};
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

const RUN = 'node --test --test-reporter=./web/outcome-reporter.js';
const CRITERION = 'The page shows a greeting. The greeting names the visitor by first name. Old browsers fall back to plain text.';

test('a green gate stores a packet whose clauses map to its runs, names the uncovered ones, and show --review reads it in under 2 s with no checkout or test [V4,C7]', { timeout: 240_000 }, () => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  // The fixture's own `node --test` must run its files, not see this runner's context and skip them.
  delete box.env.NODE_TEST_CONTEXT;
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = RUN;
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  outcomeReporter(box);
  commit(box, box.repo, 'chore: seed review packet fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  ok(box, builder, 'join', 'web', '--model', 'fixture-builder');
  const added = JSON.parse(ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--criterion', CRITERION,
    '--check', `${RUN} web/packet.test.js`, '--json').out);
  const id = added.item.item_id;
  ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/packet.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('the page shows a greeting [G1]', () => assert.match(greet('Ada Lovelace'), /^Hello/u));",
    "test('clause 2: the visitor is named [G1]', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));",
    // Declared and citing clause 3, but skipped: the gate never ran it, so clause 3 has no recorded run.
    "test('clause 3: Old browsers fall back to plain text [G1]', { skip: true }, () => assert.fail('not implemented'));",
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): greet the visitor by first name [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  const submitted = JSON.parse(ok(box, builder, 'submit', String(id), '--no-next', '--json').out);
  assert.equal(submitted.gate.green, true, 'the fixture gate is green');

  const stored = join(box.repo, '.git', 'pullboard', 'review-packets', String(id), `${head}.json`);
  assert.ok(existsSync(stored), 'the packet is stored when the gate goes green, before anyone asks for it');

  const shown = JSON.parse(ok(box, box.repo, 'show', String(id), '--json').out);
  const receiptIds = new Set(shown.proofReceipts.map(receipt => receipt.id));
  assert.ok(receiptIds.size > 0, 'the gate recorded proof receipts');

  const git = loggingGit(box);
  const path = box.env.PATH;
  box.env.PATH = `${git.bin}:${path}`;
  // The resident board process serves show from a warm process that logs no startup phases and runs git outside this shim; this case measures and watches the real CLI process [H24,C7].
  box.env.PULLBOARD_RESIDENT = '0';
  const startupTrace = join(box.dir, 'review-startup.jsonl');
  box.env.PULLBOARD_STARTUP_TRACE_FILE = startupTrace;
  box.env.PULLBOARD_STARTUP_TRACE_ENTRY = helpers.BIN;
  const traceSamples = [];
  let review;
  for (let run = 0; run < 3; run += 1) {
    const traceOffset = existsSync(startupTrace) ? readFileSync(startupTrace, 'utf8').split('\n').filter(Boolean).length : 0;
    const started = performance.now();
    const current = ok(box, box.repo, 'show', String(id), '--review');
    const elapsedMs = performance.now() - started;
    review ??= current;
    const traceRows = existsSync(startupTrace)
      ? readFileSync(startupTrace, 'utf8').split('\n').filter(Boolean).slice(traceOffset).map(line => JSON.parse(line))
      : [];
    assert.ok(traceRows.length > 0, `startup trace is recorded for run ${run + 1}`);
    traceSamples.push({ run: run + 1, processId: traceRows[0]?.processId ?? null,
      phases: traceRows.map(({ phase, elapsedMs: phaseElapsedMs }) => ({ phase, elapsedMs: phaseElapsedMs })) });
    assert.ok(elapsedMs < 2000, `show --review run ${run + 1} took ${Math.round(elapsedMs)} ms; startup samples ${JSON.stringify(traceSamples)}`); // budget: declared ceiling of the frozen bar
  }
  delete box.env.PULLBOARD_STARTUP_TRACE_FILE;
  delete box.env.PULLBOARD_STARTUP_TRACE_ENTRY;
  delete box.env.PULLBOARD_RESIDENT;
  const packet = JSON.parse(ok(box, box.repo, 'show', String(id), '--review', '--json').out);
  box.env.PATH = path;
  const calls = existsSync(git.log) ? readFileSync(git.log, 'utf8').split('\n').filter(Boolean) : [];
  assert.deepEqual(calls.filter(call => /(?:^| )(?:checkout|switch|read-tree|clone|diff|cat-file|worktree add)(?: |$)/u.test(call)), [],
    'show --review reads the stored packet: no checkout and no diff');

  assert.equal(packet.head, head);
  assert.match(packet.diff.stat, /web\/packet\.test\.js/u);
  assert.match(packet.diff.patch, /^\+test\('clause 2: the visitor is named \[G1\]'/mu, 'the full hunks are in the packet');
  assert.deepEqual(packet.clauses.map(clause => clause.n), [1, 2, 3, 4]);
  assert.match(packet.clauses[3].text, /^G1: /u, 'each frozen spec row is a clause after the criterion');
  for (const n of [1, 2, 4]) {
    const clause = packet.clauses[n - 1];
    assert.ok(clause.runs.length > 0, `clause ${n} maps to a recorded run`);
    for (const run of clause.runs) {
      assert.equal(run.file, 'web/packet.test.js');
      assert.equal(run.result, 'pass');
      assert.ok(receiptIds.has(run.receipt), `clause ${n} cites a recorded gate receipt`);
    }
  }
  assert.equal(packet.clauses[1].runs[0].test, 'clause 2: the visitor is named [G1]');
  assert.deepEqual(packet.clauses[2].runs, [], 'a skipped test that cites the clause is not a recorded run');
  assert.ok(packet.clauses.every(clause => clause.runs.every(run => run.test !== 'clause 3: Old browsers fall back to plain text [G1]')));
  assert.equal(packet.clauses[2].gap, 'no recorded run');
  assert.deepEqual(packet.failures, []);
  assert.deepEqual(packet.cells, { before: 0, after: 0, added: [], removed: [], touched: [] });
  assert.match(review.out, /^ {2}3\. Old browsers fall back to plain text\.\n {5}no recorded run: read this clause and name it in --read$/mu, 'the uncovered clause is named');
  assert.match(review.out, /^failures at head: none$/mu);
  const rerun = packet.clauses.filter(clause => !clause.runs.length).map(clause => clause.n);
  assert.ok(rerun.includes(3) && !rerun.includes(1) && !rerun.includes(2) && !rerun.includes(4));
  assert.match(review.out, new RegExp(`^review rule: read every clause marked no recorded run \\(${rerun.join(', ')}\\) and name it in --read`, 'mu'));

  const reviewer = join(box.dir, 'api-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  ok(box, reviewer, 'join', 'api', '--model', 'fixture-reviewer');
  const offer = ok(box, reviewer, 'next', '--verify', String(id));
  assert.match(offer.out, /^next to verify: #\d+ Greet the visitor/mu);
  assert.match(offer.out, new RegExp(`^review packet #${id} at ${head.slice(0, 12)}`, 'mu'), 'next --verify prints the packet with the offer');
  assert.match(offer.out, /^ {5}no recorded run: read this clause and name it in --read$/mu);

  const refused = box.run(reviewer, 'verify', String(id), 'accept', '--read', '9', '--note', 'read the packet');
  assert.notEqual(refused.code, 0, 'a clause number outside the packet is refused');
  ok(box, reviewer, 'verify', String(id), 'accept', '--read', '1,2,3', '--note', 'read the packet; reran clause 3 by hand');
  const verdict = JSON.parse(ok(box, box.repo, 'show', String(id), '--json').out).verdicts.at(-1);
  assert.equal(verdict.verdict_decision, 'ACCEPT');
  assert.match(verdict.verdict_note, new RegExp(`review packet ${head.slice(0, 12)}: read clauses 1, 2, 3; no recorded run: ${rerun.join(', ')}$`, 'mu'),
    'the accept records which clauses it read');
});

test('a test clause with no case of its own is proved by the item\'s check cases the gate ran; a clause whose own case was skipped is not [V4,C7]', { timeout: 240_000 }, () => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  // The fixture's own `node --test` must run its files, not see this runner's context and skip them.
  delete box.env.NODE_TEST_CONTEXT;
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = RUN;
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  outcomeReporter(box);
  commit(box, box.repo, 'chore: seed review packet fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  ok(box, builder, 'join', 'web', '--model', 'fixture-builder');
  const added = JSON.parse(ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--criterion', '1. The page shows a greeting [test] 2. Legacy callers keep working [test] 3. Old browsers fall back to plain text [test]',
    '--check', `${RUN} web/packet.test.js`, '--json').out);
  const id = added.item.item_id;
  ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/packet.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('the page shows a greeting [G1]', () => assert.match(greet('Ada Lovelace'), /^Hello/u));",
    "test('the visitor is named [G1]', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));",
    // Declared and citing clause 3, but skipped: the gate never ran it, so clause 3 has no recorded run.
    "test('clause 3: Old browsers fall back to plain text [G1]', { skip: true }, () => assert.fail('not implemented'));",
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): greet the visitor by first name [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  for (const n of [1, 2, 3]) ok(box, builder, 'fact', String(id), 'note', `clause ${n} [test]: web/packet.test.js, run by the check for clause ${n}`);
  const submitted = JSON.parse(ok(box, builder, 'submit', String(id), '--no-next', '--json').out);
  assert.equal(submitted.gate.green, true, 'the fixture gate is green');
  const packet = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'review-packets', String(id), `${head}.json`), 'utf8'));
  const [greeting, legacy, old] = packet.clauses;
  assert.ok(greeting.runs.length, 'the greeting clause is matched by its words');
  assert.ok(legacy.runs.length, 'a test clause with no case of its own cites the check cases the gate ran');
  assert.ok(legacy.runs.every(run => run.file === 'web/packet.test.js' && run.result === 'pass' && run.why === "the item's check ran"), JSON.stringify(legacy.runs));
  assert.deepEqual(old.runs, [], 'a clause whose own case was skipped keeps no recorded run');
  assert.equal(old.gap, 'no recorded run');
});

test('a red refusal counts the T1 units and names only the failing cases [V4,C7]', () => {
  const plan = { units: ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'], journeys: ['test/j.test.js'] };
  assert.match(testTierReport(plan), /^T1 unit tests \(3\): test\/a\.test\.js, test\/b\.test\.js, test\/c\.test\.js$/mu);
  const red = testTierReport(plan, { names: false });
  assert.doesNotMatch(red, /test\/[abc]\.test\.js/u, 'the red message does not list every unit that ran');
  assert.match(red, /^T1 unit tests: 3 ran; the failing cases follow/mu);
  assert.match(red, /^T3 journeys deferred to the landing batch \(1\)$/mu);
});
