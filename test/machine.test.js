/**
 * The item lifecycle's declaration (M1, M2, M4): sound on its own terms, each property shown
 * failing on a broken copy, and in step with the refusals the board, CLI and spec parser raise today.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { HELP } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { Refused } from '../src/refused.js';
import { BLANKS, IN_STATE, MACHINE, effectiveGuards, lifecycleHelp, lifecycleMarkdown, machineProblems, storeTriggers } from '../src/machine.js';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Refusals that are not about an item's lifecycle, so no move declares them: command input, caller
 * registration and machine-wide settings are checked before any item move.
 */
const NOT_MOVES = {
  USAGE: 'how a command was typed',
  NO_FILE: 'how a command was typed: a --note-file that does not exist',
  ALREADY_JOINED: 'registering who is asking, before any move',
  BAD_ROUTE: 'registering who is asking, before any move',
  ONE_COORDINATOR: 'registering who is asking, before any move',
  BAD_MACHINE_SETTINGS: 'machine-wide settings checked before a command runs',
  BAD_GATE_SLOTS: 'machine-wide gate capacity checked before a command runs',
  NO_AGENT: 'a linked coordinator must already be registered before an item move',
  EVENT_LOG_VERSION: 'the local board format is checked before opening it for an item move',
};

/**
 * Where each move starts in the code. Accept and reject share the board's verify and the CLI's, so
 * they answer for its refusals together.
 */
