/** Accepted cell inventory is built off submit, reused by tree, and transferred as bounded evidence [C7]. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computePlan } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { touchedCells } from '../../index.js';
import { cellsAuditBacklog } from '../../../../packages/codemap/src/io/cells/backlog.js';
import { inventoryBuildCount } from '../../../../packages/codemap/index.js';
import { validateAcceptedInventory } from '../../../../packages/codemap/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { readAcceptedCells } from '../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { analysisArtifactDescriptor } from '../../../../packages/resources/index.js';
import { readAnalysisArtifact } from '../../../../packages/resources/index.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';

/** Keep machine-wide cache writes in a disposable directory and restore the invoking process's setting. */
function isolateMachine(t) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  const directory = mkdtempSync(join(tmpdir(), 'cells-submit-machine-'));
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Resolve a possibly new write target through its nearest existing ancestor for safe path comparisons. */
function physicalPath(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return null;
  let path = resolve(value), tail = [];
  while (true) {
    try { return join(fs.realpathSync(path), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      tail.unshift(basename(path)); path = parent;
    }
  }
}

/** Record actual parent-process filesystem mutations while forwarding every operation unchanged. */
async function observeWrites(work) {
  const writes = [], originals = new Map(), descriptors = new Map();
  /** Record a path or an opened descriptor; unknown descriptors cannot prove a contained write. */
  function record(operation, value) {
    const path = typeof value === 'number' ? descriptors.get(value) ?? `unknown-fd:${value}` : physicalPath(value);
    writes.push({ operation, path });
  }
  /** Install one transparent wrapper and preserve its original binding for restoration. */
  function wrap(name, action) {
    const original = fs[name];
    if (typeof original !== 'function') return;
    originals.set(name, original);
    fs[name] = function (...args) { return action(original, args); };
  }
  for (const name of ['mkdirSync', 'mkdtempSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'truncateSync', 'createWriteStream']) {
    wrap(name, (original, args) => { record(name, args[0]); return Reflect.apply(original, fs, args); });
  }
  for (const name of ['renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync']) {
    wrap(name, (original, args) => {
      if (name === 'renameSync') record(name, args[0]);
      record(name, args[1]);
      return Reflect.apply(original, fs, args);
    });
  }
  wrap('openSync', (original, args) => {
    const flags = args[1], writable = typeof flags === 'number'
      ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
      : typeof flags === 'string' && /[wa+]/u.test(flags);
    if (writable) record('openSync', args[0]);
    const fd = Reflect.apply(original, fs, args);
    if (writable) descriptors.set(fd, physicalPath(args[0]));
    return fd;
  });
  for (const name of ['writeSync', 'writevSync', 'ftruncateSync', 'fchmodSync', 'fchownSync', 'futimesSync']) {
    wrap(name, (original, args) => {
      if (typeof args[0] === 'number' && args[0] > 2) record(name, args[0]);
      return Reflect.apply(original, fs, args);
    });
  }
  wrap('closeSync', (original, args) => {
    try { return Reflect.apply(original, fs, args); } finally { descriptors.delete(args[0]); }
  });
  syncBuiltinESMExports();
  try { return { result: await work(), writes }; }
  finally {
    for (const [name, original] of originals) fs[name] = original;
    syncBuiltinESMExports();
  }
}

/** Snapshot the fixture Git object store to detect writes made by an external Git process. */
function objectFiles(root) {
  const directory = join(root, '.git', 'objects'), rows = [];
  /** Walk only actual files in this fixture's private object store. */
  function walk(path) {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) rows.push([file.slice(directory.length), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  }
  walk(directory);
  return rows.sort(([a], [b]) => a.localeCompare(b));
}

/** Commit an actual cells plan before pinning the accepted main tree. */
function plannedFixture(t) {
  const box = fixture(t);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'accepted cell plan');
  return { ...box, main: git(box.root, 'rev-parse', 'HEAD').trim() };
}

/**
 * Prove clause 2 on real cell names: a one-file change to src/stats.js changes exactly the stats cell, and the
 * incremental inventory's touched set adds only its direct importer app:cli; the unrelated kernel, store and items
 * cells (no import edge into stats) are absent.
 */
function assertChangedAndImporterCells(root, result) {
  const plan = readPlan(root);
  assert.deepEqual(touchedCells(['src/stats.js'], plan, plan, []), ['stats'], 'the changed-cell set is exactly the changed file\'s cell');
  assert.deepEqual(result.cells, ['app:cli', 'stats'], 'the incremental result is the changed cell plus its direct importer');
  assert.ok(result.cells.includes('app:cli'), 'the direct importer cell of stats is in the touched set');
  for (const unrelated of ['kernel', 'store', 'items']) assert.ok(!result.cells.includes(unrelated), `unrelated cell ${unrelated} is absent`);
}

/** Exercise the real parser and immutable checkout port; this is a background warm, never a submit check. */
function warm(root, commit) {
  return warmAcceptedCells(root, commit, { withCheckout: withMainCheckout, withLock: withFileLock });
}

test('clause 1: clause 3: accepted inventory is an off-path, once-per-tree census; cold and corrupt reads never build [C7]', { timeout: 590_000 }, async t => {
  const machine = isolateMachine(t);
  const box = plannedFixture(t);
  const before = inventoryBuildCount();
  assert.equal(readAcceptedCells(box.root, box.main).available, false);
  assert.equal(inventoryBuildCount(), before, 'a cold read must not run a census');
  git(box.root, 'checkout', '-q', '--detach', box.main);
  box.put('src/stats.js', "export const stats = () => 'candidate';\n");
  git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'one changed module');
  const candidate = git(box.root, 'rev-parse', 'HEAD').trim();
  const services = { withMainCheckout: () => { throw new Error('cold submit opened a checkout'); },
    parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => true, readCutItems: () => [] };
  await assert.rejects(requireSubmitCells(box.root, box.main, candidate, { item_frozen: JSON.stringify({ criterion: 'one module' }) }, services),
    error => error?.code === 'CELLS_INVENTORY_PENDING' && error.retryable === true);
  assert.equal(inventoryBuildCount(), before, 'a cold submit must defer without a census');
  git(box.root, 'checkout', '-q', 'main');

  const first = await warm(box.root, box.main);
  assert.equal(first.available, true);
  assert.equal(first.reused, false);
  assert.equal(inventoryBuildCount(), before + 1, 'the producer builds the accepted tree exactly once');
  assert.ok(first.inventory.files.has('src/stats.js'));
  assert.ok(first.observations instanceof Map);
  assert.equal(readAcceptedCells(box.root, box.main).descriptor.digest, first.descriptor.digest);
  assert.equal(inventoryBuildCount(), before + 1);

  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'same tree, another commit');
  const next = git(box.root, 'rev-parse', 'HEAD').trim();
  assert.notEqual(next, box.main);
  const repeated = await warm(box.root, next);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.descriptor.tree, first.descriptor.tree);
  assert.equal(inventoryBuildCount(), before + 1, 'an empty commit reuses the completed tree artifact');

  const modes = [], reads = [];
  const worktrees = git(box.root, 'worktree', 'list', '--porcelain');
  const beforeStatus = git(box.root, 'status', '--porcelain', '--untracked-files=all');
  const objectsBefore = objectFiles(box.root);
  const allowed = [physicalPath(machine), physicalPath(join(box.root, '.git', 'pullboard', 'check-receipts'))];
  const submitServices = { ...services, onInventory: mode => modes.push(mode),
    onSnapshotRead: (file, commit) => reads.push({ file, commit }), acceptedArtifact: first };
  // Frozen #2711 criterion: one changed file must finish the cells stage in under 15 seconds.
  const started = performance.now();
  const observed = await observeWrites(() => requireSubmitCells(box.root, box.main, candidate,
    { item_frozen: JSON.stringify({ criterion: 'one module' }) }, submitServices));
  const { result, writes } = observed;
  const elapsed = performance.now() - started;
  assert.ok(result && !result.unavailable, 'the actual changed module is checked');
  assertChangedAndImporterCells(box.root, result);
  assert.ok(modes.includes('base-cache') && modes.includes('candidate-incremental'), modes.join(', '));
  assert.ok(!modes.includes('base-full') && !modes.includes('candidate-full-fallback'), modes.join(', '));
  assert.deepEqual(reads, [{ file: 'src/stats.js', commit: candidate }], 'only the changed candidate blob is read from Git');
  assert.equal(git(box.root, 'worktree', 'list', '--porcelain'), worktrees, 'submit creates no worktree');
  assert.equal(git(box.root, 'status', '--porcelain', '--untracked-files=all'), beforeStatus, 'submit leaves the source checkout unchanged');
  assert.deepEqual(objectFiles(box.root), objectsBefore, 'Git subprocesses do not write the fixture object store');
  assert.ok(writes.length, 'the observer must see cache activity');
  assert.deepEqual(writes.filter(({ path }) => !path || !allowed.some(root => path === root || path.startsWith(root + '/'))), [],
    'parent-process filesystem writes stay in machine or native receipt caches');
  assert.equal(inventoryBuildCount(), before + 1, 'submit cannot perform another full census');
  assert.ok(elapsed < 15_000, `one-file cells stage took ${Math.round(elapsed)} ms`); // budget: declared #2711 requires a one-file cells stage under 15000 ms.

  const job = { tip: box.main, tree: first.descriptor.tree };
  const backlog = await withMainCheckout(box.root, box.main, source => cellsAuditBacklog(source, job, first));
  assert.equal(backlog.tip, box.main);
  assert.equal(backlog.tree, first.descriptor.tree);
  assert.ok(backlog.cells.length > 0, 'the main audit names every planned cell');
  assert.equal(backlog.count, backlog.cells.reduce((sum, cell) => sum + cell.cuts.length, 0));
  await assert.rejects(withMainCheckout(box.root, box.main, source => cellsAuditBacklog(source,
    { ...job, tree: '0'.repeat(job.tree.length) }, first)), /pinned (?:source|tree)/u);

  const broken = Buffer.from(readFileSync(first.file));
  broken[Math.floor(broken.length / 2)] ^= 1;
  writeFileSync(first.file, broken);
  assert.equal(readAcceptedCells(box.root, next).available, false, 'corrupt evidence is unavailable, not an empty inventory');
  assert.equal(inventoryBuildCount(), before + 1, 'a corrupt read never repairs by running a census');
});

