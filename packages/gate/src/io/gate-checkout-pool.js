/** The coordinator gate's kept checkouts: moved to each candidate, so a gate writes only the files that differ [C7]. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';

/** A kept checkout's folder name: a random id, so no two gates ever pick the same new name. */
const SLOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

/** A kept checkout no gate has borrowed for a day is removed, so a burst of parallel gates does not keep its trees. */
export const GATE_CHECKOUT_IDLE_MS = 24 * 3_600_000;

/**
 * Where the coordinator keeps gate checkouts idle between gates: beside the folder that holds every gate's hand-off
 * folder, so inside the repository's own Git folder, on whatever disk the repository is on. No setting, volume or
 * path is special to one operating system (#3700).
 *
 * @param {string} root - A gate's checkout place: <hand-offs>/<job>/source.
 * @returns {string} <hand-offs>/../gate-checkouts.
 */
export function gateCheckoutPool(root) {
  return join(dirname(dirname(dirname(root))), 'gate-checkouts');
}

/**
 * A Git runner: takes Git's arguments and returns whether it succeeded, its trimmed output and its error text, never
 * throwing, so each step decides. The caller passes its own, as the runners pass theirs to borrowWarmCheckout.
 *
 * @typedef {(args: string[]) => { ok: boolean, out: string, err: string }} GateGit
 */

/** Git against the common repository, so it works whichever checkout still exists. */
const common = (git, commonDir, args) => git(['--git-dir', commonDir, ...args]);

/** Git inside one checkout. */
const inside = (git, root, args) => git(['-C', root, ...args]);

/**
 * Whether `root` is a linked checkout of this repository, at exactly this commit when one is named, with nothing
 * modified, untracked or ignored in it. Why ignored files count: a gate must never see another gate's files, and a
 * build output is a file the next gate would see.
 *
 * @param {GateGit} git
 * @param {string} commonDir
 * @param {string} root
 * @param {string} [commit]
 * @returns {boolean}
 */
