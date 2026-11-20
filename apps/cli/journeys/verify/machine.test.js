/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/store/src/io/board.js */
/**
 * The item lifecycle's declaration (M1, M2, M4): sound on its own terms, each property shown
 * failing on a broken copy, and in step with the refusals the board, CLI and spec parser raise today.
 */
import { moveOf } from '../../../../packages/gate/tests/fixtures/functions.js';
import { declaredBoardOrder } from '../../../../packages/gate/tests/fixtures/functions.js';
import * as fs from 'node:fs';
import * as machineRules from '../../../../packages/state/index.js';
import { policyRepository } from '../../tests/fixtures/board/submit.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { recordSubmitHandoff } from '../../../../packages/jobs/index.js';
import { openBoard } from '../../../lib/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { HELP } from '../../index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { assertRehomeTriggerDeclaration } from '../../tests/fixtures/machine/rehome.js';
import { assertConfiguredReviewLease } from '../../tests/fixtures/machine/reservation.js';
import { assertLifecycleReservation } from '../../tests/fixtures/machine/reservation.js';


/**
 * A deep copy of the declaration to break, so the real one stays whole.
 *
 * @returns {any}
 */
const copy = () => structuredClone(machineRules.MACHINE);


/**
 * Accept and reject hold a verifier to the same checks, in the same order, until the verdict's own
 * rules, so the bar does not depend on which way the verifier decides.
 *
 * @param {any} machine
 * @returns {string[]}
 */
function verdictsDiverge(machine) {
  const [accept, reject] = ['accept', 'reject'].map((verb) => moveOf(machine, verb).guards);
  const shared = Math.max(accept.indexOf('criterionUnchanged'), reject.indexOf('criterionUnchanged')) + 1;
  const same = shared > 0 && accept.slice(0, shared).join() === reject.slice(0, shared).join();
  return same ? [] : [`accept checks ${accept.slice(0, shared).join(', ')} before its verdict, but reject checks ${reject.slice(0, shared).join(', ')}`];
}

/** The exit guards each final state needs, and the rule each one stands for. */
const PINNED = {
  verified: { notBuilder: 'V1', criterionUnchanged: 'V3', proofNoted: 'V5', atSubmittedCommit: 'V7' },
  withdrawn: { coordinatorOnly: 'only the coordinator withdraws', noteGiven: 'the reason stays on the item' },
};

/**
 * Exit guards a final state has lost, each named with the rule it stands for.
 *
 * @param {any} machine
 * @returns {string[]}
 */
function unpinned(machine) {
  return Object.entries(PINNED).flatMap(([state, guards]) => Object.entries(guards)
    .filter(([id]) => !(machine.exitGuards[state] ?? []).includes(id))
    .map(([id, rule]) => `${state} no longer requires ${id} (${rule}) of every move into it`));
}

