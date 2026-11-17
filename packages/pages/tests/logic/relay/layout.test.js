/** Current phone state and selected history use the same exact native snapshot [H15,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { generateBoardKey } from "../../../../kernel/index.js";
import {
  CURRENT_SNAPSHOT_BYTES,
  currentSnapshotPresentation,
  openPagedSnapshot,
} from "../../../index.js";
import { writePagedSnapshot } from "../../../index.js";
import {
  readSealedDescriptor,
  writeSealedDescriptor,
} from "../../../index.js";

/** The engine the synthetic snapshot claims; the opener only compares it with maxEngine, so no registry number is involved. */
const snapshotEngine = 56;

/** Keep synthetic cipher objects and prove every requested history path belongs to the selected root. */
async function fixture() {
  const objects = new Map(), fingerprints = new Map(), reads = [];
  let root;
  const context = {
    key: await generateBoardKey(), boardId: 'c'.repeat(32), sequence: 7,
    /** A private fixture store receives no plaintext metadata. */
    put(object) { objects.set(object.id, object); },
    /** Refuse a reader that bypasses its root's opaque reachability graph. */
    get(id, parents = []) {
      assert.equal(parents[0] ?? id, root.id);
      for (const [index, parent] of parents.entries()) assert.ok(objects.get(parent).children.includes(parents[index + 1] ?? id));
      reads.push(id);
      assert.ok(objects.has(id));
      return objects.get(id).bytes;
    },
    /** Reuse only device-private fingerprints. */
    lookup(fingerprint) { return fingerprints.get(fingerprint); },
    /** Persist the private synthetic fingerprint separately from every upload object. */
    remember(fingerprint, reference) { fingerprints.set(fingerprint, reference); },
  };
  const items = [90, 2, 61].map(id => ({ id, title: 'Current work ' + id, lane: 'core', specs: ['H17'], status: 'open',
    criterion: id === 2 ? 'needle-criteria-only' : 'other requirement', brief: 'detail only', verdicts: [], history: [{ kind: 'add' }], thread: [] }));
  const shouts = Array.from({ length: 4200 }, (_, index) => ({ shout_id: index + 1, shout_text: 'Historical work ' + index,
    shout_decision: index === 0 ? 1 : 0, shout_answers: index === 4100 || index === 4101 ? 1 : null }));
  const document = { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: context.boardId }, { meta_key: 'relay_applied_sequence', meta_value: '7' }, { meta_key: 'relay_engine_version', meta_value: String(snapshotEngine) }],
    shout: shouts, event: [{ event_id: 81, event_detail: 'a historical event' }],
    item: [{ item_id: 90 }, { item_id: 2 }, { item_id: 61 }], agent: [], verdict: [], sqlite_sequence: [{ name: 'event', seq: 12345 }],
  }, presentation: { version: 1, config: { name: 'Synthetic board' }, state: {
    items, agents: [], shouts: shouts.slice(-40).reverse(), decisions: [shouts[0]], asked: [], events: [], holds: [], spec: [], practice: [], lanes: ['core'], owning: ['core'],
  }, shouts } };
  /** Seal the next snapshot before changing the private store's authorized root. */
  async function publish(value = document, nextContext = context) { root = await writePagedSnapshot(value, nextContext); return root; }
  return { objects, reads, context, document, publish, root: () => root };
}

