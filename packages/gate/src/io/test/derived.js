/** Derive the test registries a landing owns (test-cells, test-journeys, tiers) from the merged tree, so a move needs no hand edit [C7,V24]. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BASELINE_TABLES } from '../../../../commits/light.js';
import { Refused } from '../../../../kernel/index.js';
import {
  LISTING as TEST_CELLS_FILE,
  readListing,
  writeTestCells,
} from './cells.js';
import { latestRunnerFileTimes } from './budget-rows.js';
import { TEST_MANIFEST_FILE } from './manifest.js';
import { formatTestManifest } from './manifest.js';
import { generateTestManifest } from './manifest.js';
import { settleTimes } from '../../logic/test/manifest.js';
import { readFileTimes } from './value/timing.js';
import {
  TEST_TIERS_FILE,
  formatTestTiers,
  generateTestTiers,
} from './tiers.js';

export const TEST_JOURNEYS_FILE = 'packages/gate/data/tests/test-journeys.json';
const TEST_WAITS_BASELINE_FILE = BASELINE_TABLES[1];
const TEST = /\.(?:test|spec)\.[cm]?js$/u;
const pretty = value => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Re-key a path-keyed map after a landing: a renamed file's row follows it, a removed or missing file's row goes, and no row is added.
 * Why: a removal wins over a stale row, and the row count can only fall.
 */
function followRows(map, renamed, exists) {
  const out = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    const to = renamed.get(key) ?? key;
    if (exists(to) && !Object.hasOwn(out, to)) out[to] = value;
  }
  return out;
}

/** Write a file only when its text changes; true when it did. */
function writeIfChanged(root, file, text) {
  const path = join(root, file);
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  writeFileSync(path, text);
  return true;
}

/**
 * Regenerate the three shared test registries from the tree after an item merged, following renames and letting counts only fall.
 *
 * @param {string} root - A checkout of the merged tree.
 * @param {{ renamed?: Map<string, string>, touched?: string[] }} [changes] - Old path to new path for each rename the item made, and every path it added or changed.
 * @returns {string[]} The registry files that changed.
 */
export function deriveTestRegistries(root, { renamed = new Map(), touched = [] } = {}) {
  const changed = [];
  const exists = file => existsSync(join(root, file));
  const listingPath = join(root, TEST_CELLS_FILE);
  if (existsSync(listingPath)) {
    const listing = readListing(root);
    const followed = { ...listing, journeys: followRows(listing.journeys, renamed, exists), findings: followRows(listing.findings, renamed, exists) };
    const before = readFileSync(listingPath, 'utf8');
    writeFileSync(listingPath, pretty(followed));
    const refused = writeTestCells(root);
    if (refused.length) {
      writeFileSync(listingPath, before);
      throw new Refused('LAND_MERGE', `the test-cells ratchet would rise: ${refused[0].text}`, 'move the extra test into its cell or take its CLI out, then retry landing');
    }
    if (readFileSync(listingPath, 'utf8') !== before) changed.push(TEST_CELLS_FILE);
  }
  const journeysPath = join(root, TEST_JOURNEYS_FILE);
  if (existsSync(journeysPath)) {
    const journeys = JSON.parse(readFileSync(journeysPath, 'utf8'));
    journeys.files = followRows(journeys.files, renamed, exists);
    if (writeIfChanged(root, TEST_JOURNEYS_FILE, pretty(journeys))) changed.push(TEST_JOURNEYS_FILE);
  }
  const waitsPath = join(root, TEST_WAITS_BASELINE_FILE);
  if (existsSync(waitsPath)) {
    const waits = JSON.parse(readFileSync(waitsPath, 'utf8'));
    const followed = followRows(waits, renamed, exists);
    // Only a real move or removal rewrites the file, so its hand-kept layout is never churned.
    if (JSON.stringify(followed) !== JSON.stringify(waits) && writeIfChanged(root, TEST_WAITS_BASELINE_FILE, pretty(followed))) changed.push(TEST_WAITS_BASELINE_FILE);
  }
  const tiersPath = join(root, TEST_TIERS_FILE);
  if (existsSync(tiersPath)) {
    const manifest = JSON.parse(readFileSync(tiersPath, 'utf8'));
    const rows = new Map(manifest.files.map(row => [renamed.get(row.file) ?? row.file, { ...row, file: renamed.get(row.file) ?? row.file }]));
    const wanted = new Set([...touched, ...renamed.values()].filter(file => TEST.test(file) && exists(file)));
    if (wanted.size) for (const row of generateTestTiers(root).files) if (wanted.has(row.file)) rows.set(row.file, row);
    manifest.files = [...rows.values()].filter(row => exists(row.file)).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    if (writeIfChanged(root, TEST_TIERS_FILE, formatTestTiers(manifest))) changed.push(TEST_TIERS_FILE);
  }
  const manifestPath = join(root, TEST_MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    const recorded = {};
    for (const row of JSON.parse(readFileSync(manifestPath, 'utf8')).files) {
      const file = renamed.get(row.file) ?? row.file;
      if (exists(file) && Number.isFinite(row.cost?.ms)) recorded[file] = row.cost.ms;
    }
    const times = settleTimes(recorded, { ...readFileTimes(root), ...latestRunnerFileTimes(root) });
    if (writeIfChanged(root, TEST_MANIFEST_FILE, formatTestManifest(generateTestManifest(root, { times })))) changed.push(TEST_MANIFEST_FILE);
  }
  return changed;
}
