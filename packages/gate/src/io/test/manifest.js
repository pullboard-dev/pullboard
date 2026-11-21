/** Generate the test manifest, one row per test file with its kind, cost and what it spawns, never hand-kept [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { generateTestTiers } from './tiers.js';
import { latestRunnerFileTimes } from './budget-rows.js';
import { readFileTimes } from './value/timing.js';
import { testNameIds } from './names.js';
import { spawnCategories } from '../../logic/test/spawns.js';
import { manifestRows } from '../../logic/test/manifest.js';
import { JOURNEY_TAGS } from '../../logic/test/manifest.js';
import { TEST_KINDS } from '../../logic/test/manifest.js';

export const GOLDEN_FILE = 'packages/gate/data/tests/golden.json';
export const GUARDS_FILE = 'packages/gate/data/tests/guards.json';
const MOVED_JOURNEYS_FILE = 'packages/gate/data/tests/moved-journeys.json';
export const TEST_MANIFEST_FILE = 'packages/gate/data/tests/test-manifest.json';
const TEST = /\.(?:test|spec)\.[cm]?js$/u;
const SUPPORT = /(?:^|\/)(?:tests?|fixtures?)\//u;
const SRC = /(?:^|\/)src\//u;

/**
 * Every test file's spawn evidence: what its own source and the test-support files it reaches start.
 * Why: product code that spawns says nothing about the test, so only the test and its fixtures are read.
 *
 * @param {Map<string, Buffer>} sources every tracked source by path
 * @param {Set<string>} reached files reachable from the test through imports
 * @param {string} file the test file
 * @returns {{ direct: Set<string>, via: Map<string, Set<string>> }} categories started by the file itself, and by each fixture it reaches
 */
function spawnEvidence(sources, reached, file) {
  const direct = new Set(), via = new Map();
  for (const path of reached) {
    const own = path === file;
    if (!own && !(SUPPORT.test(path) && !SRC.test(path) && !TEST.test(path))) continue;
    const source = sources.get(path);
    if (!source) continue;
    const found = spawnCategories(source.toString('utf8'));
    if (own) for (const category of found) direct.add(category);
    else if (found.size) via.set(path, found);
  }
  return { direct, via };
}

/**
 * The files the golden registry names, or none when the project has no registry.
 * Why: the registry decides which journeys are harness, so the generator reads it instead of guessing from the path [C7].
 *
 * @param {string} root project root
 * @returns {Set<string>}
 */
function goldenFiles(root) {
  const path = resolve(root, GOLDEN_FILE);
  if (!existsSync(path)) return new Set();
  return new Set(JSON.parse(readFileSync(path, 'utf8')).paths.map(entry => entry.file));
}

/** Read a manifest classification list, or an empty set when the project has no list. */
function listedFiles(root, file) {
  const path = resolve(root, file);
  if (!existsSync(path)) return new Set();
  return new Set(JSON.parse(readFileSync(path, 'utf8')).files);
}

/**
 * The manifest rows for a project root, read without running any test.
 * Why: one derived record lets the census, the journey cut and review read the same facts.
 *
 * @param {string} root project root
 * @param {{ times?: Record<string, number> }} [options] recorded runtimes by file, for tests; defaults to the last landing's file times under the runner receipts
 * @returns {{ version: number, files: object[] }}
 */
export function generateTestManifest(root, { times = { ...readFileTimes(root), ...latestRunnerFileTimes(root) } } = {}) {
  let sources = new Map();
  const evidence = new Map();
  const tiers = generateTestTiers(root, {
    onInventory: ({ files }) => { sources = files; },
    onReach: row => { evidence.set(row.file, row.reached); },
  });
  const inputs = tiers.files.map(row => ({ file: row.file, ...spawnEvidence(sources, evidence.get(row.file), row.file),
    specs: testNameIds(sources.get(row.file)?.toString('utf8') ?? ''),
    ms: Object.hasOwn(times, row.file) ? Math.round(times[row.file]) : null }));
  return { version: 1, files: manifestRows(inputs, goldenFiles(root), listedFiles(root, GUARDS_FILE), listedFiles(root, MOVED_JOURNEYS_FILE)) };
}

/** One row per line so a changed row is a small, readable diff. */
export function formatTestManifest(manifest) {
  return '{\n  "version": 1,\n  "files": [\n' + manifest.files.map(row => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]\n}\n';
}

/** Write the manifest to its file, or to another path when asked. */
export function writeTestManifest(root, { out = TEST_MANIFEST_FILE, times } = {}) {
  const manifest = generateTestManifest(root, { times });
  const path = resolve(root, out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatTestManifest(manifest));
  return { manifest, path };
}

/**
 * The manifest command: write the manifest and say how many files each kind holds.
 * Why: the script stays a thin wrapper, so the command is tested in process.
 *
 * @param {string[]} args `[--out file] [project-root]`
 * @param {{ times?: Record<string, number> }} [options] recorded runtimes by file, for tests
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runManifestCommand(args, { times } = {}) {
  const at = args.indexOf('--out');
  const out = at >= 0 ? args[at + 1] : TEST_MANIFEST_FILE;
  const rest = at >= 0 ? args.filter((arg, index) => index !== at && index !== at + 1) : args;
  if (rest.some(arg => arg.startsWith('-')) || rest.length > 1 || (at >= 0 && !out)) {
    return { status: 1, stdout: '', stderr: 'usage: node packages/gate/src/io/test/scripts/manifest.js [--out file] [project-root]\n' };
  }
  const { manifest } = writeTestManifest(resolve(rest[0] ?? '.'), { out, times });
  const counts = TEST_KINDS.map(kind => `${manifest.files.filter(row => row.kind === kind).length} ${kind}`);
  const timed = manifest.files.filter(row => row.cost.ms !== null).length;
  const tags = JOURNEY_TAGS.map(tag => `${manifest.files.filter(row => row.tag === tag).length} ${tag}`);
  const unproven = manifest.files.filter(row => row.unproven).length;
  return { status: 0, stdout: `${manifest.files.length} test files; ${counts.join(', ')}; ${timed} with a recorded runtime; ${unproven} unproven (cite no spec id)\njourney tags: ${tags.join(', ')}\n`, stderr: '' };
}
