/** @pullboard-test-input apps/cli/tests/fixtures/budget.js apps/cli/src/io/commands/list.js apps/cli/src/io/list/thin.js */
/** @pullboard-world-pin compares the committed producer blobs with current main in private copies of the real CLI. */
/** One native runner pairs complete cold JSON list reads without changing their fixture, CPU reporter or judge [C7,#12932]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';

const SOURCE = resolve(import.meta.dirname, '../../../../../..');
const BASE = '453396a09bb1fc3facff222b63b64c9c71a9b1e6';
const ORIGINAL = '6292081e33b8ddc4ca7b531a753f698cf6a936fd';
const CUT = ['apps/cli/src/io/commands/list.js', 'apps/cli/src/io/list/thin.js'];
const HELPER = 'apps/cli/tests/fixtures/budget.js';

test('cli.io-list-thin-pair.native-json-pair: clause 2: one native runner records all full JSON list CPU samples at current-main and candidate producer sources with the unchanged 150 ms judge [C7,#12932]', async t => {
  const files = privateFixtureFiles('list-native-pair-12932-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: SOURCE });
  const blob = (revision, path) => runFixtureGit(['rev-parse', `${revision}:${path}`], { cwd: SOURCE });
  assert.equal(blob(BASE, HELPER), blob(head, HELPER), 'the existing fixture and judge are unchanged');
  const reports = {};
  let candidateError;
  for (const variant of ['before', 'after']) {
    const source = join(files.root, variant);
    mkdirSync(source);
    for (const path of ['apps', 'packages', 'package.json']) cpSync(join(SOURCE, path), join(source, path), { recursive: true });
    if (variant === 'before') for (const path of CUT) {
      const body = `${runFixtureGit(['show', `${BASE}:${path}`], { cwd: SOURCE })}\n`;
      assert.equal(runFixtureGit(['hash-object', '--stdin'], { cwd: SOURCE, input: body }), blob(BASE, path));
      writeFileSync(join(source, path), body);
    }
    const { assertStartupBudgets, judgeStartupRow } = await import(pathToFileURL(join(source, HELPER)).href);
    const report = {};
    let failure = null;
    try { await assertStartupBudgets(t, report, { only: ['list thin'] }); }
    catch (error) {
      // A measured baseline red is evidence, not a reason to omit the candidate's samples. Other fixture failures still stop.
      if (error.code !== 'ERR_ASSERTION' || !report.cpuSamplesMs || !String(error.message).includes('exceeds its 150 ms row')) throw error;
      failure = error.message;
      if (variant === 'after') candidateError = error;
    }
    assert.deepEqual(Object.keys(report.cpuSamplesMs), ['list thin']);
    reports[variant] = {
      cpuSamplesMs: report.cpuSamplesMs['list thin'], bareNodeCpuMs: report.bareNodeCpuMs,
      wallSamplesMs: report.samplesMs['list thin'], bareNodeMs: report.bareNodeMs,
      population: report.population, fixture: blob(head, HELPER), failure,
      verdict150: judgeStartupRow({ wall: report.mediansMs['list thin'], cpu: report.cpuMediansMs['list thin'],
        bareWall: report.bareNodeMedianMs, bareCpu: report.bareNodeCpuMedianMs }, 150),
    };
  }
  t.diagnostic(JSON.stringify({ nativeJsonListPair: reports, executionHead: head, base: BASE, originalParent: ORIGINAL,
    producerBlobs: CUT.map(path => ({ path, original: blob(ORIGINAL, path), before: blob(BASE, path), after: blob(head, path) })) }));
  if (candidateError) throw candidateError;
});