const ENTRY_POINTS = [
  { verbs: ['claim'], at: ['board.js#claim'] },
  { verbs: ['release'], at: ['board.js#release'] },
  { verbs: ['submit'], at: ['board.js#submit', 'cli.js#submitHere'] },
  { verbs: ['reserve'], at: ['board.js#reserveReview', 'board.js#reserveNextReview'] },
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

/**
 * Encrypted transport authenticates/orders a move; its board operation is walked separately above.
 * Keep walking the CLI dispatcher itself so a new item rule there cannot hide behind this boundary.
 */
const TRANSPORT_BOUNDARIES = new Set(['relay.js#relayLinked', 'relay.js#relayOperation']);

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
    if (seen.has(key) || skip.has(key) || TRANSPORT_BOUNDARIES.has(key)) return new Set();
    seen.add(key);
    const [file, name] = key.split('#');
    const { bodies, named, spaces } = load(file);
    const body = bodies.get(name) ?? '';
    const codes = new Set([...body.matchAll(/new Refused\(\s*(['"])([A-Z][A-Z0-9_]*)\1/g)].map((match) => match[2]));
    const callees = [
      ...[...body.matchAll(/(?<!\w)(?<!(?<!\.\.)\.)(\w+)\(/g)].map(([, callee]) => (bodies.has(callee) ? `${file}#${callee}` : named.get(callee) ?? CALLBACKS[file]?.[callee])),
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
    ...machine.guards.filter((guard) => !verbs || used.has(guard.id)).flatMap((guard) => [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)]),
    ...moves.map((move) => move.refuse),
    machine.unknownMove.refuse,
  ].filter(Boolean));
}

/**
 * Where a declaration and the code disagree: a refusal a move raises today that the move does not
 * declare, or a code the declaration names that the board, CLI and spec parser never raise.
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
  const raised = new Set(['board.js', 'cli.js', 'spec.js'].flatMap((file) => walk.functions(file).flatMap((name) => [...walk.refusalsOf(`${file}#${name}`)])));
  for (const code of declaredCodes(machine)) if (!raised.has(code)) problems.add(`${code} is declared but the board, CLI and spec parser never raise it`);
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
  assert.deepEqual(MACHINE.moves.map((move) => move.verb), ['claim', 'release', 'lapse', 'submit', 'reserve', 'accept', 'reject', 'escalate', 'refreeze', 'withdraw']);
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
  assert.ok(walk.refusalsOf('board.js#claim').has('A5_GRAMMAR_VERSION'), 'grammar declarations can stop a claim with their own code');
  assert.ok(walk.refusalsOf('board.js#refreeze').has('A5_GRAMMAR_VERSION'), 'and stop a refreeze too');
  assert.ok(walk.refusalsOf('cli.js#submitHere').has('UNKNOWN_SPEC'), 'submit calls the freezer too');
  assert.ok(!walk.refusalsOf('cli.js#submitHere', new Set(CAUGHT['cli.js#submitHere'])).has('UNKNOWN_SPEC'), 'and catches what it raises');
  assert.ok(walk.refusalsOf('cli.js#freezer').has('A5_GRAMMAR_VERSION'), 'the freezer propagates an unsupported grammar version');
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
    'A5_GRAMMAR_VERSION is raised by claim but not declared there',
    'A5_GRAMMAR_VERSION is raised by refreeze but not declared there',
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
  assert.deepEqual(codeProblems(invented), ['WRONG_MOON is declared but the board, CLI and spec parser never raise it']);
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
    'NO_ROUTE is raised by reserve but not declared there',
  ], 'reserve reaches the route check through the reviewer checks it shares with a verdict');

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
 * @param {{ now: () => Date }} [clock] - The board's clock; the system's when left out.
 * @returns {{ file: string, board: any, raw: () => DatabaseSync, done: () => void }}
 */
function boardOnDisk(clock) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-machine-'));
  const file = join(dir, 'board.sqlite');
  const board = store.openBoard(file, clock);
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

const BIN = join(import.meta.dirname, '..', 'bin', 'pullboard.js');

test('docs/lifecycle.md is the page the declaration generates, so a stale copy fails [M1, P4]', () => {
  const page = lifecycleMarkdown();
  const committed = readFileSync(new URL('../docs/lifecycle.md', import.meta.url), 'utf8');
  assert.equal(committed, page, 'docs/lifecycle.md is stale; regenerate it: node bin/pullboard.js lifecycle > docs/lifecycle.md');
  assert.match(page, /```mermaid\nstateDiagram-v2\n {2}\[\*\] --> open\n/);
  for (const state of MACHINE.states) assert.match(page, new RegExp(`^\\| ${state.id}( \\(final\\))? \\|`, 'm'), `${state.id} has a row`);
  for (const move of MACHINE.moves) {
    assert.match(page, new RegExp(`^\\| ${move.verb} \\| ${move.from.join(', ')} \\| ${move.to} \\|`, 'm'), `${move.verb} has a row`);
    for (const from of move.from) assert.ok(page.includes(`  ${from} --> ${move.to}: ${move.verb}`), `the diagram draws ${move.verb} from ${from}`);
    for (const id of effectiveGuards(move)) assert.ok(page.includes(id), `${move.verb}'s guard ${id} is listed`);
  }
  for (const [state, guards] of Object.entries(MACHINE.exitGuards)) assert.ok(page.includes(`| ${state} | ${guards.join(', ')} |`), `${state}'s exit guards are listed`);
  const codes = new Set([...MACHINE.guards.flatMap((guard) => [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)]), ...MACHINE.moves.map((move) => move.refuse), MACHINE.unknownMove.refuse].filter(Boolean));
  for (const code of codes) assert.match(page, new RegExp(`^\\| ${code} \\|`, 'm'), `${code} is in the refusal table`);
});

test('the lifecycle page limits family matching to require and explains unknown families [O2, O3]', () => {
  const page = lifecycleMarkdown();
  assert.match(page, /^\| O2_FAMILY_MATCH \| the builder and verifier have different declared families; an undeclared family counts as a match, only when verify\.family is require \| ask the coordinator for a verifier from another declared family \|$/m);
  for (const verb of ['reserve', 'accept', 'reject']) {
    assert.match(page, new RegExp(`^\\| ${verb} \\| .*familyAllows \\(O2_FAMILY_MATCH\\)`, 'm'));
  }
});

test('the page and the help follow the declaration: a new move appears in both [M1, P4]', () => {
  const machine = copy();
  machine.moves.push({ verb: 'shelve', from: ['open'], to: 'withdrawn', by: ['coordinator'], refuse: 'CLOSED', guards: ['joined', 'coordinatorOnly', 'noteGiven', 'itemExists', IN_STATE], sets: ['item_withdrawn_reason'] });
  assert.ok(!lifecycleMarkdown().includes('shelve'));
  assert.ok(lifecycleMarkdown(machine).includes('  open --> withdrawn: shelve'));
  assert.match(lifecycleMarkdown(machine), /^\| shelve \| open \| withdrawn \| coordinator \|/m);
  assert.match(lifecycleHelp(machine), /^ {2}coordinator +.*\bshelve\b/m);
  assert.doesNotMatch(lifecycleHelp(machine), /^ {2}agent +.*\bshelve\b/m);
});

test('pullboard help lists each role\'s moves from the declaration, and pullboard lifecycle prints the page [M1, P4]', () => {
  const help = spawnSync(process.execPath, [BIN, 'help', '--all'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  for (const role of MACHINE.roles) {
    const line = help.stdout.split('\n').find((text) => text.startsWith(`  ${role} `));
    assert.ok(line, `help has a line for ${role}`);
    const listed = line.slice(role.length + 2).split(',').map((part) => part.trim().split(' ')[0]).filter(Boolean);
    assert.deepEqual(listed.sort(), MACHINE.moves.filter((move) => move.by.includes(role)).map((move) => move.verb).sort(), `${role}'s moves`);
  }
  assert.ok(HELP.all.includes(lifecycleHelp()), 'the full help screen carries the generated section, not a typed copy');
  const printed = spawnSync(process.execPath, [BIN, 'lifecycle'], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, lifecycleMarkdown());
});

/** Guards the CLI checks before it asks the board: the board's own order starts after them. */
const CLI_CHECKED = {
  claim: ['joined'],
  submit: ['joined', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'gateConfigured', 'gateGreen', 'treeStillDuringGate'],
  reserve: ['coordinatorSaysAs', 'joined'],
  accept: ['coordinatorSaysAs', 'joined', 'atSubmittedCommit'],
  reject: ['coordinatorSaysAs', 'joined', 'atSubmittedCommit'],
};

/**
 * The refusal codes a move's board-checked guards raise, in the order the declaration checks them.
 *
 * @param {string} verb
 * @returns {string[]}
 */
function declaredBoardOrder(verb) {
  const move = moveOf(MACHINE, verb);
  return effectiveGuards(move)
    .filter((id) => !CLI_CHECKED[verb].includes(id))
    .map((id) => (id === IN_STATE ? move.refuse : MACHINE.guards.find((guard) => guard.id === id).refuse));
}

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

test('claim refuses in the declared order, one failure peeled at a time, on a real board [M1, M2]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
    const strong = store.register(board, { lane: 'web', path: '/repo-web-strong' });
    const claimAs = (id, agentId, lane, freezer = retiredFreeze) => outcome(() => store.claim(board, id, { agentId, lane, leaseMs: 7_200_000, freeze: freezer }));
    const done = submittedItem(board);
    const dependency = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const target = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page', after: [dependency] });
    const spare = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const raw = lab.raw();
    holdByHand(raw, target, 'web-2');
    store.claim(board, spare, { agentId: strong, lane: 'web', leaseMs: 7_200_000, freeze });
    store.claim(board, dependency, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    store.submit(board, dependency, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
    store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'pause' });
    const fired = [claimAs(999, light, 'api'), claimAs(done, light, 'api'), claimAs(target, light, 'api'), claimAs(target, light, 'web'), claimAs(target, strong, 'web')];
    verdictOn(board, dependency, 'web-2', 'ACCEPT');
    fired.push(claimAs(target, strong, 'web'));
    store.release(board, target, 'web-2');
    store.editItem(board, target, { agentId: 'coordinator', criterion: 'A new bar, so the next claim freezes it.' });
    fired.push(claimAs(target, strong, 'web'));
    store.releaseLane(board, 'web', { agentId: 'coordinator' });
    fired.push(claimAs(target, strong, 'web'));
    store.release(board, spare, strong);
    fired.push(claimAs(target, strong, 'web'), claimAs(target, strong, 'web', freeze));
    assert.deepEqual(fired, [...declaredBoardOrder('claim'), 'ok']);
    assert.deepEqual(fired, ['NO_ITEM', 'NOT_CLAIMABLE', 'WRONG_LANE', 'ROUTE', 'BLOCKED', 'HELD', 'LANE_HELD', 'ONE_CLAIM', 'UNKNOWN_SPEC', 'ok']);
  } finally {
    lab.done();
  }
});

test('submit, accept and reject refuse in the declared order, one failure peeled at a time [M1, M2]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
    const submitAs = (id, agentId, commit) => outcome(() => store.submit(board, id, { agentId, commit, tree: 'tree' }));
    const piece = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const submits = [submitAs(999, 'web-1', SHA_A), submitAs(piece, 'web-1', SHA_A)];
    store.claim(board, piece, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    submits.push(submitAs(piece, 'web-2', SHA_A));
    store.submit(board, piece, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
    verdictOn(board, piece, 'web-2', 'REJECT');
    store.claim(board, piece, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'Part', parentId: piece });
    submits.push(submitAs(piece, 'web-1', SHA_A));
    store.withdraw(board, child, { agentId: 'coordinator', reason: 'folded into the parent' });
    submits.push(submitAs(piece, 'web-1', SHA_A), submitAs(piece, 'web-1', SHA_B));
    assert.deepEqual(submits, [...declaredBoardOrder('submit'), 'ok']);

    const other = store.register(board, { lane: 'web', path: '/repo-web-other' });
    for (const verb of ['accept', 'reject']) {
      const decision = verb === 'accept' ? 'ACCEPT' : 'REJECT';
      const built = submittedItem(board);
      const open = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
      store.reserveReview(board, built, { agentId: 'web-2', leaseMs: 3_600_000, policy: 'any' });
      const judge = (id, agentId, fields) =>
        outcome(() => store.verify(board, id, { agentId, decision, head: SHA_A, digest: 'wrong', policy: 'coordinator', note: '', ...fields }));
      const bad = verb === 'accept' ? 'TEST_FAILURE' : 'NOPE';
      const good = verb === 'accept' ? undefined : 'TEST_FAILURE';
      const fired = [
        judge(999, 'web-2', { reason: bad }),
        judge(open, 'web-2', { reason: bad }),
        judge(built, 'web-1', { reason: bad }),
        judge(built, light, { reason: bad }),
        judge(built, 'web-2', { reason: bad }),
        judge(built, other, { reason: bad, policy: 'any', familyPolicy: 'require' }),
        judge(built, other, { reason: bad, policy: 'any' }),
        judge(built, 'web-2', { reason: bad, policy: 'any' }),
        judge(built, 'web-2', { reason: bad, policy: 'any', digest: 'digest:Page' }),
        judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page' }),
        judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page', note: 'reverted the fix; its test went red' }),
      ];
      assert.deepEqual(fired, [...declaredBoardOrder(verb), 'ok'], verb);
    }
  } finally {
    lab.done();
  }
});

test('reserve refuses in the declared order, one failure peeled at a time [V15, M1, M2]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
    const other = store.register(board, { lane: 'web', path: '/repo-web-other' });
    const built = submittedItem(board);
    const open = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const reserveAs = (id, agentId, policy = 'coordinator', familyPolicy = 'off') => outcome(() => store.reserveReview(board, id, { agentId, leaseMs: 3_600_000, policy, familyPolicy }));
    const fired = [reserveAs(999, 'web-2'), reserveAs(open, 'web-2'), reserveAs(built, 'web-1'), reserveAs(built, light), reserveAs(built, 'web-2')];
    store.reserveReview(board, built, { agentId: other, leaseMs: 3_600_000, policy: 'any' });
    fired.push(reserveAs(built, other, 'any', 'require'), reserveAs(built, 'web-2', 'any'), reserveAs(built, other, 'any'));
    assert.deepEqual(fired, [...declaredBoardOrder('reserve'), 'ok']);
    assert.deepEqual(fired, ['NO_ITEM', 'NOT_SUBMITTED', 'SELF_VERIFY', 'ROUTE', 'COORDINATOR_VERIFIES', 'O2_FAMILY_MATCH', 'REVIEW_HELD', 'ok']);
  } finally {
    lab.done();
  }
});

test('a reserved review refuses every other verdict while its lease lives, and only then; a new submission starts free [V15]', () => {
  let at = Date.parse('2026-10-06T12:00:00.000Z');
  const lab = boardOnDisk({ now: () => new Date(at) });
  try {
    const { board } = lab;
    const third = store.register(board, { lane: 'web', path: '/repo-web-3' });
    const id = submittedItem(board);
    const minutes = (count) => {
      at += count * 60_000;
    };
    const reserve = (agentId) => store.reserveReview(board, id, { agentId, leaseMs: 30 * 60_000, policy: 'any' });
    const judge = (agentId, decision) =>
      outcome(() =>
        store.verify(board, id, {
          agentId,
          decision,
          reason: decision === 'REJECT' ? 'TEST_FAILURE' : undefined,
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
    store.submit(board, id, { agentId: 'web-1', commit: SHA_B, tree: 'tree' });
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
  } finally {
    lab.done();
  }
});

test('next --verify reserves the review for the reviewLease and says until when; show names the holder; another verifier is passed over and refused [V15]', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-reserve-')));
  try {
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Test Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
      PULLBOARD_HOME: join(dir, 'home'),
    };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    // A command that never returns fails the test after a minute instead of holding the gate open.
    const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', reviewLease: '45m', lanes: { web: { owns: ['web/'] } } }));
    writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It greets. | gate: test\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'chore: a spec');
    const [builder, holder, other] = ['web-1', 'web-2', 'web-3'].map((name) => {
      const path = join(dir, name);
      git(repo, 'worktree', 'add', '-q', '--detach', path);
      const joined = run(path, 'join', 'web');
      assert.match(joined.stdout, new RegExp(`joined as ${name}`), joined.stderr);
      return path;
    });
    const added = run(repo, 'add', 'web', 'Greet', '--specs', 'G1', '--criterion', 'It greets.');
    assert.equal(added.status, 0, added.stderr);
    assert.equal(run(builder, 'claim', '1').status, 0);
    mkdirSync(join(builder, 'web'));
    writeFileSync(join(builder, 'web', 'greet.txt'), 'hello\n');
    git(builder, 'add', '-A');
    git(builder, 'commit', '-q', '-m', 'feat(web): greet [G1]');
    const commit = git(builder, 'rev-parse', 'HEAD');
    const submitted = run(builder, 'submit', '1');
    assert.equal(submitted.status, 0, submitted.stderr);

    const before = Date.now();
    const first = run(holder, 'next', '--verify');
    const after = Date.now();
    assert.equal(first.status, 0, first.stderr);
    const until = /reserved for you until (\S+): another agent's verdict on it is refused until then/.exec(first.stdout)?.[1];
    assert.ok(until, first.stdout);
    const lease = 45 * 60_000;
    assert.ok(Date.parse(until) >= before + lease && Date.parse(until) <= after + lease, `${until} is 45 minutes on, the repo's reviewLease`);
    assert.ok(run(repo, 'show', '1').stdout.includes(`under review by web-2 until ${until}`), 'show names the holder and the time');

    const passed = run(other, 'next', '--verify');
    assert.equal(passed.status, 1, passed.stdout);
    assert.match(passed.stderr, /NOTHING_FREE/);
    assert.ok(passed.stderr.includes(`web-2 holds the review of #1 until ${until}`), passed.stderr);
    git(other, 'switch', '-q', '--detach', commit);
    const refused = run(other, 'verify', '1', 'accept', '--note', 'it greets');
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /REVIEW_HELD/);
    assert.ok(refused.stderr.includes(`web-2 holds the review of #1 until ${until}`), refused.stderr);

    const renewed = run(holder, 'next', '--verify');
    const again = /reserved for you until (\S+):/.exec(renewed.stdout)?.[1];
    assert.ok(again && Date.parse(again) > Date.parse(until), `running next --verify again renews the lease: ${renewed.stdout}${renewed.stderr}`);
    git(holder, 'switch', '-q', '--detach', commit);
    const accepted = run(holder, 'verify', '1', 'accept', '--note', 'checked out the commit; web/greet.txt says hello');
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('next --verify looks and reserves in one transaction, so no other verifier takes the review in between [V15]', () => {
  const lab = boardOnDisk();
  const others = [];
  try {
    const id = submittedItem(lab.board);
    const third = store.register(lab.board, { lane: 'web', path: '/repo-web-3' });
    const fourth = store.register(lab.board, { lane: 'web', path: '/repo-web-4' });
    // A reservation that has already lapsed, so the look has a lease to read the clock for.
    store.reserveReview(lab.board, id, { agentId: fourth, leaseMs: 1, policy: 'any' });
    const rival = store.openBoard(lab.file);
    rival.db.exec('PRAGMA busy_timeout = 0');
    let armed = false;
    let rivalSaw = null;
    // web-2's own connection. Its clock runs a minute ahead, so the lapsed lease is plainly lapsed,
    // and the first time the look reads it, a rival verifier on another connection tries to
    // reserve the same review.
    const looking = store.openBoard(lab.file, {
      now: () => {
        if (armed && rivalSaw === null) {
          try {
            store.reserveReview(rival, id, { agentId: third, leaseMs: 60_000, policy: 'any' });
            rivalSaw = 'reserved';
          } catch (error) {
            rivalSaw = error.message;
          }
        }
        return new Date(Date.now() + 60_000);
      },
    });
    others.push(rival, looking);
    armed = true;
    const found = store.reserveNextReview(looking, { agentId: 'web-2', lane: 'web', leaseMs: 60_000, policy: 'any' });
    assert.equal(found.item?.item_review_by, 'web-2');
    assert.ok(rivalSaw !== null, 'the look read the clock, so the rival had its chance mid-look');
    assert.match(rivalSaw, /locked/, 'the rival could not write while the look held the board');
  } finally {
    for (const board of others) store.closeBoard(board);
    lab.done();
  }
});

test('the review lease is reviewLease in pullboard.json, 30 minutes unless the repo says otherwise [V15]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-review-lease-'));
  try {
    const leaseOf = (config) => {
      writeFileSync(join(dir, 'pullboard.json'), JSON.stringify({ gate: 'true', ...config }));
      return loadConfig(dir).reviewLeaseMs;
    };
    assert.equal(leaseOf({}), 30 * 60_000);
    assert.equal(leaseOf({ reviewLease: '2h' }), 2 * 3_600_000);
    assert.throws(() => leaseOf({ reviewLease: 'soon' }), { code: 'BAD_CONFIG', message: /reviewLease "soon" is not a duration/ });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lifecycle page and the help show the reservation: reserve, and reviewFree on every verdict [V15, M1]', () => {
  const page = lifecycleMarkdown();
  assert.match(page, /^\| reserve \| submitted \| submitted \| agent, coordinator \| .*reviewFree \(REVIEW_HELD\) \|$/m);
  for (const verb of ['accept', 'reject']) assert.match(page, new RegExp(`^\\| ${verb} \\| submitted \\| .*policyAllows \\(COORDINATOR_VERIFIES\\), familyAllows \\(O2_FAMILY_MATCH\\), reviewFree \\(REVIEW_HELD\\), criterionUnchanged`, 'm'));
  assert.match(page, /^\| REVIEW_HELD \| no other agent holds its review under a live lease \| pullboard next --verify/m);
  assert.match(HELP.all, /^ {2}agent +claim, release, submit, reserve, accept, reject, escalate$/m);
  assert.match(HELP.all, /pullboard next --verify +reserve the next submitted item you can check/);
});

test('the two conditional guards behave as declared: a renewal passes a held lane, and only a freeze checks the rows [M1, M2]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const claimAs = (id, agentId, freezer) => outcome(() => store.claim(board, id, { agentId, lane: 'web', leaseMs: 7_200_000, freeze: freezer }));
    assert.match(MACHINE.guards.find((guard) => guard.id === 'laneOpen').when, /renewing its own live claim/);
    assert.match(MACHINE.guards.find((guard) => guard.id === 'rowsInForce').when, /where the criterion freezes/);

    const mine = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const theirs = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    assert.equal(claimAs(mine, 'web-1', freeze), 'ok');
    store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'pause' });
    assert.equal(claimAs(mine, 'web-1', freeze), 'ok', 'its holder renews a live claim in a held lane');
    assert.equal(claimAs(theirs, 'web-2', freeze), 'LANE_HELD', 'a fresh claim in the held lane is refused');
    store.releaseLane(board, 'web', { agentId: 'coordinator' });

    assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'ok', 'a renewal keeps the frozen bar and checks no rows');
    store.release(board, mine, 'web-1');
    assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'ok', 'a reclaim keeps the frozen bar too');
    assert.equal(claimAs(theirs, 'web-2', retiredFreeze), 'UNKNOWN_SPEC', 'a first claim freezes, so it checks the rows');
    store.release(board, mine, 'web-1');
    store.editItem(board, mine, { agentId: 'coordinator', criterion: 'A changed bar.' });
    assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'UNKNOWN_SPEC', 'after an edit drops the bar, the next claim freezes and checks');
    assert.equal(outcome(() => store.refreeze(board, mine, { agentId: 'coordinator', freeze: retiredFreeze })), 'UNKNOWN_SPEC', 'refreeze freezes, so it checks');
  } finally {
    lab.done();
  }
});

