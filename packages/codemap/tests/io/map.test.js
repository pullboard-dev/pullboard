/** @pullboard-test-input source-cell packages/codemap */
/** The item slice seeds from the paths and names an item gives, ranks what is closest, and fits a small default budget [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsdoc } from '../../src/io/map.js';
import { renderItemSlice } from '../../src/io/map.js';

/** One scanned function as the map stores it. */
function fn(modulePath, name, { calls = [], callers = [] } = {}) {
  return { name, id: `${modulePath}#${name}`, exported: true, signature: `${name}()`, line: 1, summary: `${name} does one thing.`,
    returns: null, transitiveEffects: [], throws: [], calls, callers };
}

/** One scanned module; edges are filled in by makeMap. */
function mod(path, { functions = [], dependencies = [], tests = [] } = {}) {
  return { path, loc: 10, job: `${path} module.`, functions: functions.map(entry => (typeof entry === 'string' ? fn(path, entry) : entry)),
    dependencies, external: [], importedBy: [], tests };
}

/** A map object with importedBy edges derived from each module's dependencies. */
function makeMap(modules) {
  const byPath = new Map(modules.map(module => [module.path, module]));
  for (const module of modules) for (const dependency of module.dependencies) byPath.get(dependency).importedBy.push(module.path);
  return { mainCommit: 'a'.repeat(40), modules };
}

const line = (slice, label) => slice.split('\n').find(text => text.startsWith(`${label}: `))?.slice(label.length + 2);

test('clause 1: a packages/ or apps/ path seeds its module from the path start, the check is read, and short or common function names never seed [C7]', () => {
  const map = makeMap([
    mod('packages/demo/src/io/serve.js', { functions: ['serveThing'] }),
    mod('src/io/serve.js', { functions: ['oldServe'] }),
    mod('apps/web/src/io/page.js', { functions: ['pageThing'] }),
    mod('packages/demo/src/io/checked.js', { functions: ['checkedThing'], tests: ['packages/demo/tests/io/checked.test.js'] }),
    mod('packages/demo/src/io/one.js', { functions: ['items', 'formatThing', 'uniqueHelper'] }),
    mod('packages/demo/src/io/two.js', { functions: ['formatThing'] }),
    mod('packages/demo/src/io/three.js', { functions: ['formatThing'] }),
  ]);
  const slice = renderItemSlice(map, {
    item_id: 7,
    item_title: 'Serve the page',
    item_criterion: '1. packages/demo/src/io/serve.js serves (apps/web/src/io/page.js shows it) [test]',
    item_brief: 'Call items, formatThing and uniqueHelper.',
    item_check: 'node run.js packages/demo/tests/io/checked.test.js',
  });
  assert.equal(line(slice, 'named files'), 'apps/web/src/io/page.js, packages/demo/src/io/serve.js, packages/demo/tests/io/checked.test.js');
  assert.match(slice, /^## packages\/demo\/src\/io\/serve\.js /mu);
  assert.match(slice, /^## apps\/web\/src\/io\/page\.js /mu);
  assert.doesNotMatch(slice, /^## src\/io\/serve\.js /mu, 'the tail of a package path is no seed');
  assert.match(slice, /^## packages\/demo\/src\/io\/checked\.js /mu, 'a test named in the check seeds its mirrored source');
  assert.equal(line(slice, 'functions named by the item'), 'packages/demo/src/io/one.js#uniqueHelper');
  assert.doesNotMatch(slice, /^## packages\/demo\/src\/io\/(?:two|three)\.js /mu, 'a name defined in three modules pulls none of them in');
});

test('clause 2: named modules come before their one-hop neighbours, at most ten tests are named (seed tests first), and the default budget is 1,500 tokens [C7]', () => {
  const seedTests = Array.from({ length: 12 }, (_, index) => `packages/demo/tests/io/seed-${String(index).padStart(2, '0')}.test.js`);
  const map = makeMap([
    mod('packages/demo/src/io/seed.js', { functions: [fn('packages/demo/src/io/seed.js', 'seedThing', { calls: ['packages/far/src/io/called.js#calledThing'] })],
      dependencies: ['packages/demo/src/io/dep.js', 'packages/far/src/io/called.js'], tests: seedTests }),
    mod('packages/demo/src/io/dep.js', { functions: ['depThing'], tests: ['packages/demo/tests/io/dep.test.js'] }),
    mod('packages/far/src/io/called.js', { functions: [fn('packages/far/src/io/called.js', 'calledThing', { callers: ['packages/demo/src/io/seed.js#seedThing'] })] }),
    mod('packages/demo/src/io/user.js', { functions: ['userThing'], dependencies: ['packages/demo/src/io/seed.js'] }),
    mod('packages/demo/src/io/unrelated.js', { functions: ['unrelatedThing'] }),
  ]);
  const item = { item_id: 8, item_title: 'Fix seedThing in packages/demo/src/io/seed.js' };
  const slice = renderItemSlice(map, item, { budget: 8000 });
  assert.deepEqual(line(slice, 'closest modules').split(', '),
    ['packages/demo/src/io/seed.js', 'packages/far/src/io/called.js', 'packages/demo/src/io/dep.js', 'packages/demo/src/io/user.js']);
  const tests = line(slice, 'tests with observed imports of the closest modules').split(', ');
  assert.equal(tests.length, 10);
  assert.deepEqual(tests, seedTests.slice(0, 10));
  assert.ok(slice.indexOf('## packages/demo/src/io/seed.js') < slice.indexOf('## packages/demo/src/io/dep.js'));
  assert.doesNotMatch(slice, /unrelated\.js/u);

  const wide = makeMap([
    mod('packages/demo/src/io/hub.js', { functions: ['hubThing'], dependencies: Array.from({ length: 40 }, (_, index) => `packages/demo/src/io/leaf-${index}.js`) }),
    ...Array.from({ length: 40 }, (_, index) => mod(`packages/demo/src/io/leaf-${index}.js`,
      { functions: Array.from({ length: 6 }, (_, at) => `leafThing${index}x${at}`) })),
  ]);
  const hub = { item_id: 9, item_title: 'Fix packages/demo/src/io/hub.js' };
  const small = renderItemSlice(wide, hub);
  assert.ok(small.length <= 1500 * 4, `default slice is ${small.length} characters`);
  assert.match(small, /Omitted context is not evidence of no relationship\./u);
  assert.ok(renderItemSlice(wide, hub, { budget: 4000 }).length > 1500 * 4, 'an explicit larger budget still prints more');
});

test('codemap.map.jsdoc-tags-at-line-start: clause 1: parseJsdoc reads param, returns and throws tags only where the tag opens a JSDoc line [C7]', () => {
  const prose = parseJsdoc('/** Parse a block: first sentence, @param names and types, @returns type, @throws. */');
  assert.deepEqual([prose.params, prose.returns, prose.throws], [[], null, []], 'a tag named in prose is no tag');
  const tagged = parseJsdoc('/**\n * Add two numbers.\n * @param {number} a - The first.\n * @param [b] - The second.\n * @returns {number} The sum.\n * @throws {Error} Never.\n */');
  assert.deepEqual(tagged.params, [{ name: 'a', type: 'number', optional: false }, { name: 'b', type: null, optional: true }]);
  assert.deepEqual([tagged.summary, tagged.returns, tagged.throws], ['Add two numbers.', 'number', ['Error']]);
});
