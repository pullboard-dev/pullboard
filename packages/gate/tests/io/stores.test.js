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
import { storeOutsideWriters } from '../../src/io/stores.js';
import { storeOwnerProblems } from '../../src/io/stores.js';
import { storeReport } from '../../src/io/stores.js';
import { storeDirGrowth } from '../../src/io/stores.js';
import { storeSites } from '../../src/io/stores.js';
import { stemlessSites } from '../../src/io/stores.js';
import { isStoreSource } from '../../src/io/stores.js';
import { walk } from '../../src/io/scan.js';
import { storeWriteProblems } from '../../src/io/stores.js';
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

test('gate.io-stores.store-file-names-and-sql: clause 1: store file names and SQL table writes are sites; a stemless template is the unlisted stem *.json, tests and bare extensions are not [CD2]', () => {
  const source = [
    "const a = join(common, 'pullboard', 'main-red.json');",
    "const b = 'pullboard/relay.json';",
    "db.prepare('UPDATE item SET item_status=? WHERE item_id=?');",
    'const c = `${id}.json`;',
    "if (name.endsWith('.json')) return;",
    "const d = 'package.json';",
  ].join('\n');
  assert.deepEqual(storeSites(source, OTHER).map(row => [row.line, row.store]),
    [[1, 'main-red.json'], [2, 'relay.json'], [3, 'table:item'], [4, 'stem:*.json'], [6, 'package.json']]);
  assert.deepEqual(storeSites(source, 'packages/gate/tests/io/x.test.js'), []);
  assert.deepEqual(storeSites(source, 'packages/gate/data/x.js'), []);
});

test('gate.io-stores.the-gate-static-checks-refuse: clause 1: the gate static checks refuse a new file joining an unregistered store path [CD2]', () => {
  const failures = judge({ [OTHER]: "export const file = join(common, 'pullboard', 'brand-new.json');" });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^packages\/gate\/src\/io\/newcomer\.js:1: CD2_UNREGISTERED_STORE: brand-new\.json .*register it/u);
  assert.match(judge({ [OTHER]: "db.exec('INSERT INTO ghost (a) VALUES (1)');" })[0], /CD2_UNREGISTERED_STORE: table:ghost/u);
  assert.deepEqual(judge({ [OTHER]: "const p = 'package.json';" }), [], 'a foreign file is not a Pullboard store');
});

test('gate.io-stores.a-non-owner-module-joining: clause 1: a non-owner module joining or writing a registered store is refused, and moving it into the owner passes [CD2]', () => {
  const join = "export const file = join(common, 'pullboard', 'main-red.json');";
  assert.match(judge({ [OTHER]: join })[0], /newcomer\.js:1: CD2_SECOND_HOME: main-red\.json belongs to packages\/landing\/src\/io\/main\/red\.js/u);
  assert.match(judge({ [OTHER]: "db.prepare('DELETE FROM item WHERE item_id=?');" })[0], /CD2_SECOND_HOME: table:item/u);
  assert.deepEqual(judge({ [OWNER]: join }), []);
  assert.deepEqual(judge({ [OTHER]: join }, { baseline: { [OTHER]: { 'main-red.json': 1 } } }), [], 'an existing home within its ceiling passes');
  assert.equal(judge({ [OTHER]: `${join}\n${join}` }, { baseline: { [OTHER]: { 'main-red.json': 1 } } }).length, 1, 'one more than the ceiling refuses');
});

