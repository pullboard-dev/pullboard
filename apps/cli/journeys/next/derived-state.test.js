/** pullboard next reads gate-at-head from the derived-state table when it is current for main [C7,#8945]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { sweepDerivedState } from '../../../../packages/health/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** A gate reason no real gate at head gives this fixture item: it can only reach next's answer by being read from the table. */
const SENTINEL = 'gate green at swept0000000';

/** An open item, and the helpers a case needs around it: the setting, a sweep at main's current commit, and a move of main. */
async function openItem(t) {
  const box = await fixture(t);
  const id = box.add('Item whose gate the table may name');
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
  return { id, setting, sweep, moveMain, handed };
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
