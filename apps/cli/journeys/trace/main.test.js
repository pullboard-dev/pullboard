/** Every pullboard run appends one trace line, and tracing never changes a command's outcome [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  appendTrace,
  itemOf,
  redactArgs,
} from '../../src/io/trace.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The parsed lines of every trace file under a repo, oldest first. */
function traceLines(repo) {
  const dir = join(repo, '.git', 'pullboard', 'trace');
  return readdirSync(dir).sort().flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

/** A scratch repo with one open item on the web lane, and the item's id. */
function scratch() {
  const box = e2e.project('true');
  // @pullboard-board-file journey: seed the board file the real CLI traces from
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Trace me', criterion: 'The file is committed.' });
  store.closeBoard(board);
  return { box, id };
}

test('clause 1: every pullboard run appends one trace line with who, where, what, outcome and refusal [C7]', () => {
  const { box, id } = scratch();
  const before = existsCount(box.repo);
  assert.equal(box.run(box.web, 'show', String(id), '--json').code, 0);
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  const refused = box.run(box.web, 'claim', '99999');
  assert.notEqual(refused.code, 0);
  const lines = traceLines(box.repo).slice(before);
  const mine = lines.filter(line => ['show', 'claim'].includes(line.command));
  assert.equal(mine.length, 3, JSON.stringify(lines));
  const [show, claim, refusal] = mine;
  for (const line of mine) {
    assert.match(line.at, /^\d{4}-\d\d-\d\dT/u);
    assert.equal(line.worktree, box.web);
    assert.equal(typeof line.branch, 'string');
    assert.equal(typeof line.ms, 'number');
    assert.ok('agent' in line && 'model' in line && 'session' in line);
  }
  assert.equal(show.item, id);
  assert.equal(show.exit, 0);
  assert.equal(show.refusal, null);
  assert.deepEqual(show.args, [String(id), '--json']);
  assert.equal(claim.command, 'claim');
  assert.equal(claim.exit, 0);
  assert.equal(refusal.item, 99999);
  assert.notEqual(refusal.exit, 0);
  assert.equal(typeof refusal.refusal.code, 'string');
  assert.ok(refusal.refusal.message.length > 0);
  assert.deepEqual(redactArgs(['--api-key=abc', '--password', 'x', '--note', 'ok']), ['--api-key=[redacted]', '--password', '[redacted]', '--note', 'ok']);
});

/** How many trace lines the repo already holds. */
function existsCount(repo) {
  try { return traceLines(repo).length; } catch { return 0; }
}

test('clause 1: the item id is traced whether it is a positional or the value of --verify, never a --wait number [C7]', () => {
  assert.equal(itemOf(['show', '3214']), 3214);
  assert.equal(itemOf(['next', '--verify', '3214']), 3214);
  assert.equal(itemOf(['next', '--verify=#3214']), 3214);
  assert.equal(itemOf(['next', '--wait', '30']), null);
  assert.equal(itemOf(['inbox']), null);
});

test('clause 2: an unwritable trace folder keeps the command exit code and the append costs under 5 ms [C7]', () => {
  const { box, id } = scratch();
  // A plain file where the trace folder belongs makes every append fail, as an unwritable folder does.
  const trace = join(box.repo, '.git', 'pullboard', 'trace');
  rmSync(trace, { recursive: true, force: true });
  writeFileSync(trace, 'not a folder');
  assert.equal(box.run(box.web, 'show', String(id)).code, 0, 'a read keeps its own exit code');
  assert.notEqual(box.run(box.web, 'claim', '99999').code, 0, 'a refusal keeps its own exit code');
  assert.equal(appendTrace({ argv: ['show', '1'], cwd: box.web, startedAt: Date.now(), status: 0 }), null, 'a failed append is swallowed');
  // Measure the append itself, not the command: the best of several runs on a writable folder.
  rmSync(trace, { force: true });
  const costs = [];
  for (let i = 0; i < 20; i += 1) {
    const start = process.hrtime.bigint();
    appendTrace({ argv: ['show', '1'], cwd: box.web, startedAt: Date.now(), status: 0 });
    costs.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  costs.sort((a, b) => a - b);
  assert.ok(costs[Math.floor(costs.length / 2)] < 5, `median append ${costs[10]} ms`);
});
