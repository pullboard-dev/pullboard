/** Machine-wide settings shared by every Pullboard checkout on this machine. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setResourceCapacity } from './resources.js';
import { Refused } from './refused.js';

const DEFAULT_GATE_SLOTS = 2;

/** Resolve the separate machine settings file. */
export function machineSettingsFile() {
  return join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'settings.json');
}

/** Read and validate machine settings, preserving any unrelated settings. */
export function loadMachineSettings() {
  const file = machineSettingsFile();
  if (!existsSync(file)) return { gateSlots: DEFAULT_GATE_SLOTS };
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('BAD_MACHINE_SETTINGS', `cannot read ${file}; fix its JSON before running Pullboard`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `settings in ${file} must be a JSON object; fix it before running Pullboard`);
  }
  const gateSlots = value.gateSlots ?? DEFAULT_GATE_SLOTS;
  if (!Number.isSafeInteger(gateSlots) || gateSlots < 1) {
    throw new Refused('BAD_GATE_SLOTS', `gateSlots in ${file} must be a positive integer; run pullboard settings gateSlots <n>`);
  }
  return { ...value, gateSlots };
}

/** Atomically replace machine settings without exposing a partial JSON file. */
function writeMachineSettings(settings) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Set machine gate capacity only when its durable holder and waiter lists are empty. */
export function setGateSlots(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Refused('BAD_GATE_SLOTS', 'gateSlots must be a positive integer; run pullboard settings gateSlots <n>');
  const current = loadMachineSettings();
  const next = { ...current, gateSlots: capacity };
  setResourceCapacity({ name: 'gate', capacity, scope: 'machine', persist: () => writeMachineSettings(next) });
  return next;
}
