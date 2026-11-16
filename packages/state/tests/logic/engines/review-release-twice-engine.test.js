/** @pullboard-test-loads packages/state/src/io/engine/numbers.js */
/** @pullboard-world-pin: the first clause reads the committed leaf and the landing code, because the leaf must be numbered by the real landing merge code. */
/** The review-release-twice engine leaf sits above every landed engine, and the landing merge puts it in the engine table with a history snapshot that matches the table [C7,#9441]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { assignEngineNumbers } from '../../../src/io/engine/numbers.js';
import { discoverEngines } from '../../../src/io/engine/metadata.js';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const FOLDER = 'packages/state/src/logic/engines';
const TABLE = 'packages/state/src/logic/engine/table.js';
const LEAF = 'review-release-twice-engine.js';
const UNASSIGNED = "import { unassignedEngine } from './engine-next.js';\nexport const REVIEW_RELEASE_TWICE_ENGINE = unassignedEngine();\n";

test('clause 1: REVIEW_RELEASE_TWICE_ENGINE is a registered engine above REVIEW_RELEASE_REASON_ENGINE and no other engine shares its number [C7,#9441]', () => {
  const registry = discoverEngines();
  assert.ok(registry['review-release-twice'] > registry['review-release-reason'], `${registry['review-release-twice']} is above ${registry['review-release-reason']}`);
  const sharing = Object.entries(registry).filter(([, number]) => number === registry['review-release-twice']);
  assert.deepEqual(sharing.map(([name]) => name), ['review-release-twice']);
  const lines = readFileSync(resolve(ROOT, FOLDER, LEAF), 'utf8').split('\n').filter(line => line.startsWith('export const '));
  assert.equal(lines.length, 1, 'the leaf declares exactly one engine constant');
  assert.match(lines[0], /^export const REVIEW_RELEASE_TWICE_ENGINE = (?:\d+|unassignedEngine\(\));$/u);
});

test('clause 1: the landing merge numbers the leaf, lists it in the engine table, and writes a history snapshot that matches the table [C7,#9441]', (t) => {
  const { root, write, read } = privateFixtureFiles('pullboard-review-release-twice-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(`${FOLDER}/base-engine.js`, 'export const BASE_ENGINE = 80;\n');
  write(`${FOLDER}/${LEAF}`, UNASSIGNED);
  write(TABLE, 'export const ENGINE_NUMBERS = Object.freeze({\n});\n');
  write('packages/state/data/history/legacy.json', '{"version":1}\n');
  write('packages/moves/src/logic/moves/example.js', 'export default { operation: "fixture", engine: 80 };\n');
  const { assigned, files } = assignEngineNumbers(root);
  assert.deepEqual(assigned, [{ name: 'REVIEW_RELEASE_TWICE_ENGINE', number: 81 }], 'numbered one above the highest landed engine');
  const table = read(TABLE).toString('utf8');
  assert.match(table, /^ {2}REVIEW_RELEASE_TWICE_ENGINE: 81,$/mu, 'the engine table lists the leaf with its number');
  const snapshot = files.find(file => file.startsWith('packages/state/data/history/') && !file.endsWith('legacy.json'));
  assert.ok(snapshot, 'the merge wrote a history snapshot');
  const record = JSON.parse(readFileSync(join(root, snapshot), 'utf8'));
  assert.deepEqual([record.engine, record.name], [81, 'REVIEW_RELEASE_TWICE_ENGINE']);
  const rows = [...table.matchAll(/^ {2}([A-Z0-9_]+_ENGINE): (\d+),$/gmu)].map(row => [row[1], Number(row[2])]);
  assert.deepEqual(record.engines.map(engine => [engine.name, engine.number]).sort(), rows.sort(), 'the snapshot lists the engines the table lists');
});
