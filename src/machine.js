/**
 * The item lifecycle, declared once (M1).
 *
 * Every state an item can be in, every move between states, who may make it, and the guards it
 * must pass in the order they are checked, each guard with the refusal it raises and the step that
 * gets past it. Final states carry exit guards that every move into them must name (M2), so no
 * command can become a second way into verified or withdrawn. `machineProblems` proves the
 * declaration's properties (M4); test/machine.test.js runs it, shows each property failing on a
 * broken copy, and checks the declaration against the refusals board.js and cli.js raise today.
 */

/** @typedef {'agent' | 'coordinator' | 'clock'} Role */

/**
 * @typedef {object} Guard
 * @property {string} id - How moves name it.
 * @property {string} refuse - The refusal code it raises when it does not hold.
 * @property {string} rule - What must hold, in words.
 * @property {string} next - The step that gets past it.
 * @property {'board' | 'cli'} source - Where its fact comes from: the board file, or the CLI's look at git and the worktree.
 */

/**
 * @typedef {object} State
 * @property {string} id
 * @property {string} means
 * @property {boolean} [final] - Nothing leaves it.
 * @property {string[]} requires - Item fields that are set whenever an item is in this state.
 */

/**
 * @typedef {object} Move
 * @property {string} verb
 * @property {string[]} from - The states it starts from.
 * @property {string} to
 * @property {Role[]} by - Who may make it.
 * @property {string[]} guards - Checked in this order. IN_STATE marks where the item's state is checked.
 * @property {string} [refuse] - The code raised when the item is in none of `from`.
 * @property {string[]} [sets] - The fields it sets.
 * @property {string} [command] - The command that makes it.
 * @property {string} [when] - For the clock's move: when it happens.
 */

/**
 * @typedef {object} Machine
 * @property {Role[]} roles
 * @property {State[]} states
 * @property {Guard[]} guards
 * @property {Move[]} moves
 * @property {Record<string, string[]>} exitGuards - Per final state, the guards every move into it names.
 * @property {{ refuse: string, rule: string, next: string }} unknownMove - The refusal for a move that does not exist.
 */

/** The guard id that marks where a move checks the item's state; its code is the move's own. */
export const IN_STATE = 'inState';

/** @type {Role[]} */
export const ROLES = ['agent', 'coordinator', 'clock'];

/** @type {State[]} */
export const STATES = [
  { id: 'open', means: 'waiting for a builder; claimable once what it waits on is verified', requires: [] },
  { id: 'claimed', means: 'an agent holds it under a lease, its criterion frozen', requires: ['item_owner', 'item_lease_until', 'item_frozen_digest'] },
  { id: 'submitted', means: 'built and gated green at a pinned commit, waiting for another agent', requires: ['item_built_by', 'item_commit', 'item_frozen_digest'] },
  { id: 'verified', final: true, means: 'another agent accepted it at the submitted commit', requires: ['item_verified_by', 'item_commit'] },
  { id: 'withdrawn', final: true, means: 'nobody should build it; the reason stays on it', requires: ['item_withdrawn_reason'] },
];

