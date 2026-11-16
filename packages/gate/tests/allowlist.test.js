/** One root allowlist: allowed root paths are not strays, a new stray is refused with where it belongs, and today's strays only shrink [C7,R44]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellLintBaseline } from '../../codemap/index.js';
import { cellLintGrowth } from '../../codemap/index.js';
import { cellLintReport } from '../../codemap/index.js';
import { lowerCellLintBaseline } from '../../codemap/index.js';
import { rootAllowed } from '../../codemap/light.js';
import { strayNextStep } from '../../codemap/light.js';
import { commonJsIn } from '../index.js';
import { importsIn } from '../index.js';
import { runFixtureGit } from './fixtures/child.js';

/** A private repository with one app, one package and today's kinds of root strays. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-root-allowlist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  /** Write one private file beneath this fixture and stage it: the cell lint inventory lists staged files only. */
  const put = (file, source) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); runFixtureGit(['add', '--', file], { cwd: root }); };
  /** Remove one private file. */
  const remove = file => { rmSync(join(root, file), { force: true }); runFixtureGit(['rm', '-q', '--cached', '--ignore-unmatch', '--', file], { cwd: root }); };
  put('package.json', JSON.stringify({ type: 'module', imports: { '#*': './packages/*/index.js' } }));
  put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n");
  put('packages/sample/index.js', 'export const value = 1;\n');
  put('bin/old-tool.js', 'void 0;\n');
  put('test/old.test.js', 'void 0;\n');
  /** The report's stray findings, by path. */
  const strays = () => new Map(cellLintReport(root, { importsIn, commonJsIn }).metrics.strays.findings.map(row => [row.key, row.detail]));
  return { root, put, remove, strays, report: () => cellLintReport(root, { importsIn, commonJsIn }) };
}

test('allowed root files and folders are not strays [C7,R44]', t => {
  const box = fixture(t);
  for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.md', 'pullboard.json', '.githooks/pre-commit', 'docs/guide.md', '.github/workflows/ci.yml']) {
    box.put(file, 'allowed\n');
    assert.ok(rootAllowed(file), `${file} is on the root allowlist`);
  }
  const strays = box.strays();
  for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.md', 'pullboard.json', '.githooks/pre-commit', 'docs/guide.md', '.github/workflows/ci.yml']) {
    assert.ok(!strays.has(file), `${file} is not a stray`);
  }
});

test('a new stray is refused against the baseline, and its finding says where it belongs [C7,R44]', t => {
  const box = fixture(t);
  const baseline = cellLintBaseline(box.report());
  box.put('relay/worker.js', 'void 0;\n');
  box.put('bin/new-tool.js', 'void 0;\n');
  const growth = cellLintGrowth(box.report(), baseline).filter(row => row.metric === 'strays');
  assert.deepEqual(growth.map(row => row.key).filter(key => key !== '(total)').sort(), ['bin/new-tool.js', 'relay/worker.js']);
  const strays = box.strays();
  assert.match(strays.get('relay/worker.js'), /next: move relay\/worker\.js under apps\/<app>\/ or packages\/<cell>\//u);
  assert.match(strays.get('bin/new-tool.js'), /next: put bin\/new-tool\.js's code in packages\/<cell>\/src\/io\/ or apps\/<app>\//u);
  assert.match(strayNextStep('test/new.test.js'), /packages\/<cell>\/tests\//u);
});

test('today\'s strays are a baseline that only shrinks: removing one lowers it, and adding it back is refused [C7,R44]', t => {
  const box = fixture(t);
  const baseline = cellLintBaseline(box.report());
  assert.ok(baseline.metrics.strays.allowances['bin/old-tool.js'] && baseline.metrics.strays.allowances['test/old.test.js']);
  box.remove('test/old.test.js');
  assert.deepEqual(cellLintGrowth(box.report(), baseline), [], 'a smaller stray set never fails');
  const lowered = lowerCellLintBaseline(box.report(), baseline);
  assert.equal(lowered.metrics.strays.allowances['test/old.test.js'], undefined);
  assert.equal(lowered.metrics.strays.count, baseline.metrics.strays.count - 1);
  box.put('test/old.test.js', 'void 0;\n');
  assert.ok(cellLintGrowth(box.report(), lowered).some(row => row.metric === 'strays' && row.key === 'test/old.test.js'), 'a removed stray cannot come back');
});
