import { viewApiPorts } from '../../../view/index.js';

/** The view's API ports, handed on so the settings fixture reaches the view through this file, not directly. */
export { viewApiPorts };
/** Shared assertions and request helpers for local API fixtures. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { removeFixtureDirectory } from '../../../../packages/gate/tests/fixtures/diagnostics.js';
import { writeFileSync } from 'node:fs';
import { runFixtureChild } from './child.js';
import { runFixtureGit } from './child.js';
import { serveApi } from '../../../../packages/api/index.js';
import { createStateSnapshots } from '../../../../packages/api/index.js';
import { apiBoardOpeners } from './board.js';
import { withFixtureBoard } from './board.js';
import { main } from './native.js';
import { runCliInProcess } from './process.js';
import { runCliSync } from './sync/cli.js';
import { JOURNEY_MODE } from './e2e.js';
import { journeyCall } from './e2e.js';
import { parityRecord } from './e2e.js';
import { appendFileSync } from 'node:fs';
import { fixtureSettledMachine } from './testkit.js';
import { fixtureProjectPolicy } from './testkit.js';
import { refusalDocument } from '../../index.js';
import { JSON_SHAPES } from '../../../../packages/config/index.js';
import { fetchFresh } from './http.js';
import { startFixtureLocalRunner } from './runner/local-start.js';
import { whenRunnerSettles } from './runner/local-start.js';
import { CLI_ENTRY } from './runner/entry.js';
import { stopFixtureLocalRunner } from './runner/local-stop.js';
import { safeFixtureDiagnostic } from './child.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import {
  addItem as addBoardItem,
  appendFact,
  itemThread,
} from '../../../../packages/store/index.js';
import {
  HOST,
  installSshStandIn,
} from './runner/ssh.js';

/** Quote a literal executable path for the fixture hook's POSIX shim. */
export function shellWord(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Match one catalog field to its declared JSON value type. */
function hasType(value, type) {
  if (type.includes('|')) return type.split('|').some((part) => hasType(value, part));
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

/** Check one required-field map from JSON_SHAPES. */
function assertRequiredShape(value, required, label) {
  for (const [field, type] of Object.entries(required ?? {})) {
    assert.ok(Object.hasOwn(value, field), `${label} must include ${field}`);
    assert.ok(hasType(value[field], type), `${label}.${field} must be ${type}`);
  }
}

/** Send one bounded HTTP request to the fixture API on its own connection, authenticating by header unless overridden. */
function apiFetch(api, path, options = {}) {
  const { noSecret = false, ...requestOptions } = options;
  const headers = { ...(noSecret ? {} : { 'x-pullboard-key': api.secret }), ...requestOptions.headers };
  return fetchFresh(new URL(path, api.origin), { ...requestOptions, headers, signal: requestOptions.signal ?? AbortSignal.timeout(10_000) });
}

/** The milliseconds one awaited request takes, end to end. */
async function timedMs(work) { const started = performance.now(); await work(); return performance.now() - started; }

/** Parse and validate a versioned API refusal. */
async function apiError(response, status) {
  assert.equal(response.status, status);
  const document = await response.json();
  assertRequiredShape(document, JSON_SHAPES.error.required, 'HTTP error envelope');
  assertRequiredShape(document.error, JSON_SHAPES.errorFields, 'HTTP error');
  return document.error;
}

/** Read exactly the next non-comment server-sent event, preserving partial frames across chunks. */
async function nextSseEvent(reader, pending = { text: '' }) {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = pending.text.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = pending.text.slice(0, boundary);
      pending.text = pending.text.slice(boundary + 2);
      const id = /^id: (.+)$/m.exec(frame)?.[1];
      const data = [...frame.matchAll(/^data: (.+)$/gm)].map((match) => match[1]).join('\n');
      if (id !== undefined && data) return { id, document: JSON.parse(data) };
      continue;
    }
    const { done, value } = await reader.read();
    assert.equal(done, false, 'the live event stream remains open');
    pending.text += decoder.decode(value, { stream: true });
  }
}

export { apiFetch, apiError, assertRequiredShape, hasType, nextSseEvent, timedMs };

/** Build the actual HTTP fixture child's private terminal and Git identity. */
export function apiFixtureEnvironment(directory, bin) {
  const env = {
    ...process.env, HOME: join(directory, 'home'), PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(directory, 'home'),
    PULLBOARD_MACHINE_HOME: join(directory, 'machine-home'),
    // Fixture items carry near-identical titles; the duplicate check at add would refuse them.
    PULLBOARD_FIXTURE_ADD_DISTINCT: '1',
    PATH: bin + ':' + process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'HTTP Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'HTTP Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
  };
  for (const marker of AGENT_SHELL_MARKERS) delete env[marker];
  return env;
}

