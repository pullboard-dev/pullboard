/** runner serve checks ps and lsof before it claims a job and refuses RUNNER_TOOL_MISSING without them [6070]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { requireRunnerTools } from '../../../src/io/pull/serve.js';

/** A folder holding executable stand-ins for the named tools. */
function tools(t, names) {
  const dir = privateFixtureFiles('pb6070-tools-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of names) { writeFileSync(join(dir, name), '#!/bin/sh\n'); chmodSync(join(dir, name), 0o755); }
  return dir;
}

test('runners.serve.n6070-clause-2-a-stripped-path: 6070 clause 2: a stripped PATH refuses RUNNER_TOOL_MISSING naming the missing tool [P7]', t => {
  assert.throws(() => requireRunnerTools({ PATH: tools(t, ['ps']) }), error => error.code === 'RUNNER_TOOL_MISSING' && /lsof/u.test(error.message));
  assert.throws(() => requireRunnerTools({ PATH: tools(t, ['lsof']) }), error => error.code === 'RUNNER_TOOL_MISSING' && /\bps\b/u.test(error.message));
  assert.throws(() => requireRunnerTools({ PATH: '' }), error => error.code === 'RUNNER_TOOL_MISSING');
});

test('runners.serve.n6070-clause-2-with-ps-and: 6070 clause 2: with ps and lsof present the check passes and serve starts as before [P7]', t => {
  assert.doesNotThrow(() => requireRunnerTools({ PATH: tools(t, ['ps', 'lsof']) }));
});
