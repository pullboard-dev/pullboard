/**
 * The item lifecycle's declaration (M1, M2, M4): sound on its own terms, each property shown
 * failing on a broken copy, and in step with the refusals board.js and cli.js raise today.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { BLANKS, IN_STATE, MACHINE, effectiveGuards, machineProblems, storeTriggers } from '../src/machine.js';

/**
 * Refusals that are not about an item's lifecycle, so no move declares them: how a command was
 * typed, and registering who is asking, which happens before any move.
 */
const NOT_MOVES = {
  USAGE: 'how a command was typed',
  NO_FILE: 'how a command was typed: a --note-file that does not exist',
  ALREADY_JOINED: 'registering who is asking, before any move',
  BAD_ROUTE: 'registering who is asking, before any move',
  ONE_COORDINATOR: 'registering who is asking, before any move',
};

/**
 * Where each move starts in the code. Accept and reject share the board's verify and the CLI's, so
 * they answer for its refusals together.
 */
const ENTRY_POINTS = [
  { verbs: ['claim'], at: ['board.js#claim'] },
  { verbs: ['release'], at: ['board.js#release'] },
  { verbs: ['submit'], at: ['board.js#submit', 'cli.js#submitHere'] },
  { verbs: ['accept', 'reject'], at: ['board.js#verify', 'cli.js#verifyHere'] },
  { verbs: ['escalate'], at: ['board.js#escalate'] },
  { verbs: ['withdraw'], at: ['board.js#withdraw'] },
  { verbs: ['refreeze'], at: ['board.js#refreeze'] },
];

/** Board functions handed a function to call, and the one the CLI and the runner hand them. */
const CALLBACKS = { 'board.js': { freeze: 'cli.js#freezer' } };

/**
 * Calls whose refusals an entry point catches and reports as another: submit and verify read a
 * cited row taken out of force as a changed criterion, CRITERIA_CHANGED.
 */
const CAUGHT = { 'cli.js#submitHere': ['cli.js#freezer'], 'cli.js#verifyHere': ['cli.js#freezer'] };

