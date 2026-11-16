/**
 * One coordinator per board, held by one main checkout at a time and passed by takeover [E19].
 *
 * On a linked board every main checkout's coordinator moves reach the relay under its own root coordinator
 * credential, and each move names the checkout's relay machine id. The board records which checkout holds the
 * coordinator by both: a move from the holding checkout matches its machine id, or its relay-authenticated
 * credential lineage when the move names no machine. The first coordinator move at this engine takes the hold, so
 * a board coordinated from one checkout works as before, including after another person signs in there and the
 * relay gives that checkout a new lineage. A coordinator move from any other checkout is refused, naming the
 * holder, until that checkout runs pullboard takeover. An unlinked board's main checkout is already held by one
 * session through its checkout binding, so nothing here applies to it (#347).
 */
import { COORDINATOR } from '../../../config/index.js';
import { COORDINATOR_HOLD_ENGINE } from '../../../state/light.js';
import { Refused } from '../../../kernel/index.js';
import { computerName } from '../logic/computer.js';
import { HOLDER_KEY } from '../logic/holder.js';
import { computerLabel } from '../logic/holder.js';
import { coordinatorHolder } from '../logic/holder.js';
import { machineOf } from '../logic/holder.js';

export { computerLabel, coordinatorHolder };
import { COMPUTER_NAME_ENGINE } from '../../../state/light.js';
import { ENGINE_VERSION } from '../../../state/index.js';

const MACHINE = /^[A-Za-z0-9_.-]{1,128}$/u;
/** Operations a non-holding main checkout may still send: seat creation and path upkeep stay per machine. */
const UNHELD_OPERATIONS = new Set(['register', 'ensureCoordinator', 'takeCoordinator']);

/**
 * Name the sending checkout on a coordinator move, by its relay machine id, so a hold follows the checkout.
 *
 * @param {any} move a prepared engine move
 * @param {unknown} machine the sending link's relay machine id
 * @returns {any} the same move
 */
export function stampCoordinatorHolder(move, machine, name, { credentialActor }) {
  if (credentialActor(move) === COORDINATOR && typeof machine === 'string' && MACHINE.test(machine)) {
    move.holder = machine;
    if (move.engine >= COMPUTER_NAME_ENGINE && name !== undefined) move.holderName = computerName(name);
  }
  return move;
}

/** Record a holder in the caller's transaction and return its name. */
function saveHolder(board, machine, lineage, at, name) {
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
    .run(HOLDER_KEY, JSON.stringify({ machine: machineOf(machine), lineage, at, ...(name === undefined ? {} : { name: computerName(name) }) }));
  return computerLabel(machine, name);
}

/**
 * Admit one relay-ordered coordinator move from a linked main checkout, or refuse it by name. The first such move
 * takes the hold, so a single coordinating checkout never sees a refusal.
 *
 * @param {any} board
 * @param {{ operation: string, engine: number, holder?: unknown }} move
 * @param {string | null | undefined} lineage the relay-authenticated root coordinator lineage of the sender
 * @param {string} at the relay receipt time
 */
export function requireCoordinatorHold(board, move, lineage, at) {
  if (!lineage || !(move.engine >= COORDINATOR_HOLD_ENGINE) || UNHELD_OPERATIONS.has(move.operation)) return;
  const holder = coordinatorHolder(board);
  const name = move.engine >= COMPUTER_NAME_ENGINE ? move.holderName : undefined;
  if (!holder) { saveHolder(board, move.holder, lineage, at, name); return; }
  const machine = machineOf(move.holder);
  if (holder.lineage === lineage && (!machine || !holder.machine || machine === holder.machine)) return;
  // The holding checkout signed in again, so its credential lineage changed: the hold follows the checkout.
  if (machine && machine === holder.machine) { saveHolder(board, machine, lineage, holder.at, name); return; }
  throw new Refused('COORDINATOR_HELD',
    `this board's coordinator is held by ${holder.label}, so this main checkout cannot act as coordinator; to coordinate from here, run pullboard takeover in this main checkout`);
}

/**
 * Refuse, before a move is queued, a coordinator move this board already knows another computer's hold forbids.
 * Why: a local-first move applies at once, so without this a shout from a computer that does not hold the coordinator
 * printed "shouted to all" and was refused only later, at replay, where nobody was looking.
 *
 * @param {any} board
 * @param {{ operation: string, engine: number, holder?: unknown }} move a prepared move, stamped with its sending machine
 */
export function requireKnownCoordinatorHold(board, move) {
  if (!move.holder || !(move.engine >= COORDINATOR_HOLD_ENGINE) || UNHELD_OPERATIONS.has(move.operation)) return;
  const holder = coordinatorHolder(board);
  const machine = machineOf(move.holder);
  if (!holder || !holder.machine || !machine || machine === holder.machine) return;
  throw new Refused('COORDINATOR_HELD',
    `this board's coordinator is held by ${holder.label}, so this main checkout cannot act as coordinator; to coordinate from here, run pullboard takeover in this main checkout`);
}

/**
 * Take this board's coordinator for the linked main checkout that sent the move, recording who held it before.
 * Only a relay-ordered move under a linked main checkout's own coordinator credential can take it.
 *
 * @param {any} board
 * @param {{ agentId: string, machine?: string }} options
 * @param {{ atomic: Function, logEvent: Function }} writers the store's transaction and event log, passed in so seats never load the board
 * @returns {{ holder: string, previous: string | null }}
 */
export function takeCoordinator(board, { agentId, machine, name }, { atomic, logEvent }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator takes over the coordinator; run pullboard takeover in the main checkout');
  const lineage = board.verifierStanding?.lineage;
  if (!lineage) {
    throw new Refused('COORDINATOR_TAKEOVER', 'a linked board passes its coordinator between main checkouts; run pullboard takeover in the main checkout of a board linked with pullboard relay on');
  }
  return atomic(board, () => {
    const previous = coordinatorHolder(board);
    const at = board.clock?.now?.().toISOString?.() ?? new Date().toISOString();
    const label = (board.executionEngineVersion ?? ENGINE_VERSION) >= COMPUTER_NAME_ENGINE ? name : undefined;
    const holder = saveHolder(board, machine, lineage, at, label);
    logEvent(board, COORDINATOR, 'coordinator-takeover', null, { holder, previous: previous?.label ?? null, engine: COORDINATOR_HOLD_ENGINE });
    return { holder, previous: previous?.label ?? null };
  });
}
