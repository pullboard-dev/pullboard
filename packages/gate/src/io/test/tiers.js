/** Generate reviewable testing tiers from the literal module graph, without executing tests [C7,CS4,CD44,CD47]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { posix } from 'node:path';
import { isBuiltin } from 'node:module';
import { cellInventory } from '../../../../codemap/index.js';
import { withCellSourceSnapshots } from '../../../../codemap/index.js';
import { repositoryImport } from '../../../../codemap/index.js';
import { importsIn } from '../../../../codemap/index.js';
import { commonJsIn } from '../../../../codemap/index.js';
import { withImportParseCache } from '../imports.js';
import { lex } from '../../../../kernel/index.js';

export const TEST_TIERS_FILE = 'packages/gate/data/tests/tiers.json';
const TEST = /\.(?:test|spec)\.[cm]?js$/u;

/** Syntax the import parser cannot prove remains a journey, while parser infrastructure failures still refuse. */
function tierImports(sources) {
  try { return importsIn(sources); }
  catch (error) {
    if (error.message !== 'source does not compile as an ES module') throw error;
    return sources.map(source => {
      try { return importsIn([source])[0]; }
      catch (failure) {
        if (failure.message !== 'source does not compile as an ES module') throw failure;
        return ['(unparsed)'];
      }
    });
  }
}

const FOLDER_ROOT = /^(?:packages|apps)\/[^/]+(?=\/)/u;

/** Each file under a package or app folder is owned by that folder root; no cells plan is read, so folders alone place a file [C7,#2467]. */
export function cellOwners(files) {
  // A real Map, because the tier snapshot cache serializes it; a file map that cannot list its paths places nothing here and ownerOf falls back to the folder root.
  const owners = new Map();
  for (const file of files.keys?.() ?? []) {
    const root = FOLDER_ROOT.exec(file)?.[0];
    if (root) owners.set(file, root);
  }
  return owners;
}

/** Prefer explicit cells, then ordinary package folders, then the closest package.json. */
export function ownerOf(file, files, owners) {
  if (owners.has(file)) return owners.get(file);
  const cell = FOLDER_ROOT.exec(file)?.[0];
  if (cell) return cell;
  let directory = posix.dirname(file);
  while (directory !== '.') {
    if (files.has(`${directory}/package.json`)) return directory;
    directory = posix.dirname(directory);
  }
  return files.has('package.json') ? '.' : null;
}