/** @type {Guard[]} */
export const GUARDS = [
  { id: IN_STATE, refuse: '', rule: "the move can start from the item's current state", next: 'pullboard show <id>', source: 'board' },
  { id: 'joined', refuse: 'NOT_JOINED', rule: 'the caller is the main checkout, or a worktree that joined a lane', next: 'pullboard join <lane> (see: pullboard lanes)', source: 'cli' },
  { id: 'itemExists', refuse: 'NO_ITEM', rule: 'the item exists', next: 'pullboard list --all', source: 'board' },
  { id: 'coordinatorOnly', refuse: 'COORDINATOR_ONLY', rule: 'the caller is the coordinator', next: 'run it from the main checkout', source: 'board' },
  { id: 'coordinatorSaysAs', refuse: 'MAIN_IS_COORDINATOR', rule: 'in the main checkout, the caller says it is the coordinator', next: 'verify from your own worktree; the coordinator adds --as coordinator', source: 'cli' },
  { id: 'holderOrCoordinator', refuse: 'NOT_YOURS', rule: 'the caller holds the item, or is the coordinator', next: 'shout its holder, or the coordinator', source: 'board' },
  { id: 'isHolder', refuse: 'NOT_YOURS', rule: 'the caller holds the claim', next: 'pullboard claim <id>', source: 'board' },
  { id: 'inLane', refuse: 'WRONG_LANE', rule: "the item is in the caller's lane; the main checkout builds coordinator-lane items only", next: "cd <the lane's worktree> && pullboard claim <id>", source: 'board' },
  { id: 'routeAllows', refuse: 'ROUTE', rule: "the caller's route covers the item's: light, then mid, then strong", next: 'pullboard next, which offers only items your route covers', source: 'board' },
  { id: 'dependenciesVerified', refuse: 'BLOCKED', rule: 'every item it waits on is verified', next: 'claim another item, or shout the lane it waits on', source: 'board' },
  { id: 'notHeldByAnother', refuse: 'HELD', rule: 'no other agent holds it under a live lease', next: 'pullboard next', source: 'board' },
  { id: 'laneOpen', refuse: 'LANE_HELD', rule: 'nobody holds its lane', next: 'pullboard next --wait 9 (minutes)', source: 'board' },
  { id: 'oneLiveClaim', refuse: 'ONE_CLAIM', rule: 'the caller holds no other live top-level claim, reworks of its own rejected items aside', next: 'submit or release the other item first; child items are free', source: 'board' },
  { id: 'rowsInForce', refuse: 'UNKNOWN_SPEC', rule: 'every row the item cites exists and is in force', next: 'fix the spec, or the coordinator withdraws the item', source: 'board' },
  { id: 'criterionUnchanged', refuse: 'CRITERIA_CHANGED', rule: 'the criterion and the rows it cites read as they did at claim', next: 'the coordinator runs pullboard refreeze <id>', source: 'cli' },
  { id: 'treeClean', refuse: 'DIRTY', rule: 'the worktree has no uncommitted changes', next: 'commit your changes, then submit', source: 'cli' },
  { id: 'nothingUntracked', refuse: 'UNTRACKED', rule: 'the worktree has no untracked files', next: 'commit or ignore them, then submit', source: 'cli' },
  { id: 'hasCommit', refuse: 'NO_COMMIT', rule: 'there is a commit to submit', next: 'commit your work, then submit', source: 'cli' },
  { id: 'gateConfigured', refuse: 'NO_GATE', rule: 'the repo names a gate command', next: 'set "gate" in pullboard.json, e.g. "npm test"', source: 'cli' },
  { id: 'gateGreen', refuse: 'GATE_RED', rule: 'the gate is green at HEAD', next: 'fix what the digest names, commit, submit again', source: 'cli' },
  { id: 'childrenDone', refuse: 'CHILDREN_OPEN', rule: 'every child item is verified or withdrawn', next: 'finish the child items, or the coordinator withdraws them', source: 'board' },
  { id: 'headIsNew', refuse: 'HEAD_NOT_NEW', rule: 'a verifier has not already rejected this commit', next: 'commit the rework, then submit', source: 'board' },
  { id: 'atSubmittedCommit', refuse: 'NOT_AT_COMMIT', rule: "the caller's checkout contains the submitted commit", next: 'git switch --detach <commit>', source: 'cli' },
  { id: 'notBuilder', refuse: 'SELF_VERIFY', rule: 'the caller did not build it', next: 'another agent verifies it: pullboard next --verify', source: 'board' },
  { id: 'policyAllows', refuse: 'COORDINATOR_VERIFIES', rule: "the repo's verify policy lets the caller verify this lane's work", next: 'the coordinator verifies it', source: 'board' },
  { id: 'reasonIsMet', refuse: 'BAD_REASON', rule: 'an accept gives CRITERION_MET as its reason', next: 'a failed criterion is a reject: pullboard verify <id> reject --reason CODE', source: 'board' },
  { id: 'proofNoted', refuse: 'PROOF_REQUIRED', rule: 'an accept notes how it was proved', next: '--note "what you broke or which edge you tried, and what happened"', source: 'board' },
  { id: 'reasonCoded', refuse: 'BAD_REASON', rule: 'a reject names one of the reject reasons', next: '--reason TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD or OTHER', source: 'board' },
  { id: 'noteGiven', refuse: 'NOTE_REQUIRED', rule: 'the move carries a note: what failed, what was tried, or why', next: '--note "..." or --note-file <file>', source: 'board' },
];

