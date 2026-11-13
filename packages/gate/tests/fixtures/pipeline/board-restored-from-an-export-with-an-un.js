/**
 * A board restored from an export with an undeclared status [C7]: the import refuses before it inserts anything.
 * The invariant: an export whose item row carries a status the lifecycle never declared is refused UNDECLARED_STATE,
 * and the target board is left exactly as it was (no item, no event from the file); the same export unchanged restores.
 * Why a harness: the restore suspends the board's own lifecycle triggers while it inserts, so only the import's own
 * check can stop a forged status (SM15).
 * Run alone with `node packages/gate/tests/fixtures/pipeline/board-restored-from-an-export-with-an-un.js`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ROOT,
  from,
  guardProcesses,
  hopCheck,
  track,
} from './kit.js';

const { machine, project, SPEC } = await from('apps/cli/tests/fixtures/cockpit/machine.js');
const { fileFixtureItem } = await from('apps/cli/tests/fixtures/testkit.js');

guardProcesses();

test('an export carrying an undeclared item status is refused UNDECLARED_STATE before it inserts [C7]', { timeout: 240_000 }, async () => {
  await hopCheck('import-undeclared', async () => {
    const started = Date.now();
    const box = machine();
    track(box.dir);
    const source = project(box, 'import-source');
    fileFixtureItem(box, source.repo, { lane: 'web', title: 'An import harness item', check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
      run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
    const cli = (cwd, ...args) => spawnSync(process.execPath, [`${ROOT}/apps/cli/pullboard.js`, ...args], { cwd, env: box.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const exported = cli(source.repo, 'export');
    assert.equal(exported.status, 0, exported.stderr);
    const good = JSON.parse(exported.stdout);
    assert.ok(good.tables.item.length > 0, 'the export carries the item');
    const forged = structuredClone(good);
    forged.tables.item[0].item_status = 'shipped';
    const goodFile = join(box.dir, 'good-export.json'), forgedFile = join(box.dir, 'forged-export.json');
    writeFileSync(goodFile, JSON.stringify(good));
    writeFileSync(forgedFile, JSON.stringify(forged));
    // A fresh board refuses the forged status and keeps its initial shape.
    const target = project(box, 'import-target', SPEC, {}, { joinSeat: false });
    const before = cli(target.repo, 'export').stdout;
    const refused = cli(target.repo, 'import', forgedFile);
    assert.notEqual(refused.status, 0, 'the forged export is refused');
    assert.match(refused.stdout + refused.stderr, /UNDECLARED_STATE/u);
    assert.equal(cli(target.repo, 'export').stdout, before, 'nothing of the forged file was inserted');
    // The same export unchanged restores into a fresh board, so the refusal is about the status alone.
    const clean = project(box, 'import-clean', SPEC, {}, { joinSeat: false });
    const restored = cli(clean.repo, 'import', goodFile);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.equal(JSON.parse(cli(clean.repo, 'export').stdout).tables.item[0].item_status, good.tables.item[0].item_status, 'the declared status restores as written');
    return { ms: Date.now() - started, measured: 'status "shipped" refused UNDECLARED_STATE with the target board unchanged; the unchanged export restored' };
  });
});
