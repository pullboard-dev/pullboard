/** next reads only unfinished and in-flight items, never the board's landed and withdrawn history [C7, #10795]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../index.js';
import { listItems } from '../../../index.js';
import { nextFor } from '../../../index.js';
import { reviewOffer } from '../../../index.js';
import { register } from '../../../index.js';
import { saveAgentAbilities } from '../../../src/io/needs.js';
import { claim } from '../../../index.js';
import { largestDisjointWave } from '../../../../items/index.js';
import { submitFixture } from '../../fixtures/submit.js';
import { FIXTURE_MODEL } from '../../fixtures/cell.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { recordSubmitHandoff } from '../../../../jobs/index.js';
import { setAfterGate } from '../../../src/io/board/item/after-gate.js';
import { fixture as dispatchFixture } from '../../fixtures/dispatch.js';
import { getItem } from '../../../index.js';

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

/** A board mixing landed, withdrawn, claimed, lapsed, verified-unmerged and open items, each naming one file. */
function mixedBoard(t) {
  const board = fixtureBoard(t);
  const make = (title, file, lane = 'web', after = []) => addItem(board, { by: 'coordinator', lane, title, after, brief: `Files:\n- ${file}` });
  /** Place a status directly, the way the stage tests do: the fixture records where items stand, not how they got there. */
  const set = (id, fields) => {
    board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
    try { board.db.prepare(`UPDATE item SET ${Object.keys(fields).map(key => `${key}=?`).join(', ')} WHERE item_id=?`).run(...Object.values(fields), id); }
    finally { board.db.exec('DELETE FROM temp.moving'); }
  };
  const ids = {
    landed: make('landed', 'src/a.js'),
    withdrawn: make('withdrawn', 'src/b.js'),
    claimed: make('claimed', 'src/c.js'),
    unmerged: make('verified unmerged', 'src/d.js'),
    lapsed: make('lapsed claim', 'src/e.js', 'api'),
    onClaimed: make('open on the claimed file', 'src/c.js'),
    onUnmerged: make('open on the unmerged file', 'src/d.js'),
    onLanded: make('open on the landed file', 'src/a.js'),
    onWithdrawn: make('open on the withdrawn file', 'src/b.js'),
  };
  ids.afterLanded = make('open after the landed item', 'src/h.js', 'web', [ids.landed]);
  ids.afterOpen = make('open after an open item', 'src/i.js', 'web', [ids.onClaimed]);
  const built = { item_built_by: 'web-1', item_commit: 'b'.repeat(40), item_frozen_digest: 'd'.repeat(64) };
  // The board's verified rule needs an ACCEPT on the frozen criterion by a verifier other than the builder, at the item's commit.
  for (const id of [ids.landed, ids.unmerged]) {
    board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
      VALUES (?, 'web-3', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, '2026-11-18T00:00:00Z')`).run(id, built.item_commit, built.item_frozen_digest, built.item_commit);
  }
  set(ids.landed, { ...built, item_status: 'verified', item_verified_by: 'web-3', item_merged_commit: 'a'.repeat(40) });
  set(ids.withdrawn, { item_status: 'withdrawn', item_withdrawn_reason: 'not needed' });
  set(ids.claimed, { item_status: 'claimed', item_owner: 'web-1', item_lease_until: FUTURE, item_frozen_digest: 'd'.repeat(64) });
  set(ids.unmerged, { ...built, item_status: 'verified', item_verified_by: 'web-3', item_merged_commit: null });
  set(ids.lapsed, { item_status: 'claimed', item_owner: 'api-1', item_lease_until: PAST, item_frozen_digest: 'd'.repeat(64) });
  return { board, ids };
}

/** Every item-list statement nextFor prepares, read from the connection itself. */
function listedStatements(board) {
  const prepare = board.db.prepare.bind(board.db), seen = [];
  board.db.prepare = sql => { if (sql.includes('AS imported_rehome')) seen.push(sql); return prepare(sql); };
  return seen;
}

/** Any write moves the board's data version, so no remembered list answers the next read. */
function forget(board) {
  board.db.prepare("INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES ('pg1-touch', ?)").run(String(Math.random()));
}

test('store.io-board-next.reads-only-unfinished-and-in-flight: clause 1: nextFor builds its candidate and in-flight lists from bounded reads and never lists every item of a board with landed and withdrawn items [C7, #10795]', t => {
  const { board, ids } = mixedBoard(t);
  forget(board);
  const seen = listedStatements(board);
  const picked = nextFor(board, { agentId: 'web-2', lane: 'web' });
  assert.equal(picked.item?.item_id, ids.onLanded, picked.reasons.join(' | '));
  assert.ok(seen.length > 0, 'nextFor read its lists through the item-list statement');
  for (const sql of seen) assert.match(sql, /AND (item_status NOT IN|\(item_status IN)/u, `every item list nextFor reads is bounded by status: ${sql}`);
  assert.ok(seen.some(sql => sql.includes("item_status IN ('claimed','submitted')")), 'the in-flight list is its own bounded read');
  const inFlight = listItems(board, { inFlight: true }).map(item => item.item_id);
  assert.deepEqual(inFlight, [ids.unmerged, ids.claimed], 'only claimed, submitted and unmerged verified items are in flight; a lapsed claim reads as open');
});

test('store.io-board-next.selection-matches-reading-every-item: clause 2: on a board mixing open, claimed, landed and withdrawn items, nextFor selects and explains exactly as it does from the all-items list [C7, #10795]', t => {
  const { board, ids } = mixedBoard(t);
  const pick = options => { forget(board); return nextFor(board, { agentId: 'web-2', lane: 'web', ...options }); };
  /** The same pick read from a remembered all-items list, the way every pick read before #10795. */
  const fromAll = options => { forget(board); listItems(board, { all: true }); return nextFor(board, { agentId: 'web-2', lane: 'web', ...options }); };
  const first = pick({});
  assert.equal(first.item?.item_id, ids.onLanded, 'a landed item never blocks an open one on its file');
  assert.ok(first.reasons.includes(`#${ids.onClaimed} waits for #${ids.claimed} (claimed) on src/c.js`), first.reasons.join(' | '));
  assert.ok(first.reasons.includes(`#${ids.onUnmerged} waits for #${ids.unmerged} (verified) on src/d.js`), first.reasons.join(' | '));
  const second = pick({ omitIds: [ids.onLanded] });
  assert.equal(second.item?.item_id, ids.onWithdrawn, 'a withdrawn item never blocks an open one on its file');
  const third = pick({ omitIds: [ids.onLanded, ids.onWithdrawn] });
  assert.equal(third.item?.item_id, ids.afterLanded, 'an item waiting only on a landed item is ready');
  const idle = pick({ omitIds: [ids.onLanded, ids.onWithdrawn, ids.afterLanded, ids.onClaimed, ids.onUnmerged] });
  assert.equal(idle.item, null, idle.reasons.join(' | '));
  assert.ok(idle.reasons.some(line => line.startsWith(`#${ids.afterOpen} waits on #${ids.onClaimed} (open`)), idle.reasons.join(' | '));
  for (const options of [{}, { omitIds: [ids.onLanded] }, { omitIds: [ids.onLanded, ids.onWithdrawn] }, { omitIds: [ids.onLanded, ids.onWithdrawn, ids.afterLanded] }, { lanes: ['web', 'api'] }, { observeIdle: true, idleBlockers: true, omitIds: [ids.onLanded, ids.onWithdrawn, ids.afterLanded, ids.onClaimed, ids.onUnmerged] }]) {
    assert.deepEqual(pick(options), fromAll(options), JSON.stringify(options));
  }
});

