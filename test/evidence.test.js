/** Row evidence and stage precedence (S15, S16). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { citedTestFiles, rowEvidence, rowStage } from '../src/evidence.js';

/**
 * Write a file and stage it in the fixture repository.
 *
 * @param {string} root
 * @param {string} path
 * @param {string} text
 * @returns {void}
 */
function trackedFile(root, path, text) {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  execFileSync('git', ['-C', root, 'add', '--', path]);
}

test('evidence uses exact citations in tracked visible tests and stage precedence follows sign-offs [S15, S16]', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-evidence-'));
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = join(sandbox, 'private-home');
  const root = join(sandbox, 'repo');
  try {
    mkdirSync(root);
    execFileSync('git', ['init', '--quiet', root]);
    trackedFile(root, 'test/primary.test.js', '// proves [S15] and [S16]; not [S150]\n');
    trackedFile(root, 'tests/support.js', '/* shared [S15, S150] */\n');
    trackedFile(root, 'src/target.spec.md', 'S15 [S15]\n');
    trackedFile(root, 'test/ordinary.txt', '[S15]\n');
    trackedFile(root, 'kits/hidden.test.js', '[S15]\n');
    trackedFile(root, '.hidden/test.test.js', '[S15]\n');
    writeFileSync(join(root, 'test/untracked.test.js'), '[S15]\n');

    const tracked = citedTestFiles(root);
    assert.deepEqual(tracked.map((file) => file.path), [
      'src/target.spec.md',
      'test/ordinary.txt',
      'test/primary.test.js',
      'tests/support.js',
    ]);
    const items = [
      { item_id: 7, item_status: 'verified', item_spec_ids: 'S15, S16' },
      { item_id: 8, item_status: 'verified', item_spec_ids: 'S150' },
      { item_id: 9, item_status: 'open', item_spec_ids: 'S15' },
      { item_id: 10, item_status: 'claimed', item_spec_ids: 'S16' },
      { item_id: 11, item_status: 'submitted', item_spec_ids: 'S15' },
    ];
    const verdicts = [
      { verdict_id: 2, item_id: 7, verdict_decision: 'ACCEPT', verdict_note: 'earlier\nsecond line' },
      { verdict_id: 3, item_id: 7, verdict_decision: 'REJECT', verdict_note: 'ignored reject' },
      { verdict_id: 6, item_id: 7, verdict_decision: 'ACCEPT', verdict_note: 'latest accepted note\nmore detail' },
    ];
    const evidence = rowEvidence(root, 'S15', { items, verdicts, testFiles: tracked });
    assert.deepEqual(evidence.files, ['src/target.spec.md', 'test/ordinary.txt', 'test/primary.test.js', 'tests/support.js']);
    assert.deepEqual(evidence.verified, [{ id: 7, note: 'latest accepted note' }]);
    assert.equal(evidence.building, true);
    assert.equal(evidence.awaiting, true);
    assert.deepEqual(rowEvidence(root, 'S150', { testFiles: tracked }).files, ['test/primary.test.js', 'tests/support.js']);
    assert.deepEqual(rowEvidence(root, 'S16', { items, verdicts, testFiles: tracked }).verified, [{ id: 7, note: 'latest accepted note' }]);

    assert.equal(rowStage({ stale: [{}] }, evidence), 'stale');
    assert.equal(rowStage({}, evidence), 'awaiting a verdict');
    assert.equal(rowStage({}, { ...evidence, awaiting: false }), 'building');
    assert.equal(rowStage({}, { files: [], verified: [{ id: 7 }], building: false, awaiting: false }), 'verified and ready to sign');
    assert.equal(rowStage({}, { files: [], verified: [], building: false, awaiting: false }), 'no evidence');
  } finally {
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
