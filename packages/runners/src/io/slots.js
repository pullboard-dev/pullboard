/** Runner slot counts computed from each runner's own measured cores and memory (opt-in gate.measuredSlots) [C7]. */
import { closeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { storeName } from './store-names.js';

/** One core stays free for the runner's worker and the operating system. */
export const RESERVED_CORES = 1;
/** Memory left to the operating system and the worker before any slot is counted. */
export const RESERVED_MEMORY_MB = 2048;
/** Memory one plain test slot is given. */
export const PLAIN_SLOT_MB = 512;
/** Memory one browser slot is given. */
export const BROWSER_SLOT_MB = 2048;

/**
 * Reserve one core and 2 GB. Total slots fit plain tests; each browser replacing a plain test reserves the extra
 * 1536 MB. A runner below either reserve offers zero computed capacity.
 * @param {{cores:number,memoryMB:number}} measured
 * @returns {{slots:number,browser:number}}
 */
export function computeRunnerSlots({ cores, memoryMB }) {
  if (!Number.isSafeInteger(cores) || cores < 1 || !Number.isSafeInteger(memoryMB) || memoryMB < 1) {
    throw new TypeError('runner cores and memory must be measured positive whole numbers');
  }
  const usableMB = Math.max(0, memoryMB - RESERVED_MEMORY_MB);
  const slots = Math.max(0, Math.min(cores - RESERVED_CORES, Math.floor(usableMB / PLAIN_SLOT_MB)));
  const browser = Math.max(0, Math.min(slots,
    Math.floor((usableMB - slots * PLAIN_SLOT_MB) / (BROWSER_SLOT_MB - PLAIN_SLOT_MB))));
  return { slots, browser };
}

/** True when the runner has a measurement and no declared fixed count. */
export function runnerIsComputed(runner) {
  return runner.fixed !== true && Number.isSafeInteger(runner.cores) && Number.isSafeInteger(runner.memoryMB);
}

/** The slot counts the gate offers for one runner: computed when enabled and measured, else the registered counts. */
export function effectiveRunner(runner, enabled) {
  if (!enabled || !runnerIsComputed(runner)) return runner;
  const computed = computeRunnerSlots(runner);
  // A browserless registration (browser 0) stays browserless; memory only ever lowers browser capacity.
  return { ...runner, slots: computed.slots, browser: runner.browser === 0 ? 0 : computed.browser };
}

/** Apply effectiveRunner to every registered runner under the machine's gate.measuredSlots setting. */
export function effectiveRunners(settings) {
  const enabled = settings.gate?.measuredSlots === true;
  return (settings.runners ?? []).map(runner => effectiveRunner(runner, enabled)).filter(runner => runner.slots > 0);
}

/** Fresh measurements are reused for five minutes; the next actual admission refreshes stale hosts. */
export const RUNNER_MEASUREMENT_MS = 5 * 60_000;

/**
 * Whether the gate reads live load (#2509): when gate.loadAwareDispatch is on, and by default once any runner
 * is measured; off only when set off. Why on by default: an overloaded runner fails every job it takes.
 * The gate's own gateRunnerLoadPolicy states the same rule.
 */
function liveLoadEnabled(settings) {
  const setting = settings?.gate?.loadAwareDispatch;
  return setting === true || setting !== false && (settings?.runners ?? []).some(runner => Number.isSafeInteger(runner?.cores));
}

/** A shared probe result younger than this is every waiting gate's answer; no new probe starts. */
export const RUNNER_PROBE_SHARE_MS = 15_000;
/** A failed probe holds that runner's next attempt back this long, across every gate process. */
export const RUNNER_PROBE_BACKOFF_MS = 60_000;
/** How long a waiter stands behind an in-flight probe for its shared result before skipping this pass. */
export const RUNNER_PROBE_WAIT_MS = 5_000;
/** An in-flight probe older than this is presumed dead and its claim may be taken over. */
const RUNNER_PROBE_STALE_MS = 60_000;

/** Read a small JSON file, or null when it is absent or half-written. */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Whether a runner's last shared probe outcome still answers for it: fresh success, or a failure inside its backoff. */
function shareCurrent(state, now) {
  const at = Number(state?.at);
  // A process that read its clock a moment before the prober finished sees a result stamped slightly ahead; that is current, not stale.
  if (!Number.isFinite(at) || at - now > RUNNER_PROBE_STALE_MS) return false;
  return Math.max(0, now - at) < (state.failed ? RUNNER_PROBE_BACKOFF_MS : RUNNER_PROBE_SHARE_MS);
}

/** A waiter behind an in-flight probe polls its recorded outcome for up to waitMs, then gives up with null. */
async function waitForShared(state, now, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 25));
    const finished = readJson(state);
    if (shareCurrent(finished, now)) return { shared: finished };
  }
  return null;
}

