export { discoverEngines, ENGINE_REGISTRY, ENGINE_VERSION, VERIFIER_STANDING_ENGINE, CAUSE_ENGINE, VERDICT_REVIEW_ENGINE, MILESTONE_RANK_ENGINE, AUTO_ESCALATE_ENGINE, ROW_DRAFT_ENGINE, STRONG_REJECTION_NOTICE_ENGINE, SUBMITTED_CONFLICT_ENGINE, WITHDRAW_MILESTONE_ENGINE, REOPEN_FIRST_REFUSAL_ENGINE, QUOTED_LANDING_FAILURE_ENGINE } from './engine/metadata.js';
/**
 * The item lifecycle, declared once (M1).
 *
 * Every state an item can be in, every move between states, who may make it, and the guards it
 * must pass in the order they are checked, each guard with the refusal it raises and the step that
 * gets past it. Final states carry exit guards that every move into them must name (M2), so no
 * command can become a second way into verified or withdrawn. `machineProblems` proves the
 * declaration's properties (M4); apps/cli/journeys/verify/machine.test.js runs it, shows each property failing on a
 * broken copy, and checks the declaration against the refusals board.js and cli.js raise today.
 */

import { IN_STATE } from '../logic/machine/shared.js';
export { IN_STATE };
import { ROLES } from '../logic/machine/declaration.js';
import { INITIAL } from '../logic/machine/declaration.js';
import { RECORDS } from '../logic/machine/declaration.js';
import { STATES } from '../logic/machine/declaration.js';
import { GUARDS } from '../logic/machine/declaration.js';
import { MOVES } from '../logic/machine/declaration.js';
import { EXIT_GUARDS } from '../logic/machine/declaration.js';
import { UNKNOWN_MOVE } from '../logic/machine/declaration.js';
import { MACHINE } from '../logic/machine/declaration.js';
export { ROLES } from '../logic/machine/declaration.js';
export { INITIAL } from '../logic/machine/declaration.js';
export { RECORDS } from '../logic/machine/declaration.js';
export { STATES } from '../logic/machine/declaration.js';
export { GUARDS } from '../logic/machine/declaration.js';
export { MOVES } from '../logic/machine/declaration.js';
export { EXIT_GUARDS } from '../logic/machine/declaration.js';
export { UNKNOWN_MOVE } from '../logic/machine/declaration.js';
export { MACHINE } from '../logic/machine/declaration.js';

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
 * Property 2: every state is reachable from where items start, every non-final state can still
 * reach a final one (no traps), and nothing leaves a final state.
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
  const fromStart = reach(machine.initial, forward);
  const canEnd = new Set();
  for (const state of machine.states.filter((entry) => entry.final)) for (const id of reach(state.id, back)) canEnd.add(id);
  const problems = [];
  for (const state of machine.states) {
    if (!fromStart.has(state.id)) problems.push(`state ${state.id} cannot be reached from ${machine.initial}`);
    if (!canEnd.has(state.id)) problems.push(`state ${state.id} is a trap: no way from it to a final state`);
    if (state.final && forward.has(state.id)) problems.push(`final state ${state.id} has a move out`);
  }
  return problems;
}

/**
 * Properties 3 and 4: every final state has exit guards, and every guarded target requires all
 * moves into it to name those guards.
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
    const codes = [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)];
    if (guard.id !== IN_STATE && codes.some((code) => !/^[A-Z][A-Z0-9_]*$/.test(code))) problems.push(`guard ${guard.id} names no refusal code`);
    if (!guard.rule.trim()) problems.push(`guard ${guard.id} states no rule`);
    if (!guard.next.trim()) problems.push(`guard ${guard.id} refuses without a next step`);
    for (const refusal of guard.alsoRefuses ?? []) {
      if (!refusal.next?.trim()) problems.push(`guard ${guard.id} refusal ${refusal.code} has no next step`);
    }
    if (!used.has(guard.id)) problems.push(`guard ${guard.id} is declared but no move uses it`);
  }
  for (const move of machine.moves.filter((entry) => !entry.by.includes('clock'))) {
    const checks = move.guards.filter((id) => id === IN_STATE).length;
    if (checks !== 1) problems.push(`${move.verb} checks the item's state ${checks} times, not once`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(move.refuse ?? '')) problems.push(`${move.verb} names no code for an item in the wrong state`);
    for (const refusal of move.alsoRefuses ?? []) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(refusal.code ?? '') || !refusal.rule?.trim() || !refusal.next?.trim()) {
        problems.push(`${move.verb} supplemental refusal has no code, rule or next step`);
      }
    }
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(machine.unknownMove.refuse) || !machine.unknownMove.next.trim()) problems.push('the unknown-move refusal has no code or no next step');
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

/**
 * Text as an SQL string literal.
 *
 * @param {string} text
 * @returns {string}
 */