/**
 * A parent and two slice children, all built by core-1 and reviewable by core-2; the second slice is submitted only when `secondSubmitted`.
 * Slices carry their item-slice row and item_parent_id after submitting, the way the slice move records them.
 */
function sliceBoard(t, { secondSubmitted }) {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', family: 'human', parentDigest: 'a'.repeat(64), model: FIXTURE_MODEL });
  for (const seat of [1, 2]) register(board, { id: `core-${seat}`, lane: 'core', path: `/fixture/core-${seat}`, family: 'openai', parentDigest: String(seat).padStart(64, '0'), model: FIXTURE_MODEL });
  const make = title => addItem(board, { by: 'coordinator', lane: 'core', title, criterion: 'prove it' });
  const ids = { parent: make('parent whole'), first: make('first slice'), second: make('second slice') };
  const submitted = secondSubmitted ? [ids.parent, ids.first, ids.second] : [ids.parent, ids.first];
  for (const id of submitted) {
    claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  }
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try {
    for (const id of [ids.first, ids.second]) {
      board.db.prepare('UPDATE item SET item_parent_id=? WHERE item_id=?').run(ids.parent, id);
      board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`item-slice:${id}`, JSON.stringify({ parentId: ids.parent }));
    }
  } finally { board.db.exec('DELETE FROM temp.moving'); }
  return { board, ids, advance: ms => { now = new Date(now.getTime() + ms); } };
}

