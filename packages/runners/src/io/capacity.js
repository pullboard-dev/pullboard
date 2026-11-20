/** Current capacity descriptors for completed-receipt utilization, without admission writes [C7,O5]. */
import { join } from 'node:path';
import { machineHome } from '../../../resources/light.js';
import { openPoolReadOnly } from '../../../resources/light.js';
import { loadMachineSettings } from '../../../config/light.js';
import { validateRunner } from '../../../config/light.js';
import { localRunnerDescriptor } from './load.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

/** Missing optional tables are historical absence, never an instruction to migrate a read. */
function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
/** Return one actual persisted capacity, rejecting corrupt data rather than guessing a denominator. */
function capacity(db, name, fallback) {
  const value = db?.prepare('SELECT capacity FROM resource WHERE name=?').get(name)?.capacity ?? fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid persisted runner capacity');
  return value;
}
/** Unknown remote platforms remain unknown; only actual structured executor observations name them. */
function reportedPlatform(receipts, id) {
  const platforms = new Set(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32']);
  return receipts.filter(receipt => receipt.runner?.id === id)
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
    .map(receipt => receipt.runner?.capabilities?.os).find(value => platforms.has(value)) ?? null;
}
/** Read holder observations without declaring them fresh or deleting expired/dead leases. */
function holders(db) {
  if (!db || !tableExists(db, 'holder')) return [];
  const columns = new Set(db.prepare('PRAGMA table_info(holder)').all().map(column => column.name));
  if (!columns.has('name')) throw new Error('resource holder identity is unavailable');
  const selected = ['name', ...['timing', 'short_slot'].filter(name => columns.has(name))];
  return db.prepare(`SELECT ${selected.join(', ')} FROM holder`).all();
}
/** Build the same identity and capacity population; no live probes or pruning belong to utilization. */
function descriptors(settings, db, receipts) {
  const observed = holders(db);
  const slots = capacity(db, 'gate', settings.gateSlots);
  const browser = capacity(db, 'browser', settings.browserSlots);
  if (browser > slots) throw new Error('invalid persisted browser capacity');
  const local = localRunnerDescriptor(slots, browser > 0, null);
  const localHolders = observed.filter(row => row.name === 'gate');
  local.active = localHolders.some(row => row.timing) ? slots : localHolders.filter(row => !row.short_slot).length;
  const visible = new Map((settings.runners ?? []).map(runner => [runner.host, runner]));
  if (db && tableExists(db, 'runner_draining')) {
    for (const row of db.prepare('SELECT host,runner FROM runner_draining').all()) {
      if (!observed.some(holder => holder.name === `runner:${row.host}`)) { visible.delete(row.host); continue; }
      const runner = validateRunner(JSON.parse(row.runner));
      if (runner.host !== row.host) throw new Error('invalid draining runner identity');
      visible.set(row.host, { ...runner, draining: true });
    }
  }
  return [local, ...[...visible.values()].map(runner => ({
    id: runner.host, kind: runner.kind ?? 'ssh',
    slots: { current: runner.slots, limit: runner.slots, elastic: false },
    capabilities: { os: reportedPlatform(receipts, runner.host), browser: runner.browser > 0, gui: runner.gui ?? null },
    active: observed.filter(row => row.name === `runner:${runner.host}`).length,
    ...(runner.draining ? { draining: true } : {}),
  }))];
}
/** Existing resource databases are opened read-only; a missing pool still exposes configured unknown runners. */
export function readRunnerCapacities(receipts = []) {
  const settings = loadMachineSettings();
  const file = join(machineHome(), 'resources.sqlite');
  if (!fs.exists(file)) return descriptors(settings, null, receipts);
  const db = openPoolReadOnly(file);
  try {
    db.exec('BEGIN');
    const rows = descriptors(settings, db, receipts);
    db.exec('COMMIT');
    return rows;
  } finally { db.close(); }
}
