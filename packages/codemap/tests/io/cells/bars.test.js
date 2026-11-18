/** @pullboard-test-input packages/codemap/index.js packages/codemap/src/io/cells/move/bars.js packages/kernel/index.js */
/** A restructure move rewrites the criterion and check of every open item naming a moved path, recording an edit with the reason [B4,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteMovedBars } from '../../../index.js';

const MOVE = { from: 'packages/gate/src/io/old.js', to: 'packages/gate/src/io/cell/old.js' };
const REASON = 'cells move: packages/gate/src/io/old.js is now packages/gate/src/io/cell/old.js';

const open = (id, fields) => ({ item_id: id, item_status: 'open', item_criterion: 'No path here [test].', item_check: null, ...fields });

/** A stand-in for the pullboard CLI that answers list and records each edit, as the board's edit event does with its reason. */
function board(items) {
  const edits = [];
  const run = args => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify({ version: 1, items }), stderr: '' };
    const flag = name => args[args.indexOf(name) + 1];
    edits.push({ id: Number(args[1]), criterion: args.includes('--criterion') ? flag('--criterion') : undefined, check: args.includes('--check') ? flag('--check') : undefined, reason: flag('--reason') });
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, edits };
}

test('codemap.bars.every-open-item-naming-a: clause 1: every open item naming a moved path has its criterion and check rewritten, each edit recorded with the reason [B4,R2]', () => {
  const { run, edits } = board([
    open(1, { item_criterion: `1. ${MOVE.from} still exports run [test].`, item_check: `node --test ${MOVE.from}` }),
    open(2, { item_criterion: `1. Only the criterion names ${MOVE.from}.` }),
    open(3, { item_check: `node ${MOVE.from} && echo ok` }),
    open(4, { item_criterion: 'Names an unrelated packages/gate/src/io/other.js [test].' }),
    { ...open(5, { item_criterion: `Landed work naming ${MOVE.from}.` }), item_status: 'withdrawn' },
  ]);
  const done = rewriteMovedBars({ moves: [MOVE], reason: REASON, run });
  assert.deepEqual(done.map(change => change.id), [1, 2, 3], 'items 4 and 5 name no moved path or are closed');
  assert.deepEqual(edits, [
    { id: 1, criterion: `1. ${MOVE.to} still exports run [test].`, check: `node --test ${MOVE.to}`, reason: REASON },
    { id: 2, criterion: `1. Only the criterion names ${MOVE.to}.`, check: undefined, reason: REASON },
    { id: 3, criterion: undefined, check: `node ${MOVE.to} && echo ok`, reason: REASON },
  ]);
});

test('codemap.bars.a-path-that-only-shares: clause 1: a path that only shares a prefix or suffix with the moved one is left alone [B4,R2]', () => {
  const { run, edits } = board([open(1, { item_criterion: `${MOVE.from}x and x${MOVE.from} and ${MOVE.from}/inner and ${MOVE.from}.map stay.`, item_check: `node --test ${MOVE.from}.` })]);
  const done = rewriteMovedBars({ moves: [MOVE], reason: REASON, run });
  assert.deepEqual(done.map(change => change.id), [1]);
  assert.equal(edits[0].criterion, undefined, 'no look-alike in the criterion is rewritten');
  assert.equal(edits[0].check, `node --test ${MOVE.to}.`, 'a sentence period after the path still matches');
});

test('codemap.bars.a-rewrite-with-no-reason: clause 1: a rewrite with no reason refuses before any edit [B4,R2]', () => {
  const { run, edits } = board([open(1, { item_criterion: MOVE.from })]);
  assert.throws(() => rewriteMovedBars({ moves: [MOVE], reason: ' ', run }), { code: 'BAR_REASON' });
  assert.equal(edits.length, 0);
});