test('store.io-board-next.compose-landing-holds-parent: clause 1: with composeLanding true, verify never offers a submitted slice and offers its submitted parent only once every slice child is submitted [C7,#11320]', t => {
  const who = { agentId: 'core-2', lane: 'core', verify: true, composeLanding: true };
  const waiting = sliceBoard(t, { secondSubmitted: false });
  const held = nextFor(waiting.board, who);
  assert.equal(held.item, null, `the parent waits for its open slice and no slice is offered: ${held.reasons.join(' | ')}`);
  const done = sliceBoard(t, { secondSubmitted: true });
  assert.equal(nextFor(done.board, who).item?.item_id, done.ids.parent, 'the parent is offered once both slices are submitted');
  assert.equal(nextFor(done.board, { ...who, omitIds: [done.ids.parent] }).item, null, 'a submitted slice is never offered');
});

test('store.io-board-next.compose-landing-off-offers-slices: clause 2: with composeLanding false or unset, a submitted slice is offered for review exactly as before [C7,#11320]', t => {
  const { board, ids } = sliceBoard(t, { secondSubmitted: false });
  for (const options of [{}, { composeLanding: false }]) {
    const who = { agentId: 'core-2', lane: 'core', verify: true, ...options };
    const first = nextFor(board, who).item?.item_id;
    const second = nextFor(board, { ...who, omitIds: [first] }).item?.item_id;
    assert.deepEqual([first, second].sort(), [ids.parent, ids.first].sort(), `the submitted parent and the submitted slice are both offered: ${JSON.stringify(options)}`);
  }
});

test('store.io-board-next.compose-landing-review-offer: clause 3: reviewOffer given who.composeLanding true never returns a submitted slice, and returns it when the option is off [C7,#11320]', t => {
  const { board, ids, advance } = sliceBoard(t, { secondSubmitted: true });
  advance(3 * 60_000);
  const who = { agentId: 'core-2', lane: 'core', skipIds: [ids.parent] };
  assert.equal(reviewOffer(board, { ...who, composeLanding: true })?.item ?? null, null, 'no slice is offered when slices compose into their parent');
  assert.ok([ids.first, ids.second].includes(reviewOffer(board, who)?.item?.item_id), 'a waiting slice is offered when the option is off');
});

/** Two submitted items, the lower id built by seat `same` and the higher by seat `other`, for a reviewer seat `rev` under the prefer family policy. */
function submittedPair(t) {
  const board = fixtureBoard(t);
  const make = (title, file, builder) => {
    const id = addItem(board, { by: 'coordinator', lane: 'web', title, brief: `Files:\n- ${file}` });
    board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
    try { board.db.prepare('UPDATE item SET item_status=?, item_built_by=?, item_commit=?, item_frozen_digest=? WHERE item_id=?').run('submitted', builder, 'c'.repeat(40), 'd'.repeat(64), id); }
    finally { board.db.exec('DELETE FROM temp.moving'); }
    return id;
  };
  return { board, first: make('built by the reviewer family', 'src/p.js', 'same-1'), second: make('built by another family', 'src/q.js', 'other-1') };
}