const sqlText = (text) => `'${text.replaceAll("'", "''")}'`;

/**
 * The characters JavaScript's trim removes, as code points. A field made only of them is blank in
 * the board file, exactly as it is to the commands that trim what an agent typed.
 */
export const BLANKS = [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279];

/**
 * The SQLite triggers that make the board file itself refuse what the declaration does not allow
 * (M3): an item that starts anywhere but the start, a state or a move nobody declared, an item left
 * in a state without that state's fields or proof, and an edit to a record the board keeps for good.
 * A state's fields and proof are checked on every write that leaves an item in it, a move in or an
 * edit while it stays, so no field that makes the proof can be rewritten after it. All of it comes
 * from the declaration, so the board reinstalls any trigger that differs when the declaration changes.
 *
 * The triggers stop a status written by hand. They cannot stop an agent that forges a verdict row
 * under some name and then moves the item; that forgery stays in the ledger under the name it used.
 *
 * @param {Machine} [machine]
 * @returns {{ name: string, sql: string }[]}
 */
export function storeTriggers(machine = MACHINE) {
  const refuse = (code, text) => `BEGIN SELECT RAISE(ABORT, ${sqlText(`${code}: ${text}; the board changes only through pullboard commands`)}); END`;
  const onStatus = 'BEFORE UPDATE OF item_status ON item';
  const states = machine.states.map((state) => state.id);
  const moves = [...new Set(machine.moves.flatMap((move) => move.from.filter((from) => from !== move.to).map((from) => `${from}>${move.to}`)))];
  const declared = `OLD.item_status || '>' || NEW.item_status IN (${moves.map(sqlText).join(', ')})`;
  const holds = (state) => `NEW.item_status = ${sqlText(state)} AND (OLD.item_status = NEW.item_status OR ${declared})`;
  const onWrite = 'BEFORE UPDATE ON item';
  const trigger = (name, on, body) => ({ name, sql: `CREATE TRIGGER ${name} ${on}\n${body}` });
  // Each write meets at most one trigger: an unknown state, else an undeclared move, else missing
  // fields, else a missing proof. SQLite fires triggers in no promised order, so their conditions
  // exclude each other and the refusal never depends on which one ran first. A blank field is one
  // that BLANKS trims to nothing.
  const triggers = [
    trigger('machine_item_start', 'BEFORE INSERT ON item', `WHEN NEW.item_status <> ${sqlText(machine.initial)}\n${refuse('UNDECLARED_MOVE', `an item starts ${machine.initial}`)}`),
    trigger('machine_item_state', onStatus, `WHEN NEW.item_status NOT IN (${states.map(sqlText).join(', ')})\n${refuse('UNDECLARED_STATE', `an item is ${states.join(', ')}`)}`),
    trigger(
      'machine_item_move',
      onStatus,
      `WHEN NEW.item_status IN (${states.map(sqlText).join(', ')}) AND OLD.item_status <> NEW.item_status AND NOT ${declared}\n${refuse('UNDECLARED_MOVE', `the moves are ${moves.join(', ')}`)}`,
    ),
  ];
  const blank = `char(${BLANKS.join(', ')})`;
  const missingOf = (state) => state.requires.map((field) => `trim(coalesce(NEW.${field}, ''), ${blank}) = ''`).join(' OR ');
  for (const state of machine.states.filter((entry) => entry.requires.length)) {
    triggers.push(trigger(`machine_fields_${state.id}`, onWrite, `WHEN ${holds(state.id)} AND (${missingOf(state)})\n${refuse('MISSING_FIELD', `${state.id} needs ${state.requires.join(', ')}`)}`));
  }
  for (const state of machine.states.filter((entry) => entry.proof)) {
    const complete = state.requires.length ? ` AND NOT (${missingOf(state)})` : '';
    triggers.push(trigger(`machine_proof_${state.id}`, onWrite, `WHEN ${holds(state.id)}${complete} AND NOT (${state.proof.sql})\n${refuse('NOT_PROVEN', `${state.id} needs ${state.proof.says}`)}`));
  }
  for (const [table, kept] of Object.entries(machine.records)) {
    for (const change of kept === 'append' ? ['update', 'delete'] : ['delete']) {
      const text = kept === 'append' ? `${table} rows are only ever added` : `an ${table} is withdrawn, never deleted`;
      triggers.push(trigger(`machine_${table}_${change}`, `BEFORE ${change.toUpperCase()} ON ${table}`, refuse(kept === 'append' ? 'APPEND_ONLY' : 'KEPT', text)));
    }
  }
  return triggers;
}

