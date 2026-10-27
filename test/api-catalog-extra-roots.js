/** Additive root commands retain real CLI coverage without weakening the versioned catalog oracle [A1,C7]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureChildAsync } from './fixture-child.js';

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
    [fileURLToPath(new URL('../bin/pullboard.js', import.meta.url)), 'push-receipts', '--json'],
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
}