const REVIEW = { agentId: 'rev-1', lane: 'web', verify: true, familyPolicy: 'prefer' };

/** Every family-table read the connection prepares, with the arguments each read ran with, so a test sees which seat ids were looked up. */
function familyReads(board) {
  const prepare = board.db.prepare.bind(board.db), args = [];
  board.db.prepare = sql => {
    const statement = prepare(sql);
    if (!/famil/iu.test(sql)) return statement;
    return new Proxy(statement, { get: (target, key) => typeof target[key] === 'function' && ['get', 'all', 'run'].includes(key) ? (...values) => { args.push(...values.flat()); return target[key](...values); } : target[key] });
  };
  return args;
}

test('store.next.derived-seat-family-used: clause 1: nextFor given a derivedSeatFamily answer uses it for the seat and builder families of its review family check, and no seatFamily or builderFamilyOf read runs for an id it names [C7,#11383]', t => {
  const { board, first, second } = submittedPair(t);
  // Below the critical-path engine the queue order ties for these two items, so the family preference alone orders the offer.
  board.executionEngineVersion = 100;
  const families = { 'rev-1': 'anthropic', 'same-1': 'anthropic', 'other-1': 'openai' };
  const before = nextFor(board, REVIEW);
  assert.equal(before.item?.item_id, first, 'with no family known for any seat the lower id is offered');
  const reads = familyReads(board);
  const asked = [];
  const offered = nextFor(board, { ...REVIEW, derivedSeatFamily: id => { asked.push(id); return families[id]; } });
  assert.equal(offered.item?.item_id, second, 'the answer alone makes the other family preferred, so the later item is offered');
  assert.ok(asked.includes('rev-1') && asked.includes('same-1') && asked.includes('other-1'), `the answer was asked for every seat: ${asked}`);
  const looked = reads.filter(value => Object.keys(families).includes(value));
  assert.deepEqual(looked, [], `no family read ran for an id the answer names: ${looked}`);
});

test('store.next.derived-seat-family-fallback: clause 2: without the answer, or for an id it does not name, nextFor computes the families as before and offers the same item [C7,#11383]', t => {
  const { board, first } = submittedPair(t);
  for (const options of [{}, { derivedSeatFamily: () => undefined }]) {
    const offered = nextFor(board, { ...REVIEW, ...options });
    assert.equal(offered.item?.item_id, first, offered.reasons.join(' | '));
  }
  const partial = nextFor(board, { ...REVIEW, derivedSeatFamily: id => (id === 'rev-1' ? 'openai' : undefined) });
  assert.equal(partial.item?.item_id, first, 'an id the answer does not name is computed from the board, as on main');
});

test('store.next.derived-seat-family-beside-gate: clause 3: nextFor reads derivedSeatFamily beside derivedGateAtHead from the same options, each answering its own check [C7,#11383]', t => {
  const { board, first } = submittedPair(t);
  const asked = [];
  const offered = nextFor(board, { ...REVIEW, derivedGateAtHead: () => undefined, derivedSeatFamily: id => { asked.push(id); return undefined; } });
  assert.equal(offered.item?.item_id, first, offered.reasons.join(' | '));
  assert.ok(asked.includes('rev-1'), 'the seat-family option was read with the gate option beside it');
});

/** Four ready items: A{x}, B{x,y}, C{y}, D{z}; the largest disjoint wave is A, C, D and B waits. */
function waveBoard(t) {
  const board = fixtureBoard(t);
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const make = (title, files) => addItem(board, { by: 'coordinator', lane: 'web', title, brief: `Files:\n${files.map(file => `- ${file}`).join('\n')}` });
  const ids = { a: make('A', ['src/x.js']), b: make('B', ['src/x.js', 'src/y.js']), c: make('C', ['src/y.js']), d: make('D', ['src/z.js']) };
  return { board, ids };
}

