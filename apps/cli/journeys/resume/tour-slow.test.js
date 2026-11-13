/** The tour names its slowest steps when one step is slow (N10); split from e2e.test.js to keep each file under two minutes. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { BIN, sandbox } = e2e;

test('a slow tour names its slowest steps [N10]', () => {
  const box = sandbox();
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const slowBin = join(box.dir, 'slow-bin');
  mkdirSync(slowBin);
  // A git that sleeps before each commit: the slow step the tour must name, through a shim it calls, not a switch.
  writeFileSync(join(slowBin, 'git'), `#!/bin/sh\ncase "$*" in *"feat(app)"*) sleep 15 ;; esac\nexec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(slowBin, 'git'), 0o755);
  const plainEnv = { ...box.env, TMPDIR: box.dir, PATH: `${slowBin}:${process.env.PATH}` };
  delete plainEnv.NO_COLOR;
  delete plainEnv.FORCE_COLOR;
  const shown = spawnSync(process.execPath, [BIN, 'tour'], { cwd: box.dir, env: plainEnv, encoding: 'utf8' });
  assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  const slowest = shown.stderr.split('\n').find((line) => line.startsWith('slowest steps:'));
  assert.ok(slowest, 'the tour names its slowest steps');
  assert.match(slowest, /git commit -q -m "feat\(app\)[^;]*? ([0-9]{5,}) ms/u, 'the slowed commit is named with its time');
});
