/**
 * The fixture project, built once per test process and copied per case [C7,#8088].
 *
 * Why: a fixture project (a real git repo, a board, two commits and a joined seat) costs seconds to build, and a journey
 * file starts a fresh one in most cases. The first case in a process builds its project the ordinary way, and a copy of
 * the result becomes the template; every later case with the same shape gets a private copy of the template instead.
 * A box that does not look like a freshly made sandbox (a replaced run, declared families, an edited machine home) is
 * never copied, so a case that changed its setup still builds its own project.
 */
import { createHash } from 'node:crypto';
import { cpSync } from 'node:fs';
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
const stats = { builds: 0, copies: 0 };
const roots = new Set();
let exitHooked = false;

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
    const stat = lstatSync(join(root, next));
    yield { rel: next, abs: join(root, next), stat };
    if (stat.isDirectory()) yield* walk(root, next);
  }
}

/** Every file text of a small directory, with the sandbox path made neutral; the machine home of a fresh sandbox. */
function treeText(root, dir) {
  const rows = [];
  for (const { rel, abs, stat } of walk(root)) rows.push(`${rel}\0${stat.isFile() ? readFileSync(abs, 'utf8').replaceAll(dir, '@') : ''}`);
  return rows.sort().join('\n');
}

/**
 * What makes two boxes interchangeable: the same environment and machine home once the sandbox path is neutral, a bare
 * sandbox directory, and the original run. Null when the box has been changed and must build its own project.
 */
function signature(box) {
  if (!box.runSync || box.runSync.of !== box.run || box.declareFamilies) return null;
  const top = readdirSync(box.dir).sort().join(',');
  if (top !== 'bin,machine-home') return null;
  const env = JSON.stringify(Object.entries(box.env).sort(([a], [b]) => a < b ? -1 : 1)).replaceAll(box.dir, '@');
  return createHash('sha256').update(env).update(treeText(join(box.dir, 'machine-home'), box.dir)).digest('hex');
}

/** Fold every database write back into its file, so the copy holds no write-ahead log; false when one cannot be. */
function settleDatabases(root) {
  for (const { abs, stat } of walk(root)) {
    if (!stat.isFile() || !/\.sqlite$/u.test(abs)) continue;
    try {
      const db = new DatabaseSync(abs);
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    } catch { return false; }
    for (const side of ['-wal', '-shm']) { try { if (side === '-wal' && lstatSync(abs + side).size > 0) return false; } catch { /* No log file is the settled state. */ } }
  }
  return true;
}

/** Snapshot a freshly built project into a template, or null when it holds something a copy cannot carry. */
function snapshot(box, built) {
  if (!settleDatabases(box.dir)) return null;
  const root = join(tmpdir(), `pullboard-tpl-${process.pid}-${stats.builds}-${templates.size}-${Date.now()}`);
  mkdirSync(root);
  roots.add(root);
  hookExit();
  const names = readdirSync(box.dir).filter(name => name !== 'bin');
  for (const name of names) cpSync(join(box.dir, name), join(root, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const needle = Buffer.from(box.dir);
  const hits = [];
  for (const { rel, abs, stat } of walk(root)) {
    if (stat.isSymbolicLink() && readlinkSync(abs).includes(box.dir)) return drop(root);
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) return drop(root); // A socket or pipe cannot be copied.
    if (stat.isFile() && readFileSync(abs).includes(needle)) hits.push(rel);
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
  for (const name of template.names) cpSync(join(template.root, name), join(box.dir, name), { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
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

/** How many projects this process built from nothing and copied from a template; the fixture's own test reads it. */
export function templateStats() { return { ...stats, templates: templates.size }; }
