/** Runner source history can exceed a single blob limit without losing its safety bound [H16,C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { protectHistory } from '../packages/runners/index.js';
import { sourceGit } from '../packages/runners/index.js';
import { sourceObjects } from '../packages/runners/index.js';
import { defaults } from '../packages/config/index.js';

/** Construct history with long names using shared blob objects, without checking files out. */
test('runner history above 8 MiB scans and reports an actual smaller bound with byte count [H16,C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-history-bound-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const names = Array.from({ length: 11000 }, (_, index) => `data/${String(index).padStart(5, '0')}-${'x'.repeat(195)}.txt`);
  const files = names.map(name => `M 100644 :1 ${name}\n`).join('');
  const person = 'Fixture <fixture@example.invalid> 1700000000 +0000';
  const commits = [0, 1, 2, 3].map((index) => `commit refs/heads/main\ncommitter ${person}\ndata 2\nc${index}\n${index % 2 ? 'deleteall\n' : files}\n`).join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: `blob\nmark :1\ndata 1\nx\n${commits}`, maxBuffer: 16 * 1024 * 1024 });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const args = ['log', '--format=', '--name-only', '-z', '--no-renames', '--root', '-m', '--full-history', commit];
  const bytes = Buffer.byteLength(sourceGit(root, args, { maxBuffer: 32 * 1024 * 1024 }));
  assert.ok(bytes > 8 * 1024 * 1024, `fixture history is ${bytes} bytes`);
  assert.doesNotThrow(() => sourceObjects(root, { commit }));
  assert.doesNotThrow(() => protectHistory(root, { commit }, [defaults().protect]));
  assert.throws(() => sourceGit(root, args, { maxBuffer: 8 * 1024 * 1024 }), error => {
    assert.equal(error.code, 'RUNNER_SOURCE');
    assert.match(error.message, new RegExp(`${bytes} bytes.*8388608-byte bound`));
    return true;
  });
});
