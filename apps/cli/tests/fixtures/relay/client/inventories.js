/** Publish the accepted cells inventory each replica's submit reads [H3,H16,V1,V17]. */
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { acceptedInventoryKey } from '../../../../../../packages/codemap/index.js';
import { acceptedCellsIdentity } from '../../../../../../packages/gate/index.js';
import { readAcceptedCells } from '../../../../../../packages/gate/index.js';
import { machineHome } from '../../../../../../packages/resources/index.js';
import { warmAcceptedCells } from '../../../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../../../packages/landing/index.js';
import { withFileLock } from '../../../../../../packages/outbox/index.js';

/**
 * Publish each replica's accepted main inventory in its own machine home, as the background producer does on a real
 * board (#3533). Why: native submit refuses CELLS_INVENTORY_PENDING until main has one, and a fixture has no producer.
 */
export async function publishAcceptedInventories(fixture) {
  const stash = join(fixture.scratch, 'inventory-stash');
  const cacheHome = fixtureCellsCacheHome();
  let stashedTree = '';
  /** Run work with the process machine home set to one replica's, as that replica's CLI sees it. */
  const inMachineHome = async (env, work) => {
    const previous = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
    try { return await work(); } finally { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; }
  };
  /** Analyze the first replica's current main once and keep the published inventory in the stash. */
  const publishFirst = async (tree) => {
    const main = String(fixture.gitAt(fixture.clones[0], fixture.envs[0], 'rev-parse', 'main')).trim();
    const cacheEnv = { PULLBOARD_MACHINE_HOME: cacheHome };
    const artifact = await inMachineHome(cacheEnv, () => warmAcceptedCells(fixture.clones[0], main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: 'main' }));
    assert.equal(artifact.available, true, 'the producer published the replica main inventory');
    const key = await inMachineHome(cacheEnv, () => acceptedInventoryKey(acceptedCellsIdentity(fixture.clones[0], main, { pinned: true })));
    rmSync(stash, { recursive: true, force: true });
    mkdirSync(join(stash, 'accepted'), { recursive: true, mode: 0o700 });
    const now = new Date();
    for (const name of [`${key}.inventory.gz`, `${key}.ready.json`]) {
      const from = join(cacheHome, 'cells-cache', 'accepted', name);
      utimesSync(from, now, statSync(from).mtime); // a used entry stays fresh for pruning; its mtime is part of the ready record
      cpSync(from, join(stash, 'accepted', name), { preserveTimestamps: true });
    }
    pruneFixtureCellsCache(cacheHome);
    stashedTree = tree;
  };
  const mainTree = () => String(fixture.gitAt(fixture.clones[0], fixture.envs[0], 'rev-parse', 'main^{tree}')).trim();
  for (let index = 0; index < fixture.clones.length; index += 1) fixture.envs[index].PULLBOARD_MACHINE_HOME = join(fixture.envs[index].HOME, 'machine');
  // A seed without a cells plan has no inventory to publish, as on any project that never adopted cells: submit needs none [C7].
  const main = String(fixture.gitAt(fixture.clones[0], fixture.envs[0], 'rev-parse', 'main')).trim();
  if (!String(fixture.gitAt(fixture.clones[0], fixture.envs[0], 'ls-tree', '--name-only', main, '--', 'packages/codemap/data/plan/cells.json')).trim()) return async () => {};
  await publishFirst(mainTree());
  /**
   * Put the published inventory back in every replica's machine home; a CLI step can drop it before a later submit, and
   * relay moves can advance main to a tree it was not published for, so a changed main is analyzed again (once, then copied).
   */
  const restore = async () => {
    const tree = mainTree();
    if (tree !== stashedTree) await publishFirst(tree);
    for (const env of fixture.envs) cpSync(stash, join(env.PULLBOARD_MACHINE_HOME, 'cells-cache'), { recursive: true, force: true, preserveTimestamps: true });
  };
  await restore();
  for (let index = 0; index < fixture.clones.length; index += 1) {
    const main = String(fixture.gitAt(fixture.clones[index], fixture.envs[index], 'rev-parse', 'main')).trim();
    assert.equal(await inMachineHome(fixture.envs[index], () => readAcceptedCells(fixture.worktrees[index], main).available), true, 'a submit from the seat worktree reads it');
  }
  return restore;
}

const CACHE_DAYS = 3;

/**
 * The machine folder where the fixture's accepted cells inventories are kept between runs, keyed by tree and analyzer [C7].
 * Why: the seeded tree is the same on every run of the same source, and a cold census of it took 40-160 s on a loaded
 * runner, most of the fixture's setup; warmAcceptedCells reuses a matching artifact and checks its identity itself.
 */
function fixtureCellsCacheHome() {
  const home = join(machineHome(), 'fixture-cache', 'relay-cells');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** Drop cached inventories nobody used for CACHE_DAYS, so the machine folder stays bounded as main moves. */
function pruneFixtureCellsCache(home) {
  const folder = join(home, 'cells-cache', 'accepted'), cutoff = Date.now() - CACHE_DAYS * 86400000;
  let names;
  try { names = readdirSync(folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!name.endsWith('.inventory.gz')) continue;
    const key = name.slice(0, -'.inventory.gz'.length), file = join(folder, name);
    if (statSync(file).atimeMs >= cutoff) continue;
    for (const suffix of ['.inventory.gz', '.ready.json', '.failure.json', '.lock.sqlite']) rmSync(join(folder, key + suffix), { force: true });
  }
}
