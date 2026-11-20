/** @pullboard-test-input source-cell apps/cli packages/kernel packages/store packages/state packages/queue packages/seats packages/items packages/spec packages/git packages/verify packages/merge packages/config packages/stats packages/resources packages/transport packages/jobs packages/sandbox packages/doctrine packages/codemap packages/commits packages/person packages/roadmap */
/**
 * A read command pays only for its own modules: list and show load no gate, relay or landing module beyond the audited row each keeps
 * in startup-heavy.json, and every command keeps a startup ceiling row in startup-budget.json that only ever shrinks [C7].
 * Why a static walk: the modules a command loads are the ones its import statements reach, so no process is launched.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { assertStartupBudgets } from '../../fixtures/budget.js';
import { QUIET_BARE_CPU_MS } from '../../fixtures/budget.js';
import { QUIET_BARE_MS } from '../../fixtures/budget.js';
import { judgeStartupRow } from '../../fixtures/budget.js';
import { scaledMedian } from '../../fixtures/budget.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
/** Modules a read must never load beyond its audited row: the gate runner, the relay client and the landing machinery. */
const HEAVY = ['apps/cli/src/io/commands/gate.js', 'apps/cli/src/io/commands/relay.js', 'apps/cli/src/io/commands/land.js',
  'packages/sandbox/src/io/trusted/policy.js', 'packages/gate/src/io/check/baseline.js', 'packages/gate/src/io/run/shell.js', 'packages/commits/src/io/hooks.js',
  'packages/resources/index.js', 'packages/store/index.js', 'packages/store/src/io/board.js', 'packages/store/src/io/board/event/log.js', 'packages/state/src/io/machine.js',
  'packages/sentinels/src/io/main.js', 'packages/store/src/logic/board/landing/lease.js'];
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"`;]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gmu;

/** Every repository module a file reaches through static import and re-export statements, as repository-relative paths. */
function staticClosure(entry) {
  const seen = new Set();
  const stack = [resolve(REPO, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) stack.push(resolve(dirname(file), match[1] ?? match[2]));
  }
  return [...seen].map(file => file.slice(REPO.length + 1));
}

const rows = JSON.parse(readFileSync(resolve(REPO, 'apps/cli/journeys/list/startup-heavy.json'), 'utf8'));
const ceilings = JSON.parse(readFileSync(resolve(REPO, 'apps/cli/journeys/list/startup-budget.json'), 'utf8'));

test('cli.io-commands-read-startup.list-and-show-load-no-gate-relay: clause 1: list and show load no gate, relay or landing module beyond their audited row [C7]', () => {
  for (const command of ['list', 'show']) {
    const modules = staticClosure(`apps/cli/src/io/commands/${command}.js`);
    assert.ok(modules.length > 10, `${command} walked ${modules.length} modules`);
    const beyond = modules.filter(path => HEAVY.includes(path) && !rows[command].includes(path));
    assert.deepEqual(beyond, [], `${command} loads heavy modules beyond its row in startup-heavy.json`);
  }
});

test('cli.io-commands-read-startup.list-loads-none-of-the-heavy-set: clause 1: list loads none of the heavy set, and a row names only modules that exist [C7]', () => {
  const heavy = staticClosure('apps/cli/src/io/commands/list.js').filter(path => HEAVY.includes(path));
  assert.deepEqual(heavy, []);
  for (const [command, modules] of Object.entries(rows).filter(([, value]) => Array.isArray(value))) {
    for (const path of modules) assert.ok(existsSync(resolve(REPO, path)), `${command} row names ${path}, which is gone`);
  }
});

test('cli.io-commands-read-startup.heavy-rows-name-only-reached-modules: clause 1: every module a list or show row of startup-heavy.json names is reached by that command static closure, and the show row is exactly packages/state/src/io/machine.js [C7]', () => {
  for (const command of ['list', 'show']) {
    const modules = new Set(staticClosure(`apps/cli/src/io/commands/${command}.js`));
    const stale = rows[command].filter(path => !modules.has(path));
    assert.deepEqual(stale, [], `${command} row names modules its closure never reaches`);
  }
  assert.deepEqual(rows.show, ['packages/state/src/io/machine.js']);
});

test('cli.io-commands-read-startup.every-read-command-keeps-a-startup-ceiling: clause 2: every read command keeps a startup ceiling row, none above its audited value [C7]', () => {
  const audited = { version: 800, show: 2000, status: 3000, list: 1500, 'list thin': 200 };
  assert.deepEqual(Object.keys(ceilings).sort(), ['list', 'list thin', 'show', 'status', 'version']);
  for (const [command, limit] of Object.entries(audited)) assert.ok(ceilings[command] <= limit, `${command} ceiling ${ceilings[command]} ms is above its audited ${limit} ms`);
});