test('pages.layout.current-summaries-read-before-history-and: current summaries read before history and a selected old shout follows only its sealed ranges [H15,H17]', async () => {
  const box = await fixture();
  const root = await box.publish();
  const total = box.objects.size;
  const page = await openPagedSnapshot(root, box.context, { maxEngine: snapshotEngine });
  assert.deepEqual(box.reads, [root.id], 'opening the root does not fetch history');
  const boot = await page.presentation();
  assert.deepEqual(boot.state.items.map(item => item.id), [90, 2, 61]);
  for (const item of boot.state.items) for (const field of ['criterion', 'brief', 'history', 'thread', 'verdicts']) assert.ok(!Object.hasOwn(item, field));
  for (const item of boot.state.items) {
    assert.equal(item.stage, 'open', 'summary rows carry the canonical lifecycle stage before their history arrives');
    assert.deepEqual(item.counts, { verdicts: 0, facts: 0 });
    assert.equal(item.claim, null);
  }
  assert.ok(!Object.hasOwn(boot, 'shouts'), 'the complete shout history is not duplicated in phone boot');
  assert.ok(box.reads.length < 5 && total > 70, 'current state reads without downloading the historical page graph');
  box.reads.length = 0;
  const old = await page.shout(1);
  assert.equal(old.shout_text, 'Historical work 0');
  assert.equal(old.decision_state, 'answered');
  assert.equal(old.decision_answer.shout_id, 4101, 'first answer wins, even across history pages');
  assert.ok(new Set(box.reads).size < 12, 'two distant shout lookups do not traverse the full history');
  const found = await page.item(2);
  assert.equal(found.criterion, 'needle-criteria-only');
  assert.deepEqual(found.history, [{ kind: 'add' }]);
  assert.deepEqual(await page.searchItems('NEEDLE-CRITERIA-ONLY'), [2]);
  await assert.rejects(page.item(99), { code: 'NO_ITEM' });
  await assert.rejects(page.shout(99999), { code: 'NO_SHOUT' });
});

test('pages.layout.a-paged-native-restore-preserves-every: a paged native restore preserves every row, counter and full presentation in its original order [H15,H17]', async () => {
  const box = await fixture();
  const root = await box.publish();
  const page = await openPagedSnapshot(root, box.context, { maxEngine: snapshotEngine });
  assert.deepEqual(await page.native(), box.document);
});

test('pages.layout.newer-engines-wrong-board-and-wrong: newer engines, wrong board and wrong checkpoint coverage refuse before historical reads [H15,H17]', async () => {
  const box = await fixture();
  const root = await box.publish();
  await assert.rejects(openPagedSnapshot(root, box.context, { maxEngine: snapshotEngine - 1 }), { code: 'ENGINE_VERSION' });
  assert.deepEqual(box.reads, [root.id]);
  await assert.rejects(openPagedSnapshot(root, { ...box.context, sequence: 8 }, { maxEngine: snapshotEngine }), { code: 'RELAY_SNAPSHOT' });
  await assert.rejects(openPagedSnapshot(root, { ...box.context, boardId: 'd'.repeat(32) }, { maxEngine: snapshotEngine }), { code: 'SEAL_AUTH_FAILED' });
  assert.ok(box.reads.every(id => id === root.id));
});

test('pages.layout.a-huge-historical-row-stays-out: a huge historical row stays out of current state and survives a bounded-object addressed read [H15,H17]', async () => {
  const box = await fixture();
  const text = randomBytes(800_000).toString('base64');
  box.document.tables.shout[0].shout_text = text;
  box.document.presentation.state.decisions = [];
  const root = await box.publish();
  const page = await openPagedSnapshot(root, box.context, { maxEngine: snapshotEngine });
  await page.presentation();
  const current = new Set(box.reads);
  assert.ok(current.size < 5);
  assert.equal((await page.shout(1)).shout_text, text);
  assert.ok([...box.objects.values()].every(object => object.bytes.byteLength <= 400_000));
  assert.ok(box.reads.some(id => !current.has(id)));
});

test('pages.layout.unchanged-history-reuses-immutable-cipher-objects: unchanged history reuses immutable cipher objects across newer checkpoint positions [H15,H17]', async () => {
  const box = await fixture();
  await box.publish();
  const before = new Set(box.objects.keys());
  box.document.tables.board_meta[1].meta_value = '8';
  const next = { ...box.context, sequence: 8 };
  const root = await box.publish(box.document, next);
  const page = await openPagedSnapshot(root, next, { maxEngine: snapshotEngine });
  assert.deepEqual(await page.native(), box.document);
  assert.ok([...box.objects.keys()].filter(id => !before.has(id)).length < 5, 'only changed metadata, its index and the checkpoint root are new');
});

