/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-world-pin: clause 1 reads the repository tree and the cache module's source to prove where the cache lives and what imports it [C7,#9464]. */
/** The cells inventory cache lives in apps/cli behind its door, and nothing names its old codemap path [C7,#9464]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as codemap from '../../../../packages/codemap/index.js';
import * as door from '../../src/io/cells/cache-door.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { declarationDocBlocks } from '../../src/io/generated/declarations.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OLD = 'packages/codemap/src/io/cells/scripts/cache.js';
const SKIP = new Set(['.git', 'node_modules']);

/** Every .js and .json file under one folder, as paths from the project root. */
function sources(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => SKIP.has(entry.name) ? []
    : entry.isDirectory() ? sources(`${dir}/${entry.name}`) : /\.(js|json|tsv)$/u.test(entry.name) ? [`${dir}/${entry.name}`] : []);
}

test('cli.io-cells-cache-door.the-cache-module-is-in-the-apps: clause 1: the cache module is in the apps/cli cells folder, gone from its old codemap path, and no file imports the old path [C7,#9464]', () => {
  assert.ok(existsSync(join(ROOT, 'apps/cli/src/io/cells/cache.js')), 'cache.js is in the apps/cli cells folder');
  assert.ok(!existsSync(join(ROOT, OLD)), 'the old codemap path no longer exists');
  const importers = ['apps', 'packages'].flatMap(sources).filter(file => !file.startsWith('packages/codemap/data/plan/')
    && file !== 'apps/cli/tests/io/cells-cache-door.test.js' && readFileSync(join(ROOT, file), 'utf8').includes(OLD));
  assert.deepEqual(importers, [], 'no file names the old path');
});

test('cli.io-cells-cache-door.the-codemap-door-no-longer-exports-the: clause 1: the codemap door no longer exports the cache, and the door file serves its four names [C7,#9464]', () => {
  for (const name of ['inventoryCache', 'inventoryCodeDigest', 'inventoryPending', 'observationCache']) {
    assert.equal(codemap[name], undefined, `${name} is no longer a codemap export`);
    assert.equal(typeof door[name], 'function', `${name} comes from the door file`);
  }
});

test('cli.io-cells-cache-door.the-cache-module-reaches-codemap-git-and: clause 1: the cache module reaches codemap, git and kernel only through their doors, with the Git reader from the codemap door [C7,#9464]', () => {
  const cache = readFileSync(join(ROOT, 'apps/cli/src/io/cells/cache.js'), 'utf8');
  const from = [...cache.matchAll(/^import .* from '(\.[^']+)';$/gmu)].map(match => match[1]);
  assert.deepEqual([...new Set(from)].sort(), ['../../../../../packages/codemap/index.js', '../../../../../packages/git/index.js', '../../../../../packages/kernel/index.js']);
  assert.match(cache, /import \{ cellGit as git \} from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/packages\/codemap\/index\.js';/u);
});

test('cli.io-cells-cache-door.no-plan-rows: clause 2: the cache, the static view and the event table name no plan path, and the event table renders the same from a tree with no plan folder [C7,#2467]', () => {
  for (const file of ['apps/cli/src/io/cells/cache.js', 'apps/cli/src/io/static/view.js', 'apps/cli/src/io/generated/declarations.js']) {
    assert.ok(!readFileSync(join(ROOT, file), 'utf8').includes('packages/codemap/data/plan'), `${file} reads no plan path`);
  }
  const bare = privateFixtureFiles('cli-no-plan-');
  const documentation = 'apps/cli/src/io/documentation';
  const copy = folder => readdirSync(join(ROOT, folder), { withFileTypes: true }).forEach(entry => entry.isDirectory()
    ? copy(`${folder}/${entry.name}`) : bare.write(`${folder}/${entry.name}`, readFileSync(join(ROOT, folder, entry.name))));
  copy(documentation);
  assert.ok(!existsSync(join(bare.root, 'packages')), 'the bare tree has no plan folder');
  assert.equal(declarationDocBlocks(bare.root).events, declarationDocBlocks(ROOT).events);
});
