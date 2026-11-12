/** Prove concurrent landing gates against actual private Git, SQLite and gate subprocesses [B3,V4]. */
import { executionServicesSource } from '../gate/execution.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runFixtureChild,
  startFixtureChild,
} from '../child.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { GATE_SLOT_HELD_ENV } from '../../../../../packages/resources/index.js';
import { GATE_SLOT_POOL_ENV } from '../../../../../packages/resources/index.js';
import { GATE_SLOT_TOKEN_ENV } from '../../../../../packages/resources/index.js';
import { BROWSER_SLOT_HELD_ENV } from '../../../../../packages/resources/index.js';
import { waitForFixtureProgress } from '../progress.js';
/** Read append-only subprocess markers; each completed line is one independently observed transition. */
function markers(path) { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }

/** Add a bounded peer barrier to the existing real gate, leaving its TAP and red-item behavior intact. */
function observeGates(box) {
  const file = JSON.parse(box.gate.slice(5));
  const original = readFileSync(file, 'utf8');
  const trace = join(box.dir, 'parallel-gate-events.jsonl');
  const armed = join(box.dir, 'parallel-gates-armed');
  writeFileSync(trace, '');
  const observe = [
    '(function () {',
    "const fs = require('node:fs');",
    `const trace = ${JSON.stringify(trace)}; const armed = ${JSON.stringify(armed)};`,
    "if (!fs.existsSync(armed) || process.argv.includes('--alone')) return;",
    "const root = process.cwd(); const pid = process.pid; const files = fs.readdirSync(root + '/web').filter(name => /^land-[0-9]+\\.test\\.js$/.test(name)).sort();",
    "const tree = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();",
    "const badgeFile = root + '/docs/badges/items.json'; const badgeMessage = fs.existsSync(badgeFile) ? JSON.parse(fs.readFileSync(badgeFile, 'utf8')).message : null;",
    "const mark = phase => fs.appendFileSync(trace, JSON.stringify({ phase, root, pid, files, tree, badgeMessage, at: Date.now() }) + '\\n');",
    "mark('start'); process.on('exit', () => mark('end'));",
    // Budget: a deterministic rendezvous ceiling, not a performance requirement. Serial code exits
    // this barrier without a peer and is rejected by the parent’s overlap assertion.
    'const deadline = Date.now() + 3000;',
    "while (Date.now() < deadline) { const rows = fs.readFileSync(trace, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)); const active = new Map(); for (const row of rows) { if (row.phase === 'start') active.set(row.pid, row.root); else active.delete(row.pid); } if (new Set(active.values()).size >= 2) break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }",
    // Keep both peers observably live after rendezvous, without asserting a wall-clock budget.
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);',
    '})();',
  ].join('\n');
  writeFileSync(file, `${observe}\n${original}`);
  return { trace, armed };
}

/** Execute the public batch engine with an explicit configuration, bypassing only CLI config parsing.
 * This lets the BEFORE reach the absent scheduling behavior even before the new option is recognized.
 * The private board has no competing landing owner; every board transition uses its normal public writer.
 */
function runBatch(box, enabled) {
  const source = [
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../lib/index.js')).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/config/src/io/main.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const root = process.argv[1]; const enabled = process.argv[2] === "true";',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'try { const config = loadConfig(root); config.landing = { ...config.landing, parallel: enabled };',
    'const result = await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config, owner: "coordinator", maximum: 3, write: async (operation, args) => board.enginePorts.store[operation](board, ...args), say: () => {}, checkLease: async () => {}, checkLeaseNow: () => {} });',
    'console.log(JSON.stringify(result)); } finally { store.closeBoard(board); }',
  ].join('\n');
  const env = { ...box.env };
  for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete env[key];
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(enabled)], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.failure ?? result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

/** Check the largest number of simultaneous actual gate PIDs in distinct candidate worktrees. */
function overlap(rows) {
  const active = new Map();
  let maximum = 0;
  for (const row of rows) {
    if (row.phase === 'start') active.set(row.pid, row.root); else active.delete(row.pid);
    maximum = Math.max(maximum, new Set(active.values()).size);
  }
  assert.equal(active.size, 0, 'all observed gate children ended before the landing returned');
  return maximum;
}

