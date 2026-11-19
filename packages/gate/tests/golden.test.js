/** The golden registry names exactly one existing journey per user path, and each is tagged harness [C7]. */
/** @pullboard-world-pin: reads the committed golden registry and test manifest and checks the named journey files exist in the repository. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const ROOT = new URL('../../../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const golden = read('packages/gate/data/tests/golden.json');
const manifest = read('packages/gate/data/tests/test-manifest.json');
const USER_PATHS = [
  'init', 'add', 'next', 'claim-release', 'submit', 'verify', 'land', 'land-runners',
  'release', 'upgrade', 'relay-pair', 'view-open', 'doctor-first-run',
];

test('gate.golden.user-path-names-exactly-one: clause 1: every user path names exactly one existing journey file, or is recorded as a gap [C7]', () => {
  const named = golden.paths.map(entry => entry.path);
  const gaps = golden.gaps.map(entry => entry.path);
  assert.deepEqual([...named, ...gaps].sort(), [...USER_PATHS].sort(), 'each user path is a golden path or a gap, once');
  for (const entry of golden.paths) {
    assert.equal(typeof entry.file, 'string', `${entry.path} names one file`);
    assert.match(entry.file, /^apps\/cli\/journeys\/.+\.test\.js$/u, `${entry.path} names a journey`);
    assert.ok(existsSync(new URL(entry.file, ROOT)), `${entry.path}: ${entry.file} exists`);
    assert.ok(entry.specs.length > 0 && entry.commands.length > 0, `${entry.path} records its spec ids and commands`);
  }
  for (const gap of golden.gaps) {
    assert.equal(gap.file, undefined, `${gap.path} is a gap and invents no file`);
    assert.ok(gap.reason, `${gap.path} says why it has no journey`);
  }
});

test('gate.golden.golden-journey-tagged-harness-test: clause 2: every golden journey is tagged harness in the test manifest and carries no freeze tag [C7]', () => {
  for (const entry of golden.paths) {
    const row = manifest.files.find(item => item.file === entry.file);
    assert.ok(row, `${entry.file} has a manifest row`);
    assert.equal(row.kind, 'harness', `${entry.file} is tagged harness`);
    assert.equal(row.tag, undefined, `${entry.file} carries no freeze tag`);
    assert.deepEqual(row.specs, entry.specs, `${entry.path} records the spec ids the manifest holds`);
  }
});
