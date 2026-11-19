/** Submit on a clean committed item returns in under 5 seconds with the queued gate id; the queued gate id is printed and next --wait is never advised [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

/** Claim item 1, commit one file in its folder, then move main on so a submit that merged main would have to rewrite the source. */
async function readySubmit(t) {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.equal((await box.helpers.commitFile(box, folder, `web/${id}.txt`, `gate ${id}\n`, `feat(web): fast submit ${id} [G1]`)).status, 0);
  assert.equal((await box.helpers.commitFile(box, box.repo, 'web/newer-main.txt', 'newer\n', 'feat(web): main moved on [G1]')).status, 0);
  return { box, id, folder, claim: claimed };
}

test('cli.journeys-submit-fast.submit-on-a-clean-committed-item: clause 1: submit on a clean committed item returns within 5 seconds and prints the queued gate id [C7]', async t => {
  const { box, id, folder } = await readySubmit(t);
  const start = Date.now();
  const submitted = await box.runLocal(folder, 'submit', String(id));
  const elapsed = Date.now() - start;
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  assert.ok(elapsed < 5000, `submit took ${elapsed} ms\n${submitted.err}`); // budget: declared bar of item 2966, 5 s for submit to return.
  const { board } = await pullQueue(t, box);
  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  assert.equal(row.step, 'offered');
  const named = /job (gate:[^\s:]+:[^\s:]+:[^\s:]+)/u.exec(submitted.out)?.[1];
  assert.ok(named && row.id === named, `the output names the queued gate id ${named} of job ${row.id}`);
});

test('cli.journeys-submit-fast.join-submit-and-claim-never-print: clause 3: join, submit and claim never print next --wait as the next step [C7]', async t => {
  const { box, id, folder, claim } = await readySubmit(t);
  const submitted = await box.runLocal(folder, 'submit', String(id));
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  assert.doesNotMatch(submitted.out, /next --wait/u);
  assert.doesNotMatch(claim.out + claim.err, /next --wait/u);
  const joined = await joinFixtureSeat(box, box.repo, 'web', { run: box.runLocal });
  assert.doesNotMatch(joined.out + joined.err, /next --wait/u);
});

test('cli.journeys-submit-fast.submit-leaves-the-builder-checkout-index: clause 2: submit leaves the builder checkout, index and HEAD where they were and runs no merge hook [C7]', async t => {
  const { box, id, folder } = await readySubmit(t);
  const git = (...args) => runFixtureGit(args, { cwd: folder, env: box.env }).trim();
  const inputs = privateFixtureFiles('pullboard-fast-hooks-');
  const hooks = inputs.root;
  t.after(() => rmSync(hooks, { recursive: true, force: true }));
  const ran = join(hooks, 'ran');
  for (const name of ['pre-merge-commit', 'post-merge', 'post-checkout']) {
    inputs.write(name, `#!/bin/sh\necho ${name} >> '${ran}'\n`);
    chmodSync(join(hooks, name), 0o755);
  }
  git('config', 'core.hooksPath', hooks);
  const before = { head: git('rev-parse', 'HEAD'), index: git('write-tree'), status: git('status', '--porcelain', '--untracked-files=all') };
  const submitted = await box.runLocal(folder, 'submit', String(id));
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  assert.equal(git('rev-parse', 'HEAD'), before.head, 'HEAD did not move');
  assert.equal(git('write-tree'), before.index, 'the index did not change');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), before.status, 'the checkout did not change');
  assert.equal(existsSync(ran), false, 'no merge or checkout hook ran');
});
