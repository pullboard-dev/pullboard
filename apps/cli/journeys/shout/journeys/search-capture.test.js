// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit search row ages and spaced Node [N26] */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  searchFor,
  allowLiveHold,
  holdLive,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  makeProfile,
  shellWord,
} from './search-fixture.js';

/** Wait for committed row order, rather than rows that may already be visible as uncommitted edits. */
async function committedRows(chrome, head) {
  await chrome.waitFor(`data?.project?.rowAgesAt?.['SPEC.md'] === ${JSON.stringify(head)} && data.project.rowAgesAt['ways.md'] === ${JSON.stringify(head)}`, 15_000); // budget: hang ceiling for the committed row-age snapshot to arrive; no throughput claim.
}

/**
 * Read the board until both files' row ages name `head`. A view read answers the ages it already has and a worker
 * thread refreshes them for HEAD off the request path (#3887), so a later real read carries them.
 */
async function readAgesAt(chrome, head) {
  await chrome.waitFor(`refresh().then(() => data?.project?.rowAgesAt?.['SPEC.md'] === ${JSON.stringify(head)} && data.project.rowAgesAt['ways.md'] === ${JSON.stringify(head)})`, 15_000); // budget: hang ceiling for the row-age worker to finish; no throughput claim.
}

/** Observe the old and refreshed captures around real commits without replacing any Git or HTTP response. */
test('spec rows keep newest-first order across a capture that moves [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the moving-capture proof');
  const box = machine();
  const g3 = '- G3 [approved, must] The greeting names the visitor. | gate: web test\n';
  const g4 = '- G4 [approved, must] The greeting waves back. | gate: web test\n';
  const g5 = '- G5 [approved, must] The greeting fits a phone. | gate: web test\n';
  const r1 = '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n';
  const r2 = '- R2 [approved, must] A greeting never shouts. | gate: review\n';
  const alpha = project(box, 'moving-capture', SPEC + g3, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), r1);
  box.git(alpha.repo, 'add', 'ways.md');
  box.git(alpha.repo, 'commit', '-q', '-m', 'docs(rules): keep the local rules [G1]');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const armed = join(box.dir, 'armed'), receipt = join(box.dir, 'moved.json');
  const view = await startView(box);
  const profile = makeProfile();
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    // Keep this controlled observation until an explicit real refresh; no API response is substituted. The view's own
    // live updates (the stream's catch-up, the fallback read) wait from the moment the board is ready (#622).
    await allowLiveHold(chrome);
    await chrome.send('Page.navigate', { url: view.link.href });
    // Let the first worker finish its history reads before the wrapper is armed, so only a read at the capture trips it.
    await readAgesAt(chrome, box.git(alpha.repo, 'rev-parse', 'HEAD'));
    await holdLive(chrome, "data?.project?.spec.some(row => row.id === 'G3') && data.project.practice.some(row => row.id === 'R1')");
    // A new HEAD invalidates the age cache; R2 is already a visible working edit, as in the CI shape.
    writeFileSync(join(alpha.repo, 'ways.md'), r1 + r2);
    writeFileSync(join(alpha.repo, 'capture.txt'), 'The next state captures this commit.\n');
    box.git(alpha.repo, 'add', 'capture.txt');
    box.git(alpha.repo, 'commit', '-q', '-m', 'test(view): advance the capture [G1]');
    const captured = box.git(alpha.repo, 'rev-parse', 'HEAD');
    const wrapper = join(box.dir, 'bin/git');
    const program = join(box.dir, 'bin/git-wrapper.mjs');
    writeFileSync(program, `
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
const args = process.argv.slice(2), realGit = ${JSON.stringify(realGit)};
/** Run actual Git unchanged, including its original captured revision. */
const run = words => spawnSync(realGit, words, { encoding: 'utf8', env: process.env });
if (args[0] === 'log' && args.includes('--format=%H') && args.at(-1) === 'SPEC.md' && existsSync(${JSON.stringify(armed)})) {
  unlinkSync(${JSON.stringify(armed)});
  const before = run(['rev-parse', 'HEAD']).stdout.trim();
  const steps = [];
  for (const spec of [${JSON.stringify(SPEC + g3 + g4)}, ${JSON.stringify(SPEC + g5 + g3 + g4)}]) {
    writeFileSync('SPEC.md', spec);
    for (const words of [['add', 'SPEC.md', 'ways.md'], ['commit', '-q', '-m', 'docs(spec): add the next greeting [G1]']]) {
      const step = run(words); if (step.status !== 0) throw new Error(step.stderr);
    }
    steps.push(run(['rev-parse', 'HEAD']).stdout.trim());
  }
  writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ before, after: steps.at(-1), steps, args }));
}
const result = run(args);
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exitCode = result.status ?? 1;
`);
    writeFileSync(wrapper, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(program)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    writeFileSync(armed, 'capture');
    // The first read at the capture starts the worker whose history read moves HEAD; a later read shows its ages.
    await readAgesAt(chrome, captured);
    const proof = JSON.parse(readFileSync(receipt, 'utf8'));
    const observed = box.git(alpha.repo, 'rev-parse', 'HEAD');
    /** Read capture refs, exact ages and rendered search order together at one browser boundary. */
    const observe = () => chrome.stable(`(() => {
      showFound();
      return { captured: data.project.rowAgesAt,
        spec: data.project.spec.filter(row => ['G3','G4','G5'].includes(row.id)).map(({id,added}) => ({id,added})),
        doctrine: data.project.practice.filter(row => ['R1','R2'].includes(row.id)).map(({id,added}) => ({id,added})),
        order: [...document.querySelectorAll('#find-results [data-find]')].filter(hit => /^(spec|doctrine):/.test(hit.dataset.find)).map(hit => hit.querySelector('code').textContent) };
    })()`);
    await searchFor(chrome, 'greeting');
    const early = await observe();
    const diagnostic = JSON.stringify({ captured, observed, proof, early });
    assert.equal(proof.before, captured, diagnostic);
    assert.equal(proof.after, observed, diagnostic);
    assert.notEqual(captured, observed, diagnostic);
    assert.deepEqual(early.captured, { 'SPEC.md': captured, 'ways.md': captured }, diagnostic);
    assert.deepEqual(early.spec.filter(row => ['G4','G5'].includes(row.id)).map(row => row.added), [0, 0], diagnostic);
    assert.ok(early.doctrine.some(row => row.id === 'R2'), 'the former presence-only readiness condition is already satisfied');
    assert.deepEqual(early.order, ['G4', 'G5', 'G3', 'R2', 'R1'], diagnostic);
    // Start the actual comparison while the stale capture is still visible. Presence-only readiness
    // would resolve now and preserve that wrong order, even though a later refresh becomes correct.
    const comparison = committedRows(chrome, observed).then(observe);
    // Two ordered browser observations let the readiness check and any early comparison finish,
    // without a wall-clock sleep or changing the real response. Both still see the held capture.
    for (let checkpoint = 0; checkpoint < 2; checkpoint += 1) {
      assert.deepEqual((await observe()).captured, early.captured, 'the real stale capture remains visible before the refresh');
    }
    // Only the committed-head barrier keeps the comparison pending until these real reads carry the moved HEAD's ages.
    await readAgesAt(chrome, observed);
    const latest = await comparison;
    assert.deepEqual(latest.captured, { 'SPEC.md': observed, 'ways.md': observed }, JSON.stringify(latest));
    assert.deepEqual(latest.spec.map(row => [row.id,row.added]), [['G5',1],['G3',3],['G4',2]], JSON.stringify(latest));
    assert.deepEqual(latest.order, ['G5', 'G4', 'G3', 'R2', 'R1'], JSON.stringify(latest));
    t.diagnostic(JSON.stringify({ captured, observed, proof, early, latest }));
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