test('clause 2: a structural change runs full candidate inventories and records their cause [C7]', { timeout: 590_000 }, async t => {
  isolateMachine(t);
  const box = plannedFixture(t);
  const artifact = await warm(box.root, box.main);
  git(box.root, 'checkout', '-q', '--detach', box.main);
  box.put('package.json', JSON.stringify({ type: 'module', name: 'fallback-fixture' }));
  git(box.root, 'add', 'package.json');
  git(box.root, 'commit', '-q', '-m', 'change package discovery');
  const candidate = git(box.root, 'rev-parse', 'HEAD').trim();
  const before = inventoryBuildCount(), modes = [], reads = [];
  const result = await requireSubmitCells(box.root, box.main, candidate,
    { item_frozen: JSON.stringify({ criterion: 'package discovery' }) }, {
      withMainCheckout: () => { throw new Error('submit opened a checkout'); },
      parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => true,
      readCutItems: () => [], acceptedArtifact: artifact,
      onInventory: (mode, cause) => modes.push({ mode, cause }),
      onSnapshotRead: (file, commit) => reads.push({ file, commit }),
    });
  assert.ok(result && !result.unavailable, 'the real structural candidate is checked');
  const fallbacks = modes.filter(row => row.mode === 'candidate-full-fallback');
  assert.ok(fallbacks.length > 0, 'the structural change requires a real full candidate inventory');
  assert.deepEqual(fallbacks.map(row => row.cause), Array(fallbacks.length).fill('package.json'),
    'every fallback records the file requiring a full census');
  assert.equal(inventoryBuildCount() - before, fallbacks.length,
    'every recorded fallback corresponds to an actual full inventory build');
  assert.deepEqual(reads, [{ file: 'package.json', commit: candidate }], 'the candidate reads its actual changed blob');
});

