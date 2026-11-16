/**
 * End to end on real repos: briefs and unattended builds (B10, B13, B14, N14, B15).
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
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';

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

test('an item carries a brief to whoever claims it; a light agent sees only its tier [B10, B13, B14]', async () => {
  const box = project();
  const bin = join(box.dir, 'runner-bin');
  const worker = join(box.dir, 'runner-worker');
  const home = join(box.dir, 'runner-home');
  for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests: join(box.dir, 'runner-requests.jsonl') });
  const registered = (await box.runLocal(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '1'));
  assert.equal(registered.code, 0, registered.err || registered.out);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['gate.loadAwareDispatch', 'off'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const configured = (await box.runLocal(box.repo, 'settings', key, value));
    assert.equal(configured.code, 0, configured.err || configured.out);
  }

  writeFileSync(join(box.dir, 'brief.md'), LIGHT_BRIEF);
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Design', 'the', 'page', '--specs', 'G1')).code, 0);
  assert.match((await fixtureAdd(box.runLocal, box.repo, 'web', 'Copy', '--route', 'mid', '--brief-file', join(box.dir, 'brief.md'))).err, /NO_BRIEF.*--criterion.*--check/);
  assert.match((await fixtureAdd(box.runLocal, box.repo, 'web', 'Copy', '--brief', 'x', '--brief-file', 'y')).err, /USAGE.*give the brief once/);
  const foreign = await fixtureAdd(box.runLocal, box.repo, 'web', 'Copy', '--route', 'mid', '--criterion', 'c', '--check', 'true', '--brief', LIGHT_BRIEF.replace('web/page.js', 'api/server.js'));
  assert.match(foreign.err, /BRIEF_LANE.*api\/server.js \(api's\)/);
  const added = await addDiagnosedLight(box, 'web', 'Copy', 'the', 'header', '--route', 'light', '--criterion', 'the page shows the header', '--check', 'test -f web/page.js', '--brief-file', join(box.dir, 'brief.md'), '--wait');
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /\nnext: pullboard next\n$/u);
  assert.equal(added.out.replace(/next: pullboard next\n$/u, '').trim(), `#2\ncheck baseline red at main ${box.git(box.repo, 'rev-parse', 'main')}: test -f web/page.js`);
  assert.match((await box.runLocal(box.repo, 'list')).out, /#2 {2}open {2}web {2}Copy the header {2}light/);
  assert.doesNotMatch((await box.runLocal(box.repo, 'list', '--route', 'light')).out, /Design the page/);
  const made = (await box.runLocal(box.repo, 'worktree', 'web', '--route', 'light'));
  assert.match(made.out, /joined as web-2 \(fixture-model\) in the web lane, on the light route/);
  const light = made.out.match(/^made (\S+) /)[1];
  assert.match((await box.runLocal(light, 'whoami')).out, /^web-2 \(fixture-model\) \(web lane, light route\)/);
  const next = (await box.runLocal(light, 'next'));
  assert.match(next.out, /claimed #2: Copy the header\nnext: build and commit in [^\n]+\nitem folder: [^\n]+; seat web-2; build, commit and submit there\ncriterion: the page shows the header\ncheck: test -f web\/page.js {3}\(run it before you submit\)\nbrief:\n {2}Files:\n {2}- web\/page.js/);
  assert.match((await box.runLocal(light, 'claim', '1')).err, /ROUTE/);
  assert.match((await box.runLocal(box.web, 'next')).out, /claimed #1: Design the page/);
  assert.equal((await box.runLocal(box.repo, 'edit', '1', '--brief', 'Start from the sketch in docs/page.md.')).code, 0);
  assert.match((await box.runLocal(box.web, 'show', '1')).out, /brief:\n {2}Start from the sketch in docs\/page.md./);
  assert.match((await box.runLocal(box.web, 'edit', '2', '--brief', 'mine')).err, /HELD/);
});

test('run builds routed items unattended: the failure feeds the next attempt; red work escalates, pinned [N14, B15]', async () => {
  const box = project();
  const agent = join(box.dir, 'agent.sh');
  writeFileSync(agent, [
    '#!/bin/sh',
    'mkdir -p web api',
    'if [ "$PULLBOARD_ITEM" = "1" ]; then',
    '  if [ "$PULLBOARD_ATTEMPT" = "1" ]; then echo "export const title = \'Hello\';" > web/page.js; echo stray > api/stray.js;',
    '  elif grep -q "The check" "$PULLBOARD_PACK"; then echo "export const title = \'Hi\';" > web/page.js; fi',
    'else',
    '  echo "export const footer = \'nope\'; // $PULLBOARD_CHECK $PULLBOARD_TIER" | tr B b > web/footer.js',
    'fi',
    '',
  ].join('\n'));
  const brief = (file) => LIGHT_BRIEF.replace('web/page.js', file);
  const has = (file, text) => `grep -q ${text} ${file}`;
  assert.equal((await addDiagnosedLight(box, 'web', 'Greet', 'on', 'the', 'page', '--specs', 'G1', '--route', 'light', '--criterion', 'the page says Hi', '--check', has('web/page.js', 'Hi'), '--brief', brief('web/page.js'))).code, 0);
  assert.equal((await addDiagnosedLight(box, 'web', 'Say', 'bye', '--route', 'light', '--criterion', 'the footer says Bye', '--check', has('web/footer.js', 'Bye'), '--brief', brief('web/footer.js'))).code, 0);
  const made = (await box.runLocal(box.repo, 'worktree', 'web', '--route', 'light'));
  const light = made.out.match(/^made (\S+) /)[1];
  assert.match((await box.runLocal(box.repo, 'run', '--agent', `sh ${agent}`)).err, /MAIN_IS_COORDINATOR/);
  assert.match((await box.runLocal(light, 'run', '--agent-mid', `sh ${agent}`)).err, /ROUTE.*joined on the light route, so it cannot take mid items/);
  const ran = await box.runLocal(light, 'run', '--agent-light', `sh ${agent}`, '--attempts', '2', '--minutes', '2');
  assert.equal(ran.code, 0, ran.err);
  // A fresh seat's first delivery starts at the board head (#6152), so the lane's earlier moves are no news to it.
  assert.match(ran.out, /#1 attempt 1: red[\s\S]*#1 attempt 2: green \(agent \d+s, check \d+s\)\nsubmit authorization and source: \d+\.\d+s\n(?:no new shouts or activity\n)?#1 is in the gate as job /);
  assert.match(ran.out, /nothing left to run: no open light runnable items in the web lane/);
  assert.match(ran.out, /#2 attempt 2: red[\s\S]*#2 escalated light -> mid; the attempt is pinned at refs\/pullboard\/attempts\/2\//);
  assert.match(ran.out, /runner done: 1 submitted, 1 escalated/);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', light.split('/').at(-1), 'pullboard', 'packs');
  const second = readFileSync(join(packs, '1-light-2.md'), 'utf8');
  assert.equal(existsSync(join(packs, '1-light-1.log')), true);
  assert.match(second, /reverted your changes outside the brief's files: api\/stray.js/);
  assert.match(second, /### web\/page.js\n```\nexport const title = 'Hello';/);
  assert.equal(existsSync(join(light, 'api', 'stray.js')), false);
  // A pull submit pins the commit it offered the gate at refs/pullboard/gate/<id>; the item pin comes with the verdict [C7].
  assert.equal(box.git(light, 'log', '-1', '--format=%s', 'refs/pullboard/gate/1'), 'feat(web): greet on the page [G1]');
  assert.equal(box.git(light, 'status', '--porcelain'), '');
  const pinned = box.git(light, 'for-each-ref', '--format=%(refname)', 'refs/pullboard/attempts/2/');
  assert.match(box.git(light, 'show', `${pinned}:web/footer.js`), /nope'; \/\/ grep -q bye web\/footer.js light/);
  const shown = (await box.runLocal(box.repo, 'show', '2')).out;
  assert.match(shown, /#2 {2}open {2}web {2}Say bye {2}mid/);
  assert.match(shown, /unattended attempts: red, red/);
  assert.match(shown, /escalated light -> mid by web-2 \(fixture-model\), pinned at refs\/pullboard\/attempts\/2\/[0-9a-f]{12}: 2 attempts stayed red/);
  assert.match((await box.runLocal(box.repo, 'inbox')).out, /web-2 \(fixture-model\) -> coordinator \(unknown\): #2 escalated light -> mid after 2 red attempts/);
});
