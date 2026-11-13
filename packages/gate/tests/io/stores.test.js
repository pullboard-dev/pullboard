/** @pullboard-test-input test-tree */
/** @pullboard-world-pin reads the shipped store registry, its baseline and the source tree to prove the ratchet holds. */
/** The store registry: one owner module per state store, refused second homes, and a baseline that only falls [CD2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STATIC_CHECKS } from '../../src/io/static/check/registry.js';
import { STORE_BASELINE } from '../../src/io/stores.js';
import { STORE_REGISTRY } from '../../src/io/stores.js';
import { storeBaselineGrowth } from '../../src/io/stores.js';
import { storeExceptionApprovalText } from '../../src/io/stores.js';
import { storeGrowth } from '../../src/io/stores.js';
import { storeReport } from '../../src/io/stores.js';
import { storeSites } from '../../src/io/stores.js';
import { tightenStoreBaseline } from '../../src/io/stores.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const OWNER = 'packages/landing/src/io/main/red.js';
const OTHER = 'packages/gate/src/io/newcomer.js';
const REGISTRY = { foreign: ['package.json'], stores: { 'main-red.json': { kind: 'json', owner: OWNER }, 'table:item': { kind: 'table', owner: OWNER } }, exceptions: [] };

/** Run the registered static check on candidate files, with main's baseline as `accepted`. */
function judge(files, { registry = REGISTRY, baseline = {}, accepted = null } = {}) {
  const tree = { [STORE_REGISTRY]: JSON.stringify(registry), [STORE_BASELINE]: JSON.stringify(baseline), ...files };
  const check = STATIC_CHECKS.find(row => row.name === 'store-registry');
  return check.run({
    files: Object.keys(files),
    sources: Object.entries(files).filter(([file]) => file.endsWith('.js')).map(([file, source]) => ({ file, source })),
    text: file => tree[file],
    previous: file => (file === STORE_BASELINE && accepted ? JSON.stringify(accepted) : ''),
  });
}

test('clause 1: store file names and SQL table writes are sites; templates, tests and bare extensions are not [CD2]', () => {
  const source = [
    "const a = join(common, 'pullboard', 'main-red.json');",
    "const b = 'pullboard/relay.json';",
    "db.prepare('UPDATE item SET item_status=? WHERE item_id=?');",
    'const c = `${id}.json`;',
    "if (name.endsWith('.json')) return;",
    "const d = 'package.json';",
  ].join('\n');
  assert.deepEqual(storeSites(source, OTHER).map(row => [row.line, row.store]),
    [[1, 'main-red.json'], [2, 'relay.json'], [3, 'table:item'], [6, 'package.json']]);
  assert.deepEqual(storeSites(source, 'packages/gate/tests/io/x.test.js'), []);
  assert.deepEqual(storeSites(source, 'packages/gate/data/x.js'), []);
});

test('clause 1: the gate static checks refuse a new file joining an unregistered store path [CD2]', () => {
  const failures = judge({ [OTHER]: "export const file = join(common, 'pullboard', 'brand-new.json');" });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^packages\/gate\/src\/io\/newcomer\.js:1: CD2_UNREGISTERED_STORE: brand-new\.json .*register it/u);
  assert.match(judge({ [OTHER]: "db.exec('INSERT INTO ghost (a) VALUES (1)');" })[0], /CD2_UNREGISTERED_STORE: table:ghost/u);
  assert.deepEqual(judge({ [OTHER]: "const p = 'package.json';" }), [], 'a foreign file is not a Pullboard store');
});