/** One more seat asks for work and claims what it is offered. */
function seatTakes(board, options) {
  const agentId = register(board, { lane: 'web', path: `/seat-${board.db.prepare('SELECT COUNT(*) AS n FROM agent').get().n}`, route: 'strong' });
  const picked = nextFor(board, { agentId, lane: 'web', ...options });
  if (picked.item) claim(board, picked.item.item_id, { agentId, lane: 'web', leaseMs: 3_600_000, freeze: item => ({ text: item.item_title, digest: `digest:${item.item_title}` }) });
  return picked;
}

const CONTENTION = { threshold: 1, rates: new Map() };

test('store.io-board-next.wave-hands-out-the-largest-disjoint-set: clause 1: with a contention option set, successive seats that claim what they are offered receive exactly the ids largestDisjointWave picks [C7, #1440]', t => {
  const { board, ids } = waveBoard(t);
  const wave = largestDisjointWave(listItems(board));
  assert.deepEqual(wave.toSorted((a, b) => a - b), [ids.a, ids.c, ids.d]);
  const offered = [];
  for (let seat = 0; seat < 3; seat++) offered.push(seatTakes(board, { contention: CONTENTION }).item?.item_id);
  assert.deepEqual(offered.toSorted((a, b) => a - b), wave.toSorted((a, b) => a - b));
});

test('store.io-board-next.wave-skip-names-the-shared-file: clause 2: a ready item outside the wave is skipped with a reason naming the file it shares with a wave item [C7, #1440]', t => {
  const { board, ids } = waveBoard(t);
  // Urgent work is looked at first, so the item outside the wave is reached before the seat's first offer.
  board.db.prepare("INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, 'on')").run(`item_urgent:${ids.b}`);
  const picked = nextFor(board, { agentId: register(board, { lane: 'web', path: '/seat-reason', route: 'strong' }), lane: 'web', contention: CONTENTION });
  assert.ok([ids.a, ids.c, ids.d].includes(picked.item?.item_id), picked.reasons.join(' | '));
  assert.ok(picked.reasons.some(line => line.startsWith(`#${ids.b} waits on src/x.js: `) && line.includes('wave')), picked.reasons.join(' | '));
});

test('store.io-board-next.wave-off-leaves-the-order: clause 3: with contention null the offer order is unchanged and the second ready item is offered whole [C7, #1440]', t => {
  const { board, ids } = waveBoard(t);
  const agentId = register(board, { lane: 'web', path: '/seat-off', route: 'strong' });
  assert.equal(nextFor(board, { agentId, lane: 'web', contention: null }).item?.item_id, ids.a);
  assert.equal(nextFor(board, { agentId, lane: 'web', omitIds: [ids.a] }).item?.item_id, ids.b);
});

/** Two open items on one lane: one needing a browser, one needing nothing; seats with and without the ability. */
function needsBoard(t) {
  const board = fixtureBoard(t);
  const make = (title, file) => addItem(board, { by: 'coordinator', lane: 'web', title, brief: `Files:\n- ${file}` });
  const ids = { plain: make('needs nothing', 'src/plain.js'), browser: make('needs a browser', 'src/browser.js') };
  board.db.prepare("INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)").run(`item_needs:${ids.browser}`, JSON.stringify(['browser']));
  const seat = (path, abilities) => { const agentId = register(board, { lane: 'web', path, route: 'strong' }); saveAgentAbilities(board, agentId, abilities); return agentId; };
  return { board, ids, seat };
}

test('store.io-board-next.needs-ability-skips: clause 1: nextFor never offers an open item whose needs the seat abilities lack, offers it to a seat that has them, and offers an item with no needs as before [U136, #1888]', t => {
  const { board, ids, seat } = needsBoard(t);
  const bare = seat('/seat-bare', []), able = seat('/seat-able', ['browser']);
  assert.equal(nextFor(board, { agentId: bare, lane: 'web', omitIds: [ids.plain] }).item, null, 'a seat without the browser ability is not offered the browser item');
  assert.equal(nextFor(board, { agentId: bare, lane: 'web' }).item?.item_id, ids.plain, 'an item with no needs is offered as today');
  assert.equal(nextFor(board, { agentId: able, lane: 'web', omitIds: [ids.plain] }).item?.item_id, ids.browser);
});