/**
 * Whether a probe claim is still held. A claim whose owner record is not yet written (empty or unreadable) is held until its file is older than the stale interval.
 * Why: the claim is created before its owner record is written, and reading that window as stale let a second process probe the same runner (#3112).
 */
function claimHeld(lock, now) {
  const held = readJson(lock), at = Number(held?.at);
  if (Number.isFinite(at)) return now >= at && now - at < RUNNER_PROBE_STALE_MS;
  try { return Date.now() - statSync(lock).mtimeMs < RUNNER_PROBE_STALE_MS; } catch { return false; }
}

/**
 * Claim the one in-flight probe for a runner across processes with an exclusive create; a claim left by a dead probe
 * is taken over once it is stale. A caller that passes no probeDirectory probes unshared, as before. Returns {shared} (the recorded outcome) when one is current, {settle} (the release function) when this process now probes, or null when another process is probing.
 * Why cross-process: every waiting gate is its own process, and each one probing every runner made SSH login storms (#3112).
 */
async function claimProbe(directory, host, now, waitMs) {
  const key = createHash('sha256').update(host).digest('hex').slice(0, 24);
  const state = join(directory, storeName(key)), lock = join(directory, `${key}.lock`);
  const current = readJson(state);
  if (shareCurrent(current, now)) return { shared: current };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { closeSync(openSync(lock, 'wx', 0o600)); writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now })); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt > 0 || claimHeld(lock, now)) return await waitForShared(state, now, waitMs);
      try { unlinkSync(lock); } catch (gone) { if (gone.code !== 'ENOENT') throw gone; }
    }
  }
  // Another process may have finished between the first read and this claim.
  const finished = readJson(state);
  if (shareCurrent(finished, now)) { try { unlinkSync(lock); } catch { /* A claim already gone needs no release. */ } return { shared: finished }; }
  return { settle: (failed, facts) => {
    const temporary = `${state}.${process.pid}.tmp`;
    try { writeFileSync(temporary, JSON.stringify({ at: now, failed, ...(facts ? { facts } : {}) })); renameSync(temporary, state); }
    finally { try { unlinkSync(lock); } catch { /* A claim already gone needs no release. */ } }
  } };
}

/**
 * Refresh outside resource admission; only an authenticated healthy nonce can replace measured facts.
 * At most one probe per runner runs at a time across every gate process, a result is shared for 15 s and a failure
 * backs that runner off for 60 s (#3112); a waiter that skips records the shared result itself, so every waiter ends with the measured facts.
 */
export async function refreshRunnerMeasurements(settings, { measure, record, now = Date.now(), probeDirectory, waitMs = RUNNER_PROBE_WAIT_MS }) {
  const cpu = liveLoadEnabled(settings);
  if (settings.gate?.measuredSlots !== true && !cpu) return;
  if (typeof measure !== 'function' || typeof record !== 'function') throw new TypeError('runner measurement requires canonical transport and persistence');
  await Promise.all((settings.runners ?? []).map(async runner => {
    /** Accept only a nonfuture observation within its own freshness interval. */
    const fresh = (value, interval) => {
      const at = Date.parse(value);
      return Number.isFinite(at) && now >= at && now - at < interval;
    };
    // A busy observation can refresh CPU load without updating capacity. Retry stale capacity after the lease ends.
    const loadFresh = !cpu || fresh(runner.cpuLoad?.at, RUNNER_PROBE_SHARE_MS);
    const sizeFresh = settings.gate?.measuredSlots !== true || fresh(runner.measuredAt, RUNNER_MEASUREMENT_MS);
    if (loadFresh && sizeFresh) return;
    let claim;
    try { claim = typeof probeDirectory !== 'string' ? { settle() {} } : await claimProbe(probeDirectory, String(runner.host), now, waitMs); }
    catch { return; /* An unwritable probe directory skips this pass rather than probing unshared. */ }
    if (!claim) return;
    if (claim.shared) { if (claim.shared.facts) record(runner.host, claim.shared.facts); return; }
    const { settle } = claim;
    let failed = true, facts;
    try {
      const observed = await measure(runner, { observeGui: true, ...(cpu ? { observeLoad: true } : {}) });
      if (!observed.healthy || !Number.isSafeInteger(observed.cores) || observed.cores < 1
          || !Number.isSafeInteger(observed.memoryMB) || observed.memoryMB < 1) return;
      facts = { cores: observed.cores, memoryMB: observed.memoryMB,
        measuredAt: new Date(now).toISOString(), gui: observed.gui, ...(observed.cpuLoad ? { cpuLoad: observed.cpuLoad } : {}) };
      record(runner.host, facts);
      failed = false;
    } catch { /* Failed or busy observations preserve prior facts and every transport recovery obligation. */ }
    finally { try { settle(failed, failed ? undefined : facts); } catch { /* The shared outcome is advisory; its loss only allows one more probe. */ } }
  }));
}
