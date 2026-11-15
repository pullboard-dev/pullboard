/**
 * Fixtures for the landing-gated invariant journeys: a claimed item whose project lists submit invariants [V4,C7].
 * Why: the journeys are split across files to stay under the per-file budget and share one project builder.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { coordinatorLocal } from '../../../journeys/submit/gate/local.js';
import { runLocal } from '../../../journeys/submit/gate/local.js';
import { privateRepo } from './gate.js';
import { builderRepo } from './gate.js';
import { put } from './gate.js';
import { commitAll } from './gate.js';
import { seedGraph } from './gate.js';

/** Prepare accepted policy, then claim in a real separate builder checkout. */
export async function project(t, invariants, failing = false) {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test',
    submitGate: 'landing', shared: ['pullboard.json'], ...(invariants === undefined ? {} : { submitInvariants: invariants }) }));
  seedGraph(box);
  const marker = join(box.dir, 'invariants.log');
  box.env.FIXTURE_INVARIANT_MARKER = marker;
  put(box.root, 'test/invariant.test.js', [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { value } from '../src/a.js';",
    "appendFileSync(process.env.FIXTURE_INVARIANT_MARKER, 'invariant\\n');",
    failing ? 'assert.equal(value, 1, "the project invariant stays enforced");' : 'assert.ok(value < 3);',
  ].join('\n') + '\n');
  put(box.root, 'test/a.test.js', "import '../src/entry.js';\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.FIXTURE_INVARIANT_MARKER, 'selected\\n');\n");
  put(box.root, 'test/c.test.js', "throw new Error('unrelated test must stay deferred');\n");
  put(box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 1;\n');
  commitAll(box);
  box = builderRepo(box, ['apps/cli/src/io/run/tests.js']);
  // --wait: the check's baseline job is done before submitWithEnv stops the local runner, so no job is cut off mid-run [#7530].
  assert.equal((await coordinatorLocal(box, 'add', 'build', 'Invariant fixture', '--check', 'node -e "process.exit(0)"', '--wait')).code, 0);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  return { box, marker };
}
/** A global edit exercises the uncertain-selector path without running a full suite. */
export function change(box, global = true) {
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  if (global) put(box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 2;\n');
  commitAll(box, 'feat(core): change invariant input [G1]');
}
/** A submit subset must never leave a full-gate stamp. */
export function unstamped(box) {
  const stamp = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
  assert.equal(existsSync(stamp), false);
}