test('store.io-board-next.needs-ability-idle-skip: clause 2: with observeIdle the item skipped for a missing ability is listed with code NEEDS_ABILITY [U136, #1888]', t => {
  const { board, ids, seat } = needsBoard(t);
  const bare = seat('/seat-idle', []);
  const idle = nextFor(board, { agentId: bare, lane: 'web', omitIds: [ids.plain], observeIdle: true });
  assert.equal(idle.item, null);
  assert.deepEqual(idle.skips.filter(row => row.item === ids.browser), [{ item: ids.browser, code: 'NEEDS_ABILITY' }]);
});

/** A dispatch board whose builder seat submits parents; each parent records its gate in the given state at its own head or at `jobHead`. */
function gateBoard(t) {
  const box = dispatchFixture(t);
  let n = 0;
  const parentWith = (job, jobHead) => {
    const parent = box.add(`Parent ${n += 1}`);
    box.submit(parent);
    const head = getItem(box.board, parent).item_commit;
    recordSubmitHandoff(box.board.db, parent, { id: `fixture-${parent}`, commit: jobHead ?? head, agentId: box.seats.builder.id, ...job });
    return parent;
  };
  /** A dependent on its own file, waiting on `parent` through the after-gate list, or plain --after when `plain`. */
  const dependent = (parent, { plain = false } = {}) => {
    const child = box.add(`Dependent ${n += 1}`, { brief: `Files: web/dependent-${n}.js\nTest: next offers the dependent only behind a gate-green parent.`, ...(plain ? { after: [parent] } : {}) });
    if (!plain) setAfterGate(box.board, child, [parent]);
    return child;
  };
  /** What next offers this agent when every other dependent is omitted. */
  const offered = (child, all) => nextFor(box.board, { agentId: box.seats.actor.id, lane: 'web', omitIds: all.filter(id => id !== child) });
  return { box, parentWith, dependent, offered };
}

test('store.io-board-next.after-gate-green-parent-offered: clause 1: next offers an open dependent whose after-gate parent is submitted with a green gate at its head, and offers nothing while that gate is queued, running or red [C7,#11805]', t => {
  const { parentWith, dependent, offered } = gateBoard(t);
  const green = dependent(parentWith({ state: 'green' }));
  const queued = dependent(parentWith({ state: 'queued' }));
  const running = dependent(parentWith({ state: 'running' }));
  const red = dependent(parentWith({ state: 'red', error: { code: 'TEST_FAILURE' } }));
  const all = [green, queued, running, red];
  assert.equal(offered(green, all).item?.item_id, green, 'a green gate at the parent head releases the dependent');
  for (const child of [queued, running, red]) {
    const answer = offered(child, all);
    assert.equal(answer.item, null, `#${child} stays held: ${answer.reasons.join(' | ')}`);
    assert.ok(answer.reasons.some(line => line.startsWith(`#${child} waits on`)), answer.reasons.join(' | '));
  }
});

test('store.io-board-next.plain-after-submitted-parent-skipped: clause 2: a dependent behind a plain --after parent that is only submitted is still skipped DEPENDENCY, as is one behind a green gate recorded at another head [C7,#11805]', t => {
  const { parentWith, dependent, offered } = gateBoard(t);
  const plain = dependent(parentWith({ state: 'green' }), { plain: true });
  const stale = dependent(parentWith({ state: 'green' }, 'b'.repeat(40)));
  const all = [plain, stale];
  for (const child of all) {
    const answer = offered(child, all);
    assert.equal(answer.item, null, answer.reasons.join(' | '));
    assert.ok(answer.reasons.some(line => line.startsWith(`#${child} waits on`)), answer.reasons.join(' | '));
  }
});