test('gate.io-stores.an-exception-needs-the-person: clause 1: an exception needs the person\'s exact approval and an unexpired date [CD2]', () => {
  const join = "export const file = join(common, 'pullboard', 'main-red.json');";
  const row = { file: OTHER, store: 'main-red.json', expires: '2999-01-01', approval: storeExceptionApprovalText(OTHER, 'main-red.json', '2999-01-01') };
  assert.deepEqual(judge({ [OTHER]: join }, { registry: { ...REGISTRY, exceptions: [row] } }), []);
  const expired = { ...row, expires: '2000-01-01', approval: storeExceptionApprovalText(OTHER, 'main-red.json', '2000-01-01') };
  const failures = judge({ [OTHER]: join }, { registry: { ...REGISTRY, exceptions: [expired] } });
  assert.ok(failures.some(line => /CD2_SECOND_HOME/u.test(line)) && failures.some(line => /CD2_STORE_EXCEPTION: .* expired on 2000-01-01/u.test(line)));
  const unsigned = judge({ [OTHER]: join }, { registry: { ...REGISTRY, exceptions: [{ ...row, approval: 'ok' }] } });
  assert.ok(unsigned.some(line => /needs the person's answer: approve store exception/u.test(line)));
});

test('gate.io-stores.resources-sqlite-is-owned-by: clause 1: resources.sqlite is owned by the module that writes it, and a read-only file as owner is refused [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  assert.equal(registry.stores['resources.sqlite'].owner, 'packages/resources/src/io/main.js');
  assert.deepEqual(storeOwnerProblems(registry), []);
  const reader = { ...registry, stores: { ...registry.stores, 'resources.sqlite': { kind: 'sqlite', owner: 'packages/config/src/io/settings/inventory.js' } } };
  assert.match(storeOwnerProblems(reader)[0].text, /CD2_STORE_OWNER: resources\.sqlite is pinned to packages\/resources\/src\/io\/main\.js, not packages\/config\/src\/io\/settings\/inventory\.js/u);
  assert.match(judge({ [OTHER]: 'export const x = 1;' }, { registry: reader })[0], /CD2_STORE_OWNER: resources\.sqlite/u);
});

test('gate.io-stores.the-recount-under-ratchet-raises: clause 2: the recount under --ratchet raises no per-file ceiling once the settings inventory asks the resources module for its paths [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const baseline = JSON.parse(readFileSync(new URL(`../../../../${STORE_BASELINE}`, import.meta.url), 'utf8'));
  const recount = tightenStoreBaseline(storeReport(ROOT), registry, baseline);
  assert.deepEqual(storeBaselineGrowth(recount, baseline), []);
  assert.equal(recount['packages/config/src/io/settings/inventory.js']?.['resources.sqlite'], undefined);
});

test('gate.io-stores.the-store-baseline-may-only: clause 2: the store baseline may only fall: a risen or new ceiling refuses, a fall passes [CD2]', () => {
  const accepted = { [OTHER]: { 'main-red.json': 2 } };
  assert.deepEqual(storeBaselineGrowth({ [OTHER]: { 'main-red.json': 1 } }, accepted), []);
  assert.deepEqual(storeBaselineGrowth({}, accepted), []);
  assert.match(storeBaselineGrowth({ [OTHER]: { 'main-red.json': 3 } }, accepted)[0].text, /CD2_BASELINE_ROSE: .* 2 -> 3/u);
  assert.match(storeBaselineGrowth({ [OWNER]: { 'table:item': 1 } }, accepted)[0].text, /0 -> 1/u);
  const changed = baseline => ({ [STORE_BASELINE]: JSON.stringify(baseline) });
  assert.ok(judge(changed({ [OTHER]: { 'main-red.json': 3 } }), { accepted }).some(line => /CD2_BASELINE_ROSE/u.test(line)));
  assert.deepEqual(judge(changed({ [OTHER]: { 'main-red.json': 1 } }), { accepted }), []);
});

test('gate.io-stores.table-board-meta-is-owned: clause 1: table:board_meta is owned by one packages/store/src/io module, not the stale-state logic file [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const owner = registry.stores['table:board_meta'].owner;
  assert.match(owner, /^packages\/store\/src\/io\/[^/]+(?:\/[^/]+)*\.js$/u);
  assert.notEqual(owner, 'packages/store/src/logic/board/stale/apply.js');
  assert.deepEqual(storeOwnerProblems(registry), []);
  assert.match(storeOwnerProblems({ ...registry, stores: { ...registry.stores, 'table:board_meta': { kind: 'table', owner: 'packages/store/src/logic/board/stale/apply.js' } } })[0].text, /CD2_STORE_OWNER: table:board_meta/u);
});

