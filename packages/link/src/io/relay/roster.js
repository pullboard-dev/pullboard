/** Who reads this computer's linked boards: paired phones and joined computers, by name [H17]. */
import { listApiProjects } from '../../../../seats/index.js';
import { readRelayMachine } from './machine.js';
import { computerName } from '../../../../seats/index.js';
import { relayMachineContext } from '../relay.js';
import { relayRosterRead } from '../relay.js';

const MACHINE = /^[A-Za-z0-9_.-]{1,128}$/u;
const DEVICE = /^device-[0-9a-f]{32}$/u;

/** Read one roster document with a board's machine credential; an older or unreachable relay gives null. */
async function rosterRead(state, path) {
  try {
    return await relayRosterRead(state, path);
  } catch {
    // The roster is a courtesy: local names and dates still print when the relay cannot answer.
    return null;
  }
}

/** Return this computer's registered boards that hold a live machine link, with their names. */
function linkedBoards() {
  return listApiProjects().flatMap(project => {
    let state;
    try { state = relayMachineContext(project.root); } catch { return []; }
    return state && !state.unlinking && state.token?.startsWith('pm_') ? [{ name: project.name, state }] : [];
  });
}

/** List the other computers that joined one linked board, by host name when the relay recorded it. */
export async function joinedComputers(state) {
  const document = await rosterRead(state, '/auth/machines?board=' + state.board);
  if (!Array.isArray(document?.machines)) return [];
  return document.machines.filter(entry => MACHINE.test(entry?.machine ?? '') && entry.machine !== state.machine).map(entry => ({
    machine: entry.machine,
    name: typeof entry.name === 'string' ? computerName(entry.name) : null,
    created: Number.isSafeInteger(entry.created) ? entry.created : null,
    seen: Number.isSafeInteger(entry.seen) ? entry.seen : null,
  }));
}

/** Name a joined computer by its host, or by the end of its id when it joined before hosts were recorded. */
function computerDisplayName(computer) {
  return computer.name ?? 'computer ' + computer.machine.slice(-8);
}

/** List the phones that hold one linked board's key, by id, with the relay's last seen and revoked status. */
export async function boardPhones(state) {
  const document = await rosterRead(state, '/api/v1/devices');
  if (!Array.isArray(document?.devices)) return [];
  return document.devices.filter(entry => DEVICE.test(entry?.deviceId ?? '')).map(entry => ({
    deviceId: entry.deviceId, seen: Number.isSafeInteger(entry.seen) ? entry.seen : null, revoked: entry.revoked === true,
  }));
}

/** Gather every paired phone and joined computer with its dates and the boards it can read; fingerprints only when verbose. */
export async function relayRoster({ verbose = false } = {}) {
  const boards = linkedBoards();
  const inventory = new Map();
  for (const board of boards) inventory.set(board.state, await boardPhones(board.state));
  const phones = new Map();
  for (const device of readRelayMachine().devices) {
    // Local pairing history supplies the label; only each board's current inventory proves access.
    const reads = boards.filter(board => board.state.account === device.account && board.state.url === device.url);
    const document = reads.length ? await rosterRead(reads[0].state, '/api/v1/devices/' + device.deviceId) : null;
    const grants = document?.revoked === true ? [] : reads.filter(board => inventory.get(board.state).some(entry => entry.deviceId === device.deviceId && !entry.revoked));
    phones.set(device.deviceId, { deviceId: device.deviceId, pairedHere: true, label: device.label, createdAt: device.createdAt,
      ...(verbose ? { fingerprint: device.fingerprint } : {}),
      seen: Number.isSafeInteger(document?.seen) ? document.seen : null, revoked: document?.revoked === true, boards: grants.map(board => board.name) });
  }
  // A phone paired on another computer is known here only by the id the relay holds for the board; its name stays there.
  for (const board of boards) {
    for (const entry of inventory.get(board.state)) {
      if (entry.revoked) continue;
      const known = phones.get(entry.deviceId) ?? { deviceId: entry.deviceId, pairedHere: false, label: null, createdAt: null, seen: null, revoked: false, boards: [] };
      known.seen = Math.max(known.seen ?? -Infinity, entry.seen ?? -Infinity);
      if (!Number.isFinite(known.seen)) known.seen = null;
      if (!known.revoked && !known.boards.includes(board.name)) known.boards.push(board.name);
      phones.set(entry.deviceId, known);
    }
  }
  const devices = [...phones.values()];
  const computers = new Map();
  for (const board of boards) {
    for (const entry of await joinedComputers(board.state)) {
      const known = computers.get(entry.machine) ?? { ...entry, boards: [] };
      known.name ??= entry.name;
      known.created = Math.min(known.created ?? Infinity, entry.created ?? Infinity);
      known.seen = Math.max(known.seen ?? -Infinity, entry.seen ?? -Infinity);
      known.boards.push(board.name);
      computers.set(entry.machine, known);
    }
  }
  const finite = value => Number.isFinite(value) ? value : null;
  return { devices, computers: [...computers.values()].map(entry => ({ ...entry, created: finite(entry.created), seen: finite(entry.seen) })) };
}

/** Print a date the way this computer shows dates. */
function day(value) {
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Print a moment the way this computer shows times. */
function moment(value) {
  return value === null ? 'unknown' : new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Render one line per phone and computer; ids and fingerprints only when the person asks for them. */
export function rosterLines(roster, { verbose = false } = {}) {
  const reads = boards => boards.length ? 'reads ' + boards.join(', ') : 'reads no linked board yet';
  const lines = [];
  for (const phone of roster.devices) {
    const paired = phone.pairedHere ? `${phone.label} (phone): paired ${day(phone.createdAt)}` : `Phone ${phone.deviceId.slice(-8)} (phone): paired on another computer`;
    lines.push(`${paired}, last seen ${moment(phone.seen)}${phone.revoked ? ', revoked' : ''}; ${reads(phone.boards)}`);
    if (verbose) lines.push(`  ${phone.deviceId}${phone.fingerprint ? '  fingerprint ' + phone.fingerprint : ''}`);
  }
  for (const computer of roster.computers) {
    lines.push(`${computerDisplayName(computer)} (computer): joined ${computer.created === null ? 'on an unknown date' : day(computer.created)}, last seen ${moment(computer.seen)}; ${reads(computer.boards)}`);
    if (verbose) lines.push(`  ${computer.machine}`);
  }
  if (!lines.length) lines.push('No phones or computers are paired yet. Pair a phone with pullboard relay on --all, or another computer with pullboard relay pair.');
  return lines;
}