test('trusted inventory transport rejects changed bytes, identity and symlink sources [C7]', { timeout: 590_000 }, async t => {
  const directory = isolateMachine(t), box = plannedFixture(t);
  const artifact = await warm(box.root, box.main);
  const wrong = Buffer.from(artifact.bytes);
  wrong[0] ^= 1;
  assert.equal(validateAcceptedInventory(wrong, artifact.descriptor).available, false);
  assert.equal(validateAcceptedInventory(artifact.bytes, { ...artifact.descriptor, tree: '0'.repeat(40) }).available, false);
  const context = 'a'.repeat(64);
  const source = { file: artifact.file, bytes: artifact.bytes.length, sha256: artifact.descriptor.digest, context };
  assert.deepEqual(readAnalysisArtifact(source, context).bytes, artifact.bytes);
  assert.throws(() => readAnalysisArtifact({ ...source, sha256: '0'.repeat(64) }, context));
  assert.throws(() => analysisArtifactDescriptor({ bytes: source.bytes, sha256: source.sha256, context }, 'b'.repeat(64)));
  assert.throws(() => readAnalysisArtifact({ ...source, file: join(directory, 'missing') }, context));
  const link = join(directory, 'artifact-link');
  symlinkSync(artifact.file, link);
  assert.throws(() => readAnalysisArtifact({ ...source, file: link }, context));
});

