/** Generate the test manifest, one row per test file with its kind, cost and what it spawns, never hand-kept [C7]. */
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { generateTestTiers } from './tiers.js';
import { infrastructure } from './tiers.js';
import { latestRunnerFileTimes } from './budget-rows.js';
import { readFileTimes } from './value/timing.js';
import { manifestRows } from '../../logic/test/manifest.js';

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
    const found = new Set(infrastructure(path, source.toString('utf8')).map(reason => reason.split(':')[0]));
    if (own) for (const category of found) direct.add(category);
    else if (found.size) via.set(path, found);
  }
  return { direct, via };
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
    ms: Object.hasOwn(times, row.file) ? Math.round(times[row.file]) : null }));
  return { version: 1, files: manifestRows(inputs) };
}

/** One row per line so a changed row is a small, readable diff. */
export function formatTestManifest(manifest) {
  return '{\n  "version": 1,\n  "files": [\n' + manifest.files.map(row => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]\n}\n';
}

/** Write the manifest to its file, or to another path when asked. */
export function writeTestManifest(root, { out = TEST_MANIFEST_FILE, times } = {}) {
  const manifest = generateTestManifest(root, { times });
  const path = join(root, out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatTestManifest(manifest));
  return { manifest, path };
}
