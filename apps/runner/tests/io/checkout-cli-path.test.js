/** @pullboard-test-input apps/runner/src/io/worker/environment.js */
/** A job whose PATH holds an older global pullboard runs the checkout CLI by name, never the global one [C7,#5582]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { scopedEnvironment } from '../../src/io/worker/environment.js';

test('clause 1: a job whose PATH holds an older global pullboard runs the checkout CLI by name, and a non-job temporary folder leaves PATH alone [C7]', () => {
  const files = privateFixtureFiles('runner-checkout-cli-');
  const dir = files.root;
  try {
    const globalBin = join(dir, 'nvm-bin');
    const cli = join(dir, 'checkout/apps/cli/pullboard.js');
    files.write('nvm-bin/pullboard', '#!/bin/sh\necho 0.9.2-global\n');
    files.write('checkout/apps/cli/pullboard.js', "#!/usr/bin/env node\nconsole.log('checkout ' + process.argv.slice(2).join(' '));\n");
    files.write('tmp/keep', '');
    chmodSync(join(globalBin, 'pullboard'), 0o755);
    chmodSync(cli, 0o755);
    const S = { safePath: [globalBin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), workerId: 'job-1' };
    const env = scopedEnvironment(S, join(dir, 'home'), join(dir, 'tmp'), '', null, { gateSlotEnvironment: () => ({}) });
    const run = spawnSync('sh', ['-c', 'command -v pullboard; pullboard --version'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim().split('\n')[0], join(dir, 'cli-bin', 'pullboard'), 'the checkout link is found before the global install');
    assert.match(run.stdout, /checkout --version/u);
    assert.doesNotMatch(run.stdout, /0\.9\.2-global/u);
    const outside = scopedEnvironment(S, join(dir, 'home'), join(dir, 'nowhere/tmp'), '', null, { gateSlotEnvironment: () => ({}) });
    assert.equal(outside.PATH, S.safePath, 'a temporary folder that is not a job leaves PATH alone');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