test('clause 1: a non-owner module joining or writing a registered store is refused, and moving it into the owner passes [CD2]', () => {
  const join = "export const file = join(common, 'pullboard', 'main-red.json');";
  assert.match(judge({ [OTHER]: join })[0], /newcomer\.js:1: CD2_SECOND_HOME: main-red\.json belongs to packages\/landing\/src\/io\/main\/red\.js/u);
  assert.match(judge({ [OTHER]: "db.prepare('DELETE FROM item WHERE item_id=?');" })[0], /CD2_SECOND_HOME: table:item/u);
  assert.deepEqual(judge({ [OWNER]: join }), []);
  assert.deepEqual(judge({ [OTHER]: join }, { baseline: { [OTHER]: { 'main-red.json': 1 } } }), [], 'an existing home within its ceiling passes');
  assert.equal(judge({ [OTHER]: `${join}\n${join}` }, { baseline: { [OTHER]: { 'main-red.json': 1 } } }).length, 1, 'one more than the ceiling refuses');
});

test('clause 1: an exception needs the person\'s exact approval and an unexpired date [CD2]', () => {
  const join = "export const file = join(common, 'pullboard', 'main-red.json');";
  const row = { file: OTHER, store: 'main-red.json', expires: '2999-01-01', approval: storeExceptionApprovalText(OTHER, 'main-red.json', '2999-01-01') };
  assert.deepEqual(judge({ [OTHER]: join }, { registry: { ...REGISTRY, exceptions: [row] } }), []);
  const expired = { ...row, expires: '2000-01-01', approval: storeExceptionApprovalText(OTHER, 'main-red.json', '2000-01-01') };
  const failures = judge({ [OTHER]: join }, { registry: { ...REGISTRY, exceptions: [expired] } });
  assert.ok(failures.some(line => /CD2_SECOND_HOME/u.test(line)) && failures.some(line => /CD2_STORE_EXCEPTION: .* expired on 2000-01-01/u.test(line)));
  const unsigned = judge({ [OTHER]: join }, { registry: { ...REGISTRY, exceptions: [{ ...row, approval: 'ok' }] } });
  assert.ok(unsigned.some(line => /needs the person's answer: approve store exception/u.test(line)));
});

test('clause 2: the store baseline may only fall: a risen or new ceiling refuses, a fall passes [CD2]', () => {
  const accepted = { [OTHER]: { 'main-red.json': 2 } };
  assert.deepEqual(storeBaselineGrowth({ [OTHER]: { 'main-red.json': 1 } }, accepted), []);
  assert.deepEqual(storeBaselineGrowth({}, accepted), []);
  assert.match(storeBaselineGrowth({ [OTHER]: { 'main-red.json': 3 } }, accepted)[0].text, /CD2_BASELINE_ROSE: .* 2 -> 3/u);
  assert.match(storeBaselineGrowth({ [OWNER]: { 'table:item': 1 } }, accepted)[0].text, /0 -> 1/u);
  const changed = baseline => ({ [STORE_BASELINE]: JSON.stringify(baseline) });
  assert.ok(judge(changed({ [OTHER]: { 'main-red.json': 3 } }), { accepted }).some(line => /CD2_BASELINE_ROSE/u.test(line)));
  assert.deepEqual(judge(changed({ [OTHER]: { 'main-red.json': 1 } }), { accepted }), []);
});

test('clause 2: the updater only lowers ceilings and refuses growth without writing [CD2]', () => {
  const sites = storeSites("const a = 'main-red.json';\nconst b = 'main-red.json';", OTHER);
  const baseline = { [OTHER]: { 'main-red.json': 1 } };
  assert.throws(() => tightenStoreBaseline(sites, REGISTRY, baseline), /newcomer\.js:2: CD2_SECOND_HOME/u);
  assert.deepEqual(tightenStoreBaseline(sites.slice(0, 1), REGISTRY, baseline), baseline);
  assert.deepEqual(tightenStoreBaseline([], REGISTRY, baseline), {});
});

test('clause 2: the repository adds no unregistered store or second home past the shipped baseline [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const baseline = JSON.parse(readFileSync(new URL(`../../../../${STORE_BASELINE}`, import.meta.url), 'utf8'));
  assert.deepEqual(storeGrowth(storeReport(ROOT), registry, baseline, new Date().toISOString().slice(0, 10)), []);
  assert.ok(registry.stores['board.sqlite'] && registry.stores['table:item'], 'board files and tables are registered');
});
