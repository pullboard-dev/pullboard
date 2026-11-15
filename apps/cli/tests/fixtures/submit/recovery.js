/** Shared helpers for the pulled gate recovery journeys: the fixture's check processes, its runner and its gate job [V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  document,
  gateJob,
  state,
} from './handoff.js';
import { startFixtureLocalRunner } from '../runner/local-start.js';

/** The pids of this fixture's own frozen check processes that are still running, read from the process table. */
export function checkPids(box) {
  try { return execFileSync('pgrep', ['-f', join(box.dir, 'gate.cjs')], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); }
  catch (error) { if (error.status === 1) return []; throw error; }
}

/** Whether a process is gone; any other signal error leaves it presumed alive. */
export function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** How many claims and receipts the job has recorded: one claim per runner that took it, one receipt per terminal result. */
export function transitions(view) {
  return ['claimed', 'receipt'].map(name => view.steps.filter(step => step.name === name).length);
}

/** Count the lines a fixture gate wrote to one of its marker files. */
export function lines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

/** The pid of the machine's local runner, which holds the gate job's lease under pull, from its own state file. */
export function runnerPid(box) {
  return JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'state.json'), 'utf8')).pid;
}

/**
 * Start a fresh local runner for the fixture's machine, as the next pull submit would; the fixture removes it with the sandbox.
 * Why the shared starter: it is never this test's own child, so a stop does not wait on an unreaped zombie (HOW TO MIGRATE 8a).
 */
export function freshRunner(box) {
  return startFixtureLocalRunner(box.env, box.repo).pid;
}

/** Wait for a condition; a miss names the gate job and the runner log, so a stalled step says where it stopped. */
export async function until(box, check, label, ms) {
  try { await box.helpers.waitFor(check, label, ms); }
  catch (error) {
    const log = join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'runner.log');
    const view = gateJob(box);
    throw new Error(`${error.message}\njob: ${JSON.stringify(view && { step: view.step, attempt: view.attempt, leaseOwner: view.leaseOwner, steps: view.steps.map(step => step.name) })}`
      + `\nitem: ${state(box, box.id).item.item_status}\nrunner log:\n${existsSync(log) ? readFileSync(log, 'utf8').slice(-2000) : '(none)'}`);
  }
}

/** Submit the captured item and wait until its runner has the gate job and the captured check is running. */
export async function runningGate(box) {
  // The gate holds on its release file until the test lets it go, so the submit command must not wait for the queue to settle.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  const queued = document(await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  await until(box, () => existsSync(box.started) && checkPids(box).length > 0, 'the captured check is running', 60000); // budget: observed gate start ceiling, not a timing assertion.
  const job = gateJob(box);
  assert.equal(job.step, 'claimed', 'a runner holds the gate job');
  return job;
}

/** Wait until the board records the gate job's receipt and the item is submitted for review. */
export async function submitted(box) {
  await until(box, () => state(box, box.id).item.item_status === 'submitted', 'the resumed gate job submits the item', 50000); // budget: pulled gate settle ceiling, not a timing assertion.
}
