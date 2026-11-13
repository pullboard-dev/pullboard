/** A runner prunes its test-results store by age and to a size cap, once per interval, never a repo store an in-flight job holds [C7]. */
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GIB = 1024 ** 3;
export const RESULTS_MAX_AGE_MS = 6 * 60 * 60_000;
export const RESULTS_CAP_BYTES = 10 * GIB;
const GRACE_MS = 10 * 60_000;
const INTERVAL_MS = 10 * 60_000;
const CLAIMED = '.pruning';
const MARKER = '.prune-at';

/** The names in a folder, or none when it does not exist. */
function names(directory) {
  try { return readdirSync(directory); } catch { return []; }
}

/** Bytes under a path without following links, and the newest modification time anywhere beneath it. */
function measure(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return { bytes: 0, at: 0 }; }
  let bytes = stat.blocks * 512, at = stat.mtimeMs;
  if (stat.isDirectory()) {
    for (const name of names(path)) { const inner = measure(join(path, name)); bytes += inner.bytes; at = Math.max(at, inner.at); }
  }
  return { bytes, at };
}

/**
 * Remove old result records, then the oldest until the store fits the size cap. A unit is an input bucket, a lists entry or a green
 * record under a repo store. A repo store named in `held` (a live job pins it) is skipped whole, and a unit changed
 * within the grace period is kept: its writer may still be running. Each removal first claims the unit with an atomic
 * rename out of the store, so a reader or writer sees it whole or gone, never half deleted.
 *
 * @param {string} root the runner root, normally ~/.pullboard-runner
 * @param {{ capBytes?: number, maxAgeMs?: number, graceMs?: number, now?: number, held?: Set<string> }} [options]
 * @returns {{ removed: number, bytes: number }} units removed and the bytes left
 */
export function pruneTestResults(root, { capBytes = RESULTS_CAP_BYTES, maxAgeMs = RESULTS_MAX_AGE_MS, graceMs = GRACE_MS, now = Date.now(), held = new Set() } = {}) {
  const store = join(root, 'test-results');
  const claimed = join(store, CLAIMED);
  for (const name of names(claimed)) rmSync(join(claimed, name), { recursive: true, force: true });
  const units = [];
  for (const repo of names(store)) {
    if (repo.startsWith('.')) continue;
    for (const folder of ['inputs', 'green', 'lists']) {
      for (const name of names(join(store, repo, folder))) {
        const path = join(store, repo, folder, name);
        units.push({ path, held: held.has(repo), ...measure(path) });
      }
    }
  }
  let bytes = units.reduce((sum, unit) => sum + unit.bytes, 0), removed = 0;
  mkdirSync(claimed, { recursive: true, mode: 0o700 });
  for (const unit of units.sort((a, b) => a.at - b.at)) {
    if (unit.held || now - unit.at < graceMs) continue;
    if (now - unit.at < maxAgeMs && bytes <= capBytes) continue;
    const taken = join(claimed, randomUUID());
    try { renameSync(unit.path, taken); } catch { continue; }
    bytes -= unit.bytes;
    removed += 1;
    try { rmSync(taken, { recursive: true, force: true }); } catch { /* The next run clears leftovers. */ }
  }
  return { removed, bytes };
}

/**
 * Routine entry: prune at most once per ten minutes per runner root. The run is claimed by an atomic rename of the
 * marker, so two workers starting together prune once. Limits come from PULLBOARD_RUNNER_TEST_RESULTS_CAP_BYTES
 * (default 10 GB) and PULLBOARD_RUNNER_TEST_RESULTS_MAX_AGE_MS (default 6 hours). A failure never changes whether a job runs.
 *
 * @param {string} root the runner root
 * @param {{ env?: NodeJS.ProcessEnv, held?: Set<string>, now?: number }} [options]
 * @returns {{ removed: number, bytes: number } | null} null when throttled, lost the claim, or on failure
 */
export function maintainTestResults(root, { env = process.env, held = new Set(), now = Date.now() } = {}) {
  try {
    const store = join(root, 'test-results');
    const marker = join(store, MARKER);
    mkdirSync(store, { recursive: true, mode: 0o700 });
    let known = true;
    try { if (now - statSync(marker).mtimeMs < INTERVAL_MS) return null; } catch { known = false; }
    // The winner is whoever renames the old marker away, or creates the first one; everyone else stands down.
    if (known) { try { renameSync(marker, `${marker}.${process.pid}.${randomUUID()}`); } catch { return null; } }
    try { writeFileSync(marker, '', { flag: 'wx', mode: 0o600 }); } catch { return null; }
    for (const name of names(store)) if (name.startsWith(`${MARKER}.`)) rmSync(join(store, name), { force: true });
    /** A positive configured number, or the default. */
    const setting = (value, fallback) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; };
    try { utimesSync(marker, new Date(now), new Date(now)); } catch { /* The marker's own time is close enough. */ }
    return pruneTestResults(root, {
      capBytes: setting(env.PULLBOARD_RUNNER_TEST_RESULTS_CAP_BYTES, RESULTS_CAP_BYTES),
      maxAgeMs: setting(env.PULLBOARD_RUNNER_TEST_RESULTS_MAX_AGE_MS, RESULTS_MAX_AGE_MS), held, now,
    });
  } catch { return null; }
}