test('gate.io-stores.the-board-meta-writers-outside: clause 2: the board_meta writers outside packages/store are a known set that can only shrink [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const listed = registry.outsideWriters['table:board_meta'];
  const found = storeOutsideWriters(storeReport(ROOT), 'table:board_meta', 'packages/store/');
  assert.deepEqual(found.filter(path => !listed.includes(path)), [], 'a new outside writer of board_meta is refused; ask the store module to write the key');
  assert.deepEqual(listed.filter(path => !found.includes(path)), [], 'a file that stopped writing board_meta leaves the list');
  assert.ok(listed.length > 0 && listed.every(path => !path.startsWith('packages/store/')));
});

test('gate.io-stores.the-updater-only-lowers-ceilings: clause 2: the updater only lowers ceilings and refuses growth without writing [CD2]', () => {
  const sites = storeSites("const a = 'main-red.json';\nconst b = 'main-red.json';", OTHER);
  const baseline = { [OTHER]: { 'main-red.json': 1 } };
  assert.throws(() => tightenStoreBaseline(sites, REGISTRY, baseline), /newcomer\.js:2: CD2_SECOND_HOME/u);
  assert.deepEqual(tightenStoreBaseline(sites.slice(0, 1), REGISTRY, baseline), baseline);
  assert.deepEqual(tightenStoreBaseline([], REGISTRY, baseline), {});
});

test('gate.io-stores.a-join-pullboard-dir-directory: clause 1: a join(..., \'pullboard\', \'<dir>\') directory store is a site, and a new unregistered one is refused [CD2]', () => {
  const source = [
    "const a = join(common, 'pullboard', 'trace');",
    "const b = join(gitDir, 'pullboard/packs/x');",
    "const c = 'pullboard/verified-by-second-agent';",
    "const d = join(common, 'pullboard', 'relay.json');",
    "const e = join(common, 'pullboard');",
  ].join('\n');
  assert.deepEqual(storeSites(source, OTHER).map(row => [row.line, row.store]), [[1, 'dir:trace'], [2, 'dir:packs'], [4, 'relay.json']]);
  const registry = { ...REGISTRY, dirs: { trace: { kind: 'dir', owner: OWNER } } };
  const failures = judge({ [OTHER]: "const a = join(common, 'pullboard', 'brand-new-dir');" }, { registry });
  assert.match(failures[0], /CD2_UNREGISTERED_STORE: dir:brand-new-dir is not in/u);
  assert.match(judge({ [OTHER]: "const a = join(common, 'pullboard', 'trace');" }, { registry })[0], /CD2_SECOND_HOME: dir:trace belongs to packages\/landing/u);
  assert.deepEqual(judge({ [OWNER]: "const a = join(common, 'pullboard', 'trace');" }, { registry }), []);
});

test('gate.io-stores.stores-json-has-a-dirs: clause 2: stores.json has a dirs section seeded with the directory stores, and a missing one fails [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const seeded = 'check-output ledger-cache tool-builds trace worktree-archives module-graphs worktree-prune automatic-landing review-packets gate-receipts review-comparisons source-advances state-cache packs submit-handoffs main-audits test-runs gate-spans usage-due baseline-results history-scan release-receipts flake-evidence check-receipts worktree-maintenance publish publish-index landings trunk search sandbox-exports release-coordinator-actions outside-check-output tool-build-scheduler board'.split(' ');
  assert.deepEqual(seeded.filter(name => !registry.dirs?.[name]), [], 'every seeded directory store is registered');
  const found = new Set(storeReport(ROOT).filter(site => site.store.startsWith('dir:')).map(site => site.store.slice(4)));
  assert.deepEqual([...found].filter(name => !registry.dirs[name]), [], 'a directory store the source names is registered');
  assert.ok(Object.values(registry.dirs).every(row => row.kind === 'dir' && row.owner));
  const grown = { dirs: { trace: { homes: { [OTHER]: 2 } }, fresh: { homes: { [OTHER]: 2 } } } };
  const accepted = { dirs: { trace: { homes: { [OTHER]: 1 } } } };
  assert.deepEqual(storeDirGrowth(grown, accepted).map(row => row.text), [`CD2_BASELINE_ROSE: ${OTHER} dir:trace 1 -> 2; the store baseline may only fall`], 'a registered directory may not rise; a new one records its homes once');
  const shipped = JSON.parse(readFileSync(new URL(`../../../../${STORE_BASELINE}`, import.meta.url), 'utf8'));
  assert.ok(!JSON.stringify(shipped).includes('dir:'), 'directory ceilings live in their dirs rows');
});