/**
 * Every place in src/ that could write an item's status outside moveItem, found in the source: an
 * item_status key, quoted or computed from a literal, or any statement that updates or replaces
 * item rows, in either case. This backs up the runtime guard, which refuses such a write on every
 * path a test runs, for the paths no test reaches. Allowed: moveItem; setItem, the generic update
 * moveItem writes through, which the guard watches; and current(), which builds the reader's view
 * of a lapsed claim and never writes; and JSON_SHAPES, whose keys describe output fields.
 *
 * @param {(file: string) => string} read
 * @returns {string[]}
 */
function statusWriters(read) {
  const writers = [];
  for (const file of readdirSync(new URL('../src/', import.meta.url)).filter((name) => name.endsWith('.js'))) {
    const source = read(file);
    const allowed = file === 'board.js' ? ['moveItem', 'setItem', 'current'].map((name) => functionsIn(source).get(name)) : [];
    const spans = allowed.filter(Boolean).map((body) => [source.indexOf(body), source.indexOf(body) + body.length]);
    if (file === 'json.js') {
      const catalog = /^export const JSON_SHAPES = \{[\s\S]*?^\};/m.exec(source);
      if (catalog) spans.push([catalog.index, catalog.index + catalog[0].length]);
    }
    for (const match of source.matchAll(/(?:\[\s*)?(['"`]?)item_status\1(?:\s*\])?\s*:|\b(?:update|replace\s+into|insert\s+or\s+replace\s+into)\s+(?:main\.)?item\b/gi)) {
      if (!spans.some(([start, end]) => match.index >= start && match.index < end)) {
        const before = source.slice(0, match.index);
        const owner = [...functionsIn(source).entries()].find(([, body]) => source.indexOf(body) <= match.index && match.index < source.indexOf(body) + body.length);
        writers.push(`${file}#${owner ? owner[0] : `line ${before.split('\n').length}`}`);
      }
    }
  }
  return writers;
}

test('only moveItem writes an item\'s status, and a write anywhere else fails the check [M1]', () => {
  assert.deepEqual(statusWriters(fromDisk), []);
  assert.match(functionsIn(fromDisk('board.js')).get('moveItem'), /item_status: move\.to/, 'moveItem is the writer');
  const planted = editedSource('board.js', /set: \(found\) => \(\{ item_route: nextRoute\(found\.item_route\), item_owner: null, item_lease_until: null \}\),/, "set: (found) => ({ item_route: nextRoute(found.item_route), item_status: 'open', item_owner: null, item_lease_until: null }),");
  assert.deepEqual(statusWriters(planted), ['board.js#escalate']);
  const lowercase = editedSource('board.js', /^export function recordAttempt/m, "export function reopenByHand(board, id) {\n  board.db.prepare(\"update item set item_status = 'open' where item_id = ?\").run(id);\n}\n\nexport function recordAttempt");
  assert.deepEqual(statusWriters(lowercase), ['board.js#reopenByHand']);
  const computed = editedSource('board.js', /^export function recordAttempt/m, "export function reopenByKey(board, id) {\n  setItem(board, id, { ['item_status']: 'open' });\n}\n\nexport function recordAttempt");
  assert.deepEqual(statusWriters(computed), ['board.js#reopenByKey']);
  const besideCatalog = editedSource('json.js', /^export function commandOutput/m, "export function reopenByKey(board, id) {\n  setItem(board, id, { ['item_status']: 'open' });\n}\n\nexport function commandOutput");
  assert.deepEqual(statusWriters(besideCatalog), ['json.js#reopenByKey'], 'the output catalog exemption never covers a writer beside it');
});

test('the board refuses a status written outside moveItem at run time, however it is spelled [M1]', () => {
  const lab = boardOnDisk();
  try {
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
    store.release(board, id, 'web-1');
    assert.equal(store.getItem(board, id).item_status, 'open', 'a move through moveItem still writes');
  } finally {
    lab.done();
  }
});

test('a helper added to the board that changes a status outside moveItem is refused when it runs [M1]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-planted-'));
  try {
    for (const file of readdirSync(new URL('../src/', import.meta.url)).filter((name) => name.endsWith('.js'))) {
      const source = fromDisk(file);
      writeFileSync(join(dir, file), file === 'board.js' ? `${source}\nexport function reopenByHand(board, id) {\n  board.db.prepare("update item set item_status = 'open', item_owner = null, item_lease_until = null where item_id = ?").run(id);\n}\n` : source);
    }
    const copy = await import(pathToFileURL(join(dir, 'board.js')).href);
    const board = copy.openBoard(':memory:');
    copy.register(board, { lane: 'coordinator', path: '/repo' });
    copy.register(board, { lane: 'web', path: '/repo-web-1' });
    const id = copy.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    copy.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    assert.throws(() => copy.reopenByHand(board, id), /STATUS_OUTSIDE_MOVE/);
    assert.equal(copy.getItem(board, id).item_status, 'claimed');
    copy.closeBoard(board);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('transport boundaries keep a new item refusal in ordered dispatch visible [M1,M4,H16]', () => {
  const inDispatch = editedSource('cli.js', /^async function ordered\(ctx, board, operation, args\) \{$/m,
    "$&\n  if (args[0] === 999) throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(MACHINE, inDispatch).sort(), [
    'MOON_PHASE is raised by accept and reject but not declared there',
    'MOON_PHASE is raised by submit but not declared there',
  ], 'transport authentication is separate but a dispatcher item guard still belongs to the lifecycle');
});
