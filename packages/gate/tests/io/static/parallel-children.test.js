/** The static registry's child-process checks overlap under landing.staticParallelMax, and run serially when it is unset [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStaticTreeRegistry } from '../../../src/io/static/registry.js';
import { runStaticTreeRegistryParallel } from '../../../src/io/static/registry.js';
import { runChildren } from '../../../src/io/static/children.js';
import { describeSetting } from '../../../../config/index.js';
import { staticParallelMax } from '../../../../config/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-static-parallel-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** A child that prints when it started and ended, with a pause between, so overlap can be counted from the results. */
const napper = () => ({ args: ['-e', "const start = Date.now(); setTimeout(() => process.stdout.write(JSON.stringify([start, Date.now()])), 200);"], options: { cwd: ROOT } });

/** The most children alive at once, read from their start and end times. */
function peak(results) {
  const spans = results.map(result => JSON.parse(result.stdout));
  return Math.max(...spans.map(([start]) => spans.filter(([from, to]) => from <= start && start < to).length));
}

test('gate.io-static-parallel-children.with-landing-staticparallelmax-at-2-at: clause 1: with landing.staticParallelMax at 2, at most 2 child-process checks are in flight at once [C7]', async () => {
  const results = await runChildren(Array.from({ length: 5 }, napper), 2);
  assert.equal(results.length, 5);
  assert.ok(results.every(result => result.status === 0));
  assert.equal(peak(results), 2, 'two overlap, never three');
});

test('gate.io-static-parallel-children.the-parallel-registry-run-returns-the: clause 1: the parallel registry run returns the same rows as the serial run, in registry order [C7]', async () => {
  const args = (name, ms) => ['-e', `setTimeout(() => process.stdout.write('${name}'), ${ms})`];
  const mk = (name, ms) => ({ name, reads: () => true, child: () => ({ args: args(name, ms), options: { cwd: ROOT } }),
    run: (root, sources, context) => [`${name}: ${context.children?.get(name)?.stdout ?? name}`] });
  const classes = [mk('slow', 300), { name: 'plain', reads: () => true, run: () => ['plain: row'] }, mk('quick', 10)];
  const scope = { changed: ['x.js'], apps: null, classes };
  const serial = runStaticTreeRegistry(ROOT, scope);
  const parallel = await runStaticTreeRegistryParallel(ROOT, { ...scope, max: 2 });
  assert.deepEqual(serial, ['slow: slow', 'plain: row', 'quick: quick']);
  assert.deepEqual(parallel, serial);
});

test('gate.io-static-parallel-children.with-landing-staticparallelmax-unset-the-checks: clause 2: with landing.staticParallelMax unset, the checks run serially and the sync entry is the default [C7]', () => {
  assert.equal(withSettings({}, staticParallelMax), null);
});

test('gate.io-static-parallel-children.landing-staticparallelmax-is-a-described-setting: clause 3: landing.staticParallelMax is a described setting, unset by default, and a value below 1 is refused [C7]', async () => {
  assert.match(describeSetting('landing.staticParallelMax').description, /static/u);
  assert.equal(withSettings({ landing: { staticParallelMax: 3 } }, staticParallelMax), 3);
  for (const bad of [0, -1, 1.5, '2']) {
    assert.throws(() => withSettings({ landing: { staticParallelMax: bad } }, staticParallelMax), /landing\.staticParallelMax/u, String(bad));
  }
  await assert.rejects(() => runChildren([], 0), error => error.name === 'Refused' && /staticParallelMax/u.test(error.message));
});
