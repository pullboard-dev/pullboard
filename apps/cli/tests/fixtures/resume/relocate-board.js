/** Relocate a copied template root's board file and per-root home folders to the new root [C7,#8997]. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The ways the template root is spelled, longest first so one spelling never rewrites the middle of another. */
function spellings(templateRoot) {
  return [...new Set([templateRoot, realpathSync(templateRoot)])].sort((a, b) => b.length - a.length);
}

/** Replace every spelling of the template root in a text file; a file that does not name it is left untouched. */
function rewriteText(file, names, newRoot) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const name of names) after = after.split(name).join(newRoot);
  if (after !== before) writeFileSync(file, after);
}

/** Every file under a folder, as absolute paths; a folder that does not exist has none. */
function filesIn(folder) {
  let entries;
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(entry => (entry.isDirectory() ? filesIn(join(folder, entry.name)) : entry.isFile() ? [join(folder, entry.name)] : []));
}

/**
 * Rewrite the board file of a copied root so every stored path names the new root: seats, worktree paths and the board's own metadata.
 * Why: init stores the root path in the board, so a cached template copied into a new root would otherwise point seats at the template.
 * It is a parameterised UPDATE over every text column that names the template, never a raw byte replace of the sqlite file.
 *
 * @param {string} templateRoot the fixture root the copy was made from
 * @param {string} newRoot the copy
 */
export function relocateBoard(templateRoot, newRoot) {
  const names = spellings(templateRoot);
  const folder = join(newRoot, 'repo', '.git', 'pullboard');
  const db = new DatabaseSync(join(folder, 'board.sqlite'));
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL%'").all();
    for (const { name: table } of tables) {
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
      for (const { name: column } of columns) {
        const update = db.prepare(`UPDATE "${table}" SET "${column}" = replace("${column}", ?, ?) WHERE typeof("${column}") = 'text' AND instr("${column}", ?) > 0`);
        for (const name of names) update.run(name, newRoot, name);
      }
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  for (const file of ['setup-written-files.json', ...filesIn(join(folder, 'trace')).map(path => path.slice(folder.length + 1))]) rewriteText(join(folder, file), names, newRoot);
}

/**
 * Rewrite the per-root home and machine-home folders of a copied root so they name only the new root.
 * Why: the project list and the board-write log carry the root path, and a copy would otherwise list and log the template.
 *
 * @param {string} templateRoot the fixture root the copy was made from
 * @param {string} newRoot the copy
 */
export function relocateHomes(templateRoot, newRoot) {
  const names = spellings(templateRoot);
  for (const folder of ['home', 'machine-home']) for (const file of filesIn(join(newRoot, folder))) rewriteText(file, names, newRoot);
}