/**
 * A guard as the lifecycle page shows it: its id, with the code it raises, or the move's own code
 * for the state check.
 *
 * @param {Machine} machine
 * @param {Move} move
 * @param {string} id
 * @returns {string}
 */
function guardLabel(machine, move, id) {
  const guard = machine.guards.find((entry) => entry.id === id);
  const codes = id === IN_STATE ? [move.refuse] : [guard?.refuse, ...(guard?.alsoRefuses ?? []).map((entry) => entry.code)];
  const declared = codes.filter(Boolean).join(' or ');
  return declared ? `${id} (${declared})` : id;
}

/**
 * The lifecycle as a markdown page: a Mermaid state diagram, every move with its guards in the
 * order they are checked (transition guards included), each guarded target's required guards, and every refusal
 * with the rule behind it and the next step (M1, P4). `pullboard lifecycle` prints this page on demand,
 * so it cannot drift from the code.
 *
 * @param {Machine} [machine]
 * @returns {string}
 */
export function lifecycleMarkdown(machine = MACHINE, { compact = false } = {}) {
  const cell = (text) => String(text).replaceAll('|', '\\|');
  const finals = machine.states.filter((state) => state.final);
  const transitionGuards = Object.entries(machine.exitGuards);
  const edges = machine.moves.flatMap((move) => move.from.map((from) => `  ${from} --> ${move.to}: ${move.verb}${move.by.includes('clock') ? ' (clock)' : ''}`));
  const moves = machine.moves.map((move) => {
    const who = move.when ? `${move.by.join(', ')}, when ${move.when}` : move.by.join(', ');
    const guards = effectiveGuards(move, machine).map((id) => guardLabel(machine, move, id));
    const resultRefusals = (move.alsoRefuses ?? []).map(({ code }) => `result (${code})`);
    const checks = [...guards, ...resultRefusals].join(', ') || 'none';
    return `| ${move.verb} | ${move.from.join(', ')} | ${move.to} | ${cell(who)} | ${cell(checks)} |`;
  });
  const wrongState = machine.moves.filter((move) => move.refuse).map((move) => `| ${move.refuse} | ${move.verb}: the item is in ${move.from.join(', ')} | pullboard show <id> |`);
  const refusals = machine.guards.filter((guard) => guard.id !== IN_STATE).flatMap((guard) => [
    { code: guard.refuse, next: guard.next },
    ...(guard.alsoRefuses ?? []),
  ].map(({ code, next }) => `| ${code} | ${cell(guard.when ? `${guard.rule}, ${guard.when}` : guard.rule)} | ${cell(next)} |`));
  const resultRefusals = machine.moves.flatMap((move) => (move.alsoRefuses ?? []).map(({ code, rule, next }) => `| ${code} | ${cell(rule)} (${move.verb} result) | ${cell(next)} |`));
  const unknown = `| ${machine.unknownMove.refuse} | ${cell(machine.unknownMove.rule)} | ${cell(machine.unknownMove.next)} |`;
  return [
    '# The item lifecycle',
    '',
    'Generated from src/machine.js by `pullboard lifecycle`. Do not edit it by hand: change the declaration, then run `node docs/tools/update-docs.js` to refresh all generated documents.',
    '',
    `An item starts ${machine.initial}. Its final states, ${finals.map((state) => state.id).join(' and ')}, cannot be left. Every move into a guarded state passes the same guards, whatever command gets there. The board file refuses any move not declared here.`,
    '',
    '## Frozen check policy',
    '',
    'The coordinator may set `check.install` and `check.timeout` in committed `pullboard.json`; the defaults are no install and `5m`. Accept runs the configured install and the frozen item check in a private clone under one timeout; a configured `landing.timeout` replaces `check.timeout` as that budget, so a long check reports its real result (#1760). It reuses the verifier’s npm cache if present. Installs that download conflict with P2 (offline); configure an offline install or cache the packages.',
    '',
    compact ? 'Private checks drain their owned processes and retain bounded output; --detail includes timeout, artifact and recovery policy.' : "Private commands drain output through pipes, keeping a bounded 8 MiB capture of its beginning and end. Failed or unverified checks stream the full log through secret scanning into an owner-readable artifact; lines over 64 KiB of UTF-8 are replaced with a safe-scan marker. Output beyond the cap does not fail a successful command; dependency files and build artifacts have no capture limit. A timeout kills the command's process group. An unverified check names how to restore and retry; a failing one names rejection or builder rework.",
    '',
    '```mermaid',
    'stateDiagram-v2',
    `  [*] --> ${machine.initial}`,
    ...[...new Set(edges)],
    ...finals.map((state) => `  ${state.id} --> [*]`),
    '```',
    '',
    '## States',
    '',
    '| State | Means | Fields it needs |',
    '| --- | --- | --- |',
    ...machine.states.map((state) => `| ${state.id}${state.final ? ' (final)' : ''} | ${cell(state.means)} | ${state.requires.join(', ') || 'none'} |`),
    '',
    '## Moves',
    '',
    'Each move checks its guards in this order and refuses with the first that fails; result-path refusals are listed separately.',
    '',
    '| Move | From | To | Who | Guards, in order; result refusals |',
    '| --- | --- | --- | --- | --- |',
    ...moves,
    '',
    '## Required transition guards',
    '',
    '| State entered | Every move into it passes |',
    '| --- | --- |',
    ...transitionGuards.map(([state, guards]) => `| ${state} | ${guards.join(', ')} |`),
    '',
    '## Refusals',
    '',
    '| Code | Raised when this does not hold | Next step |',
    '| --- | --- | --- |',
    ...[...new Set([...wrongState, ...refusals, ...resultRefusals, unknown])],
    '',
    'For check diagnostics, a refusal from a failed or unverifiable check includes an output digest, sanitized tail, and a private full-output path in the CLI message (also `error.message` in JSON). The artifact is owner-readable only. If it cannot be saved, the tail remains available and the message names the storage error instead of claiming a path.',
    '',
  ].join('\n');
}

/**
 * The help screen's lifecycle section: who may make which moves, read from the declaration.
 *
 * @param {Machine} [machine]
 * @returns {string}
 */
export function lifecycleHelp(machine = MACHINE) {
  const lines = machine.roles.map((role) => {
    const moves = machine.moves.filter((move) => move.by.includes(role));
    const counts = new Map();
    for (const move of moves) counts.set(move.verb, (counts.get(move.verb) ?? 0) + 1);
    const when = moves.filter((move) => move.when && counts.get(move.verb) === 1).map((move) => `${move.verb} (when ${move.when})`);
    const plain = [...new Set(moves.filter((move) => !move.when || counts.get(move.verb) > 1).map((move) => move.verb))];
    return `  ${role.padEnd(13)} ${[...plain, ...when].join(', ')}`;
  });
  return ['Lifecycle, read from src/machine.js', '  pullboard lifecycle         the states, moves, guards and refusals as a markdown page, with a diagram', ...lines].join('\n');
}