/** Retain infrastructure imports and calls even when a test reaches them through a fixture helper. */
function infrastructure(file, source) {
  const reasons = new Set();
  const { code } = lex(source);
  // Follow named aliases of process starters as well as their original names; importing a
  // process module alone does not mean the test starts a process.
  const aliases = [...code.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|Worker)\s+(?:as)\s+([\w$]+)/gu),
    ...code.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|Worker)\s*:\s*([\w$]+)/gu)]
    .map(match => match[1]);
  if (/\b(?:openBoard|openBoardStore|openBoardForRead|openBoardReadOnly|fixtureBoard|DatabaseSync)\s*\(/u.test(code)) reasons.add('board');
  if (/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|Worker)\s*\(/u.test(code)
    || aliases.some(name => new RegExp(`\\b${name.replaceAll('$', '\\$')}\\s*\\(`, 'u').test(code))) reasons.add('process');
  if (/\b(?:launch|launchPersistentContext|connectOverCDP)\s*\(/u.test(code)) reasons.add('browser');
  if (/\b(?:startRunner|runRunner|runTestFiles|runFullSuite)\s*\(/u.test(code)) reasons.add('runner');
  return [...reasons].map(reason => `${reason}: ${file}`);
}

/** Recover ordinary literal CommonJS edges; computed or rebound loaders remain explicit journeys. */
function commonEdges(files, edges, unknown) {
  const rows = new Map(), literals = new Set();
  for (const row of unknown.filter(row => row.reason === 'CommonJS loader closure is unresolved')) {
    const source = files.get(row.file).toString('utf8'), info = lex(source);
    const words = [...info.code.matchAll(/\brequire\b/gu)];
    const calls = [...info.code.matchAll(/\brequire\s*\(\s*/gu)];
    let proven = words.length > 0 && words.length === calls.length && !/\bcreateRequire\b/u.test(info.code);
    const requests = calls.map(call => {
      const literal = info.strings.find(literal => literal.start === call.index + call[0].length);
      if (!literal || !/^\s*\)/u.test(info.code.slice(literal.end)) || source[literal.start] === '`') { proven = false; return null; }
      const text = source.slice(literal.start, literal.end);
      literals.add(text);
      return text;
    });
    rows.set(row.file, { proven, requests });
  }
  const texts = [...literals];
  const decoded = importsIn(texts.map(text => `import ${text};`));
  const values = new Map(texts.map((text, index) => [text, decoded[index][0]]));
  const imports = JSON.parse(files.get('package.json')?.toString('utf8') ?? '{}').imports;
  for (const [file, row] of rows) {
    row.requests = row.requests.map(text => values.get(text));
    for (const request of row.requests) {
      if (!request) { row.proven = false; continue; }
      if (isBuiltin(request)) continue;
      const base = repositoryImport(file, request, imports);
      const target = base && [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`, `${base}/index.cjs`].find(path => files.has(path));
      if (target) edges.get(file).push({ target, specifier: request });
      else row.proven = false;
    }
  }
  return rows;
}

/**
 * Compute every test's reached packages and one stable witness for each journey reason.
 * `depth` bounds how many import hops from the test count as reached (default: the whole closure), for callers that only need near neighbours.
 * `componentTier` (default off) marks a test whose only journey witness is crossing packages, and which crosses only through
 * each other package's index.js, as T2 with those doors listed; off, every row is as before [C7].
 */
export function generateTestTiers(root, { onInventory, onReach, depth = Infinity, componentTier = false } = {}) {
  return withImportParseCache(() => {
    const inventory = cellInventory(root, { importsIn: tierImports, commonJsIn });
    const { files, edges, unknown } = inventory;
    const owners = cellOwners(files);
    onInventory?.({ files, owners });
    const modules = [...edges.keys()];
    const common = commonEdges(files, edges, unknown);
    const evidence = new Map();
    for (const file of modules) evidence.set(file, infrastructure(file, files.get(file).toString('utf8')));
    for (const row of unknown) {
      if (row.specifier && isBuiltin(row.specifier) || row.reason === 'CommonJS loader closure is unresolved' && common.get(row.file)?.proven) continue;
      const reasons = evidence.get(row.file) ?? [];
      reasons.push(`unresolved: ${row.file}`);
      evidence.set(row.file, reasons);
    }
    const rows = [...files.keys()].filter(file => TEST.test(file)).sort().map(file => {
      const reached = new Set(), packages = new Set(), witnesses = new Map(), crossings = [];
      const pending = [file], hops = new Map([[file, 0]]);
      for (let next = 0; next < pending.length; next++) {
        const current = pending[next];
        if (reached.has(current)) continue;
        reached.add(current);
        // Helpers do not acquire ownership merely by living beside the repository's root package.json.
        if (current !== file && !/(?:^|\/)(?:test|tests)\//u.test(current) && !TEST.test(current)) {
          const owner = ownerOf(current, files, owners);
          if (owner) packages.add(owner);
        }
        for (const reason of evidence.get(current) ?? []) {
          const category = reason.split(':')[0];
          if (!witnesses.has(category) || reason < witnesses.get(category)) witnesses.set(category, reason);
        }
        if (hops.get(current) >= depth) continue;
        if (componentTier) {
          const from = ownerOf(current, files, owners);
          for (const edge of edges.get(current) ?? []) {
            const to = ownerOf(edge.target, files, owners);
            if (to && from !== to) crossings.push({ target: edge.target, owner: to });
          }
        }
        for (const edge of edges.get(current) ?? []) { if (!hops.has(edge.target)) hops.set(edge.target, hops.get(current) + 1); pending.push(edge.target); }
      }
      if (!packages.size) witnesses.set('no package', 'no package: no implementation import');
      if (packages.size > 1) witnesses.set('cross-package', 'cross-package: imports more than one package');
      const row = { file, tier: witnesses.size ? 'T3' : 'T1', packages: [...packages].sort(), reasons: [...witnesses.values()].sort() };
      if (componentTier && witnesses.size === 1 && witnesses.has('cross-package')
        && crossings.every(({ target, owner }) => target === `${owner}/index.js`)) {
        row.tier = 'T2';
        row.doors = [...new Set(crossings.map(crossing => crossing.target))].sort();
      }
      onReach?.({ ...row, reached });
      return row;
    });
    return { version: 1, files: rows };
  });
}

/**
 * The testing tiers recomputed from a sealed commit snapshot alone, equal to generating them in a checkout of that commit.
 *
 * @param {{ root: string }} snapshot a sealed source from commitSourceSnapshot
 * @param {{ onInventory?: Function, onReach?: Function }} [hooks] the same observers generateTestTiers takes
 * @returns {{ version: number, files: object[] }}
 */
export function generateTestTiersFrom(snapshot, hooks) {
  return withCellSourceSnapshots(snapshot, () => generateTestTiers(snapshot.root, hooks));
}

/** Keep one test per line so a changed classification produces a small, readable diff. */
export function formatTestTiers(manifest) {
  return '{\n  "version": 1,\n  "files": [\n' + manifest.files.map(row => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]\n}\n';
}

/** Regenerate the same portable manifest, or report drift without changing it. */
export function writeTestTiers(root, { check = false } = {}) {
  const manifest = generateTestTiers(root);
  const text = formatTestTiers(manifest);
  const path = join(root, TEST_TIERS_FILE);
  const unchanged = existsSync(path) && readFileSync(path, 'utf8') === text;
  if (!check && !unchanged) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return { manifest, unchanged, ok: !check || unchanged };
}
