/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance.js apps/cli/src/io/worktree/maintenance/observation.js apps/cli/src/io/worktree/maintenance/archive.js */
/** @pullboard-test-loads packages/state/index.js */
/** Private Git/native-board integration cases for the owning maintenance test [B3,C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  join,
  relative,
  resolve,
} from 'node:path';
import * as store from '../../../../../../packages/store/index.js';
import {
  closeBoard,
  openBoard,
} from '../../../../../lib/index.js';
import { repoInfo } from '../../../../../../packages/git/index.js';
import {
  heartbeatSeat,
  withLocalSeatPresence,
} from '../../../../../../packages/store/index.js';
import { agentHandoff } from '../../../../../../packages/state/index.js';
import { cleanMaintenanceSeat } from '../../../../src/io/worktree/maintenance.js';
import { maintenanceHealth } from '../../../../src/io/worktree/maintenance.js';
import { runWorktreeMaintenance } from '../../../../src/io/worktree/maintenance.js';
import { maintenanceGit } from '../../../../src/io/worktree/maintenance/archive.js';
import { maintenanceSnapshot } from '../../../../src/io/worktree/maintenance/archive.js';
import { writeMaintenanceState } from '../../../../src/io/worktree/maintenance/observation.js';
import { submitFixture } from '../../board/submit.js';
import { createE2eHelpers } from '../../e2e.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BORN = Date.UTC(2026, 8, 1, 12);

/** Build a real private repository and native SQLite board with a controllable board clock. */
function project(t, { born = BORN, grace = '1s' } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
  let at = born;
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(at) });
  t.after(() => closeBoard(board));
  const coordinator = store.listAgents(board).find(row => row.agent_id === 'coordinator')?.agent_id ?? 'coordinator';
  const factItem = store.addItem(board, { by: coordinator, lane: 'web', title: 'Maintenance archive fixture facts' });
  const config = { worktrees: 'inside', worktreeMaintenance: { enabled: true, every: '1h', grace, exclude: [] } };
  let censusCount = 0;
  /** Register an actual Git worktree and canonical native seat. */
  function addTree(name, { inside = true, seat = false } = {}) {
    const path = inside ? join(box.repo, '.claude', 'worktrees', name) : join(box.dir, name);
    fs.mkdirSync(join(path, '..'), { recursive: true });
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    const agent = seat ? store.register(board, { lane: 'web', path, family: box.declareFamily(path) }) : null;
    if (agent) assert.equal(heartbeatSeat(board, agent), true, 'fixture records a local heartbeat on the controllable native board clock');
    return { path, agent };
  }
  /** Read current seat and item projections from the private native board SDK. */
  const readSnapshot = async () => ({ seats: withLocalSeatPresence(board, store.listAgents(board)).map(seat => ({
    ...seat, completedTakeoverAt: agentHandoff(board, seat.agent_id)?.takenAt ?? null,
  })), items: store.listItems(board, { all: true }) });
  const archives = [];
  /** Append an actual native fact before the engine can remove its source worktree. */
  async function recordArchive(record) {
    assert.equal(fs.existsSync(record.path), true, 'archive fact must precede source removal');
    const fact = store.appendFact(board, factItem, { agentId: coordinator, kind: 'note',
      text: `Archived ${record.path}; head ${record.head}; recovery ref ${record.ref}` });
    archives.push({ ...record, fact });
  }
  /** Append the fact naming a kept dirty folder and its dirty paths. */
  async function recordDirty(record) {
    store.appendFact(board, factItem, { agentId: coordinator, kind: 'note',
      text: `Kept ${record.path}; uncommitted changes: ${record.paths.join(', ')}` });
  }
  // The archive disk guard reads the host volume; a busy runner disk below its reserve would keep every tree these
  // custody cases expect pruned, failing every concurrent gate at once (#6151). Its refusal is proven in archive tests.
  const archiveVolume = () => ({ freeBytes: 900 * 2 ** 30, totalBytes: 1000 * 2 ** 30 });
  const ports = { agentId: coordinator, readSnapshot, recordArchive, recordDirty,
    workingDirectories: () => { censusCount++; return []; } };
  return { box, board, coordinator, factItem, config, ports, archives, readSnapshot, addTree,
    setNow(value) { at = value; }, now() { return at; }, censusCount() { return censusCount; }, common() { return repoInfo(box.repo).commonDir; } };
}

