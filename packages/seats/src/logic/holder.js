/** Read which main checkout holds a board's coordinator [E19]. */
import { computerName } from './computer.js';

export const HOLDER_KEY = 'coordinator_holder';
const MACHINE = /^[A-Za-z0-9_.-]{1,128}$/u;

/**
 * The name a linked main checkout goes by: its computer, by the end of the machine id the relay gave it when it
 * was linked, as the device roster shows a computer. It carries no host name or path, since every member of a
 * team board reads it.
 *
 * @param {unknown} machine the link's relay machine id
 * @returns {string}
 */
export function computerLabel(machine, name) {
  if (name !== undefined) return computerName(name);
  return typeof machine === 'string' && MACHINE.test(machine) ? `computer ${machine.slice(-8)}` : 'another main checkout';
}

/** A move's machine id when it names a valid one. */
export function machineOf(machine) {
  return typeof machine === 'string' && MACHINE.test(machine) ? machine : null;
}

/**
 * The checkout that holds this board's coordinator, or null before any linked coordinator move at this engine.
 *
 * @param {any} board
 * @returns {{ machine: string | null, lineage: string, label: string, at: string } | null}
 */
export function coordinatorHolder(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(HOLDER_KEY);
  if (!row) return null;
  try {
    const value = JSON.parse(row.meta_value);
    return typeof value?.lineage === 'string'
      ? { machine: machineOf(value.machine), lineage: value.lineage, label: computerLabel(value.machine, value.name), at: String(value.at ?? '') } : null;
  } catch { return null; }
}