test('gate.io-stores.the-coordinator-release-audit-imports: clause 1: the coordinator release audit imports the release-receipts path from release.js and writes no second receipt [CD2]', () => {
  const read = file => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
  const coordinator = read('packages/gate/src/io/coordinator/release.js');
  assert.match(coordinator, /import \{ releaseReceiptFile \} from '\.\.\/release\.js';/u);
  assert.equal(storeSites(coordinator, 'packages/gate/src/io/coordinator/release.js').filter(site => site.store === 'dir:release-receipts').length, 0);
  assert.equal(storeSites(read('packages/gate/src/io/release.js'), 'packages/gate/src/io/release.js').filter(site => site.store === 'dir:release-receipts').length, 1, 'release.js names the folder once');
});

test('gate.io-stores.the-release-receipts-second-home: clause 2: the release-receipts second-home row is gone from the registry ceilings [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  assert.equal(registry.dirs['release-receipts'].owner, 'packages/gate/src/io/release.js');
  assert.deepEqual(registry.dirs['release-receipts'].homes ?? {}, {});
});

test('gate.io-stores.the-repository-adds-no-unregistered: clause 2: the repository adds no unregistered store or second home past the shipped baseline [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const baseline = JSON.parse(readFileSync(new URL(`../../../../${STORE_BASELINE}`, import.meta.url), 'utf8'));
  assert.deepEqual(storeGrowth(storeReport(ROOT), registry, baseline, new Date().toISOString().slice(0, 10)), []);
  assert.ok(registry.stores['board.sqlite'] && registry.stores['table:item'], 'board files and tables are registered');
});

test('gate.io-stores.board-sqlite-is-owned-by: clause 1: board.sqlite is owned by the store module that opens it, and the static check refuses any other owner [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  assert.equal(registry.stores['board.sqlite'].owner, 'packages/store/src/io/board/sqlite.js');
  assert.equal(registry.pinned['board.sqlite'], 'packages/store/src/io/board/sqlite.js');
  assert.deepEqual(storeOwnerProblems(registry), []);
  const moved = { ...registry, stores: { ...registry.stores, 'board.sqlite': { kind: 'sqlite', owner: 'packages/api/src/io/main.js' } } };
  assert.match(storeOwnerProblems(moved)[0].text, /CD2_STORE_OWNER: board\.sqlite is pinned to packages\/store\/src\/io\/board\/sqlite\.js, not packages\/api\/src\/io\/main\.js/u);
  assert.match(judge({ [OTHER]: 'export const x = 1;' }, { registry: moved })[0], /CD2_STORE_OWNER: board\.sqlite/u);
});

test('gate.io-stores.the-store-homes-recount-under: clause 2: the store-homes recount under --ratchet raises no per-file ceiling after board.sqlite changes owner [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const baseline = JSON.parse(readFileSync(new URL(`../../../../${STORE_BASELINE}`, import.meta.url), 'utf8'));
  const recount = tightenStoreBaseline(storeReport(ROOT), registry, baseline);
  assert.deepEqual(storeBaselineGrowth(recount, baseline), []);
  assert.equal(recount['packages/api/src/io/main.js']?.['board.sqlite'], undefined, 'the API server asks the store for the path');
});

