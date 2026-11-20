/** Moving test files rekeys nothing: rows keyed by stable test ID resolve to the new path, and path-keyed registries follow by ID [C7,U148]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { deriveTestRegistries } from '../../../index.js';
import { idRenames } from '../../../heavy.js';
import { resolveIdRows } from '../../../heavy.js';
import { testIdIndex } from '../../../heavy.js';

const NAMES = ['alpha', 'beta', 'gamma'];
const IDS = NAMES.map(name => `cell.${name}.claim`);
const OLD = NAMES.map(name => `packages/cell/tests/${name}.test.js`);
const NEW = NAMES.map(name => `packages/cell/tests/moved/${name}-now.test.js`);
const BASELINE = 'packages/gate/data/baselines/test-waits-baseline.json';
const TIERS = 'packages/gate/data/tests/tiers.json';

/** A test body of unrelated filler, so a rewrite of it defeats Git's rename similarity. */
const body = (id, filler) => `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n\ntest('${id}: [C7] holds', () => {\n${filler.map(line => `  assert.equal(${line}, ${line});`).join('\n')}\n});\n`;

/** A real repo on main with a receipt-like cell: three registered tests, a registry, and path-keyed rows for each. */
function repo(t) {
  const { root } = privateFixtureFiles('gate-test-ids-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sh = (...args) => runFixtureGit(args, { cwd: root });
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 't');
  put('package.json', '{"type":"module"}\n');
  IDS.forEach((id, at) => put(OLD[at], body(id, Array.from({ length: 12 }, (_, n) => n + at * 100))));
  put('packages/cell/tests/registry.json', JSON.stringify(Object.fromEntries(IDS.map(id => [id, { proves: { specs: ['C7'], claim: id }, why: 'w', kind: 'cell unit', inputs: ['x'] }]))));
  put(BASELINE, JSON.stringify(Object.fromEntries(OLD.map(file => [file, { sleep: 1 }])), null, 2) + '\n');
  put(TIERS, '{\n  "version": 1,\n  "files": [\n' + OLD.map(file => `    ${JSON.stringify({ file, tier: 'T1', packages: [], reasons: [] })}`).join(',\n') + '\n  ]\n}\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
  return { root, sh, put, read: file => JSON.parse(readFileSync(join(root, file), 'utf8')) };
}

/** Move all three files and rewrite their bodies, as a person restructuring the cell would. */
function moveAll(box) {
  IDS.forEach((id, at) => {
    box.sh('rm', '-q', OLD[at]);
    box.put(NEW[at], body(id, Array.from({ length: 12 }, (_, n) => `'moved ${at} ${n}'`)));
  });
  box.sh('add', '-A');
  box.sh('commit', '-q', '-m', 'move three tests');
}

test('gate.io-test-ids.rows-keyed-by-stable-id-resolve: [C7,U148] rows keyed by stable ID resolve to the current path, and a missing ID refuses with a next step', t => {
  const box = repo(t);
  const census = Object.fromEntries(IDS.map((id, at) => [id, { runs: at + 1 }]));
  assert.deepEqual(resolveIdRows(testIdIndex(box.root), census).map(row => row.file), OLD);
  moveAll(box);
  const after = resolveIdRows(testIdIndex(box.root), census);
  assert.deepEqual(after.map(row => row.file), NEW, 'the same IDs now resolve to the new paths');
  assert.deepEqual(Object.fromEntries(after.map(row => [row.id, row.data])), census, 'no census row changed');
  assert.throws(() => resolveIdRows(testIdIndex(box.root), { 'cell.gone.claim': {} }), error => error.code === 'TEST_ID_UNKNOWN' && /next:|retire the row/u.test(`${error.message}${error.next ?? ''}`));
});

test('gate.io-test-ids.moving-three-registered-test-files-leaves: [C7,U148] moving three registered test files leaves the tier and baseline rows following their IDs with no hand edit', t => {
  const box = repo(t);
  const before = testIdIndex(box.root, 'HEAD');
  moveAll(box);
  const gitRenames = box.sh('diff', '--name-status', '-M', 'HEAD~1', 'HEAD').split('\n').filter(line => line.startsWith('R'));
  assert.equal(gitRenames.length, 0, 'the rewrite hides the moves from Git, so only the IDs can follow them');
  const renamed = idRenames(before, testIdIndex(box.root));
  assert.deepEqual([...renamed], OLD.map((file, at) => [file, NEW[at]]));
  const changed = deriveTestRegistries(box.root, { renamed, touched: [...renamed.values()] });
  assert.ok(changed.includes(BASELINE) && changed.includes(TIERS));
  assert.deepEqual(Object.keys(box.read(BASELINE)), NEW, 'baseline rows follow, counts untouched');
  assert.deepEqual(Object.values(box.read(BASELINE)), [{ sleep: 1 }, { sleep: 1 }, { sleep: 1 }]);
  assert.deepEqual(box.read(TIERS).files.map(row => row.file), NEW, 'tier rows follow with none left on an old path');
});

test('gate.io-test-ids.a-file-whose-ids-now-live-in: [C7,U148] a file whose IDs now live in two files has no single new home and is not guessed', t => {
  const box = repo(t);
  const before = testIdIndex(box.root, 'HEAD');
  box.sh('rm', '-q', OLD[0]);
  box.put('packages/cell/tests/one.test.js', body(IDS[0], [1, 2, 3]));
  box.sh('add', '-A');
  assert.deepEqual([...idRenames(before, testIdIndex(box.root))], [[OLD[0], 'packages/cell/tests/one.test.js']]);
  const twoIds = { byId: new Map([[IDS[0], 'a.test.js'], [IDS[1], 'b.test.js']]), byFile: new Map() };
  const was = { byId: new Map(), byFile: new Map([['old.test.js', [IDS[0], IDS[1]]]]) };
  assert.equal(idRenames(was, twoIds).size, 0);
});
