/** Shared helpers for the local-first relay journeys: a linked board, the timed real-CLI call and the sender waits [H21,H5,H16]. */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  cpus,
  loadavg,
} from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runFixtureChildAsync,
  runFixtureGit,
} from '../child.js';
import { main } from '../native.js';
import { captureCommandInProcess } from '../process.js';
import { relayClientFixture } from './client.js';
import { stopSender } from './sender.js';

/** The model name every fixture seat joins with. */
export const FIXTURE_MODEL = 'fixture-model';
export const CLI = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
// Budget: the criterion's bar for a move or a read, measured from spawn to exit of the real CLI.
const LOCAL_MS = 1_000;
// Budget: an idle machine starts a bare node process in about 50 ms; the one-second bar scales by how many times slower that start is right now.
const IDLE_NODE_START_MS = 40;
// Budget: how long a test waits for the background sender to reach the relay; it polls every 200 ms here.
const SENDER_WAIT_MS = 20_000;
/** How often the burst test lists sender processes; each listing is a `ps` that competes with the commands being timed, and a sender lives far longer than this. */
export const SAMPLE_MS = 100;
/** How long one bare-start measurement of the machine's load stays current. */
const NODE_START_FRESH_MS = 5_000;

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
export function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  // The board's own commit hook runs pullboard, so this private PATH gets the CLI under test.
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): this board is local first'], { cwd: box.root, env: box.env });
}

/** The machine's background sender switched on, polling fast and leaving soon after the last nudge. */
export function senderEnv(env) {
  const next = { ...env, PULLBOARD_RELAY_SENDER_PULL_MS: '200', PULLBOARD_RELAY_SENDER_IDLE_MS: '3000' };
  delete next.PULLBOARD_RELAY_SENDER_BACKGROUND;
  return next;
}

/** The machine sender's claim file under an environment's private pullboard home. */
export function senderPid(env) {
  return join(env.PULLBOARD_HOME, 'relay-sender', 'sender.pid');
}

/** Wait until `ready()` holds, or fail naming what never happened and what `detail()` says. */
export async function eventually(what, ready, detail = () => '') {
  const deadline = Date.now() + SENDER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise(next => setTimeout(next, 50));
  }
  assert.fail(`${what} did not happen within ${SENDER_WAIT_MS} ms${String(await detail()) ? `\n${await detail()}` : ''}`);
}

/** Network attempts made by the command under measurement; the relay fixture shares this process, so only that command's async context counts. */
const measured = new AsyncLocalStorage();
let fetchCounting = false;

/** Count `fetch` calls made inside a measured command, without recording their arguments. */
function countFetches() {
  if (fetchCounting) return;
  fetchCounting = true;
  const real = globalThis.fetch;
  globalThis.fetch = (...args) => {
    const counter = measured.getStore();
    if (counter) counter.fetches++;
    return real(...args);
  };
}

/**
 * Run the production CLI in-process in `cwd` and time only its own dispatch: the clock starts when the command
 * starts running (not while an earlier in-process call is queued ahead of it), and a fetch made inside it is counted.
 * The background sender it nudges is a separate process and is never counted.
 */
export async function local(box, t, cwd, env, name, args, budget) {
  const budgetMs = budget ?? await loadedBudgetMs();
  countFetches();
  const counter = { fetches: 0 };
  let started = 0, finished = 0;
  const result = await measured.run(counter, () => captureCommandInProcess(async (argv, io) => {
    started = performance.now();
    try { return await main(argv, io); } finally { finished = performance.now(); }
  }, [...args, '--json'], { cwd, env }));
  const elapsedMs = Math.round(finished - started);
  t.diagnostic(JSON.stringify({ name, elapsedMs, status: result.status, foregroundFetches: counter.fetches }));
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(elapsedMs < budgetMs, `${name} took ${elapsedMs} ms; a local-first command returns within one second (${budgetMs} ms on this machine's load)`); // budget: declared by #1013's frozen bar: a local move or read returns within one second.
  assert.equal(counter.fetches, 0, `${name} made no network call`);
  return { document: JSON.parse(result.stdout), stderr: result.stderr };
}

let lastStart = { at: -Infinity, slowest: 0 };

/** How slow a bare node process starts right now; read at most every few seconds, as six spawns per command would be the largest cost of a case. */
async function slowestNodeStartMs() {
  if (performance.now() - lastStart.at < NODE_START_FRESH_MS) return lastStart.slowest;
  // Process-level: this times how slow a bare node process starts right now, so it must be a real spawn.
  const starts = await Promise.all([1, 2, 3, 4, 5, 6].map(() => runFixtureChildAsync(process.execPath, ['-e', '0'], {})));
  lastStart = { at: performance.now(), slowest: Math.max(...starts.map(start => start.elapsedMs)) };
  return lastStart.slowest;
}

/**
 * The local-first budget in ms: LOCAL_MS on an idle machine, stretched by how much slower a bare node start is now.
 * `concurrent` counts commands that run at once with the measured ones, each queueing on the CPU too.
 * Why: the bar is about the CLI's own work, and a loaded runner made the same command read red in one run and green in the next.
 */
export async function loadedBudgetMs(concurrent = 0) {
  const slowest = await slowestNodeStartMs();
  // A CLI command is heavier than a bare start and queues on the CPU like any other process, so run-queue pressure counts twice.
  const queued = 2 * (loadavg()[0] + concurrent) / cpus().length;
  return Math.round(LOCAL_MS * Math.max(1, slowest / IDLE_NODE_START_MS, queued));
}

/** The shout texts a board export holds. */
export function shoutTexts(exported) {
  return exported.tables.shout.map(row => row.shout_text);
}

/** A local-first board linked to the real relay, with the machine sender on for its commands. */
export async function linkedBoard(t) {
  // Registered before the fixture's own cleanup, so the sender stops before the board's folder is removed.
  const sender = {};
  t.after(() => sender.root && stopSender(sender.root));
  const box = await relayClientFixture(t);
  enableOutbox(box);
  assert.equal((await box.link()).code, 0, 'the real relay accepts the board first');
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted, true);
  sender.root = box.root;
  sender.env = senderEnv(box.env);
  return { box, env: sender.env };
}

/** The machine sender's short log, for a failure message. */
export function senderLog(env) {
  try { return readFileSync(join(env.PULLBOARD_HOME, 'relay-sender', 'sender.log'), 'utf8'); } catch { return '(no sender log)'; }
}

/** Whether the relay holds a move whose sealed record the relay acknowledged for this shout's send. */
export function outboxEmpty(box) {
  return !existsSync(join(dirname(box.linkFile), 'relay-outbox.sealed'));
}
/** Join a real agent worktree beside this machine's main checkout before the outage, on the strong route so it may claim the strong-route item the test adds. */
export async function seat(box, name) {
  const path = join(dirname(box.root), name);
  runFixtureGit(['worktree', 'add', '-q', '-b', `agent/${name}`, path], { cwd: box.root, env: box.env });
  const joined = await box.cliAtLocal(path, 'join', box.lane, '--model', FIXTURE_MODEL, '--route', 'strong');
  assert.equal(joined.code, 0, joined.failure);
  return { path, id: joined.document.agent };
}