/** Create a genuine board item and claim it through the native store. */
function claimItem(fx, agent, title) {
  const id = store.addItem(fx.board, { by: fx.coordinator, lane: 'web', title });
  store.claim(fx.board, id, { agentId: agent, lane: 'web', leaseMs: 2 * HOUR,
    freeze: item => ({ text: item.item_title, digest: `fixture:${item.item_title}` }) });
  return id;
}

/** Record a takeover through canonical native events and return its board-clock timestamp. */
function completeTakeover(fx, outgoing, incoming) {
  const handoff = store.openHandoff(fx.board, { agentId: outgoing });
  return store.takeHandoff(fx.board, { agentId: incoming, item: handoff.item }).takenAt;
}

/** Add binary staged and unstaged edits plus untracked and ignored files. */
function makeDirty(box, path) {
  const tracked = join(path, 'pullboard.json');
  fs.writeFileSync(tracked, Buffer.from([0, 1, 2, 255]));
  box.git(path, 'add', 'pullboard.json');
  fs.writeFileSync(tracked, Buffer.from([0, 3, 4, 255]));
  fs.writeFileSync(join(path, 'untracked.bin'), Buffer.from([7, 0, 8, 255]));
  fs.mkdirSync(join(path, 'ignored'), { recursive: true });
  fs.writeFileSync(join(path, 'ignored', 'private.bin'), Buffer.from([9, 0, 10, 255]));
  fs.appendFileSync(join(box.repo, '.git', 'info', 'exclude'), '\nignored/\n');
  return maintenanceSnapshot(path, { includeMetadata: true });
}

/** Add only an ignored leaf: Git status stays clean, so maintenance may still archive and remove the tree. */
function makeIgnoredOnly(box, path) {
  fs.mkdirSync(join(path, 'ignored'), { recursive: true });
  fs.writeFileSync(join(path, 'ignored', 'private.bin'), Buffer.from([9, 0, 10, 255]));
  fs.appendFileSync(join(box.repo, '.git', 'info', 'exclude'), '\nignored/\n');
  return maintenanceSnapshot(path, { includeMetadata: true });
}

/** Independently inventory the original linked Git directory without consulting its archive manifest. */
function gitDirectoryFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name), relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const state = fs.lstatSync(path);
    if (state.isDirectory() && !state.isSymbolicLink()) return gitDirectoryFiles(path, relativePath);
    const bytes = state.isSymbolicLink() ? fs.readlinkSync(path, { encoding: 'buffer' }) : fs.readFileSync(path);
    return [{ path: relativePath, type: state.isSymbolicLink() ? 'symlink' : 'file', mode: state.mode & 0o7777,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
      ...(state.isSymbolicLink() ? { targetBase64: bytes.toString('base64') } : {}) }];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Recreate source checkout changes from only the private archive, never from the removed source. */
function restoreArchivedWorktree(box, archive, destination) {
  maintenanceGit(box.repo, ['worktree', 'add', '-q', '--detach', destination, archive.ref]);
  for (const [flags, name] of [[['--index'], 'staged.patch'], [[], 'unstaged.patch']]) {
    if (fs.statSync(join(archive.directory, name)).size) maintenanceGit(destination, ['apply', ...flags, '--binary', join(archive.directory, name)]);
  }
  for (const file of archive.files) {
    const target = join(destination, file.path), bytes = fs.readFileSync(join(archive.directory, 'blobs', file.sha256));
    fs.mkdirSync(join(target, '..'), { recursive: true });
    if (file.type === 'symlink') fs.symlinkSync(Buffer.from(file.targetBase64, 'base64'), target);
    else { fs.writeFileSync(target, bytes); fs.chmodSync(target, file.mode); }
  }
  return destination;
}

/** Seed only prior successful observations; no filesystem timestamp is treated as a seat's age. */
function seedOldTrees(fx, paths, at = fx.now() - 2 * DAY) {
  const trees = Object.fromEntries(paths.map(path => [path, { firstSeenAt: at, inactiveSince: at, dirtySince: null }]));
  writeMaintenanceState(fx.common(), { version: 1, trees });
}