/** Land A and C while returning the actual red B; enabled and disabled modes share the same assertions. */
export function assertParallelLanding({ landProject, itemWorktree, submitItem, acceptItem, json }) {
  for (const enabled of [true, false]) {
    const box = landProject();
    const observed = observeGates(box);
    mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    // This is the private fixture’s own pool, never a setting on the user's machine.
    writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 2 }));
    box.env.LAND_SUPPRESS_RED = '1';
    const entries = [1, 2, 3].map(number => itemWorktree(box, number));
    for (const [index, entry] of entries.entries()) submitItem(box, entry, index === 1 ? 'RED\n' : 'PASS\n');
    for (const entry of entries) acceptItem(box, entry);
    delete box.env.LAND_SUPPRESS_RED;
    writeFileSync(observed.armed, 'armed');
    const result = runBatch(box, enabled);
    assert.deepEqual(result.landed, [entries[0].item, entries[2].item], 'green A and independent C land while B is returned');
    assert.deepEqual(result.culprits.map(row => row.id), [entries[1].item]);
    assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_status, 'open');
    assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
    assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
    const rows = markers(observed.trace);
    const maximum = overlap(rows);
    if (enabled) {
      assert.ok(maximum >= 2, 'candidate gates execute concurrently in distinct worktrees');
      const starts = rows.filter(row => row.phase === 'start');
      const sets = starts.map(row => row.files.join(','));
      assert.ok(starts.every(row => /^[a-f0-9]{40,64}$/u.test(row.tree)), 'each observed gate identifies its actual tested tree');
      assert.equal(new Set(starts.map(row => row.tree)).size, starts.length, `no exact tree is gated twice: ${JSON.stringify(starts)}`);
      for (const wanted of ['land-1.test.js', 'land-1.test.js,land-2.test.js', 'land-1.test.js,land-2.test.js,land-3.test.js']) {
        assert.equal(starts.filter(row => row.files.join(',') === wanted && row.badgeMessage === '3 items').length, 1,
          `each initial exact prefix executes once: ${wanted}; ${JSON.stringify(starts)}`);
      }
      const aTrees = starts.filter(row => row.files.join(',') === 'land-1.test.js');
      if (aTrees.length > 1) {
        // Returning B changes real committed badge content. A new A tree is a necessary matched
        // control for A+C; the old green three-item badge cannot prove the two-item projection.
        assert.equal(aTrees.length, 2, JSON.stringify(starts));
        assert.deepEqual(new Set(aTrees.map(row => row.badgeMessage)), new Set(['3 items', '2 items']));
        assert.deepEqual(box.git(box.repo, 'diff', '--name-only', aTrees[0].tree, aTrees[1].tree).split('\n'), ['docs/badges/items.json']);
      }
      assert.equal(sets.filter(value => value === 'land-1.test.js,land-3.test.js').length, 1, 'C is checked once on A, with no serial retry or pre-push rerun');
      assert.equal(sets.filter(value => value === 'land-2.test.js').length, 1, 'the distinct B-alone control confirms culpability rather than blaming an interaction');
    } else assert.equal(maximum, 1, 'the default serial behavior remains serial');
  }
}

/** Configure only the private project's accepted trunk before creating its submitted items. */
function parallelCliProject(landProject) {
  const box = landProject();
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  // Capacity belongs only to this sandbox's independent machine home, never the user's pool.
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 2 }));
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.landing = { ...config.landing, parallel: true };
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private parallel landing');
  return box;
}

