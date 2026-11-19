/** Which runner holds which installed worker runtime, so a launch sends an empty capsule instead of bytes it has [C7]. */
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { environmentAdapter } from '../../../env/index.js';
import { resolve } from 'node:path';

/** How long a runner's READY with a runtime vouches for it; past this the next launch sends the full capsule again. */
const HELD_MS = 24 * 60 * 60_000;
/** The capsule a launch sends when the runner already holds the runtime: the installer re-hashes its installed copy. */
export const REUSE_CAPSULE = 'REUSE';

/** This machine's record, in its machine home as gateMachineHome finds it (a machine or account home isolates tests). */
function heldFile(env = environmentAdapter().all()) {
  const home = env.PULLBOARD_MACHINE_HOME ? resolve(env.PULLBOARD_MACHINE_HOME) : join(resolve(env.PULLBOARD_ACCOUNT_HOME || homedir()), '.pullboard');
  return join(home, 'runner-runtimes.json');
}

/** The record by host then runtime digest, as epoch ms of the last READY; an unreadable record holds nothing. */
function readHeld() {
  try { const held = JSON.parse(readFileSync(heldFile(), 'utf8')); return held && typeof held === 'object' && !Array.isArray(held) ? held : {}; }
  catch { return {}; }
}

/** Replace the record atomically; a failed write only costs the next launch a full capsule. */
function writeHeld(held) {
  try {
    const file = heldFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(held), { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* The record is an optimization. */ }
}

/**
 * True when `host` reported READY with runtime `digest` within the last day. Why: the worker runtime travels in every
 * launch's capsule; a runner that already installed it under its digest needs none of those bytes (#4140).
 */
export function runtimeHeld(host, digest, now = Date.now()) {
  const at = readHeld()[host]?.[digest];
  return Number.isFinite(at) && now - at < HELD_MS;
}

/** Note that `host` ran runtime `digest` to READY, keeping only that host's recent digests. */
export function recordRuntimeHeld(host, digest, now = Date.now()) {
  if (typeof host !== 'string' || !host || !/^[a-f0-9]{64}$/u.test(digest ?? '')) return;
  const held = readHeld();
  const kept = Object.fromEntries(Object.entries(held[host] ?? {}).filter(([, at]) => Number.isFinite(at) && now - at < HELD_MS));
  held[host] = { ...kept, [digest]: now };
  writeHeld(held);
}

/** Forget that `host` holds runtime `digest`, so its next launch sends the full capsule. */
export function forgetRuntimeHeld(host, digest) {
  const held = readHeld();
  if (!held[host]?.[digest]) return;
  delete held[host][digest];
  writeHeld(held);
}
