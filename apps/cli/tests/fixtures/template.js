/**
 * The fixture project, built once per test process and copied per case [C7,#8088].
 *
 * Why: a fixture project (a real git repo, a board, two commits and a joined seat) costs seconds to build, and a journey
 * file starts a fresh one in most cases. The first case in a process builds its project the ordinary way, and a copy of
 * the result becomes the template; every later case with the same shape gets a private copy of the template instead.
 * A box that does not look like a freshly made sandbox (a replaced run, declared families, an edited machine home) is
 * never copied, so a case that changed its setup still builds its own project.
 *
 * Each copy is a copy-on-write clone where the file system has them (APFS, btrfs, XFS): a clone shares the template's
 * blocks, so a case pays for its directory entries, not its bytes. Where clones are unsupported (ext4 on Linux CI) it
 * falls back to an ordinary copy [C7,#8319].
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Budget: how long a template serves copies; a seat's heartbeat in an older copy would look stale to the board. */
const TEMPLATE_MAX_AGE_MS = 45_000;
/** Compressed git objects hold no sandbox path; they are the bulk of a repo, so the path scan skips them. */
const SKIPPED = '.git/objects';

const templates = new Map();
const stats = { builds: 0, copies: 0, clones: 0 };
const roots = new Set();
let exitHooked = false;

/** The cp flags that clone a tree on this platform: BSD cp -c on macOS, GNU --reflink=always elsewhere. */
const CLONE_FLAGS = process.platform === 'darwin' ? ['-c', '-pR'] : ['--reflink=always', '-a'];
/** Whether this process's file system clones: probed once on a scratch file, so an unsupported one costs one failed cp, not one per case. */
let cloning = null;