/** Capture one ambient pool per test, even when it creates several boards, and restore it at test teardown. */
const fixtureMachineTests = new WeakSet();

/** Bind in-process API commands as well as child commands to a fixture-owned machine pool. */
export function bindApiFixtureMachine(t, env) {
  if (!fixtureMachineTests.has(t)) {
    const previous = process.env.PULLBOARD_MACHINE_HOME;
    const markers = new Map(AGENT_SHELL_MARKERS.map(name => [name, process.env[name]]));
    for (const name of AGENT_SHELL_MARKERS) delete process.env[name];
    // In-process adds meet the duplicate guard too, so the fixture's distinct-title switch binds with the identity.
    // In-process landing commits merges; a runner has no Git identity of its own, so the fixture's identity binds here too.
    const identity = new Map(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'PULLBOARD_FIXTURE_ADD_DISTINCT'].map(name => [name, process.env[name]]));
    for (const name of identity.keys()) process.env[name] = env[name];
    fixtureMachineTests.add(t);
    t.after(() => {
      if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
      else process.env.PULLBOARD_MACHINE_HOME = previous;
      for (const [name, value] of [...markers, ...identity]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    });
  }
  process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
}

/**
 * Add an item at a route the way the board admits it: a light item is filed mid, then diagnosed by the coordinator.
 * Why: a light item needs a current diagnosis fact (#3120), so a direct light add refuses DIAGNOSIS_REQUIRED.
 */
export function addRoutedItem(board, fields) {
  const id = addBoardItem(board, { ...fields, route: fields.route === 'light' ? 'mid' : fields.route });
  if (fields.route === 'light') appendFact(board, id, { agentId: 'coordinator', kind: 'diagnosis', text: fields.brief });
  return id;
}

