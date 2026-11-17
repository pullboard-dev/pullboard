/** The one builder of the command that runs named test files, shared by submit, reuse, landing and the test pull [C7]. */
import { Refused } from '../../../../kernel/index.js';

/**
 * The config's affected-tests command followed by each file as a quoted `./` path.
 *
 * With a selection unit other than `file` (gate.selectionUnit), `files` holds units, and each goes shell-quoted, sorted
 * and deduplicated in place of the `{units}` placeholder, so the same units in any order give the same string. A command
 * holding `{unit}` instead runs once per unit, those commands joined with `&&`, for Rust crates and C# projects (one `-p`/project each).
 *
 * Why: submit, proof reuse, landing and the deferred landing run each assembled this string by hand, and proof reuse
 * compares command strings, so one site that quoted without the `./` prefix or kept a trailing space was a silent reuse miss.
 *
 * @param {{ affectedTests: string }} config
 * @param {string[]} files - Repo-relative paths, or units when `unit` is not `file`.
 * @param {string} [unit] - The gate.selectionUnit value; `file` keeps the path form byte for byte.
 * @returns {string}
 */
export function affectedCommand(config, files, unit = 'file') {
  const word = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  if (unit === 'file') return `${config.affectedTests.trimEnd()} ${files.map(file => word('./' + file)).join(' ')}`;
  const each = config.affectedTests.includes('{unit}');
  if (each && config.affectedTests.includes('{units}')) {
    throw new Refused('SELECTION_UNIT_COMMAND', 'the affected-tests command holds both {units} and {unit}; keep {units} for one command over all units, or {unit} for one command per unit');
  }
  if (each) return [...new Set(files)].sort().map(value => config.affectedTests.replaceAll('{unit}', () => word(value))).join(' && ');
  if (!config.affectedTests.includes('{units}')) {
    throw new Refused('SELECTION_UNIT_COMMAND', `gate.selectionUnit is ${unit} but the affected-tests command has no {units} placeholder; add {units} to it, or set gate.selectionUnit to file`);
  }
  return config.affectedTests.replaceAll('{units}', () => [...new Set(files)].sort().map(word).join(' '));
}
