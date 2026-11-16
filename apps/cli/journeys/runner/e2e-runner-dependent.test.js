/**
 * End to end on real repos: the runner returns a claimed dependent item when its dependency conflicts (B8, V1, R1).
 */
/** @pullboard-test-input source-cell apps/cli apps/lib store */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { addDiagnosedLight } from '../../tests/fixtures/runner/diagnosed-light.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, LIGHT_BRIEF,
} = e2e;

test('the runner returns a claimed dependent item when its verified dependency conflicts [B8,V1,R1]', async () => {
  const box = project();
  const localRunner = (await box.runLocal(box.repo, 'worktree', 'api', '--route', 'light')).out.match(/^made (\S+) /)[1];
  const dependencyRunner = (await box.runLocal(box.repo, 'worktree', 'api', '--route', 'light')).out.match(/^made (\S+) /)[1];
  mkdirSync(join(localRunner, 'api'));
  writeFileSync(join(localRunner, 'api', 'server.js'), "export const source = 'local';\n");
  box.git(localRunner, 'add', 'api/server.js');
  box.git(localRunner, 'commit', '-q', '-m', 'feat(api): local server variant [G2]');

  const brief = LIGHT_BRIEF.replace('web/page.js', 'api/server.js');
  await addDiagnosedLight(box, 'api', 'Upstream API', '--route', 'light', '--specs', 'G2', '--criterion', 'serves the upstream API',
    '--check', 'grep -q upstream api/server.js', '--brief', brief);
  const upstreamAgent = `sh ${join(box.dir, 'upstream.sh')}`;
  writeFileSync(join(box.dir, 'upstream.sh'), '#!/bin/sh\nmkdir -p api\nprintf "export const source = upstream;\\n" > api/server.js\n');
  assert.match((await box.runLocal(dependencyRunner, 'run', '--agent-light', upstreamAgent, '--attempts', '1')).out, /#1 is in the gate as job /);
  await settledGateJob(box, 1); // the pulled gate posts its receipt after the run returns [C7]
  const dependencyCommit = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', dependencyCommit);
  assert.match((await box.runLocal(box.web, 'verify', '1', 'accept', '--note', 'The exact upstream API check passed.')).out, /verified #1/);

  const dependentBrief = LIGHT_BRIEF.replace('web/page.js', 'api/client.js');
  await addDiagnosedLight(box, 'api', 'Dependent API', '--after', '1', '--route', 'light', '--specs', 'G2', '--criterion', 'integrates upstream API',
    '--check', 'test -f api/client.js && grep -q upstream api/server.js', '--brief', dependentBrief);
  const blocked = await box.runLocal(localRunner, 'run', '--agent-light', 'true', '--attempts', '1');
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.err, /MERGE_CONFLICT/);
  assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', '2', '--json')).out).item_status, 'open', 'the automatic claimed-item release remains unchanged');
});