/** Observe a real CLI landing without replacing its configuration, lease or in-process landing callbacks. */
function startParallelCli(box, BIN) {
  const startup = join(box.dir, 'parallel-cli-startup.jsonl');
  const env = { ...box.env, PULLBOARD_STARTUP_TRACE_FILE: startup, PULLBOARD_STARTUP_TRACE_ENTRY: BIN };
  for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete env[key];
  const child = startFixtureChild(process.execPath, [BIN, 'land', '--json'], {
    cwd: box.repo, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const closed = new Promise(resolveClose => {
    child.once('error', error => resolveClose({ error }));
    child.once('close', (code, signal) => resolveClose({ code, signal, stdout, stderr }));
  });
  // Count observed CLI and gate-marker bytes while the real candidates are being prepared.
  const progress = () => stdout.length + stderr.length + [startup, box.calls, box.trace].reduce((bytes, file) =>
    bytes + (file && existsSync(file) ? readFileSync(file).length : 0), 0);
  return { child, closed, progress };
}

/** Exercise real CLI opt-in and authority loss on separate private, normally verified projects. */
export async function assertParallelCliLease({ landProject, itemWorktree, submitItem, acceptItem, onBoard, BIN }) {
  for (const loseLease of [false, true]) {
    const box = parallelCliProject(landProject);
    const entries = [1, 2].map(number => itemWorktree(box, number));
    for (const entry of entries) submitItem(box, entry);
    for (const entry of entries) acceptItem(box, entry);
    const localBefore = box.git(box.repo, 'rev-parse', 'main');
    const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
    writeFileSync(box.hold, 'armed');
    const running = startParallelCli(box, BIN);
    let terminal;
    let observationError;
    let held;
    let batch;
    try {
      await waitForFixtureProgress({ child: running.child, ready: () => existsSync(box.entered),
        progress: running.progress, description: 'the parallel CLI entered its real gate',
        quietMs: 120_000 });
      ({ held, batch } = onBoard(box, board => ({ held: store.landingLeaseState(board).holder,
        batch: store.landingBatches(board).at(-1) })));
      // The landing runs as a drive job inside the command's own process (no guardian process), so the grant names that process.
      assert.ok(held && Number.isSafeInteger(held.pid) && held.pid > 0, 'the landing lease is held by an actual process');
      assert.doesNotThrow(() => process.kill(held.pid, 0), 'the process holding the grant is still alive');
      assert.equal(held.branch, batch.branch);
      assert.ok(Number.isSafeInteger(held.generation) && held.generation > 0);
      assert.equal(batch.parallelCandidates.length, 2, 'the CLI parsed the committed opt-in and dispatched both prefixes');
      assert.equal(new Set(batch.parallelCandidates.map(candidate => candidate.snapshot.root)).size, 2);
      if (loseLease) {
        // This private fixture owns the observed invocation. Release its actual public grant;
        // no SQL, invented token, elapsed-clock override, takeover identity or signal is used.
        onBoard(box, board => store.landingLeaseMove(board, { agentId: 'coordinator', action: 'release',
          token: held.token, generation: held.generation, branch: held.branch, pid: held.pid }));
        assert.equal(onBoard(box, board => store.landingLeaseState(board).holder), null);
      }
    } catch (error) { observationError = error; }
    finally {
      // Always release the cooperative gate. Any authority-loss cancellation is the product
      // guardian's own fenced shutdown; this test never signals an arbitrary process/group.
      writeFileSync(box.release, 'release');
      terminal = await running.closed;
    }
    if (observationError) throw new Error(`${observationError.message}\n${terminal.stdout}\n${terminal.stderr}`, { cause: observationError });
    assert.equal(terminal.error, undefined);
    assert.equal(terminal.signal, null, terminal.stderr);
    const result = JSON.parse(terminal.stdout);
    const snapshot = onBoard(box, board => ({ holder: store.landingLeaseState(board).holder,
      batch: store.landingBatches(board).find(row => row.id === batch.id), events: store.events(board),
      statuses: entries.map(entry => store.getItem(board, entry.item).item_status) }));
    assert.equal(snapshot.holder, null, 'the CLI leaves no live landing grant');
    if (loseLease) {
      assert.notEqual(terminal.code, 0, terminal.stderr);
      assert.equal(result.error?.code, 'LAND_LEASE_LOST', terminal.stdout);
      assert.equal(box.git(box.repo, 'rev-parse', 'main'), localBefore);
      assert.equal(box.git(box.remote, 'rev-parse', 'main'), remoteBefore);
      assert.equal(snapshot.events.filter(event => event.event_kind === 'main-moved').length, 0);
      assert.deepEqual(snapshot.batch.culprits ?? [], [], 'authority loss attributes no item failure');
      assert.deepEqual(snapshot.statuses, ['verified', 'verified']);
    } else {
      assert.equal(terminal.code, 0, terminal.stderr);
      assert.deepEqual(result.landed, entries.map(entry => entry.item));
      assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
      assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
      assert.equal(snapshot.events.filter(event => event.event_kind === 'main-moved').length, 1);
      assert.equal(snapshot.batch.state, 'landed');
    }
  }
}

/** Prove nested parallel refusal under a real private live gate grant through both public entries. */
export function assertParallelNestedGate({ landProject, itemWorktree, submitItem, acceptItem, onBoard, BIN }) {
  const box = parallelCliProject(landProject);
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  const before = { main: box.git(box.repo, 'rev-parse', 'main'), remote: box.git(box.remote, 'rev-parse', 'main'),
    calls: readFileSync(box.calls, 'utf8'), batches: onBoard(box, board => store.landingBatches(board)),
    paths: existsSync(join(box.repo, '.git', 'pullboard', 'landings'))
      ? readdirSync(join(box.repo, '.git', 'pullboard', 'landings'), { recursive: true }).sort() : null };
  /** Resolve the running installed source for a real private controller child. */
  const url = name => pathToFileURL(join(import.meta.dirname, '../../../../..', name)).href;
  const direct = [
    `import * as store from ${JSON.stringify(url('packages/store/index.js'))};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../lib/index.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const root = process.argv[1]; const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, owner: "private-nested-api", write: async (operation, args) => board.enginePorts.store[operation](board, ...args), say: () => {} }); console.log(JSON.stringify({ code: null })); }',
    'catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); } finally { store.closeBoard(board); }',
  ].join('\n');
  const controller = [
    "import assert from 'node:assert/strict';",
    `import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/index.js')).href)}`,
    `import { gateSlotEnvironment, holdsLease } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/resources/index.js')).href)};`,
    `import { runFixtureChild } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../child.js')).href)};`,
    'const [root, bin] = process.argv.slice(1); let owned;',
    'await withGateSlot(root, async lease => { owned = lease; const env = { ...process.env, ...gateSlotEnvironment(lease) };',
    'assert.equal(holdsLease(lease), true);',
    'const cli = runFixtureChild(process.execPath, [bin, "land", "--json"], { cwd: root, env, encoding: "utf8" });',
    'assert.notEqual(cli.status, 0); assert.equal(JSON.parse(cli.stdout).error?.code, "LAND_PARALLEL_NESTED_GATE");',
    'assert.equal(holdsLease(lease), true, "the CLI refusal cannot release its caller grant");',
    `const api = runFixtureChild(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(direct)}, root], { cwd: root, env, encoding: "utf8" });`,
    'assert.equal(api.status, 0, api.stderr); assert.equal(JSON.parse(api.stdout).code, "LAND_PARALLEL_NESTED_GATE");',
    'assert.equal(holdsLease(lease), true, "the API refusal cannot release its caller grant");',
    '}, { executionServices, browser: false, remote: false, agent: "coordinator", kind: "check" });',
    'assert.equal(holdsLease(owned), false, "only the actual owner releases the grant when its action ends");',
    'console.log(JSON.stringify({ cli: "LAND_PARALLEL_NESTED_GATE", api: "LAND_PARALLEL_NESTED_GATE", ownerReleased: true }));',
  ].join('\n');
  const env = { ...box.env };
  for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete env[key];
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', controller, box.repo, BIN], {
    cwd: box.repo, env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.failure ?? result.stderr}\n${result.stdout}`);
  assert.deepEqual(JSON.parse(result.stdout), { cli: 'LAND_PARALLEL_NESTED_GATE', api: 'LAND_PARALLEL_NESTED_GATE', ownerReleased: true });
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), before.main);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), before.remote);
  assert.equal(readFileSync(box.calls, 'utf8'), before.calls, 'neither entry launches a candidate gate');
  assert.deepEqual(onBoard(box, board => store.landingBatches(board)), before.batches, 'no new candidate batch is persisted');
  const paths = existsSync(join(box.repo, '.git', 'pullboard', 'landings'))
    ? readdirSync(join(box.repo, '.git', 'pullboard', 'landings'), { recursive: true }).sort() : null;
  assert.deepEqual(paths, before.paths, 'neither entry creates candidate paths');
}
