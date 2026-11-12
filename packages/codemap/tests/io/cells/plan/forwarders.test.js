/** Accepted loader authority survives exact cell moves without authorizing a new dependency [C7,D3]. */
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { test } from 'node:test';
import { checkCuts } from '../../../../src/io/cells/plan/engine.js';
import { computePlan as modelComputePlan } from '../../../../index.js';
import { writePlan as modelWritePlan } from '../../../../index.js';
import { readPathMap } from '../../../../index.js';
import { tryGit } from '../../../../../git/index.js';
import { cellInventory } from '../../../../index.js';
import { importsIn } from '../../../../index.js';
import { commonJsIn } from '../../../../index.js';
import { fixture } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';

/** Compute the plan with the plain Git reader; a fixture repository needs no snapshot-aware reads. */
const computePlan = root => modelComputePlan(root, { tryGit });
/** Write the plan with the plain path-map and Git readers. */
const writePlan = (root, plan) => modelWritePlan(root, plan, { readPathMap, tryGit });

const LOADER = '/** @pullboard-module-loads src/stats*.js */\nexport class Refused extends Error {}\nexport const load = name => import(name);\n';

/** Build actual accepted Git bytes, then move one selected module behind its same-cell public entry. */
function forwardedFixture(t) {
  const box = fixture(t);
  box.put('src/refused.js', LOADER);
  const plan = computePlan(box.root);
  writePlan(box.root, plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'accepted loader');
  const acceptedInventory = cellInventory(box.root, { importsIn, commonJsIn });
  const cell = plan.cells.find(row => row.name === 'stats');
  const body = cell.paths.find(([from]) => from === 'src/stats-flow.js')[1];
  const shim = `export { flow } from ${JSON.stringify('../' + cell.frontDoor)};\n`;
  box.put('src/stats-flow.js', shim);
  box.put(cell.frontDoor, `export { flow } from ${JSON.stringify('./' + posix.relative(posix.dirname(cell.frontDoor), body))};\n`);
  box.put(body, 'export const flow = true;\n');
  box.put('path-map.json', JSON.stringify({ 'src/stats-flow.js': body }));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'move selected module');
  /** Inspect real current fixture bytes against the retained accepted loader inventory. */
  function problems(name = 'kernel') {
    return checkCuts(box.root, plan, name, { allLaterCells: true, temporaryExceptions: false, acceptedInventory });
  }
  return { ...box, cell, body, problems };
}

test('accepted wildcard authority follows same-owner pure shim and public-entry exports [C7,D3]', t => {
  const box = forwardedFixture(t);
  assert.deepEqual(box.problems(), []);
});

test('an independent literal importing route cannot borrow same-owner wildcard forwarding authority [C7,D3]', t => {
  const box = forwardedFixture(t);
  box.put('src/refused.js', LOADER + "import './stats-flow.js';\n");
  assert.ok(box.problems().some(problem => problem.includes('src/refused.js -> src/stats-flow.js')));
});

test('accepted wildcard forwarding cannot cross into another owner cell [C7,D3]', t => {
  const box = forwardedFixture(t);
  box.put(box.cell.frontDoor, 'export * from "../../src/cli.js";\n');
  assert.ok(box.problems().some(problem => problem.includes(`${box.cell.frontDoor} -> src/cli.js`)));
});

test('fresh and changed wildcard declarations retain their own dependency checks [C7,D3]', t => {
  const box = forwardedFixture(t);
  box.put('src/refused.js', LOADER.replace('src/stats*.js', 'src/stat*.js'));
  assert.ok(box.problems().some(problem => problem.includes('src/refused.js -> src/stats-flow.js')));
  box.put('src/refused.js', LOADER.replace('src/stats*.js', 'packages/stats/**'));
  assert.ok(box.problems().some(problem => problem.includes('src/refused.js -> ' + box.cell.frontDoor)));
});

test('computed and unknown loader forwarders cannot inherit pure-export wildcard authority [C7,D3]', t => {
  const box = forwardedFixture(t);
  box.put('src/stats-flow.js', `/** @pullboard-module-loads ${box.body} */\nawait import(name);\n`);
  assert.ok(box.problems().some(problem => problem.includes('src/stats-flow.js -> ' + box.body)));
  box.put('src/stats-flow.js', 'await import(name);\n');
  assert.ok(box.problems().some(problem => problem.includes('cannot prove cut through src/stats-flow.js')));
});

test('real implementations keep their later imports under their own cell cut [C7,D3]', t => {
  const box = forwardedFixture(t);
  box.put(box.body, `import ${JSON.stringify(posix.relative(posix.dirname(box.body), 'src/cli.js'))};\nexport const flow = true;\n`);
  assert.deepEqual(box.problems(), [], 'the importing cell does not take ownership of another cell implementation');
  assert.ok(box.problems('stats').some(problem => problem.includes(`${box.body} -> src/cli.js`)), 'the actual owner still refuses the new later dependency');
});