/** Confirm native archive facts on the item thread rather than trusting callback invocation alone. */
function archiveFacts(fx) {
  return store.itemThread(fx.board, fx.factItem).filter(row => row.type === 'fact' && row.text.includes('recovery ref'));
}

/** Register native-board/Git maintenance cases without running them when this fixture is imported. */
export function registerMaintenanceEngineTests() {
  test('maintenance engine leaves live and claimed worktrees and their exact source/index bytes untouched [B3,C7]', async t => {
    const fx = project(t, { born: Date.UTC(2026, 9, 30, 17), grace: '1s' });
    const live = fx.addTree('live-seat', { seat: true });
    const claimed = fx.addTree('claimed-seat', { seat: true });
    assert.equal((await fx.readSnapshot()).seats.find(row => row.agent_id === live.agent)?.presence, 'live');
    const claim = claimItem(fx, claimed.agent, 'Claim retained by maintenance fixture');
    const liveDirty = makeDirty(fx.box, live.path), claimedDirty = makeDirty(fx.box, claimed.path);
    const report = await runWorktreeMaintenance(fx.box.repo, fx.config, fx.ports, { now: fx.now() });
    assert.equal(report.pruned, 0);
    assert.equal(report.archived, 0);
    assert.equal(report.entries.find(row => row.path === live.path).reason, 'seat-live', 'the local heartbeat guard, rather than grace age, retains this tree');
    for (const [tree, before] of [[live, liveDirty], [claimed, claimedDirty]]) {
      assert.equal(fs.existsSync(tree.path), true);
      assert.equal(maintenanceSnapshot(tree.path, { includeMetadata: true }).signature, before.signature);
    }
    assert.equal(store.listItems(fx.board, { all: true }).find(row => row.item_id === claim)?.item_status, 'claimed');
    assert.deepEqual(archiveFacts(fx), []);
  });

  test('maintenance archives native facts, ignored leaves and linked Git metadata before pruning [B3,C7]', async t => {
    const fx = project(t, { born: BORN, grace: '1d' });
    const finished = fx.addTree('finished-seat', { seat: true });
    const incoming = fx.addTree('finished-incoming', { seat: true });
    const orphan = fx.addTree('orphan-tree');
    const scratch = fx.addTree('scratch-tree', { inside: false });
    const item = claimItem(fx, finished.agent, 'Closed work attached to finished seat');
    const head = fx.box.git(finished.path, 'rev-parse', 'HEAD').trim();
    const tree = fx.box.git(finished.path, 'rev-parse', 'HEAD^{tree}').trim();
    submitFixture(fx.board, item, { agentId: finished.agent, commit: head, tree });
    store.withdraw(fx.board, item, { agentId: fx.coordinator, reason: 'closed private maintenance lifecycle fixture' });
    // Only a completed takeover retires a joined seat; a stale heartbeat alone never does (#5969).
    completeTakeover(fx, finished.agent, incoming.agent);
    fx.setNow(BORN + 3 * DAY);
    const dirty = makeIgnoredOnly(fx.box, finished.path);
    const gitDir = fx.box.git(finished.path, 'rev-parse', '--path-format=absolute', '--git-dir').trim();
    const rawMetadata = gitDirectoryFiles(gitDir);
    seedOldTrees(fx, [orphan.path, scratch.path]);

    const report = await runWorktreeMaintenance(fx.box.repo, fx.config, fx.ports, { now: fx.now() });
    assert.equal(report.counts.finished, 1);
    assert.equal(report.counts.orphaned, 1);
    assert.equal(report.counts.scratch, 1);
    assert.equal(report.pruned, 1);
    assert.equal(report.archived, 1);
    assert.equal(fs.existsSync(finished.path), false);
    // A worktree no seat joined, and one outside the worktree root, are outside maintenance scratch (#5969).
    for (const kept of [orphan, scratch]) assert.equal(fs.existsSync(kept.path), true);
    assert.equal(fx.archives.length, 1);
    assert.equal(archiveFacts(fx).length, 1);

    const archived = fx.archives.find(row => row.path === finished.path);
    const manifest = JSON.parse(fs.readFileSync(join(archived.archive, 'manifest.json'), 'utf8'));
    assert.equal(manifest.metadata.gitDir, gitDir);
    assert.deepEqual(manifest.metadata.files.map(file => ({ path: file.path, type: file.type, mode: file.mode,
      sha256: file.sha256, size: file.size, ...(file.targetBase64 ? { targetBase64: file.targetBase64 } : {}) })), rawMetadata);
    for (const file of manifest.metadata.files) {
      const blob = fs.readFileSync(join(archived.archive, 'blobs', file.sha256));
      assert.equal(createHash('sha256').update(blob).digest('hex'), file.sha256);
      assert.equal(blob.length, file.size);
    }
    assert.deepEqual(manifest.files.map(file => file.path).sort(), dirty.files.map(file => file.path).sort());
    const recovered = restoreArchivedWorktree(fx.box, { ...manifest, directory: archived.archive }, join(fx.box.dir, 'recovered-finished'));
    assert.deepEqual(maintenanceGit(recovered, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'], { binary: true }), dirty.stagedBuffer);
    assert.deepEqual(maintenanceGit(recovered, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'], { binary: true }), dirty.unstagedBuffer);
    for (const file of manifest.files) {
      const bytes = fs.readFileSync(join(archived.archive, 'blobs', file.sha256));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      assert.deepEqual(fs.readFileSync(join(recovered, file.path)), bytes);
    }
  });

  test('maintenance retains source when its archive fact fails or source changes after archival [B3,C7]', async t => {
    const failed = project(t, { born: BORN, grace: '1s' });
    failed.addTree('fact-failure', { seat: true });
    const failedTree = failed.addTree('fact-failure-item-5');
    seedOldTrees(failed, [failedTree.path]);
    fs.writeFileSync(join(failedTree.path, 'untracked.bin'), Buffer.from([0, 11, 12, 255]));
    const original = maintenanceSnapshot(failedTree.path, { includeMetadata: true });
    const refusesFact = { ...failed.ports, async recordArchive() { throw new Error('injected native fact refusal'); } };
    const first = await runWorktreeMaintenance(failed.box.repo, failed.config, refusesFact, { now: failed.now() });
    assert.equal(fs.existsSync(failedTree.path), true);
    assert.equal(maintenanceSnapshot(failedTree.path, { includeMetadata: true }).signature, original.signature);
    assert.equal(first.pruned, 0);
    assert.equal(first.entries.find(row => row.path === failedTree.path).action, 'kept');

    const changed = project(t, { born: BORN, grace: '1s' });
    changed.addTree('source-change-after-archive', { seat: true });
    const changedTree = changed.addTree('source-change-after-archive-item-6');
    seedOldTrees(changed, [changedTree.path]);
    const tracked = join(changedTree.path, 'pullboard.json');
    const initial = fs.readFileSync(tracked);
    const afterArchive = { ...changed.ports, async recordArchive(record) {
      await changed.ports.recordArchive(record);
      fs.writeFileSync(tracked, Buffer.from('changed after the archive fact\n'));
    } };
    const second = await runWorktreeMaintenance(changed.box.repo, changed.config, afterArchive, { now: changed.now() });
    assert.equal(fs.existsSync(changedTree.path), true);
    assert.deepEqual(fs.readFileSync(tracked), Buffer.from('changed after the archive fact\n'));
    assert.deepEqual(fs.readFileSync(tracked).equals(initial), false);
    assert.equal(second.pruned, 0);
    assert.equal(second.entries.find(row => row.path === changedTree.path).action, 'archived-kept');
    assert.equal(archiveFacts(changed).length, 1);
  });

  test('clause 1: maintenance keeps a worktree with modified, staged or untracked changes and records a fact naming the folder and its dirty paths [C7]', async t => {
    const fx = project(t, { born: BORN, grace: '1d' });
    fx.addTree('orphan-owner', { seat: true });
    const dirty = fx.addTree('orphan-owner-item-1');
    const clean = fx.addTree('orphan-owner-item-2');
    seedOldTrees(fx, [dirty.path, clean.path]);
    fx.box.git(dirty.path, 'mv', 'SPEC.md', 'SPEC-moved.md');
    const before = makeDirty(fx.box, dirty.path);
    fx.setNow(BORN + 3 * DAY);
    const first = await runWorktreeMaintenance(fx.box.repo, fx.config, fx.ports, { now: fx.now() });
    assert.equal(fs.existsSync(dirty.path), true, 'the dirty worktree stays in place');
    assert.equal(fs.existsSync(clean.path), false, 'only the clean worktree is removed');
    assert.equal(first.pruned, 1);
    assert.equal(maintenanceSnapshot(dirty.path, { includeMetadata: true }).signature, before.signature);
    const entry = first.entries.find(row => row.path === dirty.path);
    assert.equal(entry.action, 'kept');
    assert.deepEqual(entry.dirtyPaths, ['SPEC-moved.md', 'SPEC.md', 'pullboard.json', 'untracked.bin'], 'a staged rename reports both its destination and its source');
    assert.match(entry.reason, /uncommitted changes/u);
    const facts = store.itemThread(fx.board, fx.factItem).filter(row => row.type === 'fact' && row.text.includes('uncommitted'));
    assert.equal(facts.length, 1);
    assert.ok(facts[0].text.includes('SPEC-moved.md') && facts[0].text.includes('SPEC.md'), 'the fact names both rename paths');
    assert.ok(facts[0].text.includes(dirty.path) && facts[0].text.includes('pullboard.json') && facts[0].text.includes('untracked.bin'));
    await runWorktreeMaintenance(fx.box.repo, fx.config, fx.ports, { now: fx.now() + HOUR });
    assert.equal(store.itemThread(fx.board, fx.factItem).filter(row => row.type === 'fact' && row.text.includes('uncommitted')).length, 1,
      'the same dirty paths are not recorded again on the next sweep');
    assert.equal(fs.existsSync(dirty.path), true);
  });

  test('clause 1: maintenance release cleanup leaves a worktree with uncommitted changes in place and records the dirty paths [C7]', async t => {
    const fx = project(t, { born: Date.UTC(2026, 9, 30, 17), grace: '1s' });
    const owner = fx.addTree('released-dirty-owner', { seat: true });
    const released = claimItem(fx, owner.agent, 'Owner release with unfinished work');
    store.release(fx.board, released, owner.agent, 'Return the fixture claim.', 'OTHER');
    fs.writeFileSync(join(owner.path, 'untracked.bin'), 'unfinished work\n');
    const before = maintenanceSnapshot(owner.path, { includeMetadata: true }).signature;
    const result = await cleanMaintenanceSeat(owner.path, fx.config, fx.ports,
      { path: owner.path, item: released, agent: owner.agent, now: fx.now() });
    assert.equal(result, null);
    assert.equal(maintenanceSnapshot(owner.path, { includeMetadata: true }).signature, before);
    assert.deepEqual(archiveFacts(fx), [], 'no archive, reset or clean runs on a dirty tree');
    const fact = store.itemThread(fx.board, fx.factItem).find(row => row.type === 'fact' && row.text.includes('uncommitted'));
    assert.ok(fact.text.includes(owner.path) && fact.text.includes('untracked.bin'));
  });

  test('maintenance health reports only retained dirty observations before the longer prune grace [B3,C7]', async t => {
    const fx = project(t, { born: BORN, grace: '48h' });
    const tree = fx.addTree('dirty-gone-seat', { seat: true });
    fs.writeFileSync(join(tree.path, 'untracked.bin'), 'dirty work stays local\n');
    fx.setNow(BORN + 2 * HOUR);
    const first = await runWorktreeMaintenance(fx.box.repo, fx.config, fx.ports, { now: fx.now() });
    assert.equal(first.pruned, 0);
    assert.equal(first.entries.find(row => row.path === tree.path).reason, 'seat-joined');
    const secondAt = BORN + DAY + 2 * HOUR + 1;
    fx.setNow(secondAt);
    const second = await runWorktreeMaintenance(fx.box.repo, fx.config, fx.ports, { now: secondAt });
    assert.equal(second.pruned, 0, '48-hour grace still protects this 26-hour-old seat');
    const state = await fx.readSnapshot();
    const before = fx.censusCount();
    const health = maintenanceHealth(fx.common(), state, secondAt);
    assert.deepEqual(health, [{ path: tree.path, since: new Date(BORN + 2 * HOUR).toISOString(),
      reason: 'uncommitted work without a live seat for over a day' }]);
    assert.equal(fx.censusCount(), before, 'health reads retained state and does not start a filesystem scan');
  });

  test('clause 1: maintenance cleans only the released owner checkout and keeps competing claims, live retirement and exclusions [B3,C7]', async t => {
    const fx = project(t, { born: Date.UTC(2026, 9, 30, 17), grace: '1s' });
    const clean = fx.addTree('released-owner', { seat: true });
    const released = claimItem(fx, clean.agent, 'Owner release that may clean this checkout');
    store.release(fx.board, released, clean.agent,
      'Fixture releases owner claim for cleanup.', undefined, 'OTHER');
    makeIgnoredOnly(fx.box, clean.path);
    const cleanResult = await cleanMaintenanceSeat(clean.path, fx.config, fx.ports,
      { path: clean.path, item: released, agent: clean.agent, now: fx.now() });
    assert.equal(cleanResult.clean, true);
    assert.equal(maintenanceSnapshot(clean.path).dirty, false);
    assert.ok(archiveFacts(fx).some(row => row.text.includes(clean.path)));

    const held = fx.addTree('other-claim-holds', { seat: true });
    const releasedAgain = claimItem(fx, held.agent, 'Current owner release');
    store.release(fx.board, releasedAgain, held.agent,
      'Fixture releases first claim while a competing claim remains.', undefined, 'OTHER');
    const competing = claimItem(fx, held.agent, 'Another active owner claim');
    fs.writeFileSync(join(held.path, 'untracked.bin'), 'must remain dirty\n');
    const heldBefore = maintenanceSnapshot(held.path).signature;
    assert.equal(await cleanMaintenanceSeat(held.path, fx.config, fx.ports,
      { path: held.path, item: releasedAgain, agent: held.agent, now: fx.now() }), null);
    assert.equal(maintenanceSnapshot(held.path).signature, heldBefore);
    assert.equal(store.listItems(fx.board, { all: true }).find(row => row.item_id === competing)?.item_status, 'claimed');

    store.release(fx.board, competing, held.agent,
      'Fixture releases competing claim before cleanup exclusions.', undefined, 'OTHER');
    const liveBefore = maintenanceSnapshot(held.path).signature;
    assert.equal(await cleanMaintenanceSeat(held.path, fx.config, fx.ports,
      { path: held.path, item: releasedAgain, agent: held.agent, retired: true, now: fx.now() }), null);
    assert.equal(maintenanceSnapshot(held.path).signature, liveBefore);
    const excluded = { ...fx.config, worktreeMaintenance: { ...fx.config.worktreeMaintenance, exclude: [held.path] } };
    assert.equal(await cleanMaintenanceSeat(held.path, excluded, fx.ports,
      { path: held.path, item: releasedAgain, agent: held.agent, now: fx.now() }), null);
    assert.equal(maintenanceSnapshot(held.path).signature, liveBefore);
  });

  test('maintenance preserves dirty work when its owner has a verified, unmerged build [B3,C7]', async t => {
    const fx = project(t, { born: Date.UTC(2026, 9, 30, 17), grace: '1s' });
    const owner = fx.addTree('verified-unmerged-owner', { seat: true });
    const reviewerTree = fx.addTree('verified-unmerged-reviewer');
    const reviewer = store.register(fx.board, { lane: 'review', path: reviewerTree.path,
      family: fx.box.declareFamily(reviewerTree.path) });

    const released = claimItem(fx, owner.agent, 'Release eligible only without other obligations');
    store.release(fx.board, released, owner.agent,
      'Fixture releases owner claim before creating a verified unmerged obligation.', undefined, 'OTHER');
    const pendingLanding = claimItem(fx, owner.agent, 'Verified implementation still awaiting landing');
    const head = fx.box.git(owner.path, 'rev-parse', 'HEAD').trim();
    const tree = fx.box.git(owner.path, 'rev-parse', 'HEAD^{tree}').trim();
    submitFixture(fx.board, pendingLanding, { agentId: owner.agent, commit: head, tree });
    store.reserveReview(fx.board, pendingLanding, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
    const submitted = store.getItem(fx.board, pendingLanding);
    store.verify(fx.board, pendingLanding, { agentId: reviewer, decision: 'ACCEPT', policy: 'any', head,
      digest: submitted.item_frozen_digest, note: 'Native fixture verifies the pending landing; it is not merged.' });
    const verified = store.getItem(fx.board, pendingLanding);
    assert.equal(verified.item_status, 'verified');
    assert.equal(verified.item_built_by, owner.agent);
    assert.equal(verified.item_merged_commit, null, 'the native item remains verified but unmerged');

    const dirtyPath = join(owner.path, 'untracked.bin');
    fs.writeFileSync(dirtyPath, Buffer.from([0, 17, 34, 255]));
    const before = maintenanceSnapshot(owner.path, { includeMetadata: true }).signature;
    const result = await cleanMaintenanceSeat(owner.path, fx.config, fx.ports,
      { path: owner.path, item: released, agent: owner.agent, now: fx.now() });

    assert.equal(result, null, 'the verified-unmerged native obligation blocks lifecycle cleanup');
    assert.equal(fs.existsSync(owner.path), true);
    assert.deepEqual(fs.readFileSync(dirtyPath), Buffer.from([0, 17, 34, 255]));
    assert.equal(maintenanceSnapshot(owner.path, { includeMetadata: true }).signature, before);
    assert.deepEqual(archiveFacts(fx), [], 'cleanup does not archive or reset the protected checkout');
  });

  test('retired takeover cleanup needs a complete clear process census before and after archival [B3,C7]', async t => {
    const setup = (fx, name) => {
      const retired = fx.addTree(`${name}-retired`, { seat: true });
      const incoming = fx.addTree(`${name}-incoming`, { seat: true });
      const claim = claimItem(fx, retired.agent, `${name} released checkout`);
      store.release(fx.board, claim, retired.agent,
        'Fixture releases retired checkout claim before takeover.', undefined, 'OTHER');
      makeIgnoredOnly(fx.box, retired.path);
      const takenAt = completeTakeover(fx, retired.agent, incoming.agent);
      return { retired, incoming, claim, takenAt, before: maintenanceSnapshot(retired.path, { includeMetadata: true }).signature };
    };

    const clean = project(t, { born: Date.UTC(2026, 9, 30, 17), grace: '1s' });
    const safe = setup(clean, 'safe-census');
    assert.equal((await clean.readSnapshot()).seats.find(row => row.agent_id === safe.retired.agent)?.completedTakeoverAt, safe.takenAt);
    let safeScans = 0;
    const safePorts = { ...clean.ports, completedTakeover: true, workingDirectories() { safeScans++; return []; } };
    assert.notEqual(resolve(safe.incoming.path), resolve(safe.retired.path));
    const cleaned = await cleanMaintenanceSeat(safe.incoming.path, clean.config, safePorts,
      { path: safe.retired.path, item: safe.claim, agent: safe.retired.agent, retired: true, now: clean.now() });
    assert.equal(cleaned.clean, true);
    assert.equal(safeScans, 2, 'empty native working-directory results are checked on both sides of archival');
    assert.equal(maintenanceSnapshot(safe.retired.path).dirty, false);

    const unknown = project(t, { born: Date.UTC(2026, 9, 30, 17), grace: '1s' });
    const unknownCase = setup(unknown, 'unknown-census');
    const unknownResult = await cleanMaintenanceSeat(unknownCase.incoming.path, unknown.config,
      { ...unknown.ports, completedTakeover: true, workingDirectories: () => null },
      { path: unknownCase.retired.path, item: unknownCase.claim, agent: unknownCase.retired.agent, retired: true, now: unknown.now() });
    assert.equal(unknownResult, null);
    assert.equal(maintenanceSnapshot(unknownCase.retired.path, { includeMetadata: true }).signature, unknownCase.before);
    assert.deepEqual(archiveFacts(unknown), []);

    const changed = project(t, { born: Date.UTC(2026, 9, 30, 17), grace: '1s' });
    const changedCase = setup(changed, 'changed-census');
    let changedScans = 0;
    const changedPorts = { ...changed.ports, completedTakeover: true, workingDirectories() {
      changedScans++;
      return changedScans === 1 ? [] : [{ pid: 4321, path: join(changedCase.retired.path, 'nested') }];
    } };
    const changedResult = await cleanMaintenanceSeat(changedCase.incoming.path, changed.config, changedPorts,
      { path: changedCase.retired.path, item: changedCase.claim, agent: changedCase.retired.agent, retired: true, now: changed.now() });
    assert.equal(changedResult, null);
    assert.equal(changedScans, 2);
    assert.equal(maintenanceSnapshot(changedCase.retired.path, { includeMetadata: true }).signature, changedCase.before);
    assert.equal(archiveFacts(changed).length, 1, 'the archive fact is retained, while the newly occupied source is not reset');
  });
}

/** Register the #5969 sweep cases: joined and leased seats and trees outside maintenance scratch all survive [C7]. */
export function registerMaintenanceProtectionTests() {
  test('clause 1 [test]: a joined seat with no claim and a seat holding a leased claim survive a sweep days after their last heartbeat [C7,#5969]', async t => {
    const fx = project(t, { born: BORN, grace: '1d' });
    // A seat joined days ago and rejoined just now keeps its old row and heartbeat, so its presence reads "gone".
    const joined = fx.addTree('pool-seat', { seat: true });
    const leased = fx.addTree('leased-seat', { seat: true });
    // Control: a clean item folder of a joined seat is maintenance's own scratch, so the sweep does remove it.
    const spare = fx.addTree('pool-seat-item-77');
    fx.setNow(BORN + 3 * DAY);
    const claim = claimItem(fx, leased.agent, 'Leased claim keeps its checkout');
    seedOldTrees(fx, [joined.path, leased.path, spare.path]);
    assert.equal((await fx.readSnapshot()).seats.find(seat => seat.agent_id === joined.agent).presence, 'gone',
      'the fixture reproduces a seat whose heartbeat went stale');

    const report = await runWorktreeMaintenance(fx.box.repo, fx.config, fx.ports, { now: fx.now() });
    assert.equal(fs.existsSync(joined.path), true, 'the joined seat without a claim is kept');
    assert.equal(fs.existsSync(leased.path), true, 'the seat holding a leased claim is kept');
    assert.equal(report.entries.find(row => row.path === joined.path).reason, 'seat-joined');
    assert.equal(report.entries.find(row => row.path === leased.path).reason, 'claim');
    assert.equal(store.getItem(fx.board, claim).item_status, 'claimed');
    assert.equal(fs.existsSync(spare.path), false,
      `the sweep ran and removed its own idle item folder: ${report.entries.find(row => row.path === spare.path)?.reason}`);
    assert.equal(report.pruned, 1);
  });

  test('clause 2 [test]: a sibling checkout and a hand-made worktree in the worktree folder survive a sweep [C7,#5969]', async t => {
    const fx = project(t, { born: BORN, grace: '1d' });
    const sibling = fx.addTree(`${relative(fx.box.dir, fx.box.repo)}-census`, { inside: false });
    const smoke = fx.addTree('smoke-pool-1');
    const outsideSeat = fx.addTree('outside-seat', { inside: false, seat: true });
    fx.setNow(BORN + 3 * DAY);
    seedOldTrees(fx, [sibling.path, smoke.path, outsideSeat.path]);

    const report = await runWorktreeMaintenance(fx.box.repo, fx.config, fx.ports, { now: fx.now() });
    for (const tree of [sibling, smoke, outsideSeat]) assert.equal(fs.existsSync(tree.path), true, `${tree.path} is kept`);
    assert.equal(report.pruned, 0);
    assert.equal(report.archived, 0);
    for (const tree of [sibling, smoke]) assert.equal(report.entries.find(row => row.path === tree.path).reason, 'outside-maintenance-scratch');
  });
}
