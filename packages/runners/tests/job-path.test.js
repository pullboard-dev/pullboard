/** A runner test job's PATH keeps the system directories, so git resolves whatever PATH the service started with [C7,#8245]. */
import assert from 'node:assert/strict';
import { accessSync } from 'node:fs';
import { constants } from 'node:fs';
import { delimiter } from 'node:path';
import { test } from 'node:test';
import { jobPath } from '../index.js';

/** Whether `tool` is an executable file in one of the PATH's directories. */
function resolves(tool, path) {
  return path.split(delimiter).filter(Boolean).some(directory => { try { accessSync(`${directory}/${tool}`, constants.X_OK); return true; } catch { return false; } });
}

test('runners.job-path.a-runner-test-job-environment-keeps: clause 1: a runner test job environment keeps a PATH on which git resolves [C7,#8245]', () => {
  for (const service of [undefined, '', '/nonexistent/bin', '/usr/local/bin:/nonexistent/bin']) {
    const path = jobPath(service, delimiter);
    assert.ok(resolves('git', path), `git resolves on the job PATH made from ${JSON.stringify(service)}`);
  }
  assert.equal(jobPath('/opt/tools:/usr/bin'), '/opt/tools:/usr/bin:/bin:/usr/sbin:/sbin', 'service entries keep their order and none repeats');
});