test('gate.io-stores.build-js-is-the-one: #6746 clause 1: build.js is the one home of writeTimer and the maintenance scheduler imports it [CD2]', () => {
  const read = file => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
  const build = read('apps/cli/src/io/tool/build.js');
  const scheduler = read('apps/cli/src/io/worktree/maintenance/scheduler.js');
  assert.match(build, /export function writeTimer\(/u);
  assert.doesNotMatch(scheduler, /function (?:writeTimer|readTimer|timerFiles)\(/u, 'no second definition');
  assert.match(scheduler, /import \{ writeTimer \} from '\.\.\/\.\.\/tool\/build\.js';/u);
});

test('gate.io-stores.the-store-homes-baseline-drops: #6746 clause 2: the store-homes baseline drops the scheduler timer rows, 2 of 4 [CD2]', () => {
  const baseline = JSON.parse(readFileSync(new URL(`../../../../${STORE_BASELINE}`, import.meta.url), 'utf8'));
  assert.equal(baseline['apps/cli/src/io/worktree/maintenance/scheduler.js'], undefined);
  assert.equal(baseline['apps/cli/src/io/tool/build.js'], undefined, 'build.js reaches the timer files through timerFiles and keeps no ceiling [#10207]');
});

test('gate.io-stores.a-template-registers-by-its: #6739 clause 1: a ${...} template registers by its literal stem, and a name with no literal word registers as the unlisted stem *.json [CD2]', () => {
  const source = [
    'const a = join(dir, `exit-anchor-${claim}.json`);',
    'const b = `${id}.json`;',
    'const c = `${a}-${b}.profile.json`;',
    'const d = `${dir}/${name}.jsonl`;',
    "const e = `${count} items`;",
  ].join('\n');
  assert.deepEqual(storeSites(source, OTHER).map(row => [row.line, row.store]), [[1, 'stem:exit-anchor-*.json'], [2, 'stem:*.json'], [3, 'stem:*-*.profile.json'], [4, 'stem:*.jsonl']]);
});

test('gate.io-stores.the-registry-lists-every-current: #6739 clause 2: the registry lists every current templated stem, and a new unlisted stem fails the check [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const stems = new Set(storeReport(ROOT).map(site => site.store).filter(store => store.startsWith('stem:')));
  assert.ok(stems.size >= 25, `the repository holds ${stems.size} templated stems`);
  for (const stem of stems) assert.ok(registry.stems[stem.slice(5)]?.owner, `${stem} has an owner row in stems`);
  assert.deepEqual(storeSites('const a = `exit-anchor-${claim}.json`;', OTHER).map(row => row.store), ['stem:exit-anchor-*.json']);
  const failures = judge({ [OTHER]: 'const f = `fresh-${id}.json`;' }, { registry: { ...REGISTRY, stems: {} } });
  assert.match(failures[0], /CD2_UNREGISTERED_STORE: stem:fresh-\*\.json is not in/u);
});

test('gate.io-stores.a-stem-that-gains-a: #6739 clause 2: a stem that gains a second home past its recorded ceiling is refused [CD2]', () => {
  const registry = { ...REGISTRY, stems: { 'fresh-*.json': { kind: 'json', owner: OWNER, homes: {} } } };
  assert.match(judge({ [OTHER]: 'const f = `fresh-${id}.json`;' }, { registry })[0], /CD2_SECOND_HOME: stem:fresh-\*\.json belongs to packages\/landing/u);
});

test('gate.io-stores.every-store-owner-in-the: #6742 clause 1: every store owner in the registry holds a write call, is repo-data or is on the measured debt list [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const read = file => { try { return readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'); } catch { return undefined; } };
  assert.deepEqual(storeWriteProblems(registry, read), []);
  assert.ok(Object.values(registry.stores).filter(row => row.kind === 'repo-data').length >= 19, 'read-only data files are marked repo-data');
  assert.ok(registry.writeOwnerDebt.length <= 4, 'the debt list only shrinks');
});

