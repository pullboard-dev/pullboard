/**
 * End to end on real repos: runner tiers and dependency conflicts (N16, B8, V1, R1). Hold lives in e2e-runner-hold.
 */
/** @pullboard-test-input source-cell apps/cli apps/lib store */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, LIGHT_BRIEF,
} = e2e;

/** File light work at mid, then route it through the coordinator's diagnosis. */
async function addDiagnosedLight(box, ...args) {
  const route = args.indexOf('--route');
  assert.equal(args[route + 1], 'light');
  const brief = args.includes('--brief-file') ? readFileSync(args[args.indexOf('--brief-file') + 1], 'utf8') : args[args.indexOf('--brief') + 1];
  args[route + 1] = 'mid';
  const added = await fixtureAdd(box.runLocal, box.repo, ...args);
  assert.equal(added.code, 0, added.err || added.out);
  const id = added.out.match(/^#(\d+)/m)?.[1];
  assert.ok(id, added.out);
  const diagnosis = (await box.runLocal(box.repo, 'fact', id, 'diagnosis', brief));
  assert.equal(diagnosis.code, 0, diagnosis.err || diagnosis.out);
  return added;
}

test('one runner climbs the tiers: an escalated item goes to the next command, with the earlier tries; it merges the verified work an item waits on [N16]', async () => {
  const box = project();
  const script = (name, lines) => {
    writeFileSync(join(box.dir, name), ['#!/bin/sh', 'mkdir -p web api', ...lines, ''].join('\n'));
    return `sh ${join(box.dir, name)}`;
  };
  const good = script('web.sh', ["echo \"export const title = 'Hi';\" > web/page.js"]);
  const weak = script('weak.sh', ['echo nope > api/server.js']);
  const strong = script('strong.sh', ['grep -q "Earlier tries by a lighter model" "$PULLBOARD_PACK" && echo "export const served = true;" > api/server.js']);
  const brief = (file) => LIGHT_BRIEF.replace('web/page.js', file);
  await addDiagnosedLight(box, 'web', 'Greet', '--route', 'light', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', brief('web/page.js'));
  await addDiagnosedLight(box, 'api', 'Serve', 'the', 'page', '--after', '1', '--route', 'light', '--criterion', 'serves it', '--check', 'test -f web/page.js && grep -q served api/server.js', '--brief', brief('api/server.js'));
  const webRunner = (await box.runLocal(box.repo, 'worktree', 'web', '--route', 'light')).out.match(/^made (\S+) /)[1];
  assert.match((await box.runLocal(webRunner, 'run', '--agent-light', good, '--attempts', '1')).out, /#1 is in the gate as job /);
  await settledGateJob(box, 1); // the pulled gate posts its receipt after the run returns [C7]
  const commit = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', commit);
  assert.match((await box.runLocal(box.web, 'verify', '1', 'accept', '--no-next', '--note', 'ran the check, then emptied the file and saw it fail')).out, /verified #1/);
  const apiRunner = (await box.runLocal(box.repo, 'worktree', 'api', '--route', 'mid')).out.match(/^made (\S+) /)[1];
  const ran = await box.runLocal(apiRunner, 'run', '--agent-light', weak, '--agent-mid', strong, '--attempts', '2', '--minutes', '2');
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /#2 attempt 1\/2: running the light agent[\s\S]*#2 escalated light -> mid[\s\S]*#2 attempt 1\/2: running the mid agent\n#2 attempt 1: green[\s\S]*#2 is in the gate as job /);
  assert.match(ran.out, /runner done: 1 submitted, 1 escalated/);
  assert.equal(box.tryGit(apiRunner, 'merge-base', '--is-ancestor', commit, 'HEAD').status, 0);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', apiRunner.split('/').at(-1), 'pullboard', 'packs');
  assert.match(readFileSync(join(packs, '2-mid-1.md'), 'utf8'), /## Earlier tries by a lighter model\n- 2 attempts stayed red/);
  assert.equal(existsSync(join(packs, '2-light-1.md')), true);
});

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
