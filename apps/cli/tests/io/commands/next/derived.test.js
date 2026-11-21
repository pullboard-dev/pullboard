/** pullboard next reads gate-at-head and seat families from the derived-state table when it is current for main [C7,#8945,#11386]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import { derivedStatePath } from '../../../../../../packages/health/index.js';
import { sweepDerivedState } from '../../../../../../packages/health/index.js';
import * as store from '../../../../../../packages/store/index.js';
import { nextPorts } from '../../../../src/io/next.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** A gate reason no real gate at head gives this fixture item: it can only reach next's answer by being read from the table. */
const SENTINEL = 'gate green at swept0000000';

/** An open item, and the helpers a case needs around it: the setting, a sweep at main's current commit, and a move of main. */
async function openItem(t, { review = false } = {}) {
  const box = await fixture(t, review ? { family: 'require' } : {});
  const id = box.add('Item whose gate the table may name');
  if (review) box.submit(id);
  /** Turn health.derivedState on or off in the fixture's machine settings. */
  const setting = on => writeFileSync(machineSettingsFile(), JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, health: { derivedState: on } }));
  /** Sweep the table at the commit main is at now, every open item's gate-at-head answering `reason`. */
  const sweep = reason => sweepDerivedState(box.board, { mainCommit: box.git(box.root, 'rev-parse', 'main').trim(), enabled: true,
    listItems: board => board.db.prepare('SELECT * FROM item ORDER BY item_id').all(), verdictState: () => null, gateAtHead: () => reason });
  /** Move main one commit on with the same tree, so the table swept before it is no longer current. */
  const moveMain = () => {
    const tree = box.git(box.root, 'rev-parse', 'main^{tree}').trim();
    const next = box.git(box.root, 'commit-tree', tree, '-p', 'main', '-m', 'chore: main moves on').trim();
    box.git(box.root, 'update-ref', 'refs/heads/main', next);
  };
  /** The item id next hands the actor seat, or null with the reasons it gave. */
  const handed = async () => {
    const taken = await cli(box, box.seats.actor.path, ['next']);
    assert.equal(taken.code, 0, taken.out + taken.err);
    return { id: taken.document.item?.item_id ?? null, text: taken.out };
  };
  /** Rewrite the outside seat's family row in the swept table to the builder's, so only the table says the two seats share a family. */
  const tableSaysSameFamily = () => {
    const derived = new DatabaseSync(derivedStatePath(box.file));
    try {
      const builder = derived.prepare("SELECT value FROM derived_state WHERE kind = 'seat-family' AND key = ?").get(box.seats.builder.id);
      const changed = derived.prepare("UPDATE derived_state SET value = ? WHERE kind = 'seat-family' AND key = ?").run(builder.value, box.seats.outside.id);
      assert.equal(changed.changes, 1, 'the sweep holds a family row for the outside seat');
    } finally { derived.close(); }
  };
  /** What the default next loop answers the outside seat, which a require family rule lets review the builder's item only from another family and another parent session. */
  const reviewed = async () => {
    const taken = await cli(box, box.seats.outside.path, ['next']);
    return { code: taken.code, id: taken.document?.item?.item_id ?? null, text: taken.out + taken.err };
  };
  return { box, id, setting, sweep, moveMain, handed, tableSaysSameFamily, reviewed };
}

test('cli.journeys-next-derived-state.a-current-table-answers-the-gate: clause 1: with health.derivedState on and the table swept at the current main, next answers the same item as with it off, and an item the table names gate-at-head is not offered [C7,#8945]', async t => {
  const { id, setting, sweep, handed } = await openItem(t);
  setting(true);
  sweep(null);
  assert.equal((await handed()).id, id, 'a table naming no gate answers the item the computed gate answers');
  const named = await openItem(t);
  named.setting(true);
  named.sweep(SENTINEL);
  const answer = await named.handed();
  assert.equal(answer.id, null, 'an item the table names gate-at-head is not offered');
  assert.ok(answer.text.includes(SENTINEL), 'the reason comes from the table row, not from a computed gate');
});

test('cli.journeys-next-derived-state.an-older-table-or-the-setting-off-computes: clause 2: with the table swept at an older main, or with the setting off, next computes gate-at-head and answers the same item [C7,#8945]', async t => {
  const old = await openItem(t);
  old.setting(true);
  old.sweep(SENTINEL);
  old.moveMain();
  assert.equal((await old.handed()).id, old.id, 'a table swept at an older main is ignored and the gate is computed');
  const off = await openItem(t);
  off.setting(false);
  off.sweep(SENTINEL);
  assert.equal((await off.handed()).id, off.id, 'with the setting off the same table is never read');
});

test('cli.journeys-next-derived-state.a-current-table-answers-the-families: clause 1: with health.derivedState on and the table swept at the current main, next answers the same item as with it off, and the seat families come from the table [C7,#11386]', async t => {
  const plain = await openItem(t, { review: true });
  plain.setting(false);
  const off = await plain.reviewed();
  assert.equal(off.id, plain.id, `with the setting off the other-family seat is offered the review: ${off.text}`);
  const agreeing = await openItem(t, { review: true });
  agreeing.setting(true);
  agreeing.sweep(null);
  assert.equal((await agreeing.reviewed()).id, agreeing.id, 'a table that agrees with the board answers the item the computed families answer');
});

test('cli.journeys-next-derived-state.an-older-table-or-the-setting-off-computes-the-families: clause 2: with the table swept at an older main, or with the setting off, next computes the seat families and answers the same item [C7,#11386]', async t => {
  const old = await openItem(t, { review: true });
  old.setting(true);
  old.sweep(null);
  old.tableSaysSameFamily();
  old.moveMain();
  assert.equal((await old.reviewed()).id, old.id, 'a table swept at an older main is ignored and the families are computed');
  const off = await openItem(t, { review: true });
  off.setting(false);
  off.sweep(null);
  off.tableSaysSameFamily();
  assert.equal((await off.reviewed()).id, off.id, 'with the setting off the same table is never read');
});

test('cli.journeys-next-derived-state.next-ports-carry-the-seat-family-reader: clause 3: nextPorts carries derivedSeatFamily, which answers the table\'s seat families while it is current for main and null otherwise [C7,#11386]', async t => {
  const { box, setting, sweep, moveMain, reviewed, tableSaysSameFamily } = await openItem(t, { review: true });
  assert.equal(typeof nextPorts.derivedSeatFamily, 'function', 'the port exists beside derivedGateAtHead');
  setting(true);
  sweep(null);
  assert.equal((await reviewed()).code, 0, 'the real next command loads the derived-state readers');
  const families = nextPorts.derivedSeatFamily(box.root, box.board);
  assert.ok(families instanceof Map, 'a current table answers its seat-family map');
  assert.equal(families.get(box.seats.builder.id), store.seatFamily(box.board, box.seats.builder.id), 'the map holds the builder seat\'s family');
  tableSaysSameFamily();
  assert.equal(nextPorts.derivedSeatFamily(box.root, box.board).get(box.seats.outside.id), families.get(box.seats.builder.id), 'a family row rewritten in the table is the answer, so the families come from the table and not the board');
  moveMain();
  assert.equal(nextPorts.derivedSeatFamily(box.root, box.board), null, 'a table swept at an older main answers null');
  setting(false);
  assert.equal(nextPorts.derivedSeatFamily(box.root, box.board), null, 'with the setting off the answer is null');
});
