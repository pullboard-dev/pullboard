/** The leak stop script spares a live job and stops only a dead one's process [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';
import { stopScript } from '../../../src/io/leaked.js';

test('clause 2: the stop script excludes a live job id and a fake ps listing keeps only the non-live job pid [C7]', () => {
  const dir = temporaryDirectory('pullboard-leak-ps-');
  try {
    const root = join(dir, 'runner');
    const script = stopScript(root, ['live-job']);
    assert.match(script, /live-job/u);
    assert.match(script, /index\(\$0,ENVIRON\["J"\] ids\[i\]\)/u);
    writeFileSync(join(dir, 'ps'), `#!/bin/sh
case "$*" in
  *-axo*) printf '%s\\n' '111 Mon Nov 6 10:00:00 2026 node ${root}/jobs/live-job/step' '222 Mon Nov 6 10:00:00 2026 node ${root}/jobs/dead-job/step' '333 Mon Nov 6 10:00:00 2026 node /elsewhere' ;;
esac
`);
    chmodSync(join(dir, 'ps'), 0o755);
    const run = spawnSync('sh', ['-c', script.replace(/^sh -c /u, 'sh -c ')], { env: { ...process.env, PATH: dir + ':' + process.env.PATH }, encoding: 'utf8' });
    assert.equal(run.stdout.trim(), '222', run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