test('pages.layout.invalid-history-ranges-and-duplicate-root: invalid history ranges and duplicate root tables cannot become a partial board [H15,H17]', async () => {
  const box = await fixture();
  const root = await box.publish();
  const directory = await readSealedDescriptor(root, box.context);
  const unsafe = { ...directory.value, tables: [...directory.value.tables] };
  unsafe.tables[1] = unsafe.tables[0];
  const bad = await writeSealedDescriptor(unsafe, directory.links, box.context);
  const arbitrary = { ...box.context, get: id => box.objects.get(id).bytes };
  await assert.rejects(openPagedSnapshot(bad, arbitrary, { maxEngine: snapshotEngine }), { code: 'RELAY_SNAPSHOT' });
  box.document.tables.shout[1].shout_id = 1;
  await assert.rejects(writePagedSnapshot(box.document, box.context), { code: 'RELAY_SNAPSHOT' });
});

test('pages.layout.bounded-current-state-precedes-thirty-thousand: bounded current state precedes thirty thousand events and complete background history arrives newest first [H15,H17]', async () => {
  const box = await fixture();
  box.document.tables.event = Array.from({ length: 30_000 }, (_, index) => ({ event_id: index + 1, event_detail: 'Preserved historical event ' + index }));
  box.document.presentation.state.items = Array.from({ length: 2000 }, (_, index) => ({ id: index + 1, title: 'A long item title '.repeat(250),
    lane: 'core', specs: ['H17'], criterion: 'A full governing requirement '.repeat(100), brief: 'Retained detail', verdicts: [], history: [], thread: [] }));
  const original = JSON.stringify(box.document.presentation);
  const root = await box.publish();
  const page = await openPagedSnapshot(root, box.context, { maxEngine: snapshotEngine });
  const boot = await page.presentation();
  assert.ok(Buffer.byteLength(JSON.stringify(boot)) < CURRENT_SNAPSHOT_BYTES && CURRENT_SNAPSHOT_BYTES < 1_000_000);
  assert.ok(boot.state.items.length < 2000);
  assert.ok(box.reads.length < 8, 'the thirty-thousand-event history is not part of startup');
  let events = 0, lastEvent = Infinity, shouts = 0, lastShout = Infinity, items = 0, full = null, complete = false;
  for await (const chunk of page.history()) {
    if (chunk.kind === 'presentation') full = chunk.value;
    if (chunk.kind === 'table' && chunk.name === 'event') for (const row of chunk.rows) {
      assert.ok(row.event_id < lastEvent); lastEvent = row.event_id; events++;
    }
    if (chunk.kind === 'table' && chunk.name === 'shout') for (const row of chunk.rows) {
      assert.ok(row.shout_id < lastShout); lastShout = row.shout_id; shouts++;
    }
    if (chunk.kind === 'items') items += chunk.rows.length;
    if (chunk.kind === 'complete') complete = true;
  }
  assert.equal(events, 30_000); assert.equal(lastEvent, 1);
  assert.equal(shouts, 4200); assert.equal(lastShout, 1);
  assert.equal(items, 2000); assert.equal(full.state.items.length, 2000); assert.equal(complete, true);
  assert.equal(page.historyTotal, Object.values(box.document.tables).reduce((sum, rows) => sum + rows.length, 0) + 2000);
  assert.equal(JSON.stringify(box.document.presentation), original, 'initial-screen bounds never truncate retained source data');
  assert.equal((await page.shout(1)).shout_text, 'Historical work 0');
});

test('pages.layout.a-huge-current-field-is-bounded: a huge current field is bounded only on first paint and remains complete in detail [H15,H17]', async () => {
  const box = await fixture();
  const text = 'Large current title '.repeat(100_000);
  box.document.presentation.state.items[0].title = text;
  const direct = currentSnapshotPresentation(box.document.presentation);
  assert.ok(Buffer.byteLength(JSON.stringify(direct)) < 1_000_000);
  const root = await box.publish();
  const page = await openPagedSnapshot(root, box.context, { maxEngine: snapshotEngine });
  assert.ok((await page.presentation()).state.items[0].title.length < text.length);
  assert.equal((await page.item(90)).title, text);
});
