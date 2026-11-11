/** Any pullboard command takes --why and the trace line keeps the stated intent [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { extractWhy } from '../../src/logic/why.js';
import { HELP } from '../../src/io/help.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The parsed trace lines of a repo, oldest first. */
function traceLines(repo) {
  const dir = join(repo, '.git', 'pullboard', 'trace');
  return readdirSync(dir).sort().flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

test('clause 1: --why and PULLBOARD_WHY are ignored for behaviour and stored in the call trace line [C7]', () => {
  const box = e2e.project('true');
  // @pullboard-board-file journey: seed the board file the real CLI traces from
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Why me', criterion: 'The file is committed.' });
  store.closeBoard(board);
  assert.equal(box.run(box.web, 'show', String(id), '--why', 'checking the bar', '--json').code, 0);
  assert.equal(box.run(box.web, 'show', String(id), '--why=inline intent', '--json').code, 0);
  const lines = traceLines(box.repo).filter(line => line.command === 'show');
  assert.deepEqual(lines.map(line => line.why), ['checking the bar', 'inline intent']);
  assert.ok(lines.every(line => !line.args.includes('--why') && !line.args.includes('checking the bar')), JSON.stringify(lines));
  assert.deepEqual(extractWhy(['show', '3'], { PULLBOARD_WHY: 'from env' }), { argv: ['show', '3'], why: 'from env' });
  assert.deepEqual(extractWhy(['land', '--why', '--json'], {}), { argv: ['land', '--why', '--json'], why: null });
});

test('clause 2: help lists --why once for every command from one shared flag definition [C7]', () => {
  const names = Object.keys(HELP.commands);
  assert.ok(names.length > 10);
  for (const name of names) {
    const hits = HELP.commands[name].flags.filter(flag => flag.startsWith('--why'));
    assert.equal(hits.length, 1, `${name}: ${JSON.stringify(hits)}`);
    assert.equal(hits[0], HELP.commands.show.flags.find(flag => flag.startsWith('--why')), name);
  }
});