test('gate.io-stores.a-new-store-whose-owner: #6742 clause 1: a new store whose owner writes nothing is refused, and a repaired debt row must leave the list [CD2]', () => {
  const reads = { [OWNER]: 'export const x = readFileSync(file);', [OTHER]: 'writeFileSync(file, text);' };
  const read = file => reads[file];
  const silent = { stores: { 'fresh.json': { kind: 'json', owner: OWNER } } };
  assert.match(storeWriteProblems(silent, read)[0].text, /CD2_OWNER_NO_WRITE: fresh\.json is owned by packages\/landing\/src\/io\/main\/red\.js, which holds no write call/u);
  assert.deepEqual(storeWriteProblems({ stores: { 'fresh.json': { kind: 'repo-data', owner: OWNER } } }, read), []);
  assert.deepEqual(storeWriteProblems({ ...silent, writeOwnerDebt: ['fresh.json'] }, read), []);
  const repaired = { stores: { 'fresh.json': { kind: 'json', owner: OTHER } }, writeOwnerDebt: ['fresh.json'] };
  assert.match(storeWriteProblems(repaired, read)[0].text, /fresh\.json now has a writing owner or is repo-data; remove it from writeOwnerDebt/u);
});

test('gate.io-stores.auth-sqlite-baseline-json-board: #8619 clause 1: auth.sqlite, baseline.json, board-hold-baseline.json, board-links.sqlite and board.json are off writeOwnerDebt, each owned by its writer or marked repo-data, with no store-homes ceiling raised [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const baseline = JSON.parse(readFileSync(new URL(`../../../../${STORE_BASELINE}`, import.meta.url), 'utf8'));
  const read = file => { try { return readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'); } catch { return undefined; } };
  const settled = ['auth.sqlite', 'baseline.json', 'board-hold-baseline.json', 'board-links.sqlite', 'board.json'];
  assert.deepEqual(settled.filter(store => registry.writeOwnerDebt.includes(store)), []);
  assert.deepEqual(storeWriteProblems(registry, read), []);
  assert.equal(registry.stores['auth.sqlite'].owner, 'apps/relay/src/io/auth.js', 'the module that opens the database owns it');
  assert.equal(registry.stores['board-links.sqlite'].owner, 'apps/relay/src/io/board/links.js');
  for (const store of ['baseline.json', 'board-hold-baseline.json', 'board.json']) assert.equal(registry.stores[store].kind, 'repo-data', `${store} is only read`);
  assert.equal(Object.values(baseline).filter(row => row['auth.sqlite'] || row['board-links.sqlite']).length, 0, 'no second home was added for the relay stores');
});

test('gate.io-stores.code-map-json-last-green: #8620 clause 1: code-map.json, last-green.json, models.json, path-map.json and post-land-suite.json are off writeOwnerDebt, each owned by its writer or marked repo-data, with no store-homes ceiling raised [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const read = file => { try { return readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'); } catch { return undefined; } };
  const settled = ['code-map.json', 'last-green.json', 'models.json', 'path-map.json', 'post-land-suite.json'];
  assert.deepEqual(settled.filter(store => registry.writeOwnerDebt.includes(store)), []);
  assert.deepEqual(storeWriteProblems(registry, read), []);
  assert.equal(registry.stores['code-map.json'].owner, 'packages/codemap/src/io/map.js');
  assert.equal(registry.stores['last-green.json'].owner, 'packages/gate/src/io/main/audit/state.js');
  assert.equal(registry.stores['post-land-suite.json'].owner, 'packages/landing/src/io/post/land.js');
  for (const store of ['models.json', 'path-map.json']) assert.equal(registry.stores[store].kind, 'repo-data', `${store} is only read`);
});

test('gate.io-stores.pullboard-item-json-pullboard-runner: #8622 clause 1: pullboard-item.json, pullboard-runner-policy.json, recovery.json and relay-health.sqlite are off writeOwnerDebt, each owned by its writer, with no store-homes ceiling raised [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const read = file => { try { return readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'); } catch { return undefined; } };
  const settled = ['pullboard-item.json', 'pullboard-runner-policy.json', 'recovery.json', 'relay-health.sqlite'];
  assert.deepEqual(settled.filter(store => registry.writeOwnerDebt.includes(store)), []);
  assert.deepEqual(storeWriteProblems(registry, read), []);
  assert.equal(registry.stores['pullboard-item.json'].owner, 'packages/items/src/io/claim.js');
  assert.equal(registry.stores['recovery.json'].owner, 'packages/sync/src/io/git/repair.js');
  assert.equal(registry.stores['relay-health.sqlite'].owner, 'packages/link/src/io/relay/canary/health.js');
});

