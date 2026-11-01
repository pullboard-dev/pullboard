/** A real fast static-stage refusal through submit never enters the runner failure counter [B4,B5]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { json } from './land-board-fixture.js';
import { onBoard } from './land-board-fixture.js';
import * as store from '../packages/store/index.js';
import { claimProgress } from '../packages/items/index.js';

test('an actual submit static refusal never counts toward the three runner failures [B4,B5]', { timeout: 300_000 }, t => {
  // Budget: one private project, one submit and one static subprocess; the ceiling is for hangs, not a speed target.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, gate: 'true', staticChecks: 'node static.cjs' }));
  writeFileSync(join(box.repo, 'static.cjs'), "console.log('private static-stage failure'); process.exit(1);\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: configure private static guard');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = json(box, box.repo, 'add', 'web', 'Fix static', '--specs', 'G1', '--criterion', 'result exists', '--check', 'true').item.item_id;
  json(box, box.web, 'claim', String(id));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/result.txt'), 'private result\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-qm', 'feat(web): private result [G1]');
  const failed = box.run(box.web, 'submit', String(id));
  assert.notEqual(failed.code, 0);
  assert.match(failed.out + failed.err, /static checks are red/u, 'the real static stage refused it');
  const observed = onBoard(box, board => {
    const outcomes = store.events(board, { itemId: id }).map(event => JSON.parse(event.event_detail).submitOutcome).filter(Boolean);
    assert.equal(outcomes.at(-1)?.code, 'GATE_RED');
    assert.equal(outcomes.at(-1)?.stage, 'fast');
    return claimProgress(board, store.getItem(board, id), Date.now(), { runnerOnly: true });
  });
  assert.equal(observed.failures, 0);
});