// 'list thin' is an audited exception: the 100 ms target is out of reach for now, so the row sits at 200 ms against the measured
// median of 182 ms (run 91c72d73-2ba5-49e3-bff6-359ea1541783); the cut toward 100 is a follow-up item, and the row never rises [C7,#9090].
test('cli.io-commands-read-startup.the-list-thin-row-is-200-ms: clause 2: the list thin row is 200 ms and the list row stays at its audited 1500 ms [C7,#9090]', () => {
  assert.equal(ceilings['list thin'], 200);
  assert.equal(ceilings.list, 1500);
});

const startupReport = {};
test('cli.io-commands-read-startup.the-version-show-status-and-list-rows-hold: clause 1: the version, show, status and list rows hold their startup rows; list thin is measured in apps/cli/tests/io/list/thin.test.js [C7,#10293]', async (t) => {
  await assertStartupBudgets(t, startupReport, { only: ['version', 'show', 'status', 'list'] });
});

test('cli.io-commands-read-startup.the-version-row-reports-its-median-the: clause 1: the version row reports its median, the bare node median and the overhead as a diagnostic line [C7]', () => {
  assert.ok(startupReport.floorLines, 'the startup measurement above did not produce its report');
  const line = startupReport.floorLines.find(text => text.startsWith('version median '));
  assert.match(line, /^version median \d+\.\d\d ms, bare node median \d+\.\d\d ms, overhead -?\d+\.\d\d ms$/u);
  assert.equal(startupReport.floorLines.length, Object.keys(startupReport.mediansMs).length);
});

test('cli.io-commands-read-startup.list-thin-is-an-audited-exception-at: clause 3: list thin is an audited exception at 200 ms over its measured median of 182 ms, run 91c72d73-2ba5-49e3-bff6-359ea1541783 [C7,#9090]', () => {
  assert.ok(182 < ceilings['list thin'] && ceilings['list thin'] === 200);
});

test('cli.io-commands-read-startup.the-scaled-check-judges-overhead-not-load: clause 2: the scaled check fails a row whose overhead grows while the bare floor stays quiet, and passes a row that only slows with the floor [C7]', () => {
  const row = ceilings['list thin'];
  assert.ok(scaledMedian(row + 20, QUIET_BARE_MS) >= row, 'overhead grew on a quiet floor, so the row fails');
  assert.ok(scaledMedian(row * 2.5, QUIET_BARE_MS * 3) < row, 'a row that only slows with a floor three times slower passes');
  assert.equal(scaledMedian(143.22, 30.66), 143.22, 'a quiet run is judged exactly as measured');
  assert.equal(scaledMedian(143.22, 10), 143.22, 'a floor faster than the quiet one never lowers the median');
});

test('cli.io-commands-read-startup.the-cpu-judge-fails-grown-cpu-not-load: clause 2: a row whose CPU time grows fails on a loaded floor, a row whose wall time alone grows with the floor passes, and a quiet run still fails a wall overrun [C7]', () => {
  const row = ceilings['list thin'];
  const loaded = { bareWall: QUIET_BARE_MS * 2, bareCpu: QUIET_BARE_CPU_MS };
  assert.equal(judgeStartupRow({ ...loaded, wall: row * 5, cpu: row - 20 }, row).ok, true, 'a run whose wall time alone is five times the row passes while its CPU time holds');
  assert.equal(judgeStartupRow({ ...loaded, wall: row * 5, cpu: row + 20 }, row).ok, false, 'CPU time grown past the row fails however loaded the floor is');
  assert.equal(judgeStartupRow({ ...loaded, wall: row * 5, cpu: (row + 20) * 2, bareCpu: QUIET_BARE_CPU_MS * 2 }, row).ok, false, 'CPU time that grew past what the bare CPU floor explains fails');
  assert.equal(judgeStartupRow({ ...loaded, wall: row * 5, cpu: (row - 20) * 2, bareCpu: QUIET_BARE_CPU_MS * 2 }, row).ok, true, 'CPU time that only follows a bare CPU floor twice as slow passes');
  const quiet = { bareWall: QUIET_BARE_MS, bareCpu: QUIET_BARE_CPU_MS };
  assert.equal(judgeStartupRow({ ...quiet, wall: row + 20, cpu: row - 60 }, row).ok, false, 'on a quiet floor the wall time is still held to the row');
  assert.equal(judgeStartupRow({ ...quiet, wall: row - 20, cpu: row - 60 }, row).ok, true);
});