test('gate.io-stores.publish-json-is-off-writeownerdebt: #8752 clause 1: publish.json is off writeOwnerDebt, owned by the landing pause module that writes it, and publish writes through that owner, with no store-homes ceiling raised [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const read = file => { try { return readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'); } catch { return undefined; } };
  assert.equal(registry.writeOwnerDebt.includes('publish.json'), false);
  assert.deepEqual(storeWriteProblems(registry, read), []);
  assert.equal(registry.stores['publish.json'].owner, 'packages/landing/src/io/pause.js');
  assert.match(read('packages/github/src/io/publish.js'), /writePublishState\(root/u, 'publish writes through the owner');
});

test('gate.io-stores.settled-json-is-off-writeownerdebt: #8754 clause 1: settled.json is off writeOwnerDebt, owned by the audit state module that holds saveMainAudit, with no store-homes ceiling raised [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const read = file => { try { return readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'); } catch { return undefined; } };
  assert.equal(registry.writeOwnerDebt.includes('settled.json'), false);
  assert.deepEqual(storeWriteProblems(registry, read), []);
  assert.equal(registry.stores['settled.json'].owner, 'packages/gate/src/io/main/audit/state.js');
});

/** The stemless templated store names under one package: every one must come from the cell's registry const [CD2]. */
function stemlessIn(cell) {
  return walk(ROOT, /\.js$/u).filter(path => isStoreSource(path) && path.startsWith(cell))
    .flatMap(path => stemlessSites(readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8'), path).map(row => `${row.path}:${row.line} ${row.text}`));
}

test('gate.io-stores.a-stemless-templated-store-file: #7003 clause 1: a stemless templated store-file name is found, and no site under packages/gate or packages/api holds one [CD2]', () => {
  assert.deepEqual(stemlessSites('const a = `${id}.json`;\nconst b = `exit-${id}.json`;\nconst c = id + EXT;', OTHER).map(row => [row.line, row.text]), [[1, '${id}.json']]);
  assert.deepEqual([...stemlessIn('packages/gate/'), ...stemlessIn('packages/api/')], [], 'name each file from a registry const such as storeName(key)');
});

test('gate.io-stores.no-store-file-site-under: #7012 clause 1: no store-file site under packages/runners builds its name from a stemless template [CD2]', () => {
  assert.deepEqual(stemlessIn('packages/runners/'), [], 'name each file from the runners registry const storeName(key)');
});

test('gate.io-stores.no-store-file-site-under-packages: #7014 clause 1: no store-file site under packages/landing builds its name from a stemless template [CD2]', () => {
  assert.deepEqual(stemlessIn('packages/landing/'), [], 'name each file from the landing registry const storeName(key)');
});

test('gate.io-stores.no-store-file-site-in: #7015 clause 1: no store-file site in any package or app builds its name from a stemless template, and a new one is refused as unregistered [CD2]', () => {
  assert.deepEqual(stemlessIn(''), [], 'name each file from its cell registry const storeName(key)');
  const failures = judge({ [OTHER]: 'const f = join(dir, `${id}.json`);' }, { registry: REGISTRY });
  assert.match(failures[0], /CD2_UNREGISTERED_STORE: stem:\*\.json is not in/u);
});

test('gate.io-stores.no-store-file-site-under-packages-link: #7013 clause 1: no store-file site under packages/link builds its name from a stemless template [CD2]', () => {
  assert.deepEqual(stemlessIn('packages/link/'), [], 'name each file from the link registry const storeName(key)');
});

test('gate.io-stores.stats-history-jsonl-timer-guard: #8623 clause 1: stats-history.jsonl, timer.guard.sqlite, timer.json and vendors.json are off writeOwnerDebt, each owned by its writer or marked repo-data, with no store-homes ceiling raised [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const baseline = JSON.parse(readFileSync(new URL(`../../../../${STORE_BASELINE}`, import.meta.url), 'utf8'));
  const read = file => { try { return readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'); } catch { return undefined; } };
  const settled = ['stats-history.jsonl', 'timer.guard.sqlite', 'timer.json', 'vendors.json'];
  assert.deepEqual(settled.filter(store => registry.writeOwnerDebt.includes(store)), []);
  assert.deepEqual(storeWriteProblems(registry, read), []);
  assert.equal(registry.stores['stats-history.jsonl'].owner, 'packages/stats/src/io/time/history.js', 'the module that appends the history owns it');
  assert.equal(registry.stores['timer.json'].owner, 'packages/gate/src/io/main/audit/state.js', 'the module that writes the timer owns it');
  assert.equal(registry.stores['timer.guard.sqlite'].owner, 'packages/gate/src/io/main/audit/state.js');
  assert.equal(registry.stores['vendors.json'].kind, 'repo-data', 'vendors.json is only read');
  assert.equal(Object.values(baseline).filter(row => row['stats-history.jsonl']).length, 0, 'no second home names the history file');
});

test('gate.io-stores.writeownerdebt-in-stores-json-ends: #8623 clause 2: writeOwnerDebt in stores.json ends empty and every store passes the write-owner check [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const read = file => { try { return readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8'); } catch { return undefined; } };
  assert.deepEqual(registry.writeOwnerDebt, [], 'no store is left on the debt list');
  assert.deepEqual(storeWriteProblems(registry, read), []);
});

