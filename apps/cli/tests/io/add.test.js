/** @pullboard-test-input apps/cli/src/io/add.js apps/cli/tests/fixtures/next/take.js apps/cli/tests/fixtures/e2e.js apps/cli/tests/fixtures/testkit.js apps/cli/tests/fixtures/runner/ssh.js */
/** With laneMode off, pullboard add and edit accept a brief naming files outside the item's lane folders; with it on, add still refuses BRIEF_LANE [C7,#10843]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { claimJob } from '../../../../packages/api/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { openJob } from '../../../../packages/api/index.js';
import { queueFor } from '../../../../packages/api/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { cli } from '../fixtures/next/take.js';
import { fixture } from '../fixtures/next/take.js';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { fixtureAdd } from '../fixtures/testkit.js';
import { HOST } from '../fixtures/runner/ssh.js';
import { installSshStandIn } from '../fixtures/runner/ssh.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A web-lane brief whose Files section names a file in the docs lane's folder. */
const FOREIGN = 'Files:\n- docs/x.js\nTest: the docs page renders\n';

/** File one web-lane item from the main checkout through the real CLI main(), as a customer's coordinator does. */
function add(box, brief) {
  return cli(box, box.root, ['add', 'web', 'Docs page', '--specs', 'G1', '--route', 'mid', '--criterion', 'the docs page renders', '--check', 'false', '--brief', brief]);
}

test('cli.io-add.lanes-off-foreign-brief: clause 1: with laneMode off, pullboard add files a web-lane item whose brief names docs/x.js [C7,#10843]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const added = await add(box, FOREIGN);
  assert.equal(added.code, 0, added.out + added.err);
  const id = added.document.item.item_id;
  assert.match(store.getItem(box.board, id).item_brief, /docs\/x\.js/u);
});

test('cli.io-add.lanes-on-refused: clause 2: with laneMode on, the same add is refused BRIEF_LANE naming docs/x.js [C7,#10843]', async t => {
  const box = await fixture(t);
  const added = await add(box, FOREIGN);
  assert.equal(added.code, 1, added.out + added.err);
  const { error } = added.document;
  assert.equal(error.code, 'BRIEF_LANE', added.out);
  assert.match(error.message, /docs\/x\.js/u);
});

test('cli.io-add.lanes-off-edit-brief: clause 3: with laneMode off, pullboard edit --brief accepts a brief naming docs/x.js on a web-lane item [C7,#10843]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const added = await add(box, 'Files:\n- web/x.js\nTest: the web page renders\n');
  assert.equal(added.code, 0, added.out + added.err);
  const id = added.document.item.item_id;
  const edited = await cli(box, box.root, ['edit', String(id), '--brief', FOREIGN]);
  assert.equal(edited.code, 0, edited.out + edited.err);
  assert.match(store.getItem(box.board, id).item_brief, /docs\/x\.js/u);
});

test('cli.io-add.ssh-runner-baseline-measured: clause 1: with an ssh-registered runner and no runner serve, a waited add measures its check baseline red at main instead of waiting on a job no runner pulls [C7,#10844]', async () => {
  const box = e2e.project();
  const bin = join(box.dir, 'runner-bin'), worker = join(box.dir, 'runner-worker'), home = join(box.dir, 'runner-home');
  for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests: join(box.dir, 'runner-requests.jsonl') });
  const registered = await box.runLocal(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '1');
  assert.equal(registered.code, 0, registered.err || registered.out);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['gate.loadAwareDispatch', 'off'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const configured = await box.runLocal(box.repo, 'settings', key, value);
    assert.equal(configured.code, 0, configured.err || configured.out);
  }
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Copy', 'the', 'header', '--route', 'mid', '--criterion', 'the page shows the header', '--check', 'test -f web/page.js', '--brief', 'Files:\n- web/page.js\nTest: the page shows the header\n', '--wait');
  assert.equal(added.code, 0, added.err || added.out);
  assert.match(added.out, new RegExp(`check baseline red at main ${box.git(box.repo, 'rev-parse', 'main')}: test -f web/page.js`, 'u'));
  assert.doesNotMatch(added.out, /running in the background/u);
});

test('cli.io-add.served-runner-baseline-queued: clause 2: with a runner serve claim on the board queue, the add leaves its baseline an open check-baseline runner job and starts no worker [C7,#10844]', async t => {
  const box = await fixture(t);
  const settings = machineSettingsFile();
  writeFileSync(settings, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, runners: [{ host: 'mini.local', slots: 2, browser: 0 }] }));
  const queue = queueFor(box.board, 'coordinator');
  offerJob(box.board.db, { id: 'serve-probe', kind: 'probe', needs: ['node22'], run: ['true'] }, queue);
  assert.ok(claimJob(queue ? queue.runs.db : box.board.db, { runner: 'mini.local', capabilities: ['node22'] }), 'a serve claims a job from this board');
  const added = await cli(box, box.root, ['add', 'web', 'Docs page', '--specs', 'G1', '--route', 'mid', '--criterion', 'the docs page renders', '--check', 'false', '--brief', 'Files:\n- web/x.js\nTest: the web page renders\n']);
  assert.equal(added.code, 0, added.out + added.err);
  const item = added.document.item;
  assert.equal(store.getItem(box.board, item.item_id).item_check_baseline.result, 'pending');
  const job = openJob(queue ? queue.runs.db : box.board.db, { kind: 'check-baseline', item: item.item_id, candidate: item.item_check_baseline.main });
  assert.ok(job, 'the baseline waits on the board queue as a runner job, so no detached worker took it');
});