/** @type {Move[]} */
export const MOVES = [
  {
    verb: 'claim', from: ['open', 'claimed'], to: 'claimed', by: ['agent', 'coordinator'], refuse: 'NOT_CLAIMABLE',
    guards: ['joined', 'itemExists', IN_STATE, 'inLane', 'routeAllows', 'dependenciesVerified', 'notHeldByAnother', 'laneOpen', 'oneLiveClaim', 'rowsInForce'],
    sets: ['item_owner', 'item_lease_until', 'item_frozen_digest'], command: 'pullboard claim <id>',
  },
  {
    verb: 'release', from: ['claimed'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    guards: ['joined', 'itemExists', IN_STATE, 'isHolder'], command: 'pullboard release <id>',
  },
  { verb: 'lapse', from: ['claimed'], to: 'open', by: ['clock'], guards: [], when: 'its lease runs out' },
  {
    verb: 'submit', from: ['claimed'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    guards: ['joined', 'itemExists', IN_STATE, 'isHolder', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'gateConfigured', 'gateGreen', 'childrenDone', 'headIsNew'],
    sets: ['item_built_by', 'item_commit'], command: 'pullboard submit <id>',
  },
  {
    verb: 'accept', from: ['submitted'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    guards: ['coordinatorSaysAs', 'joined', 'itemExists', IN_STATE, 'atSubmittedCommit', 'notBuilder', 'routeAllows', 'policyAllows', 'criterionUnchanged', 'reasonIsMet', 'proofNoted'],
    sets: ['item_verified_by'], command: 'pullboard verify <id> accept --note "..."',
  },
  {
    verb: 'reject', from: ['submitted'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    guards: ['coordinatorSaysAs', 'joined', 'itemExists', IN_STATE, 'atSubmittedCommit', 'notBuilder', 'routeAllows', 'policyAllows', 'criterionUnchanged', 'reasonCoded', 'noteGiven'],
    command: 'pullboard verify <id> reject --reason CODE --note "..."',
  },
  {
    verb: 'escalate', from: ['open', 'claimed'], to: 'open', by: ['agent', 'coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'noteGiven', 'itemExists', 'holderOrCoordinator', IN_STATE], command: 'pullboard escalate <id> --note "..."',
  },
  {
    verb: 'refreeze', from: ['open', 'claimed', 'submitted'], to: 'open', by: ['coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'coordinatorOnly', 'itemExists', IN_STATE, 'rowsInForce'],
    sets: ['item_frozen_digest'], command: 'pullboard refreeze <id>',
  },
  {
    verb: 'withdraw', from: ['open', 'claimed', 'submitted'], to: 'withdrawn', by: ['coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'coordinatorOnly', 'noteGiven', 'itemExists', IN_STATE],
    sets: ['item_withdrawn_reason'], command: 'pullboard withdraw <id> <reason>',
  },
];

/**
 * What every move into a final state must pass, whatever the command (M2). The interpreter adds
 * any a move leaves out, and `machineProblems` reports the move anyway: a guard nobody can see in
 * a move's list is a guard nobody reviews.
 *
 * @type {Record<string, string[]>}
 */
export const EXIT_GUARDS = {
  verified: ['atSubmittedCommit', 'notBuilder', 'criterionUnchanged', 'proofNoted'],
  withdrawn: ['coordinatorOnly', 'noteGiven'],
};

/** The refusal for a move nobody declared, such as a verdict that is neither accept nor reject. */
export const UNKNOWN_MOVE = { refuse: 'BAD_DECISION', rule: 'a verdict is accept or reject', next: 'pullboard verify <id> accept, or reject --reason CODE --note "..."' };

/** @type {Machine} */
export const MACHINE = { roles: ROLES, states: STATES, guards: GUARDS, moves: MOVES, exitGuards: EXIT_GUARDS, unknownMove: UNKNOWN_MOVE };

/**
 * The guards a move passes, in order: its own, then any exit guard of its target it left out.
 *
 * @param {Move} move
 * @param {Machine} [machine]
 * @returns {string[]}
 */
export function effectiveGuards(move, machine = MACHINE) {
  const exit = machine.exitGuards[move.to] ?? [];
  return [...move.guards, ...exit.filter((id) => !move.guards.includes(id))];
}

/**
 * The states reachable from `start` along `edges`.
 *
 * @param {string} start
 * @param {Map<string, string[]>} edges
 * @returns {Set<string>}
 */
function reach(start, edges) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of edges.get(/** @type {string} */ (queue.shift())) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Property 1: every state, guard and role a move names is declared.
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function unresolved(machine) {
  const states = new Set(machine.states.map((state) => state.id));
  const guards = new Set(machine.guards.map((guard) => guard.id));
  const problems = [];
  for (const move of machine.moves) {
    for (const state of [...move.from, move.to]) if (!states.has(state)) problems.push(`${move.verb}: no state "${state}"`);
    for (const id of move.guards) if (!guards.has(id)) problems.push(`${move.verb}: no guard "${id}"`);
    for (const role of move.by) if (!machine.roles.includes(role)) problems.push(`${move.verb}: no role "${role}"`);
  }
  for (const [state, ids] of Object.entries(machine.exitGuards)) {
    if (!states.has(state)) problems.push(`exit guards for an undeclared state "${state}"`);
    for (const id of ids) if (!guards.has(id)) problems.push(`exit guards of ${state}: no guard "${id}"`);
  }
  return problems;
}

/**
 * Property 2: every state is reachable from open, every non-final state can still reach a final
 * one (no traps), and nothing leaves a final state.
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function unreachable(machine) {
  const forward = new Map();
  const back = new Map();
  for (const move of machine.moves) {
    for (const from of move.from) {
      forward.set(from, [...(forward.get(from) ?? []), move.to]);
      back.set(move.to, [...(back.get(move.to) ?? []), from]);
    }
  }
  const fromOpen = reach('open', forward);
  const canEnd = new Set();
  for (const state of machine.states.filter((entry) => entry.final)) for (const id of reach(state.id, back)) canEnd.add(id);
  const problems = [];
  for (const state of machine.states) {
    if (!fromOpen.has(state.id)) problems.push(`state ${state.id} cannot be reached from open`);
    if (!canEnd.has(state.id)) problems.push(`state ${state.id} is a trap: no way from it to a final state`);
    if (state.final && forward.has(state.id)) problems.push(`final state ${state.id} has a move out`);
  }
  return problems;
}

/**
 * Properties 3 and 4: every final state has exit guards, and every move into it names them all.
 * A move that leaves one out is a second door (M2).
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function secondDoors(machine) {
  const problems = [];
  for (const state of machine.states.filter((entry) => entry.final)) {
    if (!(machine.exitGuards[state.id] ?? []).length) problems.push(`final state ${state.id} has no exit guards`);
  }
  for (const move of machine.moves) {
    for (const id of machine.exitGuards[move.to] ?? []) {
      if (!move.guards.includes(id)) problems.push(`${move.verb} reaches ${move.to} without naming its exit guard ${id}: a second door`);
    }
  }
  return problems;
}

/**
 * Property 5: every guard has a code, a rule and a next step, and some move uses it; every move
 * a caller makes checks the item's state exactly once and has a code for it (P4).
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function unnamedRefusals(machine) {
  const used = new Set([...machine.moves.flatMap((move) => move.guards), ...Object.values(machine.exitGuards).flat()]);
  const problems = [];
  for (const guard of machine.guards) {
    if (guard.id !== IN_STATE && !/^[A-Z][A-Z_]*$/.test(guard.refuse)) problems.push(`guard ${guard.id} names no refusal code`);
    if (!guard.rule.trim()) problems.push(`guard ${guard.id} states no rule`);
    if (!guard.next.trim()) problems.push(`guard ${guard.id} refuses without a next step`);
    if (!used.has(guard.id)) problems.push(`guard ${guard.id} is declared but no move uses it`);
  }
  for (const move of machine.moves.filter((entry) => !entry.by.includes('clock'))) {
    const checks = move.guards.filter((id) => id === IN_STATE).length;
    if (checks !== 1) problems.push(`${move.verb} checks the item's state ${checks} times, not once`);
    if (!/^[A-Z][A-Z_]*$/.test(move.refuse ?? '')) problems.push(`${move.verb} names no code for an item in the wrong state`);
  }
  if (!/^[A-Z][A-Z_]*$/.test(machine.unknownMove.refuse) || !machine.unknownMove.next.trim()) problems.push('the unknown-move refusal has no code or no next step');
  return problems;
}

/**
 * Property 6: who may make a move agrees with its guards. The coordinator's moves name
 * coordinatorOnly, and only they do; the clock's move is the clock's alone and checks nothing a
 * caller could supply.
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function roleMismatches(machine) {
  const problems = [];
  for (const move of machine.moves) {
    const coordinatorOnly = move.by.length === 1 && move.by[0] === 'coordinator';
    if (coordinatorOnly !== move.guards.includes('coordinatorOnly')) {
      problems.push(`${move.verb} is for ${move.by.join(' or ')}, but its guards ${coordinatorOnly ? 'do not name' : 'name'} coordinatorOnly`);
    }
    if (move.by.includes('clock') && (move.by.length !== 1 || move.guards.length)) {
      problems.push(`${move.verb} mixes the clock with callers or guards a caller could supply`);
    }
  }
  return problems;
}

/**
 * Property 7: every move sets each field its target state requires, or comes from states that
 * already require it.
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function missingFields(machine) {
  const requires = new Map(machine.states.map((state) => [state.id, state.requires]));
  const problems = [];
  for (const move of machine.moves) {
    for (const from of move.from) {
      const carried = new Set([...(requires.get(from) ?? []), ...(move.sets ?? [])]);
      for (const field of requires.get(move.to) ?? []) {
        if (!carried.has(field)) problems.push(`${move.verb} from ${from} can reach ${move.to} without ${field}`);
      }
    }
  }
  return problems;
}

/**
 * Every property the declaration breaks (M4); empty when it is sound.
 *
 * @param {Machine} [machine]
 * @returns {string[]}
 */
export function machineProblems(machine = MACHINE) {
  return [
    ...unresolved(machine),
    ...unreachable(machine),
    ...secondDoors(machine),
    ...unnamedRefusals(machine),
    ...roleMismatches(machine),
    ...missingFields(machine),
  ];
}
