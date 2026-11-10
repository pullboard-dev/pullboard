/** A red submit static check on the merged landing tree names its check, file and line, and charges the items that changed the file [C7,#3345]. */
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/** The `path:line: text` rows a static check prints, one per violation. */
export function staticRows(output) {
  return String(output ?? '').split('\n').map(line => /^(\S+?):(\d+): (.+)$/u.exec(line.trim())).filter(Boolean)
    .map(match => ({ file: match[1], line: Number(match[2]), text: match[3] }));
}

/**
 * Turn the submit static runner's GATE_RED on the merged tree into LAND_STATIC_RED when its rows sit in files the batch changed.
 * Why: the check is green on main, so a row in a file the batch touched is the batch's own; a row in an untouched file is main's
 * and keeps the plain refusal. Reusing the submit runner's output keeps one list of checks for submit and landing.
 * @param {string} root The landing checkout holding the merged tree.
 * @param {string} base Main's tip the batch was built on.
 * @param {unknown} error What the static runner threw.
 * @param {string} [check] The configured static check command, named in the refusal.
 * @returns {unknown} A LAND_STATIC_RED refusal with `files` and `rows`, or the error unchanged.
 */
export function landingStaticRefusal(root, base, error, check = 'staticChecks') {
  if (!(error instanceof Refused) || error.code !== 'GATE_RED' || !/static checks are red/u.test(error.message)) return error;
  const changed = new Set(git(root, ['diff', '--no-renames', '--name-only', base, 'HEAD']).split('\n').filter(Boolean));
  const rows = staticRows(error.message).filter(row => changed.has(row.file));
  if (!rows.length) return error;
  const refusal = new Refused('LAND_STATIC_RED', `the static check ${check} is green on main and red on the merged tree: ${rows.map(row => `${row.file}:${row.line}: ${row.text}`).join('; ')}; fix those lines and resubmit`);
  refusal.files = [...new Set(rows.map(row => row.file))];
  refusal.rows = rows;
  return refusal;
}

/** The batch entries whose own change touches any of the named files; the rest of the batch is not charged. */
export function entriesTouching(root, base, entries, files) {
  return entries.filter(entry => {
    const changed = tryGit(root, ['--no-replace-objects', 'diff', '--name-only', `${base}...${entry.commit}`]);
    return changed.status === 0 && changed.stdout.split('\n').some(file => files.includes(file));
  });
}
