/** @pullboard-test-input apps/cli/tests/fixtures/budget.js apps/cli/src/io/commands/list.js apps/cli/src/io/list/thin.js */
/** @pullboard-world-pin the diagnostic copies the committed CLI and restores only the two measured files from the exact current-main pin. */
/** One native runner measures full JSON list before/after and separately records actual remaining read costs [C7,#12932]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';

const SOURCE = resolve(import.meta.dirname, '../../../../../..');
const BASE = '7baa0aa1591cea0788d28b798c15fbb01f85f158';
const CUT = ['apps/cli/src/io/commands/list.js', 'apps/cli/src/io/list/thin.js'];

test('cli.io-list-thin-profile.native-pair-and-read-costs: clause 2: record actual full JSON list CPU samples and separate read costs without changing the native budget judge [C7,#12932]', async t => {
  const files = privateFixtureFiles('list-read-costs-12932-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: SOURCE });
  assert.equal(runFixtureGit(['rev-parse', `${BASE}^{commit}`], { cwd: SOURCE }), BASE);
  const reports = {};
  for (const variant of ['before', 'after', 'profile']) {
    const source = join(files.root, variant);
    mkdirSync(source);
    for (const path of ['apps', 'packages', 'package.json']) cpSync(join(SOURCE, path), join(source, path), { recursive: true });
    if (variant === 'before') for (const path of CUT) {
      const body = `${runFixtureGit(['show', `${BASE}:${path}`], { cwd: SOURCE })}\n`;
      assert.equal(runFixtureGit(['hash-object', '--stdin'], { cwd: SOURCE, input: body }), runFixtureGit(['rev-parse', `${BASE}:${path}`], { cwd: SOURCE }), 'restored producer bytes match the exact base blob');
      writeFileSync(join(source, path), body);
    }
    const profileFile = join(files.root, 'reads.json');
    if (variant === 'profile') {
      const entry = join(source, 'apps/cli/pullboard.js');
      renameSync(entry, join(source, 'apps/cli/profile-original.js'));
      const marker = join(files.root, 'profile-once');
      writeFileSync(entry, `import { existsSync } from 'node:fs';\nimport { writeFileSync } from 'node:fs';\nconst first = !existsSync(${JSON.stringify(marker)});\nif (first) writeFileSync(${JSON.stringify(marker)}, 'profile first child');\nconst finish = first ? await (await import('./tests/fixtures/list-read-profile.js')).startListReadProfile(${JSON.stringify(profileFile)}) : null;\ntry { await import('./profile-original.js'); } finally { if (finish) await finish(); }\n`);
    }
    // Import the unchanged helper FROM each copied tree: it resolves its own actual CLI entry. No unsupported entry option.
    const { assertStartupBudgets, judgeStartupRow } = await import(pathToFileURL(join(source, 'apps/cli/tests/fixtures/budget.js')).href);
    const report = {};
    t.diagnostic(JSON.stringify({ variant, executionHead: head, base: BASE, source, changedProductionFiles: CUT }));
    await assertStartupBudgets(t, report, { only: ['list thin'] });
    assert.deepEqual(Object.keys(report.cpuSamplesMs), ['list thin']);
    reports[variant] = {
      cpuSamplesMs: report.cpuSamplesMs['list thin'], bareNodeCpuMs: report.bareNodeCpuMs,
      wallSamplesMs: report.samplesMs['list thin'], bareNodeMs: report.bareNodeMs,
      verdict150: judgeStartupRow({ wall: report.mediansMs['list thin'], cpu: report.cpuMediansMs['list thin'], bareWall: report.bareNodeMedianMs, bareCpu: report.bareNodeCpuMedianMs }, 150),
    };
    if (variant === 'profile') {
      assert.ok(existsSync(profileFile), 'the actual first CLI child recorded its profile');
      const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
      assert.ok(profile.reads.some(row => row.operation === 'all' && /FROM item\b/iu.test(row.sql)), 'real item SQL reads were observed');
      t.diagnostic(JSON.stringify({ actualReadProfile: profile, executionHead: head }));
    }
  }
  t.diagnostic(JSON.stringify({ nativeJsonListPair: { before: reports.before, after: reports.after }, diagnosticOnly: reports.profile, executionHead: head, base: BASE }));
});