/** Probe once whether cp can clone in the temp folder; any failure means the copy fallback. */
function canClone() {
  if (cloning !== null) return cloning;
  const probe = join(tmpdir(), `pullboard-tpl-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(probe);
    writeFileSync(join(probe, 'from'), 'probe\n');
    execFileSync('cp', [...CLONE_FLAGS, join(probe, 'from'), join(probe, 'to')], { stdio: 'ignore' });
    cloning = readFileSync(join(probe, 'to'), 'utf8') === 'probe\n';
  } catch { cloning = false; } finally { rmSync(probe, { recursive: true, force: true }); }
  return cloning;
}

/**
 * Clone the named entries of one directory into another (created or merged), true when cp cloned them all. Why one cp
 * for the whole set: a process start costs about what node pays to copy a few hundred small files.
 */
function cloneInto(from, names, to) {
  if (!names.length || !canClone()) return false;
  try { execFileSync('cp', [...CLONE_FLAGS, ...names.map(name => join(from, name)), `${to}/`], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Copy the named entries of one directory into another: a copy-on-write clone where supported, else an ordinary copy [C7,#8319]. */
function copyInto(from, names, to) {
  if (cloneInto(from, names, to)) { stats.clones += 1; return 'clone'; }
  for (const name of names) cpSync(join(from, name), join(to, name), { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
  return 'copy';
}

/** Remove every template tree when the process ends; the copies belong to their own sandboxes. */
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => { for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* A leftover temp tree is harmless. */ } } });
}

/** Every entry under a directory as { rel, abs, stat }, skipping compressed git objects. */
function* walk(root, rel = '') {
  for (const name of readdirSync(join(root, rel))) {
    const next = rel ? `${rel}/${name}` : name;
    if (next === SKIPPED) continue;
    let stat;
    try { stat = lstatSync(join(root, next)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; } // A database's -shm file vanishes when it closes.
    yield { rel: next, abs: join(root, next), stat };
    if (stat.isDirectory()) yield* walk(root, next);
  }
}

/** Every path and file text under a small directory, with the sandbox path made neutral; a fresh sandbox is a shim and a machine home. */
function treeText(root, dir) {
  const rows = [];
  for (const { rel, abs, stat } of walk(root)) rows.push(`${rel}\0${stat.isFile() ? readFileSync(abs, 'utf8').replaceAll(dir, '@') : ''}`);
  return rows.sort().join('\n');
}

/**
 * What makes two boxes interchangeable: the same environment and sandbox files once the sandbox path is neutral and the original run. Null when the box has been changed and must build its own project.
 */
function signature(box) {
  if (!box.runSync || box.runSync.of !== box.run || box.declareFamilies) return null;
  const env = JSON.stringify(Object.entries(box.env).sort(([a], [b]) => a < b ? -1 : 1)).replaceAll(box.dir, '@');
  return createHash('sha256').update(env).update(treeText(box.dir, box.dir)).digest('hex');
}

/** Fold every database write back into its file, so the copy holds no write-ahead log; false when one cannot be. */
function settleDatabases(root) {
  for (const { abs, stat } of [...walk(root)]) {
    if (!stat.isFile() || !/\.sqlite$/u.test(abs)) continue;
    try {
      const db = new DatabaseSync(abs);
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    } catch { return false; }
    for (const side of ['-wal', '-shm']) { try { if (side === '-wal' && lstatSync(abs + side).size > 0) return false; } catch { /* No log file is the settled state. */ } }
  }
  return true;
}

/**
 * The files git tracks in the live project, as paths relative to the sandbox: one listing per working tree. Why: a tracked
 * file's committed blob holds the sandbox path and cannot be rewritten, so its working copy keeps that path too;
 * rewriting it would show as a change the hooks then refuse.
 */
function trackedFiles(box) {
  const tracked = new Set();
  for (const top of readdirSync(box.dir)) {
    if (!existsSync(join(box.dir, top, '.git'))) continue;
    const listed = box.tryGit(join(box.dir, top), 'ls-files', '-z');
    if (listed.status === 0) for (const name of String(listed.stdout).split('\0')) if (name) tracked.add(`${top}/${name}`);
  }
  return tracked;
}

/** Snapshot a freshly built project into a template, or null when it holds something a copy cannot carry. */
function snapshot(box, built) {
  if (!settleDatabases(box.dir)) return null;
  const root = join(tmpdir(), `pullboard-tpl-${process.pid}-${stats.builds}-${templates.size}-${Date.now()}`);
  mkdirSync(root);
  roots.add(root);
  hookExit();
  const names = readdirSync(box.dir).filter(name => name !== 'bin');
  copyInto(box.dir, names, root);
  const needle = Buffer.from(box.dir);
  const hits = [];
  const tracked = trackedFiles(box);
  for (const { rel, abs, stat } of walk(root)) {
    if (stat.isSymbolicLink() && readlinkSync(abs).includes(box.dir)) return drop(root);
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) return drop(root); // A socket or pipe cannot be copied.
    if (stat.isFile() && readFileSync(abs).includes(needle) && !tracked.has(rel)) hits.push(rel);
  }
  const fields = {};
  for (const [key, value] of Object.entries(built)) if (typeof value === 'string' && value.startsWith(`${box.dir}/`) && box[key] !== value) fields[key] = value.slice(box.dir.length + 1);
  return { from: box.dir, root, names, hits, fields, builtAt: Date.now() };
}

/** Discard a template that cannot be used. */
function drop(root) { rmSync(root, { recursive: true, force: true }); roots.delete(root); return null; }

/** Replace every occurrence of one sandbox path with another of the same length, in place, so no offset moves. */
function rewrite(file, from, to) {
  const data = readFileSync(file);
  const needle = Buffer.from(from);
  const next = Buffer.from(to);
  for (let at = data.indexOf(needle); at >= 0; at = data.indexOf(needle, at + needle.length)) next.copy(data, at);
  writeFileSync(file, data);
}

/** Copy a template into a bare sandbox and point its stored paths at the new directory. */
function instantiate(template, box) {
  copyInto(template.root, template.names, box.dir);
  for (const rel of template.hits) rewrite(join(box.dir, rel), template.from, box.dir);
  return { ...box, ...Object.fromEntries(Object.entries(template.fields).map(([key, rel]) => [key, join(box.dir, rel)])) };
}

/**
 * The project for one case: a private copy of this process's template for the same shape, or a fresh build that also
 * becomes the template.
 *
 * @param {object} box - The case's sandbox.
 * @param {string} shape - What else distinguishes projects (the gate, the git layout); equal shapes share a template.
 * @param {() => object} build - Builds the project the ordinary way and returns the box with its paths.
 * @returns {object} The box with its project paths.
 */
export function templatedProject(box, shape, build) {
  const sig = signature(box);
  if (sig === null || process.env.PULLBOARD_FIXTURE_TEMPLATE === 'off') return build();
  const key = `${shape}\0${sig}`;
  const have = templates.get(key);
  if (have && have.from.length === box.dir.length && Date.now() - have.builtAt < TEMPLATE_MAX_AGE_MS) { stats.copies += 1; return instantiate(have, box); }
  stats.builds += 1;
  const built = build();
  if (have) drop(have.root);
  const made = snapshot(box, built);
  if (made) templates.set(key, made); else templates.delete(key);
  return built;
}

/** The sandbox directories this process's templates were taken from. */
export function templateOrigins() { return [...templates.values()].map(template => template.from); }

/**
 * How many projects this process built from nothing and copied from a template, how many tree copies were clones, and
 * the copy method this file system gets ('clone' or 'copy'); the fixture's own test reads it.
 */
export function templateStats() { return { ...stats, templates: templates.size, method: canClone() ? 'clone' : 'copy' }; }
