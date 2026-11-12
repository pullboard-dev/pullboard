/**
 * The repository layout rules, as pure functions over a list of tracked paths [V32,V33].
 * Why: the freeze that moves every cell to apps/ and packages/ with logic/ and io/ needs a counter that says how far the
 * tree is from the target, so each violation is named by its rule and the count can only go down.
 */
import { ROOT_FILES } from './allowlist.js';
import { ROOT_FOLDERS } from './allowlist.js';
import { isDefaultTestFile } from './discovery.js';

/** What each rule demands and the next step, so a finding names where its file belongs. */
export const LAYOUT_RULES = Object.freeze({
  'root-entry': 'the root holds only apps/, packages/, docs/, skills/, package.json and the project documents; move it under a cell',
  'alias-root': 'migration alias: a root bin/, src/, relay/ or test/ folder; move its files into the cell that owns them',
  'cell-entry': 'a cell holds only index.js, light.js, browser.js, src/, tests/, data/ (and journeys/ plus one command file in an app); move it into one of them',
  'alias-door': 'migration alias: core.js is light.js and pure.js is browser.js; rename the door',
  'alias-folder': 'migration alias: src/core is src/logic and src/shell is src/io; rename the folder',
  'src-entry': 'a cell\'s src/ holds only logic/ and io/; move it into one of them',
  'test-placement': 'tests/ holds test files under logic/ and io/ and helpers under fixtures/; move it',
  'test-mirror': 'a test file sits at tests/<logic|io>/<path> and mirrors the src/<logic|io>/<path> file it proves (a test in tests/<tier>/<name>/ mirrors src/<tier>/<name>); a test with no source file sits at tests/<topic> or tests/<group>/<topic>; move it',
  'data-group': 'data/ holds only the groups baselines/, ceilings/, tests/, plan/, history/ and blueprints/; move it into one',
  'journey-folder': 'journeys/ holds one folder per exact command; put the file in journeys/<command>/',
  'name-repeat': 'a file name never repeats its cell\'s or folder\'s name; drop that word',
  'name-length': 'a file name is one word, or two only when one word would be ambiguous in its folder; shorten it',
  'name-group': 'three or more files sharing a first word become a subfolder named for that word, without the word in each file',
});

const ROOT_DIRS = new Set(['apps', 'packages', 'docs', 'skills', ...ROOT_FOLDERS.filter(folder => folder.startsWith('.'))]);
const ROOT_DOCS = new Set([...ROOT_FILES, 'COORDINATOR.md']);
const ALIAS_ROOTS = new Set(['bin', 'src', 'relay', 'test']);
const DOORS = new Set(['index.js', 'light.js', 'browser.js']);
const ALIAS_DOORS = new Map([['core.js', 'light.js'], ['pure.js', 'browser.js']]);
const ALIAS_FOLDERS = new Map([['core', 'logic'], ['shell', 'io']]);
const TIERS = new Set(['logic', 'io']);
const DATA_GROUPS = new Set(['baselines', 'ceilings', 'tests', 'plan', 'history', 'blueprints']);
/** Folders whose file names a registry reads, so the name rules leave them alone. */
const REGISTRY_FOLDERS = new Set(['moves', 'commands']);
const CELL = /^(apps|packages)\/([^/]+)\/(.+)$/u;

/** The words of a file name: whatever precedes its first dot, split on hyphens. */
function words(name) {
  return name.split('.')[0].split('-');
}

/** Whether `part` appears in `all` as consecutive words. */
function containsRun(all, part) {
  for (let at = 0; at + part.length <= all.length; at += 1) if (part.every((word, i) => all[at + i] === word)) return true;
  return false;
}

/**
 * Every layout violation in a tree, one per offending entry: a folder is one finding, a file is one finding.
 *
 * @param {string[]} paths Repository-relative tracked file paths.
 * @returns {{ rule: string, key: string, detail: string }[]} Sorted by rule then key.
 */
export function layoutViolations(paths) {
  const found = new Map();
  const add = (rule, key, detail) => { if (!found.has(`${rule}\0${key}`)) found.set(`${rule}\0${key}`, { rule, key, detail }); };
  const files = [...new Set(paths)].sort();
  const rootFiles = new Map();
  const cells = new Map();
  for (const path of files) {
    const top = path.split('/')[0];
    const match = CELL.exec(path);
    if (!match) {
      rootFiles.set(top, (rootFiles.get(top) ?? 0) + 1);
      continue;
    }
    const cell = `${match[1]}/${match[2]}`;
    if (!cells.has(cell)) cells.set(cell, { name: match[2], apps: match[1] === 'apps', rels: [] });
    cells.get(cell).rels.push(match[3]);
  }
  for (const [top, count] of rootFiles) {
    const isFolder = files.some(path => path.startsWith(`${top}/`));
    const detail = isFolder ? `${top}/ (${count} files)` : top;
    if (isFolder && ALIAS_ROOTS.has(top)) add('alias-root', top, detail);
    else if (isFolder ? !ROOT_DIRS.has(top) : !ROOT_DOCS.has(top)) add('root-entry', top, detail);
  }
  for (const [cell, info] of cells) cellViolations(cell, info, add);
  return [...found.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.key.localeCompare(b.key));
}

