/** @pullboard-test-input source-cell config */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as light from '../../light.js';

const FILE = new URL('../../light.js', import.meta.url);

/** Every name the config light door exports: those from before it was reflowed [C7], plus settings readers added since. */
const BEFORE = [
  'CONFIG_FILE',
  'COORDINATOR',
  'DOCTRINE_FILE',
  'LEGACY_DOCTRINE_FILE',
  'boardRemote',
  'browserFreeChecksEnabled',
  'configFromSource',
  'doctrineFile',
  'environmentProblem',
  'healthDiskFloorGb',
  'hunkFreshnessEnabled',
  'listThinRead',
  'loadConfig',
  'loadMachineSettings',
  'maintenanceDurations',
  'namedImportSelectionOn',
  'readThinCommands',
  'reofferInfraEndEnabled',
  'retireIdleSeatHours',
  'submitProofOnly',
  'typedFieldsEnabled',
  'validateRunner',
];

test('config.io-barrel-shape.clause-1-light-js-lines-stay-short-names: clause 1: light.js lines stay short, names sit one per line sorted, paths are grouped sorted [C7]', () => {
  const text = readFileSync(FILE, 'utf8');
  for (const line of text.split('\n')) assert.ok(line.length <= 120, `line too long: ${line.slice(0, 60)}`);
  const statements = [...text.matchAll(/export \{([^}]*)\} from ('[^']+');/g)];
  for (const [, body] of statements) {
    const names = body.split('\n').map((line) => line.trim()).filter(Boolean);
    if (names.length === 1 && !names[0].endsWith(',')) continue;
    assert.ok(names.every((name) => /^[A-Za-z0-9_$]+,$/.test(name)), `not one per line: ${body.slice(0, 60)}`);
    const plain = names.map((name) => name.slice(0, -1));
    assert.deepEqual(plain, [...plain].sort());
  }
  const paths = statements.map((match) => match[2]);
  assert.deepEqual(paths, [...new Set(paths)].sort());
});

test('config.io-barrel-shape.clause-2-light-js-exports-exactly-the: clause 2: light.js exports exactly the names it did before the reflow [C7]', () => {
  assert.deepEqual(Object.keys(light).sort(), BEFORE);
});