/** Run a receiver in a separate process so real stdin chunking and EOF are exercised without changing this test runner. */
function receiveFixture(directory, bytes, digest) {
  const module = new URL('../../../../packages/resources/index.js', import.meta.url).href;
  const code = `import {receiveAnalysisArtifact} from ${JSON.stringify(module)};
import {readFileSync} from 'node:fs';
const state={transportLost:false,rejectPendingFrame:null};
try { const file=await receiveAnalysisArtifact(state,process.argv[1],{bytes:Number(process.argv[2]),sha256:process.argv[3]});
 const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
 process.stdout.write(JSON.stringify({artifact:readFileSync(file,'utf8'),rest:Buffer.concat(chunks).toString('utf8')}));
} catch(error) { process.stderr.write(error.message); process.exitCode=1; }`;
  return { code, args: ['--input-type=module', '-e', code, directory, String(bytes), digest] };
}

test('private runner input consumes exactly its artifact and rejects truncated or mismatched frames [C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cells-artifact-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('trusted-inventory');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const run = receiveFixture(directory, bytes.length, digest);
  const received = spawnSync(process.execPath, run.args, { input: Buffer.concat([bytes, Buffer.from('history')]), encoding: 'utf8', timeout: 30_000 });
  assert.equal(received.status, 0, received.stderr);
  assert.deepEqual(JSON.parse(received.stdout), { artifact: bytes.toString(), rest: 'history' });
  rmSync(join(directory, 'analysis-artifact.bin'));
  const incomplete = spawnSync(process.execPath, run.args, { input: bytes.subarray(0, -1), encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /incomplete|closed/u);
  const bad = receiveFixture(directory, bytes.length, '0'.repeat(64));
  const altered = spawnSync(process.execPath, bad.args, { input: bytes, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /digest mismatch/u);
});
