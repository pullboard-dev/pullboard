/** Additive root commands retain real CLI coverage without weakening the versioned catalog oracle [A1,C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureChildAsync } from '../child.js';

/** Exercise the real economics report and the additive push command's genuine missing-audit refusal. */
export async function exerciseAdditiveRoots({ project, uncataloguedRootJSON, withCatalogChild, coveredRoots }) {
  const box = await project();
  const report = await uncataloguedRootJSON(box, box.repo, 'test-value');
  assert.ok(Array.isArray(report.report.files));
  assert.equal(typeof report.report.method, 'string');
  assert.equal(typeof report.report.since, 'string');
  assert.equal(typeof report.report.asOf, 'string');
  assert.deepEqual(report.report.costs, { costOfEscape: 3600, costOfWaiting: 1, costOfFalseRed: 300 });
  const before = { head: await box.git(box.repo, 'rev-parse', 'HEAD'), status: await box.git(box.repo, 'status', '--porcelain=v1') };
  const hook = join(box.repo, '.git', 'hooks', 'pre-push');
  const hookBefore = existsSync(hook) ? readFileSync(hook) : null;
  const result = await withCatalogChild(() => runFixtureChildAsync(process.execPath,
    [fileURLToPath(new URL('../../../pullboard.js', import.meta.url)), 'push-receipts', '--json'],
    { cwd: box.repo, env: box.env, input: '', encoding: 'utf8' }));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const refused = JSON.parse(result.stdout);
  assert.deepEqual(refused, { version: 1, green: false, commits: [],
    problems: ['the latest native audit lacks complete, source-bound full collection evidence'], activated: false,
    diagnostics: ['the latest native audit lacks complete, source-bound full collection evidence'] });
  assert.equal(result.stderr, '', 'JSON mode retains the exact refusal in diagnostics without mixing stderr into the public document');
  assert.equal(await box.git(box.repo, 'rev-parse', 'HEAD'), before.head);
  assert.equal(await box.git(box.repo, 'status', '--porcelain=v1'), before.status);
  assert.deepEqual(existsSync(hook) ? readFileSync(hook) : null, hookBefore, 'the additive command never activates or replaces the existing hook');
  coveredRoots.add('push-receipts');
  // The read-only gate health report is one document with its gate and landing halves.
  const health = await uncataloguedRootJSON(box, box.repo, 'gate-health');
  assert.deepEqual([typeof health.report, typeof health.landing], ['object', 'object']);
  // A wait key nothing is over budget on answers within budget, with no breach to exit non-zero on.
  const waits = await uncataloguedRootJSON(box, box.repo, 'waits', ['check', 'fixture-wait-key']);
  assert.deepEqual(waits, { version: 1, key: 'fixture-wait-key', over: [] });
  // block, expedite and rulings are additive roots read through real CLI JSON on a board holding two items.
  const ids = [];
  for (const title of ['Block fixture alpha: tighten the parser', 'Block fixture beta: rotate the cache keys']) ids.push((await uncataloguedRootJSON(box, box.repo, 'add', ['coordinator', title, '--specs', 'G1', '--criterion', `${title} is verified`, '--check', 'true'])).item.item_id);
  await uncataloguedRootJSON(box, box.repo, 'block', ['add', 'catalog-block', ...ids.map(String), '--tier', 'mid']);
  assert.deepEqual((await uncataloguedRootJSON(box, box.repo, 'block', ['list'])).blocks.map(block => block.name), ['catalog-block']);
  const expedited = await uncataloguedRootJSON(box, box.repo, 'expedite', [String(ids[0]), '--reason', 'catalog fixture expedite']);
  assert.deepEqual({ id: expedited.id, expedited: expedited.expedited }, { id: ids[0], expedited: true });
  assert.deepEqual((await uncataloguedRootJSON(box, box.repo, 'rulings', ['design-choice'])).rulings, [], 'a board with no answers holds no rulings');
  // shadow-batch composes only accepted items, so a name no item answers to is refused by name and changes nothing.
  const shadow = await withCatalogChild(() => runFixtureChildAsync(process.execPath,
    [fileURLToPath(new URL('../../../pullboard.js', import.meta.url)), 'shadow-batch', '99999', '--json'],
    { cwd: box.repo, env: box.env, input: '', encoding: 'utf8' }));
  assert.equal(shadow.status, 1, shadow.stdout + shadow.stderr);
  assert.equal(JSON.parse(shadow.stdout).error.code, 'NO_SUCH_ITEM');
  assert.equal(await box.git(box.repo, 'rev-parse', 'HEAD'), before.head);
  coveredRoots.add('shadow-batch');
}

/** Exercise immutable patches through actual submitted source and ordinary coordinator CLI authority. */
export async function exercisePatchCommands({ box, json, submitted }) {
  const author = (await json(box, box.repo, 'whoami')).id;
  const initial = await json(box, box.repo, 'patch', ['list', '1']);
  assert.deepEqual(initial.patches, []);
  assert.equal(initial.digest, null);
  const patch = ['diff --git a/app/catalog-patch.js b/app/catalog-patch.js',
    'new file mode 100644', 'index 0000000..e69de29', '--- /dev/null',
    '+++ b/app/catalog-patch.js', '@@ -0,0 +1 @@', '+export const catalogPatch = true;', ''].join('\n');
  const file = join(box.dir, 'catalog.patch');
  writeFileSync(file, patch);
  const attached = await json(box, box.repo, 'patch', ['attach', '1', file,
    '--key', 'catalog-patch', '--author', author, '--source', submitted.commit], 'attach');
  assert.equal(attached.item, 1);
  assert.equal(attached.changed, true);
  const listed = await json(box, box.repo, 'patch', ['list', '1'], 'list');
  assert.equal(listed.digest, attached.digest);
  assert.equal(listed.patches.length, 1);
  assert.equal(listed.patches[0].commit, submitted.commit);
  assert.equal(listed.patches[0].author.agentId, author);
  assert.equal(listed.patches[0].patch, patch);
  assert.equal(listed.patches[0].digest, createHash('sha256').update(patch).digest('hex'));
  const removed = await json(box, box.repo, 'patch', ['remove', '1', 'catalog-patch'], 'remove');
  assert.equal(removed.changed, true);
  assert.notEqual(removed.digest, null, 'removed patches retain immutable native history');
  const empty = await json(box, box.repo, 'patch', ['list', '1'], 'list');
  assert.deepEqual(empty.patches, []);
  assert.equal(empty.digest, removed.digest);
}
