/**
 * The item lifecycle's declaration (M1, M2, M4): sound on its own terms, each property shown
 * failing on a broken copy, and in step with the refusals board.js and cli.js raise today.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IN_STATE, MACHINE, effectiveGuards, machineProblems } from '../src/machine.js';

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

/** Where each move starts in the code: the board's functions, and the CLI's submit and verify. */
const ENTRY_POINTS = [
  ['board.js', 'claim'],
  ['board.js', 'release'],
  ['board.js', 'submit'],
  ['board.js', 'verify'],
  ['board.js', 'escalate'],
  ['board.js', 'withdraw'],
  ['board.js', 'refreeze'],
  ['cli.js', 'submitHere'],
  ['cli.js', 'verifyHere'],
];

const parsed = new Map();

/**
 * A source file's top-level functions by name, and what it imports from this package.
 *
 * @param {string} file - A file in src/.
 * @returns {{ bodies: Map<string, string>, named: Map<string, [string, string]>, spaces: Map<string, string> }}
 */
function parse(file) {
  if (parsed.has(file)) return parsed.get(file);
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const bodies = new Map();
  let name = null;
  let lines = [];
  for (const line of source.split('\n')) {
    const start = /^(?:export )?(?:async )?function (\w+)\(/.exec(line);
    if (start) {
      if (name !== null) bodies.set(name, lines.join('\n'));
      [name, lines] = [start[1], []];
    }
    if (name === null) continue;
    lines.push(line);
    if (line === '}') {
      bodies.set(name, lines.join('\n'));
      name = null;
    }
  }
  const named = new Map();
  for (const [, names, from] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+\.js)'/g)) {
    for (const part of names.split(',').map((text) => text.trim()).filter(Boolean)) {
      const [original, local = original] = part.split(/\s+as\s+/);
      named.set(local, [from, original]);
    }
  }
  const spaces = new Map([...source.matchAll(/import \* as (\w+) from '\.\/([\w-]+\.js)'/g)].map(([, space, from]) => [space, from]));
  const result = { bodies, named, spaces };
  parsed.set(file, result);
  return result;
}

/**
 * Every refusal code a function raises, itself or through the functions of this package it calls.
 *
 * @param {string} file
 * @param {string} name
 * @param {Set<string>} [seen]
 * @returns {Set<string>}
 */
function refusalsOf(file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return new Set();
  seen.add(key);
  const { bodies, named, spaces } = parse(file);
  const body = bodies.get(name) ?? '';
  const codes = new Set([...body.matchAll(/new Refused\(\s*'([A-Z_]+)'/g)].map((match) => match[1]));
  for (const [, callee] of body.matchAll(/(?<![.\w])(\w+)\(/g)) {
    const target = bodies.has(callee) ? [file, callee] : named.get(callee);
    if (target) for (const code of refusalsOf(target[0], target[1], seen)) codes.add(code);
  }
  for (const [, space, callee] of body.matchAll(/\b(\w+)\.(\w+)\(/g)) {
    if (spaces.has(space)) for (const code of refusalsOf(spaces.get(space), callee, seen)) codes.add(code);
  }
  return codes;
}

/**
 * Every refusal code a declaration names: its guards', its moves' wrong-state codes, and the
 * unknown move's.
 *
 * @param {any} machine
 * @returns {Set<string>}
 */
function declaredCodes(machine) {
  return new Set([
    ...machine.guards.map((guard) => guard.refuse),
    ...machine.moves.map((move) => move.refuse),
    machine.unknownMove.refuse,
  ].filter(Boolean));
}

/** Every code board.js and cli.js raise, directly or through the functions they call. */
const raisedAnywhere = new Set(['board.js', 'cli.js'].flatMap((file) => [...parse(file).bodies.keys()].flatMap((name) => [...refusalsOf(file, name)])));

/** Every code the lifecycle's moves raise, starting where each move starts in the code. */
const raisedByMoves = new Set(ENTRY_POINTS.flatMap(([file, name]) => [...refusalsOf(file, name)]));

/**
 * Where a declaration and the code disagree: a code the moves raise that it does not declare,
 * or a code it declares that the code never raises.
 *
 * @param {any} machine
 * @returns {string[]}
 */
function codeProblems(machine) {
  const declared = declaredCodes(machine);
  return [
    ...[...raisedByMoves].filter((code) => !declared.has(code) && !(code in NOT_MOVES)).map((code) => `${code} is raised by a move but not declared`),
    ...[...declared].filter((code) => !raisedAnywhere.has(code)).map((code) => `${code} is declared but board.js and cli.js never raise it`),
  ];
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

test('the declaration names every refusal the moves raise today, and only codes the code raises [M1]', () => {
  assert.deepEqual(codeProblems(MACHINE), []);
  for (const code of ['NOT_CLAIMABLE', 'LANE_HELD', 'GATE_RED', 'NO_GATE', 'NOT_AT_COMMIT', 'SELF_VERIFY', 'BAD_DECISION']) {
    assert.ok(raisedByMoves.has(code), `the code walk finds ${code}`);
  }
  for (const code of Object.keys(NOT_MOVES)) assert.ok(raisedByMoves.has(code), `${code} is listed as not a move because a move's code path raises it`);
});

test('a broken copy fails the check against the code, both ways [M1, M4]', () => {
  const missing = copy();
  missing.guards = missing.guards.filter((guard) => guard.id !== 'laneOpen');
  for (const move of missing.moves) move.guards = move.guards.filter((id) => id !== 'laneOpen');
  assert.deepEqual(codeProblems(missing), ['LANE_HELD is raised by a move but not declared']);

  const invented = copy();
  invented.guards.push({ id: 'moonPhase', refuse: 'WRONG_MOON', rule: 'the moon is full', next: 'wait', source: 'board' });
  moveOf(invented, 'claim').guards.push('moonPhase');
  assert.deepEqual(codeProblems(invented), ['WRONG_MOON is declared but board.js and cli.js never raise it']);
});
