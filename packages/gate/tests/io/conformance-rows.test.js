/** @pullboard-test-input source-cell gate */
/** The gate reads the recorded conformance runs of a root and returns the per-stage rows, probing toolchains on a given path [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refused } from '../../../kernel/index.js';
import { conformanceRows } from '../../index.js';
import { CONFORMANCE_STAGES } from '../../src/logic/conformance-setups.js';
import { privateFixtureFiles } from '../fixtures/child.js';

test('gate.io-conformance-rows.rows-from-runs-file: clause 1: conformanceRows reads the root runs file and a recorded node run shows its outcome and run id, every other setup unknown, with the toolchain probe reading only executables on the path value [C7]', () => {
  const files = privateFixtureFiles('pullboard-fixture-conformance-rows-');
  files.write('.pullboard/conformance/runs.json', JSON.stringify([
    { id: 'run-old', language: 'node', at: '2026-11-19T10:00:00Z', stages: { claim: 'red' } },
    { id: 'run-new', language: 'node', at: '2026-11-20T10:00:00Z', stages: { claim: 'works' } },
  ]));
  files.write('bin/cargo', '#!/bin/sh\n');
  files.write('bin/node', '#!/bin/sh\n');
  files.write('bin/go', 'not executable\n');
  chmodSync(join(files.root, 'bin/cargo'), 0o755);
  chmodSync(join(files.root, 'bin/node'), 0o755);
  chmodSync(join(files.root, 'bin/go'), 0o644);
  const rows = conformanceRows({ root: files.root, pathValue: join(files.root, 'bin') });
  assert.equal(rows.length, 9 * CONFORMANCE_STAGES.length);
  assert.deepEqual(rows.find(row => row.language === 'node' && row.stage === 'claim'), { language: 'node', stage: 'claim', outcome: 'works', run: 'run-new' });
  assert.deepEqual(rows.find(row => row.language === 'node' && row.stage === 'land'), { language: 'node', stage: 'land', outcome: 'unknown', run: null });
  assert.ok(rows.filter(row => row.language === 'rust').every(row => row.outcome === 'unknown' && row.run === null), 'cargo on the path makes rust available, so nothing recorded reads unknown');
  assert.ok(rows.filter(row => row.language === 'go').every(row => row.outcome === 'unavailable'), 'go is a non-executable file, so it is unavailable');
  assert.ok(rows.filter(row => row.language === 'python').every(row => row.outcome === 'unavailable'), 'python3 is absent from the path');
});

test('gate.io-conformance-rows.no-file-and-bad-file: clause 2: with no runs file every row is unknown or unavailable and nothing throws, and a runs file that is not a JSON list is refused naming the file [C7]', () => {
  const files = privateFixtureFiles('pullboard-fixture-conformance-rows-');
  files.write('bin/node', '#!/bin/sh\n');
  chmodSync(join(files.root, 'bin/node'), 0o755);
  const rows = conformanceRows({ root: files.root, pathValue: join(files.root, 'bin') });
  assert.ok(rows.every(row => ['unknown', 'unavailable'].includes(row.outcome) && row.run === null));
  assert.equal(rows.find(row => row.language === 'node' && row.stage === 'claim').outcome, 'unknown');
  for (const bytes of ['{"id":"x"}', 'not json']) {
    files.write('.pullboard/conformance/runs.json', bytes);
    assert.throws(() => conformanceRows({ root: files.root, pathValue: '' }), error => error instanceof Refused && error.message.includes(join(files.root, '.pullboard/conformance/runs.json')));
  }
});