export function exactGateCheckout(git, commonDir, root, commit) {
  const identity = inside(git, root, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel', 'HEAD']);
  if (!identity.ok) return false;
  const [actualCommon, top, head] = identity.out.split('\n');
  try {
    if (realpathSync(actualCommon) !== realpathSync(commonDir) || realpathSync(top) !== realpathSync(root)) return false;
  } catch { return false; }
  if (commit && head !== commit) return false;
  const status = inside(git, root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);
  return status.ok && status.out === '';
}

/**
 * Remove one checkout and its registration. A kept checkout is locked against pruning, so removal forces twice.
 *
 * @param {GateGit} git
 * @param {string} commonDir
 * @param {string} root
 */
export function discardGateCheckout(git, commonDir, root) {
  common(git, commonDir, ['worktree', 'remove', '--force', '--force', root]);
  rmSync(root, { recursive: true, force: true });
}

/** Re-point Git's registration at the folder a checkout was moved to. */
function repair(git, commonDir, root) {
  return common(git, commonDir, ['worktree', 'repair', root]).ok;
}

/** The idle kept checkouts, most recently used first. */
function idleSlots(pool) {
  let names;
  try { names = readdirSync(pool); } catch { return []; }
  const slots = [];
  for (const name of names.filter(entry => SLOT.test(entry))) {
    try { slots.push({ path: join(pool, name), usedAt: statSync(join(pool, name)).mtimeMs }); } catch { /* borrowed meanwhile */ }
  }
  return slots.sort((a, b) => b.usedAt - a.usedAt);
}

/** How many tracked files differ between two commits: the files a move between them writes or deletes. */
function changedFiles(git, root, from, to) {
  if (from === to) return 0;
  const diff = inside(git, root, ['diff', '--name-only', '--no-renames', '-z', from, to]);
  return diff.ok ? diff.out.split('\0').filter(Boolean).length : null;
}

/**
 * Take a checkout for one gate at `root`, which must not exist, checked out at `commit`. An idle kept checkout is
 * claimed by renaming it to `root`, which only one gate can win, then moved to the candidate with a detached
 * checkout, which writes only the files that differ. A kept checkout that is not exactly clean, or cannot be moved,
 * is discarded and never used. With none left, a new checkout is added, locked so no prune or sweep removes it.
 * Why: the runners keep warm checkouts the same way (borrowWarmCheckout); here each kept checkout is a linked
 * worktree of the coordinator's repository, so the gate's checkout stays where the hand-off binding expects it.
 *
 * @param {{ git: GateGit, commonDir: string, pool: string, root: string, commit: string }} options - Git, the common Git folder, the
 *   kept checkouts' folder (gateCheckoutPool), the gate's place and its candidate.
 * @returns {{ reused: boolean, from: string | null, written: number | null }} Whether a kept checkout was reused,
 *   the commit it moved from, and how many tracked files the move wrote or deleted (null for a new checkout).
 */
export function borrowGateCheckout({ git, commonDir, pool, root, commit }) {
  if (!isAbsolute(root) || existsSync(root)) throw new Error('a gate checkout needs an empty absolute place');
  for (const slot of idleSlots(pool)) {
    try { renameSync(slot.path, root); } catch { continue; } // another gate claimed it first
    if (repair(git, commonDir, root) && exactGateCheckout(git, commonDir, root)) {
      const from = inside(git, root, ['rev-parse', 'HEAD']).out;
      if (inside(git, root, ['checkout', '-q', '--detach', commit]).ok && exactGateCheckout(git, commonDir, root, commit)) {
        return { reused: true, from, written: changedFiles(git, root, from, commit) };
      }
    }
    discardGateCheckout(git, commonDir, root);
  }
  const added = common(git, commonDir, ['worktree', 'add', '--lock', '--detach', root, commit]);
  if (!added.ok) throw new Error(`queued source Git worktree failed: ${added.err.slice(0, 1000)}`);
  return { reused: false, from: null, written: null };
}

/**
 * Give a gate's checkout back once the gate has ended. Only a checkout still exactly at `commit` with nothing
 * modified, untracked or ignored is kept; anything else is discarded. Kept checkouts idle past
 * GATE_CHECKOUT_IDLE_MS are removed on the way.
 *
 * @param {{ git: GateGit, commonDir: string, pool: string, root: string, commit: string, now?: number }} options
 * @returns {boolean} Whether the checkout was kept for the next gate.
 */
export function returnGateCheckout({ git, commonDir, pool, root, commit, now = Date.now() }) {
  if (!existsSync(root)) return false;
  let kept = false;
  if (exactGateCheckout(git, commonDir, root, commit)) {
    mkdirSync(pool, { recursive: true, mode: 0o700 });
    const slot = join(pool, randomUUID());
    try {
      renameSync(root, slot);
      kept = repair(git, commonDir, slot);
      if (kept) utimesSync(slot, new Date(now), new Date(now));
      else discardGateCheckout(git, commonDir, slot);
    } catch { discardGateCheckout(git, commonDir, existsSync(slot) ? slot : root); kept = false; }
  } else discardGateCheckout(git, commonDir, root);
  trimGateCheckouts(git, commonDir, pool, now);
  return kept;
}

/**
 * Remove kept checkouts idle past GATE_CHECKOUT_IDLE_MS. Each is claimed by a rename first, so a checkout a gate is
 * borrowing at the same moment is never removed under it.
 *
 * @param {GateGit} git
 * @param {string} commonDir
 * @param {string} pool - The kept checkouts' folder.
 * @param {number} [now]
 */
export function trimGateCheckouts(git, commonDir, pool, now = Date.now()) {
  for (const slot of idleSlots(pool)) {
    if (now - slot.usedAt < GATE_CHECKOUT_IDLE_MS) continue;
    const claimed = resolve(pool, `.discard-${randomUUID()}`);
    try { renameSync(slot.path, claimed); } catch { continue; }
    repair(git, commonDir, claimed);
    discardGateCheckout(git, commonDir, claimed);
  }
}