test('gate.io-stores.verdict-owned-by-verify-io: #10814 clause 1: table:verdict is owned by the verify io module that writes it, and the logic file holds no verdict write [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const owner = registry.stores['table:verdict'].owner;
  assert.equal(owner, 'packages/verify/src/io/review/independence.js');
  assert.match(readFileSync(new URL(`../../../../${owner}`, import.meta.url), 'utf8'), /INSERT INTO verdict /u);
  assert.doesNotMatch(readFileSync(new URL('../../../verify/src/logic/verdict/assurance.js', import.meta.url), 'utf8'), /INSERT INTO verdict /u);
  assert.deepEqual(storeOwnerProblems(registry), []);
});

test('gate.io-stores.temp-owned-by-outbox-io: #10813 clause 1: table:temp is owned by the outbox io module that writes it, and the logic file holds no write call [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const owner = registry.stores['table:temp'].owner;
  assert.equal(owner, 'packages/outbox/src/io/relay/undo.js');
  assert.match(readFileSync(new URL(`../../../../${owner}`, import.meta.url), 'utf8'), /INSERT INTO temp\.moving/u);
  assert.doesNotMatch(readFileSync(new URL('../../../outbox/src/logic/undo.js', import.meta.url), 'utf8'), /temp\.moving/u);
  assert.deepEqual(storeOwnerProblems(registry), []);
});

test('gate.io-stores.person-enrollment-owned-by-relay-io: #10810 clause 1: table:person_enrollment is owned by the relay io module that writes it, not a logic file [CD2]', () => {
  const registry = JSON.parse(readFileSync(new URL(`../../../../${STORE_REGISTRY}`, import.meta.url), 'utf8'));
  const owner = registry.stores['table:person_enrollment'].owner;
  assert.equal(owner, 'apps/relay/src/io/store/enrollment.js');
  const source = readFileSync(new URL(`../../../../${owner}`, import.meta.url), 'utf8');
  assert.match(source, /INSERT INTO person_enrollment/u, 'the owner holds the write call');
  const oldHome = ['apps/relay/src/logic/person/enrollment', 'store.js'].join('/');
  assert.throws(() => readFileSync(new URL(`../../../../${oldHome}`, import.meta.url)), /ENOENT/u, 'no logic file keeps the store');
});
