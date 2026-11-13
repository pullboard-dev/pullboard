/** Cockpit search row ages read from one captured commit [N26] */
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  shellWord,
  writeSpec,
} from './search-fixture.js';

/** Commit between actual Git reads, preserving each real command's output and exit status. */
function interleavedAges(file, when) {
  const box = machine();
  const g3 = '- G3 [approved, must] The greeting names the visitor. | gate: web test\n';
  const g4 = '- G4 [approved, must] The greeting waves back. | gate: web test\n';
  const g5 = '- G5 [approved, must] The greeting fits a phone. | gate: web test\n';
  const r1 = '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n';
  const r2 = '- R2 [approved, must] A greeting never shouts. | gate: review\n';
  const alpha = project(box, 'pinned-ages', SPEC + g3, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), r1);
  writeSpec(alpha.repo, SPEC + g3 + g4);
  box.git(alpha.repo, 'add', 'ways.md', 'SPEC.md');
  box.git(alpha.repo, 'commit', '-q', '-m', 'docs(spec): add the second greeting [G1]');
  const specTarget = file === 'SPEC.md';
  if (specTarget) writeFileSync(join(alpha.repo, 'ways.md'), r1 + r2);
  else writeSpec(alpha.repo, SPEC + g5 + g3 + g4);
  box.git(alpha.repo, 'commit', '-q', '-am', 'docs(spec): add the next greeting [G1]');
  const captured = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const future = join(box.dir, 'next-row.txt'), receipt = join(box.dir, 'interleave.json');
  writeFileSync(future, specTarget ? SPEC + g5 + g3 + g4 : r1 + r2);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const wrapper = join(box.dir, 'bin', 'git');
  const program = join(box.dir, 'bin', 'git-wrapper.mjs');
  writeFileSync(program, `
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
const args = process.argv.slice(2), file = ${JSON.stringify(file)}, receipt = ${JSON.stringify(receipt)};
const realGit = ${JSON.stringify(realGit)};
/** Run the real Git command with unchanged arguments and environment. */
const run = (words) => spawnSync(realGit, words, { encoding: 'utf8', env: process.env });
const interleave = args[0] === 'log' && args.includes('--format=%H') && args.at(-1) === file && !existsSync(receipt);
let before, after, result;
/** Add the prepared real row in a real commit, without changing any command response. */
function advance() {
  writeFileSync(file, readFileSync(${JSON.stringify(future)}));
  for (const words of [['add', file], ['commit', '-q', '-m', 'docs(spec): interleave a greeting [G1]']]) {
    const step = run(words);
    if (step.status !== 0) throw new Error(step.stderr);
  }
  after = run(['rev-parse', 'HEAD']).stdout.trim();
}
if (interleave) {
  before = run(['rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(receipt, '{}');
  if (${JSON.stringify(when)} === 'before') advance();
  result = run(args);
  if (${JSON.stringify(when)} === 'after') advance();
  writeFileSync(receipt, JSON.stringify({ args, before, after, status: result.status, stdout: result.stdout }));
} else result = run(args);
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exitCode = result.status ?? 1;
`);
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(program)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  // Both tabs may read the on-disk row before its commit lands between their history reads.
  writeFileSync(join(alpha.repo, file), readFileSync(future));
  const worker = spawnSync(process.execPath, ['--input-type=module', '-e', `import { projectState } from ${JSON.stringify(new URL('../../../src/io/view.js', import.meta.url).href)}; console.log(JSON.stringify(projectState(${JSON.stringify(alpha.repo)})));`], { cwd: alpha.repo, env: box.env, encoding: 'utf8' });
  assert.equal(worker.status, 0, `real projectState child: ${worker.stderr}`);
  const state = JSON.parse(worker.stdout), observed = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const proof = JSON.parse(readFileSync(receipt, 'utf8'));
  const ordinals = { spec: state.spec.map(({ id, added }) => ({ id, added })), doctrine: state.practice.map(({ id, added }) => ({ id, added })) };
  return { state, captured, observed, proof, ordinals };
}

/** Pin every age read despite a real commit before or after either file's ordinal log. */
test('row ages read from one captured commit [N26]', () => {
  for (const file of ['SPEC.md', 'ways.md']) for (const when of ['after', 'before']) {
    const { state, captured, observed, proof, ordinals } = interleavedAges(file, when);
    const diagnostic = JSON.stringify({ file, when, ordinals, captured, observed, computedAt: state.rowAgesAt ?? null, proof });
    assert.notEqual(observed, captured, diagnostic);
    assert.equal(proof.before, captured, diagnostic);
    assert.equal(proof.after, observed, diagnostic);
    assert.equal(proof.status, 0, diagnostic);
    /** Keep only the deliberate fixture rows, in the same age order as search results. */
    const ordered = (rows, ids) => rows.filter((row) => ids.includes(row.id)).sort((a, b) => a.added - b.added).map(({ id, added }) => [id, added]);
    const spec = ordered(state.spec, ['G3', 'G4', 'G5']), doctrine = ordered(state.practice, ['R1', 'R2']);
    assert.deepEqual(spec.map(([id]) => id), ['G5', 'G4', 'G3'], diagnostic);
    assert.deepEqual(doctrine.map(([id]) => id), ['R2', 'R1'], diagnostic);
    assert.deepEqual(spec, file === 'SPEC.md' ? [['G5', 0], ['G4', 1], ['G3', 2]] : [['G5', 1], ['G4', 2], ['G3', 3]], diagnostic);
    assert.deepEqual(doctrine, file === 'SPEC.md' ? [['R2', 1], ['R1', 2]] : [['R2', 0], ['R1', 1]], diagnostic);
    assert.deepEqual(state.rowAgesAt, { 'SPEC.md': captured, 'ways.md': captured }, diagnostic);
  }
});
