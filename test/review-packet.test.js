/** A green gate stores a review packet a reviewer reads instead of checking out and rerunning [V4,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

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

const CRITERION = 'The page shows a greeting. The greeting names the visitor by first name. Old browsers fall back to plain text. The full suite passes as run by the submit gate.';

test('a green gate stores a packet whose clauses map to its runs, names the uncovered ones, and show --review reads it in under 2 s with no checkout or test [V4,C7]', { timeout: 240_000 }, () => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = 'node --test';
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  commit(box, box.repo, 'chore: seed review packet fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  ok(box, builder, 'join', 'web');
  const added = JSON.parse(ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--criterion', CRITERION,
    '--check', 'node --test web/packet.test.js', '--json').out);
  const id = added.item.item_id;
  ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/packet.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('the page shows a greeting [G1]', () => assert.match(greet('Ada Lovelace'), /^Hello/u));",
    "test('clause 2: the visitor is named [G1]', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));",
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
  const started = performance.now();
  const review = ok(box, box.repo, 'show', String(id), '--review');
  const elapsedMs = performance.now() - started;
  const packet = JSON.parse(ok(box, box.repo, 'show', String(id), '--review', '--json').out);
  box.env.PATH = path;
  assert.ok(elapsedMs < 2000, `show --review took ${Math.round(elapsedMs)} ms`);
  const calls = existsSync(git.log) ? readFileSync(git.log, 'utf8').split('\n').filter(Boolean) : [];
  assert.deepEqual(calls.filter(call => /(?:^| )(?:checkout|switch|read-tree|clone|diff|cat-file|worktree add)(?: |$)/u.test(call)), [],
    'show --review reads the stored packet: no checkout and no diff');

  assert.equal(packet.head, head);
  assert.match(packet.diff.stat, /web\/packet\.test\.js/u);
  assert.match(packet.diff.patch, /^\+test\('clause 2: the visitor is named \[G1\]'/mu, 'the full hunks are in the packet');
  assert.deepEqual(packet.clauses.map(clause => clause.n), [1, 2, 3, 4]);
  for (const n of [1, 2]) {
    const clause = packet.clauses[n - 1];
    assert.ok(clause.runs.length > 0, `clause ${n} maps to a recorded run`);
    for (const run of clause.runs) {
      assert.equal(run.file, 'web/packet.test.js');
      assert.equal(run.result, 'pass');
      assert.ok(receiptIds.has(run.receipt), `clause ${n} cites a recorded gate receipt`);
    }
  }
  assert.equal(packet.clauses[1].runs[0].test, 'clause 2: the visitor is named [G1]');
  assert.deepEqual(packet.clauses[2].runs, []);
  assert.equal(packet.clauses[2].gap, 'no recorded run');
  assert.match(packet.clauses[3].gap, /deferred the full suite/u, 'a deferred full suite is not a recorded run');
  assert.deepEqual(packet.failures, []);
  assert.deepEqual(packet.cells, { before: 0, after: 0, added: [], removed: [], touched: [] });
  assert.match(review.out, /^ {2}3\. Old browsers fall back to plain text\.\n {5}no recorded run: rerun this clause$/mu, 'the uncovered clause is named');
  assert.match(review.out, /^failures at head: none$/mu);
  assert.match(review.out, /^review rule: rerun only clauses marked no recorded run \(3, 4\)/mu);

  const reviewer = join(box.dir, 'api-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  ok(box, reviewer, 'join', 'api');
  const offer = ok(box, reviewer, 'next', '--verify', String(id));
  assert.match(offer.out, /^next to verify: #\d+ Greet the visitor/mu);
  assert.match(offer.out, new RegExp(`^review packet #${id} at ${head.slice(0, 12)}`, 'mu'), 'next --verify prints the packet with the offer');
  assert.match(offer.out, /^ {5}no recorded run: rerun this clause$/mu);

  const refused = box.run(reviewer, 'verify', String(id), 'accept', '--read', '9', '--note', 'read the packet');
  assert.notEqual(refused.code, 0, 'a clause number outside the packet is refused');
  ok(box, reviewer, 'verify', String(id), 'accept', '--read', '1,2,3', '--note', 'read the packet; reran clause 3 by hand');
  const verdict = JSON.parse(ok(box, box.repo, 'show', String(id), '--json').out).verdicts.at(-1);
  assert.equal(verdict.verdict_decision, 'ACCEPT');
  assert.match(verdict.verdict_note, new RegExp(`review packet ${head.slice(0, 12)}: read clauses 1, 2, 3; no recorded run: 3, 4`, 'u'),
    'the accept records which clauses it read');
});
