/** @pullboard-test-input apps/cli/tests/fixtures/child.js packages/gate/src/io/run/tests.js packages/resources/index.js */
/** A landing gate already inside a runner slot runs as one pass; only the controller fans out [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withMainCheckout } from '../../../index.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { GATE_SLOT_HELD_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_POOL_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_TOKEN_ENV } from '../../../../resources/index.js';
import { BROWSER_SLOT_HELD_ENV } from '../../../../resources/index.js';

const SOURCE = join(import.meta.dirname, '../../../../..');

/** Run a landing gate under a held gate slot, as a runner worker or a local controller holds it. */
async function landingUnderSlot(t, runnerExecution) {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-no-nested-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const machine = join(home, 'machine');
  mkdirSync(machine);
  // Six shards are configured and exactly one gate slot exists: a nested shard would have to ask for a second one.
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1, landingShards: 6,
    gate: { runnersOnly: false, runnersFirst: false, runnerWaitMs: 100 } }));
  const marker = join(home, 'body-ran');
  const env = { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_TEST_REUSE: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Nested shard fixture', GIT_AUTHOR_EMAIL: 'nested@example.invalid',
    GIT_COMMITTER_NAME: 'Nested shard fixture', GIT_COMMITTER_EMAIL: 'nested@example.invalid' };
  for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV,
    'NODE_TEST_CONTEXT', 'PULLBOARD_LANDING_SHARD', 'PULLBOARD_RELEASE_EXECUTORS']) delete env[key];
  env.PULLBOARD_LANDING_RUN = '1';
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: SOURCE }).trim();
  return await withMainCheckout(SOURCE, head, async root => {
    runFixtureGit(['checkout', '-B', 'main'], { cwd: root, env });
    const file = 'test/nested-shard-body.test.js';
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\n"
      + `test('nested shard body [C7]', () => appendFileSync(${JSON.stringify(marker)}, 'x'));\n`);
    runFixtureGit(['add', file], { cwd: root, env });
    runFixtureGit(['commit', '-qm', 'test: nested shard body [C7]'], { cwd: root, env });
    const driver = join(home, 'driver.mjs');
    writeFileSync(driver, `import { takeResource, gateSlotEnvironment } from ${JSON.stringify(pathToFileURL(join(root, 'packages/resources/index.js')).href)};
import { runFixtureChild } from ${JSON.stringify(pathToFileURL(join(root, 'apps/cli/tests/fixtures/child.js')).href)};
const lease = await takeResource({ name: 'gate', scope: 'machine', root: ${JSON.stringify(root)}, capacity: 1, remote: false, runnerExecution: ${runnerExecution} });
try {
  const result = runFixtureChild(process.execPath, [${JSON.stringify(join(root, 'apps/cli/src/io/run/tests.js'))}, ${JSON.stringify(file)}], { cwd: ${JSON.stringify(root)}, env: { ...process.env, ...gateSlotEnvironment(lease) }, encoding: 'utf8', timeout: 60000 });
  process.stdout.write(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
} finally { lease.release(); }\n`);
    const outer = runFixtureChild(process.execPath, [driver], { cwd: root, env, encoding: 'utf8', timeout: 90_000 });
    assert.equal(outer.status, 0, outer.context ?? outer.stderr);
    const result = JSON.parse(outer.stdout);
    return { result, runs: existsSync(marker) ? readFileSync(marker, 'utf8').length : 0 };
  });
}

test('a landing run inside a runner slot with landingShards 6 runs as one pass and asks for no local slot [C7,V4]', async t => {
  const { result, runs } = await landingUnderSlot(t, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(runs, 1, 'the body runs once, in the held slot');
  assert.doesNotMatch(result.stdout, /# landing shards/u);
  assert.doesNotMatch(result.stdout + result.stderr, /RESOURCE_CAPACITY_MISMATCH/u);
});

test('a landing run under a plain local slot still fans out from the controller [C7,V4]', async t => {
  const { result } = await landingUnderSlot(t, false);
  assert.match(result.stdout, /# landing shards/u);
});
