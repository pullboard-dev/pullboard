/** A machine load ceiling beside the memory floor: heavy local work waits in the local resource line on a busy machine [Q1,C7,#2466]. */
import { availableParallelism } from 'node:os';
import { loadavg } from 'node:os';
import { takeResource } from '../main.js';
import { memoryAdmission } from './memory.js';

/** The host readings this module takes; a test swaps them so no assertion depends on the real machine. */
const HOST_PORT = Object.freeze({
  loadavg,
  cores: availableParallelism,
});
let port = HOST_PORT;

/** The ceiling's default, as a multiple of the machine's logical cores. */
export const LOAD_CEILING_PER_CORE = 1.5;

/**
 * Replace part of the host port, returning a function that restores the previous one.
 * Why: os.loadavg is the host's; a fixture injects its own reading so the result never depends on the test machine.
 *
 * @param {{ loadavg?: () => number[], cores?: () => number }} next
 * @returns {() => void}
 */
export function setMachineLoadPort(next) {
  const previous = port;
  port = Object.freeze({ ...port, ...next });
  return () => { port = previous; };
}

/**
 * The 1-minute load above which this machine holds heavy local work: machine.loadCeiling, or 1.5 times the logical cores.
 *
 * @param {object} settings machine settings (~/.pullboard/settings.json)
 * @returns {number}
 */
export function loadCeilingOf(settings) {
  const value = settings?.machine?.loadCeiling;
  if (typeof value === 'number') return value;
  return Math.round(LOAD_CEILING_PER_CORE * port.cores() * 100) / 100;
}

/**
 * Whether this process runs inside an admitted gate run, whose work the machine already counted.
 * Why: a gate's own tests and hooks must not wait on the load that gate itself adds.
 *
 * @returns {boolean}
 */
export function insideAdmittedGate() { return process.env.PULLBOARD_GATE_SLOT_HELD === '1'; }

/**
 * Read the load once and say whether it holds heavy local work, in the memory hold's verdict shape.
 *
 * @param {object} settings
 * @returns {{ checked: true, held: boolean, load: number, cores: number, ceiling: number, line: string }}
 */
export function machineLoadVerdict(settings) {
  const load = Math.round(Number(port.loadavg()[0]) * 100) / 100;
  const cores = port.cores();
  const ceiling = loadCeilingOf(settings);
  const held = load > ceiling && !insideAdmittedGate();
  const verdict = held ? 'holding heavy local work' : 'admitting';
  return { checked: true, held, load, cores, ceiling, line: `load: ${verdict}: 1-minute load ${load} on ${cores} cores (ceiling ${ceiling})` };
}

/**
 * One admission check for the local resource FIFO: held while the load is over its ceiling or the memory hold holds.
 *
 * @param {{ settings: () => object, memory?: () => Promise<{ checked: boolean, held: boolean, line: string, warning?: string }> }} options
 * @returns {() => Promise<{ checked: boolean, held: boolean, line: string, warning?: string, load: object }>}
 */
export function machineAdmission({ settings, memory }) {
  return async () => {
    const load = machineLoadVerdict(settings());
    const kept = memory ? await memory() : null;
    if (!kept) return { checked: true, held: load.held, line: load.line, load };
    return { ...kept, held: kept.held || load.held, line: `${load.line}; ${kept.line}`, load };
  };
}

/**
 * The memory admission for gate.memoryFloorMB, or undefined while no floor is set.
 *
 * @param {() => object} settings
 * @returns {(() => Promise<object>)|undefined}
 */
export function memoryFloorAdmission(settings) {
  const floor = settings()?.gate?.memoryFloorMB;
  if (floor === undefined || floor === null) return undefined;
  return memoryAdmission({ floorBytes: () => (settings()?.gate?.memoryFloorMB ?? floor) * 1024 ** 2 });
}

/**
 * Run heavy local work through the machine's local resource FIFO, waiting while the load ceiling or the
 * gate.memoryFloorMB hold holds, and saying why and for how long; work inside an admitted gate run goes straight through.
 *
 * @param {string} kind what the work is, for pullboard resources and the wait line
 * @param {() => any} action
 * @param {{ settings: () => object, root?: string, agent?: string, say?: (line: string) => void, memory?: () => Promise<object>, everyMs?: number }} options
 * @returns {Promise<any>}
 */
export async function withHeavyLocalWork(kind, action, { settings, root = process.cwd(), agent, say = line => process.stderr.write(line + '\n'), memory, everyMs = 30_000 }) {
  if (insideAdmittedGate()) return action();
  const started = Date.now();
  let reported = null;
  const capacity = () => Math.max(1, port.cores());
  const lease = await takeResource({ name: 'heavy', capacity: capacity(), capacityProvider: capacity,
    scope: 'machine', root, repo: root, agent, kind, allowIdleCapacityUpdate: true,
    memory: machineAdmission({ settings, memory: memory ?? memoryFloorAdmission(settings) }),
    onWait: state => {
      if (state.admitted || !state.memory?.held || reported !== null && Date.now() - reported < everyMs) return;
      reported = Date.now();
      say(`${kind} waits in the local resource line: ${state.memory.line}; waited ${Math.round((Date.now() - started) / 1000)}s`);
    } });
  try { return await action(); }
  finally { lease.release(); }
}
