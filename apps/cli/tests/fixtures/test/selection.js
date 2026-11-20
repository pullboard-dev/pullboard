/** Shared fixture for the test selection journeys: two unit packages, a unitless one and a cross-package journey [C7,CS4,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../e2e.js';
import { writeTestTiers } from '../../../../../packages/gate/heavy.js';
import { joinFixtureSeat } from '../testkit.js';

/** Demand a real successful private CLI document. */
export function json(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Commit fixture source through ordinary installed hooks. */
export function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** Read actual executed fixture markers; missing logs mean nothing ran. */
export function calls(box, name) {
  const file = join(box.dir, `${name}.log`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/** Prepare two unit packages, one unitless package and one cross-package journey. */
export function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node --test --test-reporter=tap');
  delete box.env.NODE_TEST_CONTEXT; // Each private Node test runner is independent of this parent test.
  const config = { ...helpers.CONFIG, gate: 'node --test --test-reporter=tap', affectedTests: 'node --test --test-reporter=tap',
    submitGate: 'landing', submitInvariants: [], registryGuards: [], landing: { perItem: false, manualOverride: true, publish: 'separate', parallel: false },
    lanes: { ...helpers.CONFIG.lanes, web: { owns: ['packages/', 'test/'], specs: ['G1'] } } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  for (const name of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(box.repo, `packages/${name}`), { recursive: true });
    writeFileSync(join(box.repo, `packages/${name}/index.js`), 'export const n = 1;\n');
  }
  for (const name of ['alpha', 'beta']) writeFileSync(join(box.repo, `test/${name}.test.js`), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { n } from '../packages/${name}/index.js';
test('${name} exposes a number [G1]', () => { appendFileSync(${JSON.stringify(join(box.dir, `${name}.log`))}, '${name}:' + JSON.stringify(n) + '\\n'); console.log('T1_${name}'); assert.equal(typeof n, 'number'); });
`);
  writeFileSync(join(box.repo, 'test/journey.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { n as alpha } from '../packages/alpha/index.js';
import { n as beta } from '../packages/beta/index.js';
test('both packages preserve the positive journey [G1]', () => { appendFileSync(${JSON.stringify(join(box.dir, 'journey.log'))}, 'journey\\n'); console.log('T3_JOURNEY'); assert.ok(alpha > 0 && beta > 0); });
`);
  writeFileSync(join(box.repo, 'check.cjs'), `const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.ok(fs.existsSync('packages/' + process.argv[2] + '/index.js')); console.log('FROZEN_' + process.argv[2]);\n`);
  box.git(box.repo, 'add', '-A'); // The tier manifest reads tracked files only.
  const manifest = writeTestTiers(box.repo).manifest;
  assert.deepEqual(manifest.files.map(row => [row.file, row.tier]), [['test/alpha.test.js', 'T1'], ['test/beta.test.js', 'T1'], ['test/journey.test.js', 'T3']]);
  const base = commit(box, box.repo, 'test: configure immutable testing tiers [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return { ...box, base };
}

/** Build exactly one package from main without stacking another item's source. */
export function build(box, name, value, { second = false } = {}) {
  let root = box.web;
  if (second) {
    root = join(box.dir, `builder-${name}`);
    box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/${name}`, root, 'main');
    joinFixtureSeat(box, root, 'web', { route: 'strong' });
  }
  const id = json(box, box.repo, 'add', 'web', `Change ${name}`, '--specs', 'G1', '--criterion', `The ${name} package remains present and its unit contract holds.`, '--check', `node check.cjs ${name}`, '--route', 'strong').item.item_id;
  json(box, root, 'claim', String(id));
  writeFileSync(join(root, `packages/${name}/index.js`), `export const n = ${JSON.stringify(value)};\n`);
  const head = commit(box, root, `feat(web): change ${name} [G1]`);
  return { id, root, head };
}

/** Accept only this synthetic private item after the actual frozen check and unit proof. */
export function accept(box, entry) {
  const root = join(box.dir, `review-${entry.id}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, entry.head);
  joinFixtureSeat(box, root, 'api', { route: 'strong' });
  const result = box.run(root, 'verify', String(entry.id), 'accept', '--note', 'The private frozen check and changed package units passed.');
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /T1 unit tests/u);
  assert.match(result.out, /T3 journeys deferred to the landing batch/u);
}
