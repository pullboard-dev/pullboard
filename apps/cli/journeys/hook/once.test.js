/**
 * Pre-commit reads git once per commit, not once per out-of-lane file (#2232): a 300-file commit
 * is checked in seconds, refuses exactly the paths it refused before, and runs one staged diff.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('a 300-file out-of-lane commit is refused for exactly those paths, with git called a fixed number of times and one staged diff [L3]', () => {
  const box = e2e.project('true');
  const { web } = box;
  mkdirSync(join(web, 'api'), { recursive: true });
  for (let i = 0; i < 300; i++) writeFileSync(join(web, 'api', `f${i}.js`), `export const v${i} = ${i};\n`);
  box.git(web, 'add', '-A');
  const trace = join(box.dir, 'trace.log');
  const started = performance.now();
  box.env.GIT_TRACE = trace;
  const result = box.run(web, 'hook', 'pre-commit');
  delete box.env.GIT_TRACE;
  const seconds = (performance.now() - started) / 1000;
  const out = `${result.out ?? ''}${result.err ?? ''}`;
  assert.notEqual(result.code, 0, 'out-of-lane files are still refused');
  const refused = new Set([...out.matchAll(/api\/f(\d+)\.js/g)].map(match => match[1]));
  assert.equal(refused.size, 300, 'every foreign path is still named');
  let traced = '';
  try { traced = readFileSync(trace, 'utf8'); } catch { /* no trace file */ }
  // Git versions may emit extra executable-path diagnostics per invocation; count only command records.
  const commands = traced.split('\n').filter(line => /trace: (?:built-in|exec): git(?: |$)/u.test(line));
  const diffs = commands.filter(line => /git.* diff .*--cached/.test(line) && !/--name-status/.test(line));
  assert.equal(diffs.length, 1, 'one staged diff per commit');
  const calls = commands.length;
  // Bound: the hook costs about 27 git calls on any commit (spec-file shows, repo probes, one diff, batched
  // ls-tree/ls-files/cat-file). 40 leaves headroom for new probes and sits far below the 900+ the per-file path
  // ran, so a per-file regression fails it. The ruling on #2232 proves the time bar by this bound, not a clock.
  assert.ok(calls <= 40, `git ran ${calls} times for 300 files; the old path ran several per file`);
  console.log(`# precommit-seconds ${seconds.toFixed(2)} diffs ${diffs.length} gitcalls ${calls}`);
});
