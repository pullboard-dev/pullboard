/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/state/src/io/machine.js */
/** A declined Rigor draft stays declined and a bar-correction reopen is no failure [D1,H16] (GitHub #26). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { loadDoctrine } from '../../../doctrine/index.js';
import { loadConfig } from '../../../config/index.js';
import { planAutomaticRigorApply } from '../../index.js';
import { prepareRowDecisions } from '../../../spec/index.js';
import { writeRowApply } from '../../../spec/index.js';
import { openKitBoard } from '../../../board/tests/fixtures/board.js';
import { rigorFixtureBoard } from '../../../gate/tests/fixtures/testkit.js';

const fixture = () => rigorFixtureBoard(store, openKitBoard);

test('rigor.auto.declined-never-redrafted: a declined key is never drafted again under a new id, even for a new item [D1,H16]', () => {
  const box = fixture();
  try {
    for (const title of ['First', 'Second', 'Third']) box.reject(box.submit(title));
    const [draft] = store.rowDrafts(box.board);
    const ref = `doctrine:${draft.id}`;
    const config = loadConfig(box.root);
    writeRowApply(box.root, planAutomaticRigorApply(box.root, config, store.rowDrafts(box.board)));
    store.recordRowDecisions(box.board, { agentId: store.PERSON, channel: 'terminal', decisions: prepareRowDecisions(box.root, config,
      { ids: [ref], decision: 'decline', reason: 'not the right remedy', on: box.board.clock.now().toISOString() }, { loadDoctrine }) });
    const before = store.rowDrafts(box.board).length;
    for (const title of ['Fourth', 'Fifth']) box.reject(box.submit(title));
    assert.equal(store.rowDrafts(box.board).length, before, 'the declined key files no new draft under a new id');
  } finally { box.close(); }
});

test('rigor.auto.bar-correction-not-refusal: a coordinator bar-correction reopen is not counted as a refusal:REOPENED failure [D1,H16]', () => {
  const box = fixture();
  try {
    for (const title of ['First', 'Second', 'Third']) {
      const id = box.submit(title);
      store.reopen(box.board, id, { agentId: 'coordinator', note: 'correct the frozen criterion, not the work' });
    }
    assert.equal(store.rowDrafts(box.board).length, 0, 'bar corrections never reach the repeat threshold');
    assert.equal(store.allShouts(box.board).filter(shout => shout.shout_from === 'rigor').length, 0);
  } finally { box.close(); }
});
