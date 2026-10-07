/**
 * The harness every proof audit shares. It copies the repo's tracked folders to a fresh temporary
 * folder and works only there, so it never changes a real checkout. It checks that each named test
 * is green on the unchanged copy, since a red that was already there proves nothing. Then it makes
 * each change in turn and runs the test that should judge it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const COPIED = ['src', 'bin', 'test', 'skills', 'docs', 'package.json', 'PRACTICE.md', 'README.md'];

/**
 * Run an audit and print one line per change. Sets the exit code to 1 if any change comes out other
 * than expected.
 *
 * @param {[string, string, [string, string, string][], [string, string], 'red' | 'green'][]} mutants
 *   Each one: the row, the change in words, its edits as [file, from, to], the test that judges it as
 *   [file, a unique part of its title], and the outcome expected.
 */
export function audit(mutants) {
  const copy = mkdtempSync(join(tmpdir(), 'pullboard-proof-'));
  try {
    for (const entry of COPIED) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    /**
     * Run one test by name in the copy: whether it passed, and how many tests the name matched. When
     * no test matches, Node reports the file itself as one passing test, so only results whose
     * title holds the name count.
     */
    const judge = ([file, name]) => {
      const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', `--test-name-pattern=${name}`, file], { cwd: copy, encoding: 'utf8', timeout: 300_000 });
      const titles = [...(result.stdout ?? '').matchAll(/^(?:not )?ok \d+ - (.*)$/gm)].map((match) => match[1]);
      return { green: result.status === 0, matched: titles.filter((title) => title.includes(name)).length };
    };
    const targets = [...new Set(mutants.map(([, , , target]) => JSON.stringify(target)))].map((target) => JSON.parse(target));
    const unready = targets.filter((target) => {
      const { green, matched } = judge(target);
      return !green || matched !== 1;
    });
    if (unready.length) throw new Error(`not green on the unchanged copy, or not exactly one test: ${unready.map(([file, name]) => `${file}: ${name}`).join('; ')}`);
    let unexpected = 0;
    for (const [row, change, edits, target, expected] of mutants) {
      const before = new Map(edits.map(([file]) => [file, readFileSync(join(copy, file), 'utf8')]));
      const after = new Map(before);
      for (const [file, from, to] of edits) {
        if (!after.get(file).includes(from)) throw new Error(`${row}: the code to change is gone from ${file}; update this audit`);
        after.set(file, after.get(file).replace(from, to));
      }
      for (const [file, text] of after) writeFileSync(join(copy, file), text);
      const { green } = judge(target);
      for (const [file, text] of before) writeFileSync(join(copy, file), text);
      const outcome = green ? 'green' : 'red';
      if (outcome !== expected) unexpected += 1;
      console.log(`${outcome === expected ? 'ok        ' : 'UNEXPECTED'} ${row} ${outcome.padEnd(5)} ${change}  (${target[1]})`);
    }
    console.log(`${mutants.length} changes, ${unexpected} unexpected; the unchanged copy is green on all ${targets.length} targets`);
    process.exitCode = unexpected ? 1 : 0;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