/** Apply the cell rules to one cell's files. */
function cellViolations(cell, { name, apps, rels }, add) {
  const effective = new Set();
  const commandFiles = rels.filter(rel => !rel.includes('/') && rel.endsWith('.js') && !DOORS.has(rel) && !ALIAS_DOORS.has(rel));
  const command = apps ? commandFiles[0] : undefined;
  for (const rel of rels) {
    const parts = rel.split('/');
    const [first] = parts;
    if (parts.length === 1) {
      if (ALIAS_DOORS.has(first)) add('alias-door', `${cell}/${first}`, `${cell}/${first} is ${cell}/${ALIAS_DOORS.get(first)}`);
      else if (!DOORS.has(first) && first !== command) add('cell-entry', `${cell}/${first}`, `${cell}/${first}`);
      continue;
    }
    if (first === 'src') {
      const tier = parts[1];
      if (ALIAS_FOLDERS.has(tier) && parts.length > 2) {
        add('alias-folder', `${cell}/src/${tier}`, `${cell}/src/${tier} is ${cell}/src/${ALIAS_FOLDERS.get(tier)}`);
        effective.add(['src', ALIAS_FOLDERS.get(tier), ...parts.slice(2)].join('/'));
      } else if (TIERS.has(tier) && parts.length > 2) effective.add(rel);
      else add('src-entry', `${cell}/src/${tier}`, `${cell}/src/${tier}`);
    } else if (first === 'tests') effective.add(rel);
    else if (first === 'data') {
      if (parts.length < 3 || !DATA_GROUPS.has(parts[1])) add('data-group', `${cell}/data/${parts[1]}`, `${cell}/data/${parts[1]}`);
    } else if (first === 'journeys' && apps) {
      if (parts.length < 3) add('journey-folder', `${cell}/${rel}`, `${cell}/${rel}`);
    } else add('cell-entry', `${cell}/${first}`, `${cell}/${first}/`);
  }
  for (const rel of effective) {
    const parts = rel.split('/');
    if (parts[0] === 'tests') testViolations(cell, rel, parts, effective, add);
    nameViolations(cell, name, rel, parts, effective, add);
  }
}

/** Placement and mirroring of one file under tests/. */
function testViolations(cell, rel, parts, effective, add) {
  const full = `${cell}/${rel}`;
  const fixture = parts[1] === 'fixtures' && parts.length > 2;
  if (fixture) return;
  if (!isDefaultTestFile(rel)) { add('test-placement', full, full); return; }
  if (parts.length === 2 && DOORS.has(`${words(parts[1])[0]}.js`)) return;
  if (parts.length === 2 || (!TIERS.has(parts[1]) && parts[1] !== 'fixtures')) return;
  if (parts.length < 3 || !TIERS.has(parts[1])) { add('test-mirror', full, `${full} has no logic/ or io/ folder`); return; }
  const mirror = ['src', ...parts.slice(1, -1), `${words(parts.at(-1)).join('-')}.js`].join('/');
  const folderMirror = parts.length > 3 ? ['src', ...parts.slice(1, -2), `${parts.at(-2)}.js`].join('/') : null;
  if (!effective.has(mirror) && !(folderMirror && effective.has(folderMirror))) add('test-mirror', full, `${full} mirrors nothing at ${cell}/${mirror}`);
}

/** The naming rules for one file under src/ or tests/. */
function nameViolations(cell, cellName, rel, parts, effective, add) {
  const full = `${cell}/${rel}`;
  const file = parts.at(-1);
  const folder = parts.at(-2);
  if (REGISTRY_FOLDERS.has(folder)) return;
  const own = words(file);
  if (folder === 'engines' && own.length > 1 && own.at(-1) === 'engine') own.pop();
  const repeats = [cellName, folder].some(other => containsRun(own, other.split('-')));
  if (repeats) add('name-repeat', full, full);
  const siblings = [...effective].filter(other => other !== rel && other.startsWith(parts.slice(0, -1).join('/') + '/') && other.split('/').length === parts.length);
  const mates = siblings.map(other => words(other.split('/').at(-1)));
  if (folder !== 'engines' && own.length > 2) add('name-length', full, full);
  else if (folder !== 'engines' && own.length === 2 && !mates.some(other => other.at(-1) === own[1] || other[0] === own[0])) add('name-length', full, full);
  if (own.length > 1 && 1 + mates.filter(other => other.length > 1 && other[0] === own[0]).length >= 3) {
    add('name-group', `${cell}/${parts.slice(0, -1).join('/')}/${own[0]}-`, `${cell}/${parts.slice(0, -1).join('/')}: files starting ${own[0]}-`);
  }
}

/**
 * Count findings per rule.
 *
 * @param {{ rule: string }[]} violations
 * @returns {Record<string, number>} Every known rule, zero when clean.
 */
export function layoutCounts(violations) {
  const counts = Object.fromEntries(Object.keys(LAYOUT_RULES).map(rule => [rule, 0]));
  for (const { rule } of violations) counts[rule] += 1;
  return counts;
}

/**
 * Compare the counts with the accepted baseline: a rule above its baseline is a problem, one below is progress.
 * Why: the freeze lowers these counts; they may never rise, and a rule missing from the baseline accepts none.
 *
 * @param {Record<string, number>} counts
 * @param {{ version?: number, rules?: Record<string, number> } | null} baseline
 * @param {{ rule: string, key: string }[]} violations
 * @returns {{ problems: string[], lowered: string[] }}
 */
export function layoutRatchet(counts, baseline, violations) {
  const accepted = baseline?.rules ?? {};
  const problems = [], lowered = [];
  for (const rule of Object.keys(LAYOUT_RULES)) {
    const before = accepted[rule] ?? 0, now = counts[rule] ?? 0;
    if (now > before) {
      const sample = violations.filter(row => row.rule === rule).slice(0, 5).map(row => row.key).join(', ');
      problems.push(`layout ${rule} rose from ${before} to ${now} (${sample}); ${LAYOUT_RULES[rule]}`);
    } else if (now < before) lowered.push(`layout ${rule} fell from ${before} to ${now}; run layout-check --write to lock it in`);
  }
  return { problems, lowered };
}