/** Each property, broken the way a real board could break, and what the check must then say. */
const BROKEN = [
  {
    property: 'every state, guard and role a move names is declared',
    breaks: (machine) => moveOf(machine, 'claim').from.push('limbo'),
    says: /claim: no state "limbo"/,
  },
  {
    property: 'every state is reachable from open',
    breaks: (machine) => {
      machine.states.push({ id: 'orphan', final: true, means: 'nothing leads here', requires: [] });
      machine.exitGuards.orphan = ['notBuilder'];
    },
    says: /state orphan cannot be reached from open/,
  },
  {
    property: 'every non-final state has a way out',
    breaks: (machine) => {
      machine.states.push({ id: 'parked', means: 'set aside', requires: [] });
      machine.moves.push({ verb: 'park', from: ['open'], to: 'parked', by: ['agent', 'coordinator'], refuse: 'CLOSED', guards: ['joined', 'itemExists', machineRules.IN_STATE] });
    },
    says: /state parked is a trap/,
  },
  {
    property: 'nothing leaves a final state',
    breaks: (machine) => machine.moves.push({ verb: 'restore', from: ['withdrawn'], to: 'open', by: ['agent', 'coordinator'], refuse: 'CLOSED', guards: ['joined', 'coordinatorOnly', 'itemExists', machineRules.IN_STATE] }),
    says: /final state withdrawn has a move out/,
  },
  {
    property: 'every final state has exit guards',
    breaks: (machine) => {
      machine.exitGuards.withdrawn = [];
    },
    says: /final state withdrawn has no exit guards/,
  },
  {
    property: 'accept names every exit guard of verified',
    breaks: (machine) => {
      const accept = moveOf(machine, 'accept');
      accept.guards = accept.guards.filter((id) => id !== 'notBuilder');
    },
    says: /accept reaches verified without naming its exit guard notBuilder: a second door/,
  },
  {
    property: 'no second door into verified',
    breaks: (machine) => machine.moves.push({ verb: 'land', from: ['submitted'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED', guards: ['joined', 'itemExists', machineRules.IN_STATE], sets: ['item_verified_by'] }),
    says: /land reaches verified without naming its exit guard atSubmittedCommit: a second door/,
  },
  {
    property: 'every guard names a refusal code',
    breaks: (machine) => {
      machine.guards.find((guard) => guard.id === 'laneOpen').refuse = '';
    },
    says: /guard laneOpen names no refusal code/,
  },
  {
    property: 'every guard says the next step',
    breaks: (machine) => {
      machine.guards.find((guard) => guard.id === 'laneOpen').next = ' ';
    },
    says: /guard laneOpen refuses without a next step/,
  },
  {
    property: 'every additional refusal says its next step',
    breaks: (machine) => {
      machine.guards.find((guard) => guard.id === 'rowsInForce').alsoRefuses[0].next = '';
    },
    says: /guard rowsInForce refusal A5_GRAMMAR_VERSION has no next step/,
  },
  {
    property: 'every guard is used by some move',
    breaks: (machine) => machine.guards.push({ id: 'unused', refuse: 'UNUSED', rule: 'nothing', next: 'nothing', source: 'board' }),
    says: /guard unused is declared but no move uses it/,
  },
  {
    property: "every caller's move checks the item's state once",
    breaks: (machine) => {
      const release = moveOf(machine, 'release');
      release.guards = release.guards.filter((id) => id !== machineRules.IN_STATE);
    },
    says: /release checks the item's state 0 times, not once/,
  },
  {
    property: "the coordinator's moves name coordinatorOnly",
    breaks: (machine) => {
      moveOf(machine, 'withdraw').by = ['agent', 'coordinator'];
    },
    says: /withdraw is for agent or coordinator, but its guards name coordinatorOnly/,
  },
  {
    property: "the clock's move is the clock's alone",
    breaks: (machine) => {
      moveOf(machine, 'lapse').by = ['clock', 'agent'];
    },
    says: /lapse mixes the clock with callers/,
  },
  {
    property: "every move sets its target state's fields",
    breaks: (machine) => {
      moveOf(machine, 'submit').sets = ['item_built_by'];
    },
    says: /submit from claimed can reach submitted without item_commit/,
  },
];

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * A freeze that digests the title, as the real one digests the criterion.
 *
 * @param {any} item
 * @returns {{ text: string, digest: string }}
 */
const freeze = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/**
 * A board file on disk with a coordinator and two web agents, opened the way the CLI opens it,
 * and a way to open the same file raw, as any agent with a shell could.
 *
 * @param {{ now: () => Date }} [clock] - The board's clock; the system's when left out.
 * @returns {{ file: string, board: any, raw: () => DatabaseSync, done: () => void }}
 */
function boardOnDisk(clock) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pullboard-machine-'));
  const file = join(dir, 'board.sqlite');
  const board = openBoard(file, clock, { gitRoot: policyRepository(dir) });
  store.register(board, { lane: 'coordinator', path: '/repo', family: 'human' });
  store.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
  store.register(board, { lane: 'web', path: '/repo-web-2', family: 'review-vendor' });
  const handles = [board.db];
  return {
    file,
    board,
    raw: () => {
      const db = new DatabaseSync(file);
      handles.push(db);
      return db;
    },
    done: () => {
      for (const db of handles) {
        try {
          db.close();
        } catch {
          // already closed by the test
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A logic-only board uses the shared memory contract; raw connections stay in boardOnDisk. */
function memoryBoardLab(t, clock, { reviewerFamily = 'review-vendor' } = {}) {
  const board = fixtureBoard(t, { clock });
  store.register(board, { lane: 'coordinator', path: '/repo', family: 'human' });
  store.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
  store.register(board, { lane: 'web', path: '/repo-web-2', family: reviewerFamily });
  return { board };
}

/**
 * An item web-1 claimed and submitted.
 *
 * @param {any} board
 * @param {{ reviewFamily?: string }} [options] optional real item metadata for guard witnesses
 * @returns {number}
 */
function submittedItem(board, options = {}) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page', ...options });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
  return id;
}

/**
 * A submitted item whose queued gate has no captured proof receipt, so a reviewer finds GATE_PENDING.
 *
 * @param {any} board
 * @returns {number}
 */
function gatePendingItem(board) {
  const id = submittedItem(board);
  const item = store.getItem(board, id);
  recordSubmitHandoff(board.db, id, { version: 1, id: `job-pending-${id}`, agentId: 'web-1', commit: item.item_commit,
    executionCommit: item.item_commit, executionTree: item.item_tree, digest: item.item_frozen_digest, state: 'running' });
  return id;
}

/**
 * A verdict with what a careful verifier passes.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} agentId
 * @param {'ACCEPT' | 'REJECT'} decision
 */
function verdictOn(board, id, agentId, decision) {
  const reason = decision === 'REJECT' ? { reason: 'TEST_FAILURE', clause: 'Page' } : {};
  store.verify(board, id, { agentId, decision, head: SHA_A, digest: 'digest:Page', policy: 'any', note: 'reverted the fix; its test went red; restored it', ...reason });
}

/**
 * Insert an ACCEPT by hand, as a forger would.
 *
 * @param {DatabaseSync} db
 * @param {number} id
 * @param {string} by
 * @param {string} commit
 * @param {string} [digest]
 */
function forgeAccept(db, id, by, commit, digest = 'digest:Page') {
  db.prepare(
    `INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
     VALUES (?, ?, 'ACCEPT', 'CRITERION_MET', 'forged', ?, ?, ?, '2026-10-06T00:00:00Z')`,
  ).run(id, by, commit, digest, commit);
}

/**
 * The names of a board file's triggers.
 *
 * @param {any} board
 * @returns {string[]}
 */
const triggerNames = (board) => board.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((row) => row.name);

/** Guards checked before the explicit transition: CLI facts and optional roadmap selection. */
const PRECHECKED = {
  claim: ['joined', 'checkProvesSomething'],
  submit: ['joined', 'checkProvesSomething', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'withinLane', 'trunkMergeClean', 'trunkInCandidate', 'infraExplained', 'doctrineHolds', 'clausesInspected', 'gateConfigured', 'queuedItemLease', 'gateGreen', 'proofRecorded', 'noUnverifiedStack'],
  reserve: ['coordinatorSaysAs', 'joined', 'roadmapReadable', 'companionWindow'],
  accept: ['coordinatorSaysAs', 'joined', 'companionWindow', 'atSubmittedCommit', 'reviewTreeCurrent', 'trunkMergeClean', 'queuedItemLease', 'itemCheckGreen', 'proofRecorded', 'noUnverifiedStack'],
  reject: ['coordinatorSaysAs', 'joined', 'companionWindow', 'atSubmittedCommit', 'reviewTreeCurrent'],
};


/**
 * The refusal code a call raises, or 'ok'.
 *
 * @param {() => unknown} run
 * @returns {string}
 */
function outcome(run) {
  try {
    run();
    return 'ok';
  } catch (error) {
    if (!error.code) throw error;
    return error.code;
  }
}

/** A freeze for an item whose cited row has been retired. */
const retiredFreeze = () => {
  throw new Refused('UNKNOWN_SPEC', 'G1 is retired; fix the spec, or the coordinator withdraws the item');
};

/**
 * Set an item claimed by hand, with every field a claim carries, the way a test sets up a holder
 * the board's own guards would not let it reach directly.
 *
 * @param {DatabaseSync} db
 * @param {number} id
 * @param {string} owner
 */
function holdByHand(db, id, owner) {
  db.prepare("UPDATE item SET item_status = 'claimed', item_owner = ?, item_lease_until = ?, item_frozen_digest = 'digest:Page' WHERE item_id = ?")
    .run(owner, new Date(Date.now() + 3_600_000).toISOString(), id);
}

test('cli.journeys-verify-machine.the-declared-lifecycle-is-sound-reachable: the declared lifecycle is sound: reachable, no traps, no second door, every refusal with a next step [M1, M2, M4]', () => {
  assert.deepEqual(machineRules.machineProblems(), []);
  assert.deepEqual(machineRules.MACHINE.states.map((state) => state.id), ['open', 'claimed', 'submitted', 'verified', 'withdrawn']);
  assert.deepEqual(machineRules.MACHINE.states.filter((state) => state.final).map((state) => state.id), ['withdrawn']);
  assert.deepEqual(machineRules.MACHINE.moves.map((move) => move.verb), ['patch-objected', 'patch-claimed', 'patch', 'rehomeImport', 'intake', 'claim', 'release', 'lapse', 'submit', 'submit-merge', 'reserve', 'accept', 'reject', 'reopen', 'reland', 'escalate', 'refreeze', 'refreeze', 'withdraw']);
  assert.deepEqual(machineRules.MACHINE.moves.find((move) => move.verb === 'rehomeImport').sets, ['item_verified_by', 'item_commit']);
});

test('cli.journeys-verify-machine.a-door-declared-without-its-exit: a door declared without its exit guards still passes them [M2]', () => {
  const machine = copy();
  const land = { verb: 'land', from: ['submitted'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED', guards: ['joined', 'itemExists', machineRules.IN_STATE] };
  machine.moves.push(land);
  const passes = machineRules.effectiveGuards(land, machine);
  for (const id of machine.exitGuards.verified) assert.ok(passes.includes(id), `land passes ${id}`);
  assert.deepEqual(passes.slice(0, land.guards.length), land.guards, 'its own guards come first, in order');
  assert.deepEqual(machineRules.effectiveGuards(moveOf(machineRules.MACHINE, 'accept')), moveOf(machineRules.MACHINE, 'accept').guards, 'accept names them all already, so nothing is added');
});

test('cli.journeys-verify-machine.verified-and-withdrawn-keep-the-exit: verified and withdrawn keep the exit guards their rules need, and a copy that drops one fails [V1, V3, V5, V7, M2, M4]', () => {
  assert.deepEqual(unpinned(machineRules.MACHINE), []);
  const broken = copy();
  broken.exitGuards.verified = broken.exitGuards.verified.filter((id) => id !== 'notBuilder');
  assert.deepEqual(unpinned(broken), ['verified no longer requires notBuilder (V1) of every move into it']);
});

test('cli.journeys-verify-machine.accept-and-reject-hold-a-verifier: accept and reject hold a verifier to the same checks until the verdict, and a copy that splits them fails [M1, M4]', () => {
  assert.deepEqual(verdictsDiverge(machineRules.MACHINE), []);
  const broken = copy();
  const accept = moveOf(broken, 'accept');
  accept.guards = accept.guards.filter((id) => id !== 'routeAllows');
  assert.equal(verdictsDiverge(broken).length, 1);
});

test('cli.journeys-verify-machine.the-board-file-refuses-written-by: the board file refuses, written by hand: an unknown state, an undeclared move, an unproven verified, a reasonless withdrawal, an edited record [M3]', () => {
  const lab = boardOnDisk();
  try {
    const open = store.addItem(lab.board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const built = submittedItem(lab.board);
    const raw = lab.raw();
    const refused = (sql, args, code) => assert.throws(() => raw.prepare(sql).run(...args), new RegExp(code), sql);
    refused('UPDATE item SET item_status = ? WHERE item_id = ?', ['shipped', open], 'UNDECLARED_STATE');
    refused('UPDATE item SET item_status = ? WHERE item_id = ?', ['verified', open], 'MISSING_FIELD');
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-2', item_commit = ?, item_frozen_digest = 'digest:Forged', item_built_by = 'web-1' WHERE item_id = ?",
      [SHA_A, open], 'NOT_PROVEN');
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-2' WHERE item_id = ?", [built], 'NOT_PROVEN');
    forgeAccept(raw, built, 'web-1', SHA_A);
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-1' WHERE item_id = ?", [built], 'NOT_PROVEN');
    forgeAccept(raw, built, 'web-2', SHA_B);
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-2' WHERE item_id = ?", [built], 'NOT_PROVEN');
    forgeAccept(raw, built, 'web-2', SHA_A, 'digest:Another criterion');
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-2' WHERE item_id = ?", [built], 'NOT_PROVEN');
    refused("UPDATE item SET item_status = 'withdrawn' WHERE item_id = ?", [open], 'MISSING_FIELD');
    refused("UPDATE event SET event_kind = 'nothing' WHERE event_id = 1", [], 'APPEND_ONLY');
    refused('DELETE FROM event', [], 'APPEND_ONLY');
    refused("UPDATE verdict SET verdict_by = 'web-2'", [], 'APPEND_ONLY');
    refused('DELETE FROM verdict', [], 'APPEND_ONLY');
    refused('DELETE FROM item WHERE item_id = ?', [open], 'KEPT');
    refused(
      "INSERT INTO item (item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at) VALUES ('web', 'Forged', 'verified', 'web-1', 'now', 'now')",
      [],
      'UNDECLARED_MOVE',
    );
    assert.equal(store.getItem(lab.board, open).item_status, 'open');
    assert.equal(store.getItem(lab.board, built).item_status, 'submitted');
  } finally {
    lab.done();
  }
});

test('cli.journeys-verify-machine.every-move-the-board-makes-passes: every move the board makes passes the triggers: claim, submit, accept, reject, rework, release, escalate, refreeze, withdraw [M3]', t => {
  const lab = memoryBoardLab(t);
  const { board } = lab;
  const accepted = submittedItem(board);
  verdictOn(board, accepted, 'web-2', 'ACCEPT');
  store.merged(board, accepted, { agentId: 'coordinator', commit: SHA_A });
  const rejected = submittedItem(board);
  verdictOn(board, rejected, 'web-2', 'REJECT');
  store.claim(board, rejected, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  store.release(board, rejected, 'web-1', 'Release the rework fixture before escalation.', undefined, 'OTHER');
  store.escalate(board, rejected, { agentId: 'coordinator', note: 'two tries stayed red' });
  store.refreeze(board, rejected, { agentId: 'coordinator', freeze });
  const dropped = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Old idea' });
  store.claim(board, dropped, { agentId: 'web-2', lane: 'web', leaseMs: 7_200_000, freeze });
  store.withdraw(board, dropped, { agentId: 'coordinator', reason: 'superseded' });
  assert.deepEqual([accepted, rejected, dropped].map((id) => store.getItem(board, id).item_status), ['verified', 'open', 'withdrawn']);
});

test('cli.journeys-verify-machine.an-older-board-gets-the-triggers: an older board gets the triggers quietly on its next open; one dropped by hand comes back, and the log says so [M3]', () => {
  const lab = boardOnDisk();
  try {
    const id = store.addItem(lab.board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const every = machineRules.storeTriggers().map(({ name }) => name).sort();
    assert.deepEqual(triggerNames(lab.board), every);
    store.closeBoard(lab.board);

    const older = lab.raw();
    for (const name of every) older.exec(`DROP TRIGGER ${name}`);
    older.exec('PRAGMA user_version = 0');
    older.prepare("UPDATE item SET item_status = 'verified' WHERE item_id = ?").run(id);
    older.prepare("UPDATE item SET item_status = 'open' WHERE item_id = ?").run(id);
    older.close();

    const upgraded = openBoard(lab.file);
    assert.deepEqual(triggerNames(upgraded), every);
    assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'guards'").get().n, 0, 'an older board gets them quietly');
    store.closeBoard(upgraded);

    const tampered = lab.raw();
    tampered.exec('DROP TRIGGER machine_proof_verified');
    tampered.exec('DROP TRIGGER machine_item_move');
    tampered.exec('CREATE TRIGGER machine_item_move BEFORE UPDATE OF item_status ON item WHEN 0 BEGIN SELECT 1; END');
    tampered.exec('PRAGMA user_version = 3'); // current, so drifted and left alone on open; behind it is refused (#7767)
    tampered.close();

    const restored = openBoard(lab.file);
    try { store.guardStore(restored); // the install that audits a hand-dropped guard, as a migration runs it
      assert.deepEqual(triggerNames(restored), every);
      const logged = restored.db.prepare("SELECT event_by, event_detail FROM event WHERE event_kind = 'guards'").all();
      assert.deepEqual(logged.map((row) => [row.event_by, JSON.parse(row.event_detail)]), [['board', { missing: ['machine_proof_verified'], changed: ['machine_item_move'], stale: [] }]]);
      assert.throws(() => lab.raw().prepare("UPDATE item SET item_status = 'verified' WHERE item_id = ?").run(id), /MISSING_FIELD/);
    } finally {
      store.closeBoard(restored);
    }
  } finally {
    lab.done();
  }
});

test('cli.journeys-verify-machine.the-triggers-come-from-the-declaration: the triggers come from the declaration, so a changed declaration changes them [M1, M3]', () => {
  assertRehomeTriggerDeclaration();
});

test('cli.journeys-verify-machine.a-verified-item-s-proof-cannot: a verified item\'s proof cannot be rewritten afterwards: its commit, builder, verifier or criterion [M3]', () => {
  const lab = boardOnDisk();
  try {
    const id = submittedItem(lab.board);
    verdictOn(lab.board, id, 'web-2', 'ACCEPT');
    const raw = lab.raw();
    const refused = (sql) => assert.throws(() => raw.prepare(sql).run(id), /NOT_PROVEN/, sql);
    refused(`UPDATE item SET item_commit = '${SHA_B}' WHERE item_id = ?`);
    refused("UPDATE item SET item_built_by = 'web-2' WHERE item_id = ?");
    refused("UPDATE item SET item_verified_by = 'web-1' WHERE item_id = ?");
    refused("UPDATE item SET item_frozen_digest = 'digest:Another criterion' WHERE item_id = ?");
    refused(`UPDATE item SET item_status = 'verified', item_commit = '${SHA_B}' WHERE item_id = ?`);
    raw.prepare(`UPDATE item SET item_merged_commit = '${SHA_A}' WHERE item_id = ?`).run(id);
    assert.deepEqual([store.getItem(lab.board, id).item_commit, store.getItem(lab.board, id).item_merged_commit], [SHA_A, SHA_A]);
  } finally {
    lab.done();
  }
});

test('cli.journeys-verify-machine.a-field-a-state-needs-cannot: a field a state needs cannot be blanked, on the way in or while the item stays, with any whitespace [M3]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const withdrawn = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Old idea' });
    store.withdraw(board, withdrawn, { agentId: 'coordinator', reason: 'superseded' });
    const fresh = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Another' });
    const claimed = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    store.claim(board, claimed, { agentId: 'web-2', lane: 'web', leaseMs: 7_200_000, freeze });
    const built = submittedItem(board);
    const raw = lab.raw();
    const refused = (sql, args) => assert.throws(() => raw.prepare(sql).run(...args), /MISSING_FIELD/, `${sql} ${JSON.stringify(args)}`);
    refused("UPDATE item SET item_withdrawn_reason = '' WHERE item_id = ?", [withdrawn]);
    refused('UPDATE item SET item_withdrawn_reason = NULL WHERE item_id = ?', [withdrawn]);
    refused("UPDATE item SET item_status = 'withdrawn', item_withdrawn_reason = '' WHERE item_id = ?", [withdrawn]);
    for (const blank of [' ', '\t\n', ' ', ' ', '﻿', '　 ']) {
      refused("UPDATE item SET item_status = 'withdrawn', item_withdrawn_reason = ? WHERE item_id = ?", [blank, fresh]);
    }
    refused('UPDATE item SET item_owner = NULL WHERE item_id = ?', [claimed]);
    refused("UPDATE item SET item_commit = '' WHERE item_id = ?", [built]);
    assert.equal(store.getItem(board, withdrawn).item_withdrawn_reason, 'superseded');
    assert.equal(store.getItem(board, fresh).item_status, 'open');
    assert.throws(() => store.withdraw(board, fresh, { agentId: 'coordinator', reason: ' ' }), /NOTE_REQUIRED/, 'the command trims the same way');
  } finally {
    lab.done();
  }
});

test('cli.journeys-verify-machine.a-blank-field-in-the-board: a blank field in the board file is exactly what JavaScript\'s trim removes [M3]', () => {
  const trimmed = [];
  for (let code = 0; code <= 0xffff; code += 1) if (String.fromCharCode(code).trim() === '') trimmed.push(code);
  assert.deepEqual(machineRules.BLANKS, trimmed);
});

test('cli.journeys-verify-machine.claim-refuses-in-the-declared-order: claim refuses in the declared order, one failure peeled at a time, on a real board [M1, M2]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
    const strong = store.register(board, { lane: 'web', path: '/repo-web-strong' });
    // The target expects 45 build minutes: a 60-minute budget admits it, and the board's 30-minute default peels buildScopeFits.
    const claimAs = (id, agentId, lane, freezer = retiredFreeze, buildBudgetMinutes = 60) => outcome(() => store.claim(board, id, { agentId, lane, leaseMs: 7_200_000, freeze: freezer, buildBudgetMinutes }));
    const done = submittedItem(board);
    const returned = submittedItem(board);
    // A reject reopens to anyone (REJECT_OPEN_ENGINE); a failed landing still waits for its builder first.
    verdictOn(board, returned, 'web-2', 'ACCEPT');
    store.reopen(board, returned, { agentId: 'coordinator', reopenFirstRefusalMinutes: 30, note: `test/page.test.js: failed case; merge commit ${SHA_B}` });
    const dependency = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const target = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page', after: [dependency], expectedBuildMinutes: 45 });
    const spare = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const raw = lab.raw();
    holdByHand(raw, target, 'web-2');
    store.claim(board, spare, { agentId: strong, lane: 'web', leaseMs: 7_200_000, freeze });
    store.claim(board, dependency, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    submitFixture(board, dependency, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
    store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'pause' });
    store.holdItem(board, target, { agentId: 'coordinator', reason: 'item pause' });
    const fired = [claimAs(999, light, 'api'), claimAs(done, light, 'api')];
    store.setBarReady(board, { agentId: 'coordinator', enabled: true });
    store.editItem(board, target, { agentId: 'coordinator', brief: 'Unsigned bar edge' });
    fired.push(claimAs(target, light, 'api'));
    store.setBarReady(board, { agentId: 'coordinator', enabled: false });
    fired.push(claimAs(target, light, 'api'));
    store.releaseItemHold(board, target, { agentId: 'coordinator' });
    fired.push(claimAs(target, light, 'api'), claimAs(target, light, 'web'), claimAs(target, strong, 'web', retiredFreeze, 30), claimAs(target, strong, 'web'));
    verdictOn(board, dependency, 'web-2', 'ACCEPT');
    fired.push(claimAs(target, strong, 'web'), claimAs(returned, strong, 'web'));
    store.editItem(board, target, { agentId: 'coordinator', criterion: 'Pending correction before the lane guard.' });
    store.release(board, target, 'web-2', 'Release the fixture holder before checking the pending correction.', undefined, 'OTHER');
    fired.push(claimAs(target, strong, 'web'));
    store.refreeze(board, target, { agentId: 'coordinator', freeze });
    store.editItem(board, target, { agentId: 'coordinator', criterion: 'A new bar, so the next claim freezes it.' });
    fired.push(claimAs(target, strong, 'web'));
    store.releaseLane(board, 'web', { agentId: 'coordinator' });
    store.setLineSetting(board, { agentId: 'coordinator', key: 'wipPerReviewer', value: 1.5, reason: 'peel the actual capacity guard', window: { activeReviewers: 1 } });
    fired.push(claimAs(target, strong, 'web'));
    store.setLineSetting(board, { agentId: 'coordinator', key: 'wipPerReviewer', value: false, reason: 'peel the remaining existing guards', window: { activeReviewers: 1 } });
    fired.push(claimAs(target, strong, 'web'));
    store.release(board, spare, strong, 'Release the spare fixture claim before checking the next guard.', undefined, 'OTHER');
    fired.push(claimAs(target, strong, 'web'), claimAs(target, strong, 'web', freeze));
    assert.deepEqual(fired, [...declaredBoardOrder(machineRules, PRECHECKED, 'claim'), 'ok']);
    assert.deepEqual(fired, ['NO_ITEM', 'NOT_CLAIMABLE', 'BAR_NOT_READY', 'ITEM_HELD', 'WRONG_LANE', 'ROUTE', 'ITEM_BUILD_BUDGET', 'BLOCKED', 'HELD', 'REOPEN_HELD_FOR_BUILDER', 'PENDING_REFREEZE', 'LANE_HELD', 'LINE_WIP_LIMIT', 'ONE_CLAIM', 'UNKNOWN_SPEC', 'ok']);
  } finally {
    lab.done();
  }
});

test('cli.journeys-verify-machine.submit-accept-and-reject-refuse-in: submit, accept and reject refuse in the declared order, one failure peeled at a time [M1, M2]', t => {
  const lab = memoryBoardLab(t, undefined, { reviewerFamily: 'REQUIRED REVIEW' }); // Declared once: a family is one derived value (#1783).
  const { board } = lab;
  const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
  const submitAs = (id, agentId, commit) => outcome(() => submitFixture(board, id, { agentId, commit, tree: 'tree' }));
  const piece = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const submits = [submitAs(999, 'web-1', SHA_A), submitAs(piece, 'web-1', SHA_A)];
  store.claim(board, piece, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  submits.push(submitAs(piece, 'web-2', SHA_A));
  store.editItem(board, piece, { agentId: 'coordinator', criterion: 'A correction before submission.', reason: 'the fixture corrects its bar' });
  submits.push(submitAs(piece, 'web-1', SHA_A));
  assert.equal(submits.at(-1), 'PENDING_REFREEZE', 'a pending correction stops the board submission before later guards');
  store.refreeze(board, piece, { agentId: 'web-1', freeze });
  store.setBarReady(board, { agentId: 'coordinator', enabled: true });
  store.editItem(board, piece, { agentId: 'coordinator', brief: 'Unsigned corrected bar' });
  submits.push(submitAs(piece, 'web-1', SHA_A));
  store.setBarReady(board, { agentId: 'coordinator', enabled: false });
  submits.push(outcome(() => submitFixture(board, piece, { agentId: 'web-1', commit: SHA_A, tree: 'tree',
    submissionProof: { version: 99, files: [], full: false, deferred: true, reason: '' } })));
  submitFixture(board, piece, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
  verdictOn(board, piece, 'web-2', 'REJECT');
  store.claim(board, piece, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'Part', parentId: piece });
  submits.push(submitAs(piece, 'web-1', SHA_A));
  store.withdraw(board, child, { agentId: 'coordinator', reason: 'folded into the parent' });
  submits.push(submitAs(piece, 'web-1', SHA_A), submitAs(piece, 'web-1', SHA_B));
  assert.deepEqual(submits, [...declaredBoardOrder(machineRules, PRECHECKED, 'submit'), 'ok']);

  // A family is one derived value since #1783, so each vendor role is its own seat rather than a rewritten column.
  const other = store.register(board, { lane: 'web', path: '/repo-web-other' });
  const otherVendor = store.register(board, { lane: 'web', path: '/repo-web-other-vendor', family: 'BUILDER-VENDOR' });
  const otherRequired = store.register(board, { lane: 'web', path: '/repo-web-other-required', family: 'required review' });
  for (const verb of ['accept', 'reject']) {
    const decision = verb === 'accept' ? 'ACCEPT' : 'REJECT';
    store.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
    const built = submittedItem(board, { reviewFamily: 'Required Review' });
    const vendorOnly = submittedItem(board, { sensitive: true });
    const landed = submittedItem(board);
    verdictOn(board, landed, 'web-2', 'ACCEPT');
    store.merged(board, landed, { agentId: 'coordinator', commit: SHA_A });
    const open = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const pending = gatePendingItem(board);
    store.reserveReview(board, built, { agentId: 'web-2', leaseMs: 3_600_000, policy: 'any' });
    const judge = (id, agentId, fields) =>
      outcome(() => store.verify(board, id, { agentId, decision, head: SHA_A, digest: 'wrong', policy: 'coordinator', note: '', review: { commit: SHA_A, head: SHA_A, trunk: SHA_B, paths: ['web/page.js'] }, ...fields }));
    const bad = verb === 'accept' ? 'TEST_FAILURE' : 'NOPE';
    const good = verb === 'accept' ? undefined : 'TEST_FAILURE';
    const fired = [
      judge(999, 'web-2', { reason: bad }),
      judge(open, 'web-2', { reason: bad }),
      judge(pending, 'web-2', { reason: bad }),
      judge(landed, 'web-2', { reason: bad }),
      judge(built, 'web-2', { reason: bad, review: null }),
      judge(built, 'web-1', { reason: bad }),
      judge(built, light, { reason: bad }),
      judge(built, 'web-2', { reason: bad }),
      judge(built, other, { reason: bad, policy: 'any' }),
      /** Observe vendor refusal on Strict work, then restore the required-family peer for later guards. */
      judge(vendorOnly, otherVendor, { reason: bad, policy: 'any', familyPolicy: 'require' }),
      judge(built, otherRequired, { reason: bad, policy: 'any' }),
      judge(built, 'web-2', { reason: bad, policy: 'any' }),
      judge(built, 'web-2', { reason: bad, policy: 'any', digest: 'digest:Page' }),
      judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page' }),
      // Only a reject reads a cause key, so only its order has the malformed-cause step (#713).
      ...(verb === 'reject' ? [judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page', note: 'reverted the fix; its test went red', cause: 'free text' })] : []),
      judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page', note: 'reverted the fix; its test went red' }),
      ...(verb === 'reject' ? [judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page', note: 'reverted the fix; its test went red', clause: 'Page' })] : []),
    ];
    assert.deepEqual(fired, [...declaredBoardOrder(machineRules, PRECHECKED, verb), 'ok'], verb);
  }
});

test('cli.journeys-verify-machine.reserve-refuses-in-the-declared-order: reserve refuses in the declared order, one failure peeled at a time [V15, M1, M2]', t => {
  const lab = memoryBoardLab(t, undefined, { reviewerFamily: 'REQUIRED REVIEW' }); // Declared once: a family is one derived value (#1783).
  const { board } = lab;
  const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
  const other = store.register(board, { lane: 'web', path: '/repo-web-other' });
  // A family is one derived value since #1783, so each vendor role is its own seat rather than a rewritten column.
  const otherVendor = store.register(board, { lane: 'web', path: '/repo-web-other-vendor', family: 'BUILDER-VENDOR' });
  const otherRequired = store.register(board, { lane: 'web', path: '/repo-web-other-required', family: 'required review' });
  store.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
  const built = submittedItem(board, { reviewFamily: 'Required Review' });
  const vendorOnly = submittedItem(board, { sensitive: true });
  const open = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const reserveAs = (id, agentId, policy = 'coordinator', familyPolicy = 'off') => outcome(() => store.reserveReview(board, id, { agentId, leaseMs: 3_600_000, policy, familyPolicy }));
  const pending = gatePendingItem(board);
  const cooling = submittedItem(board);
  store.reserveReview(board, cooling, { agentId: 'web-2', leaseMs: 3_600_000, policy: 'any' });
  store.release(board, cooling, 'web-2', 'another reviewer should take it', undefined, 'OTHER');
  const fired = [reserveAs(999, 'web-2'), reserveAs(open, 'web-2'), reserveAs(pending, 'web-2'), reserveAs(cooling, 'web-2'), reserveAs(built, 'web-1'), reserveAs(built, light), reserveAs(built, 'web-2'), reserveAs(built, other, 'any')];
  fired.push(reserveAs(vendorOnly, otherVendor, 'any', 'require'));
  store.reserveReview(board, built, { agentId: otherRequired, leaseMs: 3_600_000, policy: 'any' });
  fired.push(reserveAs(built, 'web-2', 'any'), reserveAs(built, otherRequired, 'any'));
  assert.deepEqual(fired, [...declaredBoardOrder(machineRules, PRECHECKED, 'reserve'), 'ok']);
  assert.deepEqual(fired, ['NO_ITEM', 'NOT_SUBMITTED', 'GATE_PENDING', 'REVIEW_COOLDOWN', 'SELF_VERIFY', 'ROUTE', 'COORDINATOR_VERIFIES', 'REQUIRED_REVIEW_FAMILY', 'SAME_FAMILY', 'REVIEW_HELD', 'ok']);
});

test('cli.journeys-verify-machine.a-reserved-review-refuses-every-other: a reserved review refuses every other verdict while its lease lives, and only then; a new submission starts free [V15]', t => {
  let at = Date.parse('2026-10-06T12:00:00.000Z');
  const lab = memoryBoardLab(t, { now: () => new Date(at) });
  const { board } = lab;
  const third = store.register(board, { lane: 'web', path: '/repo-web-3', family: 'review-vendor' });
  const id = submittedItem(board);
  const minutes = (count) => {
    at += count * 60_000;
    // A reservation holds only while its reviewer's seat is alive, so both reviewers keep beating as the clock moves.
    for (const seat of ['web-2', third]) heartbeatSeat(board, seat);
  };
  const reserve = (agentId) => store.reserveReview(board, id, { agentId, leaseMs: 30 * 60_000, policy: 'any' });
  const judge = (agentId, decision) =>
    outcome(() =>
      store.verify(board, id, {
        agentId,
        decision,
        reason: decision === 'REJECT' ? 'TEST_FAILURE' : undefined, ...(decision === 'REJECT' ? { clause: 'Page' } : {}),
        note: 'reverted the fix; its test went red',
        head: store.getItem(board, id).item_commit,
        digest: 'digest:Page',
        policy: 'any',
      }),
    );
  const holder = () => store.reviewHolder(board, store.getItem(board, id));
  const offered = (agentId) => store.nextFor(board, { agentId, lane: 'web', verify: true });

  assert.equal(reserve('web-2').item_review_until, '2026-10-06T12:30:00.000Z');
  assert.equal(holder(), 'web-2');
  assert.equal(offered(third).item ?? null, null, 'another agent is passed over');
  assert.match(offered(third).reasons.join('; '), /web-2 holds the review of #1 until 2026-10-06T12:30:00\.000Z/);
  assert.equal(outcome(() => reserve(third)), 'REVIEW_HELD');
  assert.equal(judge(third, 'ACCEPT'), 'REVIEW_HELD');
  assert.equal(judge(third, 'REJECT'), 'REVIEW_HELD');
  assert.equal(offered('web-2').item.item_id, id, 'the holder is offered its own review');

  minutes(20);
  assert.equal(reserve('web-2').item_review_until, '2026-10-06T12:50:00.000Z', 'reserving again renews the lease');
  minutes(25);
  assert.equal(judge(third, 'ACCEPT'), 'REVIEW_HELD', 'at 12:45 the renewed lease still holds');

  minutes(6);
  assert.equal(holder(), null, 'at 12:51 the lease has run out');
  assert.equal(offered(third).item.item_id, id);
  assert.equal(reserve(third).item_review_until, '2026-10-06T13:21:00.000Z');
  assert.equal(judge('web-2', 'ACCEPT'), 'REVIEW_HELD', 'a lapsed lease gives nothing over the agent that reserved since');
  assert.equal(judge(third, 'REJECT'), 'ok');
  assert.equal(store.getItem(board, id).item_review_by, third, 'the reservation stays on the record');
  assert.equal(holder(), null, 'but holds nothing once the item leaves submitted, though its lease lives until 13:21');

  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_B, tree: 'tree' });
  assert.equal(store.getItem(board, id).item_review_by, null, 'a new submission starts with no reservation');
  assert.equal(offered('web-2').item.item_id, id, 'though the last lease would live until 13:21');

  reserve('web-2');
  minutes(60);
  assert.equal(holder(), null);
  assert.equal(judge('web-2', 'ACCEPT'), 'ok', "the holder's own verdict is never refused for its lease having lapsed");
  assert.equal(store.getItem(board, id).item_status, 'verified');
  const reserved = store
    .events(board, { itemId: id })
    .filter((event) => event.event_kind === 'reserve')
    .map((event) => [event.event_by, JSON.parse(event.event_detail).until]);
  assert.deepEqual(reserved, [
    ['web-2', '2026-10-06T12:30:00.000Z'],
    ['web-2', '2026-10-06T12:50:00.000Z'],
    [third, '2026-10-06T13:21:00.000Z'],
    ['web-2', '2026-10-06T13:21:00.000Z'],
  ]);
});

test('cli.journeys-verify-machine.next-verify-looks-outside-the-lock: next --verify looks outside the lock and rechecks inside it, so no other verifier takes the review in between [V15]', () => {
  const lab = boardOnDisk();
  const others = [];
  try {
    const id = submittedItem(lab.board);
    const third = store.register(lab.board, { lane: 'web', path: '/repo-web-3', family: 'review-vendor' });
    const fourth = store.register(lab.board, { lane: 'web', path: '/repo-web-4', family: 'review-vendor' });
    // A reservation that has already lapsed, so the look has a lease to read the clock for.
    store.reserveReview(lab.board, id, { agentId: fourth, leaseMs: 1, policy: 'any' });
    const rival = openBoard(lab.file);
    rival.db.exec('PRAGMA busy_timeout = 0');
    let armed = false;
    let rivalSaw = null;
    // web-2's own connection. Its clock runs a minute ahead, so the lapsed lease is plainly lapsed,
    // and the first time the look reads it, a rival verifier on another connection reserves the
    // same review. The look holds no write lock (#3156), so the rival's write lands mid-look.
    const looking = openBoard(lab.file, {
      now: () => {
        if (armed && rivalSaw === null) {
          try {
            store.reserveReview(rival, id, { agentId: third, leaseMs: 600_000, policy: 'any' });
            rivalSaw = 'reserved';
          } catch (error) {
            rivalSaw = error;
          }
        }
        return new Date(Date.now() + 60_000);
      },
    });
    others.push(rival, looking);
    armed = true;
    const found = store.reserveNextReview(looking, { agentId: 'web-2', lane: 'web', leaseMs: 60_000, policy: 'any' });
    assert.ok(rivalSaw !== null, 'the look read the clock, so the rival had its chance mid-look');
    assert.equal(rivalSaw, 'reserved', 'the look held no write lock, so the rival reserved mid-look');
    // The in-lock recheck sees the rival's live reservation and refuses: the looker never takes the review.
    assert.notEqual(found.item?.item_id, id, 'the looker did not take the review the rival holds');
    const held = store.getItem(lab.board, id);
    assert.equal(held.item_review_by, third, 'exactly one verifier holds the review: the rival');
  } finally {
    for (const board of others) store.closeBoard(board);
    lab.done();
  }
});

test('cli.journeys-verify-machine.the-review-lease-is-reviewlease-in: the review lease is reviewLease in pullboard.json, 30 minutes unless the repo says otherwise [V15]', () => {
  assertConfiguredReviewLease(loadConfig);
});

test('cli.journeys-verify-machine.the-lifecycle-page-and-the-help: the lifecycle page and the help show the reservation: reserve, and reviewFree on every verdict [V15, M1]', () => {
  assertLifecycleReservation(machineRules, HELP);
});

test('cli.journeys-verify-machine.the-two-conditional-guards-behave-as: the two conditional guards behave as declared: a renewal passes a held lane, and only a freeze checks the rows [M1, M2]', t => {
  const lab = memoryBoardLab(t);
  const { board } = lab;
  const claimAs = (id, agentId, freezer) => outcome(() => store.claim(board, id, { agentId, lane: 'web', leaseMs: 7_200_000, freeze: freezer }));
  assert.match(machineRules.MACHINE.guards.find((guard) => guard.id === 'laneOpen').when, /renewing its own live claim/);
  assert.match(machineRules.MACHINE.guards.find((guard) => guard.id === 'rowsInForce').when, /where the criterion freezes/);

  const mine = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const theirs = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  assert.equal(claimAs(mine, 'web-1', freeze), 'ok');
  store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'pause' });
  assert.equal(claimAs(mine, 'web-1', freeze), 'ok', 'its holder renews a live claim in a held lane');
  assert.equal(claimAs(theirs, 'web-2', freeze), 'LANE_HELD', 'a fresh claim in the held lane is refused');
  store.releaseLane(board, 'web', { agentId: 'coordinator' });

  assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'ok', 'a renewal keeps the frozen bar and checks no rows');
  store.release(board, mine, 'web-1', 'Release the fixture claim to check reclaiming the frozen bar.', undefined, 'OTHER');
  assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'ok', 'a reclaim keeps the frozen bar too');
  assert.equal(claimAs(theirs, 'web-2', retiredFreeze), 'UNKNOWN_SPEC', 'a first claim freezes, so it checks the rows');
  store.release(board, mine, 'web-1', 'Release the fixture claim before correcting its bar.', undefined, 'OTHER');
  store.editItem(board, mine, { agentId: 'coordinator', criterion: 'A changed bar.', reason: 'the fixture corrects its bar' });
  assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'UNKNOWN_SPEC', 'after an edit drops the bar, the next claim freezes and checks');
  assert.equal(outcome(() => store.refreeze(board, mine, { agentId: 'coordinator', freeze: retiredFreeze })), 'UNKNOWN_SPEC', 'refreeze freezes, so it checks');
});

test('cli.journeys-verify-machine.the-board-refuses-a-status-written: the board refuses a status written outside moveItem at run time, however it is spelled [M1]', t => {
  const lab = memoryBoardLab(t);
  const { board } = lab;
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  const column = ['item', 'status'].join('_');
  for (const sql of ["update item set item_status = 'open' where item_id = ?", `UPDATE item SET ${column} = 'claimed' WHERE item_id = ?`]) {
    assert.throws(() => board.db.prepare(sql).run(id), /STATUS_OUTSIDE_MOVE/, sql);
  }
  assert.throws(
    () => board.db.prepare("REPLACE INTO item (item_id, item_lane, item_title, item_created_by, item_created_at, item_updated_at) VALUES (?, 'web', 'Page', 'x', 'now', 'now')").run(id),
    /KEPT/,
    'a replace deletes the old row first, and the board keeps items',
  );
  assert.equal(store.getItem(board, id).item_status, 'claimed');
  store.release(board, id, 'web-1', 'Exercise the declared release move after refusing direct status writes.', undefined, 'OTHER');
  assert.equal(store.getItem(board, id).item_status, 'open', 'a move through moveItem still writes');
});

test('cli.journeys-verify-machine.a-helper-added-to-the-board: a helper added to the board that changes a status outside moveItem is refused when it runs [M1]', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pullboard-planted-'));
  try {
    copyPackageFiles(join(import.meta.dirname, '../../../..'), dir);
    const boardFile = join(dir, 'packages/store/index.js');
    fs.appendFileSync(boardFile, `\nexport function reopenByHand(board, id) {\n  board.db.prepare("update item set item_status = 'open', item_owner = null, item_lease_until = null where item_id = ?").run(id);\n}\n`);
    const copy = await import(pathToFileURL(boardFile).href);
    const copyNative = await import(pathToFileURL(join(dir, 'apps', 'lib', 'index.js')).href);
    const board = copyNative.openBoard(':memory:');
    copy.register(board, { lane: 'coordinator', path: '/repo', family: 'human' });
    copy.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
    const id = copy.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    copy.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    assert.throws(() => copy.reopenByHand(board, id), /STATUS_OUTSIDE_MOVE/);
    assert.equal(copy.getItem(board, id).item_status, 'claimed');
    copy.closeBoard(board);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

