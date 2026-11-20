/** A red submit static check on the merged landing tree names its check, file and line, and charges the items that changed the file [C7,#3345]. */
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { STATIC_SCOPE_ENV } from '../../../gate/heavy.js';
import { analysisScope } from '../../../gate/heavy.js';

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

/** A scope list longer than this is not exported into a shell command line; the check runs whole instead. */
const SCOPE_PATH_LIMIT = 1000;

/**
 * The static command for a landing batch, handed the merged tree's changed paths through PULLBOARD_STATIC_SCOPE.
 * Why: the submit gate already scopes its static run to the changed paths; the landing ran every rule on every file. A change to
 * an input every rule reads, a deletion or an unreadable diff keeps the whole run, as submit does.
 * @param {string} root The landing checkout holding the merged tree.
 * @param {string} base Main's tip the batch was built on.
 * @param {{staticChecks?: string}} config The project config.
 * @returns {{staticChecks?: string}} The config with its static command exporting the scope, or the config unchanged.
 */
export function scopedStaticConfig(root, base, config) {
  const command = config?.staticChecks?.trim();
  if (!command) return config;
  const ran = tryGit(root, ['--no-replace-objects', 'diff', '--no-renames', '--name-status', base, 'HEAD']);
  if (ran.status !== 0) return config;
  const changes = ran.stdout.split('\n').filter(Boolean).map(row => { const [status, ...path] = row.split('\t'); return { status: status[0], path: path.join('\t') }; });
  const scope = analysisScope(changes);
  if (scope.full || scope.files.length > SCOPE_PATH_LIMIT) return config;
  const quoted = `'${JSON.stringify(scope.files).replaceAll("'", "'\\''")}'`;
  return { ...config, staticChecks: `export ${STATIC_SCOPE_ENV}=${quoted}; ${command}` };
}

/**
 * Judge a red static check on the merged tree against the same check on main: a row main already prints (same file and text,
 * wherever its line moved) is main's own and never refuses; a row main does not print refuses LAND_STATIC_RED with its file and
 * line. Why: refusing any red row held every landing behind rows main itself carried [C7,#5560].
 *
 * @param {unknown} error What the static runner threw on the merged tree.
 * @param {string} baseline What the same check printed on main.
 * @param {string} [check] The configured static check command, named in the refusal.
 * @returns {unknown} null when every red row is main's, a LAND_STATIC_RED refusal with `files` and `rows`, or the error unchanged when it is not a static red.
 */
export function judgeStaticAgainstBaseline(error, baseline, check = 'staticChecks') {
  if (!(error instanceof Refused) || error.code !== 'GATE_RED' || !/static checks are red/u.test(error.message)) return error;
  const key = row => `${row.file}\0${row.text}`;
  const inherited = new Set(staticRows(baseline).map(key));
  const rows = staticRows(error.message);
  if (!rows.length) return error;
  const added = rows.filter(row => !inherited.has(key(row)));
  if (!added.length) return null;
  const refusal = new Refused('LAND_STATIC_RED', `the static check ${check} is red on the merged tree in rows main does not print: ${added.map(row => `${row.file}:${row.line}: ${row.text}`).join('; ')}; fix those lines and resubmit`);
  refusal.files = [...new Set(added.map(row => row.file))];
  refusal.rows = added;
  return refusal;
}