/** A top-level function, or a top-level arrow function bound to a const. */
const START = /^(?:export )?(?:(?:async )?function (\w+)\(|const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>)/;

/**
 * Each top-level function's source by name, arrow functions included. A function declaration ends
 * at its closing brace; an arrow function ends where its statement does.
 *
 * @param {string} source
 * @returns {Map<string, string>}
 */
function functionsIn(source) {
  const bodies = new Map();
  let open = null;
  for (const line of source.split('\n')) {
    if (open) {
      open.lines.push(line);
      if (open.ends(line)) {
        bodies.set(open.name, open.lines.join('\n'));
        open = null;
      }
      continue;
    }
    const start = START.exec(line);
    if (!start) continue;
    const end = line.trimEnd();
    if (start[1]) open = { name: start[1], lines: [line], ends: (next) => next === '}' };
    else if (end.endsWith(';')) bodies.set(start[2], line);
    else if (end.endsWith('{')) open = { name: start[2], lines: [line], ends: (next) => next === '};' };
    else open = { name: start[2], lines: [line], ends: (next) => next.trimEnd().endsWith(';') };
  }
  return bodies;
}

/**
 * A walk over this package's source: the refusal codes a function raises, itself or through the
 * functions it calls, followed across imports and into the functions the CLI hands the board.
 *
 * @param {(file: string) => string} read - The source of a file in src/.
 * @returns {{ functions: (file: string) => string[], refusalsOf: (key: string, skip?: Set<string>) => Set<string> }}
 */
function codeWalk(read) {
  const files = new Map();
  const load = (file) => {
    if (!files.has(file)) {
      const source = read(file);
      const named = new Map();
      for (const [, names, from] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+\.js)'/g)) {
        for (const part of names.split(',').map((text) => text.trim()).filter(Boolean)) {
          const [original, local = original] = part.split(/\s+as\s+/);
          named.set(local, `${from}#${original}`);
        }
      }
      const spaces = new Map([...source.matchAll(/import \* as (\w+) from '\.\/([\w-]+\.js)'/g)].map(([, space, from]) => [space, from]));
      files.set(file, { bodies: functionsIn(source), named, spaces });
    }
    return files.get(file);
  };
  const refusalsOf = (key, skip = new Set(), seen = new Set()) => {
    if (seen.has(key) || skip.has(key)) return new Set();
    seen.add(key);
    const [file, name] = key.split('#');
    const { bodies, named, spaces } = load(file);
    const body = bodies.get(name) ?? '';
    const codes = new Set([...body.matchAll(/new Refused\(\s*(['"])([A-Z_]+)\1/g)].map((match) => match[2]));
    const callees = [
      ...[...body.matchAll(/(?<![.\w])(\w+)\(/g)].map(([, callee]) => (bodies.has(callee) ? `${file}#${callee}` : named.get(callee) ?? CALLBACKS[file]?.[callee])),
      ...[...body.matchAll(/\b(\w+)\.(\w+)\(/g)].map(([, space, callee]) => (spaces.has(space) ? `${spaces.get(space)}#${callee}` : undefined)),
    ];
    for (const callee of callees.filter(Boolean)) for (const code of refusalsOf(callee, skip, seen)) codes.add(code);
    return codes;
  };
  return { functions: (file) => [...load(file).bodies.keys()], refusalsOf };
}

/**
 * A file in src/ as it is on disk.
 *
 * @param {string} file
 * @returns {string}
 */
const fromDisk = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

/**
 * The refusal codes the named moves declare, or the whole declaration's when none is named: their
 * guards' codes, exit guards included, their wrong-state codes, and the unknown move's.
 *
 * @param {any} machine
 * @param {string[]} [verbs]
 * @returns {Set<string>}
 */
function declaredCodes(machine, verbs) {
  const moves = verbs ? machine.moves.filter((move) => verbs.includes(move.verb)) : machine.moves;
  const used = new Set(moves.flatMap((move) => effectiveGuards(move, machine)));
  return new Set([
    ...machine.guards.filter((guard) => !verbs || used.has(guard.id)).map((guard) => guard.refuse),
    ...moves.map((move) => move.refuse),
    machine.unknownMove.refuse,
  ].filter(Boolean));
}

/**
 * Where a declaration and the code disagree: a refusal a move raises today that the move does not
 * declare, or a code the declaration names that board.js and cli.js never raise.
 *
 * @param {any} machine
 * @param {(file: string) => string} [read]
 * @returns {string[]}
 */
function codeProblems(machine, read = fromDisk) {
  const walk = codeWalk(read);
  const problems = new Set();
  for (const { verbs, at } of ENTRY_POINTS) {
    const declared = declaredCodes(machine, verbs);
    for (const entry of at) {
      for (const code of walk.refusalsOf(entry, new Set(CAUGHT[entry] ?? []))) {
        if (!declared.has(code) && !(code in NOT_MOVES)) problems.add(`${code} is raised by ${verbs.join(' and ')} but not declared there`);
      }
    }
  }
  const raised = new Set(['board.js', 'cli.js'].flatMap((file) => walk.functions(file).flatMap((name) => [...walk.refusalsOf(`${file}#${name}`)])));
  for (const code of declaredCodes(machine)) if (!raised.has(code)) problems.add(`${code} is declared but board.js and cli.js never raise it`);
  return [...problems];
}

/**
 * The source of src/ with one line of one file rewritten, for a broken copy of the code. Refuses if
 * the line is not there, so a refactor cannot quietly turn the broken copy into the real one.
 *
 * @param {string} file
 * @param {RegExp} line
 * @param {string} replacement
 * @returns {(name: string) => string}
 */
function editedSource(file, line, replacement) {
  return (name) => {
    const source = fromDisk(name);
    if (name !== file) return source;
    assert.match(source, line, `${file} still has the line this broken copy rewrites`);
    return source.replace(line, replacement);
  };
}

/**
 * A deep copy of the declaration to break, so the real one stays whole.
 *
 * @returns {any}
 */
const copy = () => structuredClone(MACHINE);

/**
 * The move with this verb.
 *
 * @param {any} machine
 * @param {string} verb
 * @returns {any}
 */
const moveOf = (machine, verb) => machine.moves.find((move) => move.verb === verb);

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
      machine.moves.push({ verb: 'park', from: ['open'], to: 'parked', by: ['agent', 'coordinator'], refuse: 'CLOSED', guards: ['joined', 'itemExists', IN_STATE] });
    },
    says: /state parked is a trap/,
  },
  {
    property: 'nothing leaves a final state',
    breaks: (machine) => machine.moves.push({ verb: 'reopen', from: ['verified'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_VERIFIED', guards: ['joined', 'itemExists', IN_STATE] }),
    says: /final state verified has a move out/,
  },
  {
    property: 'every final state has exit guards',
    breaks: (machine) => {
      machine.exitGuards.verified = [];
    },
    says: /final state verified has no exit guards/,
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
    breaks: (machine) => machine.moves.push({ verb: 'land', from: ['submitted'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED', guards: ['joined', 'itemExists', IN_STATE], sets: ['item_verified_by'] }),
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
    property: 'every guard is used by some move',
    breaks: (machine) => machine.guards.push({ id: 'unused', refuse: 'UNUSED', rule: 'nothing', next: 'nothing', source: 'board' }),
    says: /guard unused is declared but no move uses it/,
  },
  {
    property: "every caller's move checks the item's state once",
    breaks: (machine) => {
      const release = moveOf(machine, 'release');
      release.guards = release.guards.filter((id) => id !== IN_STATE);
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

test('the declared lifecycle is sound: reachable, no traps, no second door, every refusal with a next step [M1, M2, M4]', () => {
  assert.deepEqual(machineProblems(), []);
  assert.deepEqual(MACHINE.states.map((state) => state.id), ['open', 'claimed', 'submitted', 'verified', 'withdrawn']);
  assert.deepEqual(MACHINE.states.filter((state) => state.final).map((state) => state.id), ['verified', 'withdrawn']);
  assert.deepEqual(MACHINE.moves.map((move) => move.verb), ['claim', 'release', 'lapse', 'submit', 'accept', 'reject', 'escalate', 'refreeze', 'withdraw']);
});

for (const broken of BROKEN) {
  test(`a broken copy fails the check: ${broken.property} [M4]`, () => {
    const machine = copy();
    broken.breaks(machine);
    const problems = machineProblems(machine);
    assert.ok(problems.some((problem) => broken.says.test(problem)), `expected ${broken.says}, got:\n${problems.join('\n')}`);
    assert.deepEqual(machineProblems(), [], 'the real declaration stays sound');
  });
}

test('a door declared without its exit guards still passes them [M2]', () => {
  const machine = copy();
  const land = { verb: 'land', from: ['submitted'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED', guards: ['joined', 'itemExists', IN_STATE] };
  machine.moves.push(land);
  const passes = effectiveGuards(land, machine);
  for (const id of machine.exitGuards.verified) assert.ok(passes.includes(id), `land passes ${id}`);
  assert.deepEqual(passes.slice(0, land.guards.length), land.guards, 'its own guards come first, in order');
  assert.deepEqual(effectiveGuards(moveOf(MACHINE, 'accept')), moveOf(MACHINE, 'accept').guards, 'accept names them all already, so nothing is added');
});

test('verified and withdrawn keep the exit guards their rules need, and a copy that drops one fails [V1, V3, V5, V7, M2, M4]', () => {
  assert.deepEqual(unpinned(MACHINE), []);
  const broken = copy();
  broken.exitGuards.verified = broken.exitGuards.verified.filter((id) => id !== 'notBuilder');
  assert.deepEqual(unpinned(broken), ['verified no longer requires notBuilder (V1) of every move into it']);
});

test('accept and reject hold a verifier to the same checks until the verdict, and a copy that splits them fails [M1, M4]', () => {
  assert.deepEqual(verdictsDiverge(MACHINE), []);
  const broken = copy();
  const accept = moveOf(broken, 'accept');
  accept.guards = accept.guards.filter((id) => id !== 'routeAllows');
  assert.equal(verdictsDiverge(broken).length, 1);
});

test('every refusal a move raises today is declared on that move, and every declared code is raised [M1]', () => {
  assert.deepEqual(codeProblems(MACHINE), []);
  const walk = codeWalk(fromDisk);
  assert.ok(walk.refusalsOf('board.js#claim').has('UNKNOWN_SPEC'), 'the walk follows claim into the freezer the CLI hands it');
  assert.ok(walk.refusalsOf('board.js#refreeze').has('UNKNOWN_SPEC'), 'and refreeze too');
  assert.ok(walk.refusalsOf('cli.js#submitHere').has('UNKNOWN_SPEC'), 'submit calls the freezer too');
  assert.ok(!walk.refusalsOf('cli.js#submitHere', new Set(CAUGHT['cli.js#submitHere'])).has('UNKNOWN_SPEC'), 'and catches what it raises');
  for (const code of ['NOT_CLAIMABLE', 'LANE_HELD', 'GATE_RED', 'NO_GATE', 'NOT_AT_COMMIT', 'SELF_VERIFY', 'BAD_DECISION']) {
    assert.ok(ENTRY_POINTS.some(({ at }) => at.some((entry) => walk.refusalsOf(entry).has(code))), `the walk finds ${code}`);
  }
  for (const code of Object.keys(NOT_MOVES)) {
    assert.ok(ENTRY_POINTS.some(({ at }) => at.some((entry) => walk.refusalsOf(entry).has(code))), `${code} is listed as not a move because a move's code path raises it`);
  }
});

test('a broken copy of the declaration fails the check against the code, both ways [M1, M4]', () => {
  const noLaneHold = copy();
  noLaneHold.guards = noLaneHold.guards.filter((guard) => guard.id !== 'laneOpen');
  for (const move of noLaneHold.moves) move.guards = move.guards.filter((id) => id !== 'laneOpen');
  assert.deepEqual(codeProblems(noLaneHold), ['LANE_HELD is raised by claim but not declared there']);

  const noRows = copy();
  noRows.guards = noRows.guards.filter((guard) => guard.id !== 'rowsInForce');
  for (const move of noRows.moves) move.guards = move.guards.filter((id) => id !== 'rowsInForce');
  assert.deepEqual(codeProblems(noRows).sort(), [
    'UNKNOWN_SPEC is raised by claim but not declared there',
    'UNKNOWN_SPEC is raised by refreeze but not declared there',
  ]);

  const noRouteOnVerdicts = copy();
  for (const verb of ['accept', 'reject']) {
    const move = moveOf(noRouteOnVerdicts, verb);
    move.guards = move.guards.filter((id) => id !== 'routeAllows');
  }
  assert.deepEqual(codeProblems(noRouteOnVerdicts), ['ROUTE is raised by accept and reject but not declared there']);

  const invented = copy();
  invented.guards.push({ id: 'moonPhase', refuse: 'WRONG_MOON', rule: 'the moon is full', next: 'wait', source: 'board' });
  moveOf(invented, 'claim').guards.push('moonPhase');
  assert.deepEqual(codeProblems(invented), ['WRONG_MOON is declared but board.js and cli.js never raise it']);
});

test('a broken copy of the code fails the check: a refusal added wherever a move reaches [M1, M4]', () => {
  const inFreeze = editedSource('spec.js', /^export function frozenCriterion\(spec, item\) \{$/m, "$&\n  if (item.item_title === 'moon') throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(MACHINE, inFreeze).sort(), [
    'MOON_PHASE is raised by claim but not declared there',
    'MOON_PHASE is raised by refreeze but not declared there',
  ], 'claim and refreeze let a freeze refusal through; submit and verify catch it');

  const inArrow = editedSource('board.js', /^export const canTake = .*$/m, "export const canTake = (agentRoute, itemRoute) => { if (!agentRoute) throw new Refused('NO_ROUTE', 'no route'); return ROUTES.indexOf(itemRoute) <= ROUTES.indexOf(agentRoute); };");
  assert.deepEqual(codeProblems(MACHINE, inArrow).sort(), [
    'NO_ROUTE is raised by accept and reject but not declared there',
    'NO_ROUTE is raised by claim but not declared there',
  ]);

  const doubleQuoted = editedSource('cli.js', /^const cdTo = .*$/m, "const cdTo = (root) => { if (!root) throw new Refused(\"NO_ROOT\", 'no root'); return 'cd ' + root + ' &&'; };");
  assert.deepEqual(codeProblems(MACHINE, doubleQuoted), ['NO_ROOT is raised by accept and reject but not declared there']);
});

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
 * @returns {{ file: string, board: any, raw: () => DatabaseSync, done: () => void }}
 */
function boardOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-machine-'));
  const file = join(dir, 'board.sqlite');
  const board = store.openBoard(file);
  store.register(board, { lane: 'coordinator', path: '/repo' });
  store.register(board, { lane: 'web', path: '/repo-web-1' });
  store.register(board, { lane: 'web', path: '/repo-web-2' });
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * An item web-1 claimed and submitted.
 *
 * @param {any} board
 * @returns {number}
 */
function submittedItem(board) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  store.submit(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
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
  const reason = decision === 'REJECT' ? { reason: 'TEST_FAILURE' } : {};
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

test('the board file refuses, written by hand: an unknown state, an undeclared move, an unproven verified, a reasonless withdrawal, an edited record [M3]', () => {
  const lab = boardOnDisk();
  try {
    const open = store.addItem(lab.board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const built = submittedItem(lab.board);
    const raw = lab.raw();
    const refused = (sql, args, code) => assert.throws(() => raw.prepare(sql).run(...args), new RegExp(code), sql);
    refused('UPDATE item SET item_status = ? WHERE item_id = ?', ['shipped', open], 'UNDECLARED_STATE');
    refused('UPDATE item SET item_status = ? WHERE item_id = ?', ['verified', open], 'UNDECLARED_MOVE');
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

test('every move the board makes passes the triggers: claim, submit, accept, reject, rework, release, escalate, refreeze, withdraw [M3]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const accepted = submittedItem(board);
    verdictOn(board, accepted, 'web-2', 'ACCEPT');
    store.merged(board, accepted, { agentId: 'coordinator', commit: SHA_A });
    const rejected = submittedItem(board);
    verdictOn(board, rejected, 'web-2', 'REJECT');
    store.claim(board, rejected, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    store.release(board, rejected, 'web-1');
    store.escalate(board, rejected, { agentId: 'coordinator', note: 'two tries stayed red' });
    store.refreeze(board, rejected, { agentId: 'coordinator', freeze });
    const dropped = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Old idea' });
    store.claim(board, dropped, { agentId: 'web-2', lane: 'web', leaseMs: 7_200_000, freeze });
    store.withdraw(board, dropped, { agentId: 'coordinator', reason: 'superseded' });
    assert.deepEqual([accepted, rejected, dropped].map((id) => store.getItem(board, id).item_status), ['verified', 'open', 'withdrawn']);
  } finally {
    lab.done();
  }
});

test('an older board gets the triggers quietly on its next open; one dropped by hand comes back, and the log says so [M3]', () => {
  const lab = boardOnDisk();
  try {
    const id = store.addItem(lab.board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const every = storeTriggers().map(({ name }) => name).sort();
    assert.deepEqual(triggerNames(lab.board), every);
    store.closeBoard(lab.board);

    const older = lab.raw();
    for (const name of every) older.exec(`DROP TRIGGER ${name}`);
    older.exec('PRAGMA user_version = 0');
    older.prepare("UPDATE item SET item_status = 'verified' WHERE item_id = ?").run(id);
    older.prepare("UPDATE item SET item_status = 'open' WHERE item_id = ?").run(id);
    older.close();

    const upgraded = store.openBoard(lab.file);
    assert.deepEqual(triggerNames(upgraded), every);
    assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'guards'").get().n, 0, 'an older board gets them quietly');
    store.closeBoard(upgraded);

    const tampered = lab.raw();
    tampered.exec('DROP TRIGGER machine_proof_verified');
    tampered.exec('DROP TRIGGER machine_item_move');
    tampered.exec('CREATE TRIGGER machine_item_move BEFORE UPDATE OF item_status ON item WHEN 0 BEGIN SELECT 1; END');
    tampered.close();

    const restored = store.openBoard(lab.file);
    try {
      assert.deepEqual(triggerNames(restored), every);
      const logged = restored.db.prepare("SELECT event_by, event_detail FROM event WHERE event_kind = 'guards'").all();
      assert.deepEqual(logged.map((row) => [row.event_by, JSON.parse(row.event_detail)]), [['board', { missing: ['machine_proof_verified'], changed: ['machine_item_move'], stale: [] }]]);
      assert.throws(() => lab.raw().prepare("UPDATE item SET item_status = 'verified' WHERE item_id = ?").run(id), /UNDECLARED_MOVE/);
    } finally {
      store.closeBoard(restored);
    }
  } finally {
    lab.done();
  }
});

test('the triggers come from the declaration, so a changed declaration changes them [M1, M3]', () => {
  const moveSql = (machine) => storeTriggers(machine).find(({ name }) => name === 'machine_item_move').sql;
  const pairs = MACHINE.moves.flatMap((move) => move.from.filter((from) => from !== move.to).map((from) => `'${from}>${move.to}'`));
  for (const pair of pairs) assert.ok(moveSql(MACHINE).includes(pair), `the move trigger allows ${pair}`);
  assert.ok(!moveSql(MACHINE).includes("'open>submitted'"));
  const machine = copy();
  machine.moves.push({ verb: 'land', from: ['open'], to: 'submitted', by: ['coordinator'], refuse: 'CLOSED', guards: ['joined', 'coordinatorOnly', 'itemExists', IN_STATE], sets: ['item_built_by', 'item_commit', 'item_frozen_digest'] });
  assert.ok(moveSql(machine).includes("'open>submitted'"));
  const names = storeTriggers().map(({ name }) => name);
  for (const state of MACHINE.states.filter((entry) => entry.requires.length)) assert.ok(names.includes(`machine_fields_${state.id}`), `${state.id} has a fields trigger`);
  assert.ok(names.includes('machine_proof_verified'));
});

test("a verified item's proof cannot be rewritten afterwards: its commit, builder, verifier or criterion [M3]", () => {
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

test('a field a state needs cannot be blanked, on the way in or while the item stays, with any whitespace [M3]', () => {
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

test("a blank field in the board file is exactly what JavaScript's trim removes [M3]", () => {
  const trimmed = [];
  for (let code = 0; code <= 0xffff; code += 1) if (String.fromCharCode(code).trim() === '') trimmed.push(code);
  assert.deepEqual(BLANKS, trimmed);
});
