/** @pullboard-world-pin reads the committed cells plan, the landing sources and the front door to prove the guard.js move. */
/** The landing guard sits in the shell cell with its importers repointed, and its static import closure reaches no CLI front door [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const LANDING = new URL('../../', import.meta.url);
const PLAN = new URL('../../../codemap/data/plan/', import.meta.url);
const OLD = 'packages/landing/src/logic/land/guard.js';
const NEW = 'packages/landing/src/io/land/guard.js';
const read = (base, path) => readFileSync(new URL(path, base), 'utf8');

test('clause 1: the static import closure of the landing guard reaches no CLI front door [C7]', () => {
  const seen = new Set();
  const walk = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+'(\.[^']+)'/gu)) {
      const target = new URL(match[1], file);
      assert.ok(!/\/apps\/cli\//u.test(target.pathname), `${file.pathname} imports ${match[1]}`);
      if (existsSync(target)) walk(target);
    }
  };
  walk(new URL('src/io/land/guard.js', LANDING));
  assert.ok(seen.size >= 1);
});

test('clause 2: landing guard.js sits in the shell cell in the cells plan with importers repointed [C7]', () => {
  assert.ok(existsSync(new URL('src/io/land/guard.js', LANDING)));
  assert.ok(!existsSync(new URL('src/logic/land/guard.js', LANDING)));
  const freeze = JSON.parse(read(PLAN, 'path-map/freeze.json'));
  assert.equal(freeze['packages/landing/src/core/land-local-guard.js'], NEW);
  assert.ok(!Object.values(freeze).includes(OLD));
  const renames = read(PLAN, 'renames.tsv');
  assert.ok(renames.includes(`packages/landing/src/core/land-local-guard.js\t${NEW}\n`));
  assert.ok(!renames.includes(OLD));
  assert.ok(read(PLAN, '36-landing.json').includes(`"${NEW}"`));
  assert.ok(!read(PLAN, '36-landing.json').includes(OLD));
  assert.match(read(LANDING, 'index.js'), /from "\.\/src\/io\/land\/guard\.js"/u);
  assert.match(read(LANDING, 'src/io/step/gate.js'), /from '\.\.\/land\/guard\.js'/u);
});