/** The board with its database wrapped so every statement run is listed, one entry per run. */
function boardWithStatements(board, statements) {
  const db = new Proxy(board.db, { get(target, key) {
    const value = target[key];
    if (key !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
    return sql => new Proxy(target.prepare(sql), { get(statement, name) {
      const method = statement[name];
      if (typeof method !== 'function') return method;
      return (...args) => { if (name === 'all' || name === 'get' || name === 'run') statements.push(String(sql)); return method.apply(statement, args); };
    } });
  } });
  return Object.assign(Object.create(board), { db });
}

/**
 * File `count` items on the fixture's board, then build its state from nothing as a server's first build does, listing the SQL
 * that build ran. A control runs the per-item thread read on a few items through the same counter.
 * Why: how many reads a cold build makes is the claim under test, and no build result shows it [C7,#8480].
 *
 * @param {{ root: string }} box - An apiHttpFixture.
 * @param {number} count - How many items to file before the build.
 * @returns {{ ids: number[], built: number[], statements: string[], control: string[], threads: Map<number, any[]>, expected: Map<number, any[]> }} The filed ids, the ids the build projected, the build's SQL, the control's, the built threads and itemThread's own.
 */
export function coldStateReads(box, count) {
  const file = join(box.root, '.git/pullboard/board.sqlite');
  const ids = withFixtureBoard(file, board => Array.from({ length: count }, (_, index) => addRoutedItem(board, { by: 'coordinator', lane: 'app', title: `cold build item ${index}`, criterion: 'The build reads its thread.', check: 'true', route: 'mid',
    brief: 'Files: app/cold.js\nTest: the cold build reads this thread with the rest in one pass.' })));
  const statements = [], control = [], built = [];
  const { openBoard: openFile, openBoardForRead: openForRead } = apiBoardOpeners;
  const openers = { ...apiBoardOpeners,
    openBoard: path => boardWithStatements(openFile(path), statements),
    openBoardForRead: path => { const opened = openForRead(path); return opened && boardWithStatements(opened, statements); } };
  const snapshots = createStateSnapshots({ projects: () => [{ root: box.root, name: 'HTTP fixture' }], viewPorts: viewApiPorts, boardOpeners: openers, onItemBuild: ({ itemId }) => built.push(itemId) });
  const record = snapshots.materialize({ id: 'cold-build', root: box.root }, { full: true });
  const threads = new Map(JSON.parse(record.full.json.join('0')).items.map(item => [item.id, item.thread]));
  const expected = new Map();
  withFixtureBoard(file, board => {
    for (const id of ids) expected.set(id, JSON.parse(JSON.stringify(itemThread(board, id))));
    for (const id of ids.slice(0, 5)) itemThread(boardWithStatements(board, control), id);
  });
  return { ids, built, statements, control, threads, expected };
}

/** File a light item through the CLI: `json` adds it mid and checks the add shape, then its own brief diagnoses it; returns the added document. */
export function addLightViaCli(json, box, cwd, args) {
  const added = json(box, cwd, 'add', args, 'add');
  const diagnosed = box.run(cwd, 'fact', String(added.item.item_id), 'diagnosis', args[args.indexOf('--brief') + 1], '--json');
  assert.equal(diagnosed.status, 0, diagnosed.stderr || diagnosed.stdout);
  return added;
}

/**
 * Register the SSH stand-in as the fixture's one runner, so a check baseline has a runner to measure on [A2,V2].
 * Why: a check baseline runs only on a registered runner (#2520), and an HTTP fixture has none until this is called.
 * The in-process API finds the stand-in through the test process's PATH, so that is bound here and restored at teardown.
 */
export function registerFixtureRunner(t, box) {
  const bin = join(box.dir, 'ssh-bin');
  const worker = join(box.dir, 'worker');
  const remoteHome = join(box.dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  for (const folder of [bin, worker, remoteHome, remoteMachineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests: join(box.dir, 'ssh-requests.jsonl') });
  const previousPath = process.env.PATH;
  const held = new Map(['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD'].map(name => [name, process.env[name]]));
  t.after(() => {
    process.env.PATH = previousPath;
    for (const [name, value] of held) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
  box.env.PATH = bin + ':' + box.env.PATH;
  process.env.PATH = bin + ':' + process.env.PATH;
  for (const name of held.keys()) { delete box.env[name]; delete process.env[name]; }
  box.cli(box.root, 'runner', 'add', HOST, '--slots', '1', '--browser', '1');
  box.cli(box.root, 'settings', 'gate.loadAwareDispatch', 'off');
}

/** Include a fixture CLI result's timing and JSON output when a named test step fails. */
export function fixtureCommandEvidence(step, result, env) {
  return `${step}\n${result.context}\nstdout: ${safeFixtureDiagnostic(result.stdout, env)}`;
}

/** Scope one real API command to its clone's exact existing environment fields, then restore them. */
export async function withApiCommandEnvironment(env, work) {
  const names = ['PATH', 'HOME', 'PULLBOARD_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = env[name];
    return await work();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}
const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/** Create a private, committed project, with an exact-build hook shim and no personal Git config. */
export function apiHttpFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-http-')));
  // A pulled submit starts the loopback local runner in this machine home; it stops before the sandbox goes, or it keeps writing into it.
  t.after(() => { stopFixtureLocalRunner(join(dir, 'machine-home')); removeFixtureDirectory(dir); });
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = apiFixtureEnvironment(dir, bin);
  bindApiFixtureMachine(t, env);
  // A fixture's submit settles the same way whatever the machine's dispatch default is, so the review it queues is ready [P7].
  fixtureSettledMachine(env.PULLBOARD_MACHINE_HOME);
  mkdirSync(env.HOME);
  /** Run Git only inside the private fixture. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  /** One real CLI process with a private environment: the fixture's process-mode path, so PULLBOARD_JOURNEY_MODE=process still runs every call for real [C7]. */
  const realRun = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  /**
   * This worktree's CLI with a private environment, answered synchronously by a warm worker thread (no node start-up), or as a real
   * process under PULLBOARD_JOURNEY_MODE=process; PULLBOARD_PARITY_RECORD appends each call's record for the parity check [C7].
   * Why: these are quick setup moves (init, add, fact, settings, runner add); none settles a pulled job, so none needs a process.
   */
  const run = (cwd, ...args) => {
    const result = JOURNEY_MODE === 'process' ? realRun(cwd, ...args) : runCliSync(args, { cwd, env });
    if (process.env.PULLBOARD_PARITY_RECORD) appendFileSync(process.env.PULLBOARD_PARITY_RECORD, `${JSON.stringify(parityRecord({ dir, env, cwd, args, result: { code: result.status, out: result.stdout, stderr: result.stderr } }))}\n`);
    return result;
  };
  /** Decode one versioned CLI result, failing with its refusal code and message when it did not succeed. */
  function decodeCli(result) {
    let reason = result.stderr;
    if (result.status !== 0 && result.stdout) {
      try {
        const response = JSON.parse(result.stdout);
        const error = response?.error;
        if (error && typeof error === 'object') {
          reason = [result.stderr, error.code, error.message].filter(Boolean).join('\n');
        }
      } catch { /* Keep the existing stderr-only diagnostic for non-JSON failures. */ }
    }
    assert.equal(result.status, 0, reason);
    return JSON.parse(result.stdout);
  }
  /** Decode one successful versioned CLI invocation without printing session links. */
  function cli(cwd, ...args) {
    return decodeCli(run(cwd, ...args, '--json'));
  }
  /** The same call answered by the production dispatcher in this process, without a node start-up [C7]. */
  async function cliLocal(cwd, ...args) {
    const called = [...args, '--json'];
    return decodeCli(await journeyCall({ dir, env, cwd, args: called, inProcess: () => runCliInProcess(called, { cwd, env }), real: () => realRun(cwd, ...called) }));
  }
  git('init', '-q', '-b', 'main');
  cli(root, 'init');
  // HTTP fixtures file "true" checks to move items, so they keep a board with no hold setting.
  const { checks: _hold, ...config } = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] }, review: { owns: [] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: private HTTP fixture');
  return { root, dir, env, cli, cliLocal, run, commit: git('rev-parse', 'HEAD').trim() };
}

/** Serve this fixture's explicit project, avoiding any registry outside its private home. */
export async function apiHttpBox(t, { includeMissing = false, onStateBuild, additionalProjects = [] } = {}) {
  const box = apiHttpFixture(t);
  // The in-process API runs the merge hook on this process's PATH, whose first pullboard is the test runner's refusal shim; put the fixture's real one first, restored at teardown.
  const previousPath = process.env.PATH;
  process.env.PATH = box.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, onStateBuild, projects: () => [...(includeMissing ? [{ root: join(box.dir, 'gone'), name: 'Missing fixture' }] : []), { root: box.root, name: 'HTTP fixture' }, ...additionalProjects] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  const origin = url.origin;
  /** Make a real HTTP call and decode its single versioned response. */
  async function call(path, value, headers = {}) {
    const response = await fetchFresh(origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const document = await response.json();
    assert.equal(document.version, 1);
    return { status: response.status, document };
  }
  const listed = await call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.equal(listed.document.boards.length, 1 + additionalProjects.length);
  const id = listed.document.boards.find((entry) => resolve(entry.root) === resolve(box.root)).id;
  assert.match(id, /^[0-9a-f]{32}$/);
  return { ...box, api, origin, key, id, call, path: '/api/v1/boards/' + id };
}

/** Commit work citing the item in the builder's checkout, so its submit carries a change against main. */
export function commitWork(box, seat, id) {
  // Each item builds on accepted main, never on an earlier unverified item's commit in the same checkout.
  runFixtureGit(['switch', '--detach', 'main'], { cwd: seat.path, env: box.env, stdio: 'pipe' });
  mkdirSync(join(seat.path, 'app'), { recursive: true });
  writeFileSync(join(seat.path, 'app', 'work-' + id + '.txt'), 'work for #' + id + '\n');
  runFixtureGit(['add', '-A'], { cwd: seat.path, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'feat: fixture work [G1]\n\nPullboard-Item: #' + id], { cwd: seat.path, env: box.env, stdio: 'pipe' });
}

/** Put the reviewer's checkout on the builder's submitted commit, as a review requires. */
export function checkOutSubmitted(box, builder, verifier) {
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: builder.path, env: box.env, stdio: 'pipe' }).toString().trim();
  runFixtureGit(['switch', '--detach', head], { cwd: verifier.path, env: box.env, stdio: 'pipe' });
}

/**
 * The full item without claimHealth, which the full state carries but neither the summary nor the detail does yet:
 * #3482 puts claimHealth in both, and this comparison then drops the helper.
 */
export function withoutClaimHealth({ claimHealth, ...rest }) {
  return rest;
}

/** A build brief a mid-route fixture item needs: the paths to touch and what the test asserts. */
export const FIXTURE_BRIEF = 'Files:\n- app/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- the fixture case passes';
/** The brief the summary case checks stays out of summaries and shows in the detail. */
export const DETAIL_BRIEF = 'Files:\n- app/fixture.js\nTest:\n- A brief only the detail carries';

/**
 * Submit one claimed item through the served board and wait for its pulled gate to settle.
 *
 * Why: a pulled submit leaves the item claimed until the host's local runner posts the gate receipt, so a review or a
 * snapshot read right after the move would see no submission [P7,N26].
 */
export async function submitSettled(t, box, move, id, agent) {
  if (!box.localRunnerStarted) {
    // The runner also pulls the board's automatic land job; a person lands by hand here, so accepted items stay accepted.
    const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
    fixtureProjectPolicy(box.root, { config: { ...config, landing: { ...config.landing, manualOverride: true } } });
    // Only policy committed to trunk grants the override (mainPolicy reads trunk), so commit it or the board still offers land jobs whose push fails and retries.
    runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env, stdio: 'pipe' });
    runFixtureGit(['commit', '-q', '-m', 'chore: fixture lands by hand'], { cwd: box.root, env: box.env, stdio: 'pipe' });
    startFixtureLocalRunner(box.env, box.root, { entry: CLI_ENTRY });
    box.localRunnerStarted = true;
  }
  const result = await move({ verb: 'submit', item: id, agent });
  await whenRunnerSettles(box.env, async () => {
    const row = (await box.call(box.path + '/state')).document.state.items.find((entry) => entry.id === id);
    return row.status === 'claimed' ? null : row;
  }, { deadlineMs: 60_000, what: `the pulled gate of #${id}` });
  return result;
}
