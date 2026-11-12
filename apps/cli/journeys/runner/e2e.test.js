/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  startFixtureChild as spawn,
  runFixtureChild as spawnSync,
} from '../../tests/fixtures/child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { connect } from 'node:net';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { parseSpec } from '../../../../packages/spec/index.js';
import { checkAtCommit } from '../../../runner/index.js';
import * as store from '../../../../packages/store/index.js';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

/** File light work at mid, then route it through the coordinator's diagnosis. */
async function addDiagnosedLight(box, ...args) {
  const route = args.indexOf('--route');
  assert.equal(args[route + 1], 'light');
  const brief = args.includes('--brief-file') ? readFileSync(args[args.indexOf('--brief-file') + 1], 'utf8') : args[args.indexOf('--brief') + 1];
  args[route + 1] = 'mid';
  const added = fixtureAdd(box.run, box.repo, ...args);
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
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Design', 'the', 'page', '--specs', 'G1').code, 0);
  assert.match(fixtureAdd(box.run, box.repo, 'web', 'Copy', '--route', 'mid', '--brief-file', join(box.dir, 'brief.md')).err, /NO_BRIEF.*--criterion.*--check/);
  assert.match(fixtureAdd(box.run, box.repo, 'web', 'Copy', '--brief', 'x', '--brief-file', 'y').err, /USAGE.*give the brief once/);
  const foreign = fixtureAdd(box.run, box.repo, 'web', 'Copy', '--route', 'mid', '--criterion', 'c', '--check', 'true', '--brief', LIGHT_BRIEF.replace('web/page.js', 'api/server.js'));
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
  assert.match(ran.out, /#1 attempt 1: red[\s\S]*#1 attempt 2: green \(agent \d+s, check \d+s\)\nsubmit authorization and source: \d+\.\d+s\nsubmit composition: \d+\.\d+s\nsubmit changed static: \d+\.\d+s\nsubmit doctrine: \d+\.\d+s\nsubmit static: \d+\.\d+s\nsubmit cells: \d+\.\d+s\nno new shouts or activity\nsubmitted #1 at [0-9a-f]{12};/);
  assert.match(ran.out, /nothing left to run: no open light runnable items in the web lane/);
  assert.match(ran.out, /#2 attempt 2: red[\s\S]*#2 escalated light -> mid; the attempt is pinned at refs\/pullboard\/attempts\/2\//);
  assert.match(ran.out, /runner done: 1 submitted, 1 escalated/);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', light.split('/').at(-1), 'pullboard', 'packs');
  const second = readFileSync(join(packs, '1-light-2.md'), 'utf8');
  assert.equal(existsSync(join(packs, '1-light-1.log')), true);
  assert.match(second, /reverted your changes outside the brief's files: api\/stray.js/);
  assert.match(second, /### web\/page.js\n```\nexport const title = 'Hello';/);
  assert.equal(existsSync(join(light, 'api', 'stray.js')), false);
  assert.equal(box.git(light, 'log', '-1', '--format=%s', 'refs/pullboard/items/1/' + box.git(light, 'rev-parse', '--short=12', 'HEAD')), 'feat(web): greet on the page [G1]');
  assert.equal(box.git(light, 'status', '--porcelain'), '');
  const pinned = box.git(light, 'for-each-ref', '--format=%(refname)', 'refs/pullboard/attempts/2/');
  assert.match(box.git(light, 'show', `${pinned}:web/footer.js`), /nope'; \/\/ grep -q bye web\/footer.js light/);
  const shown = (await box.runLocal(box.repo, 'show', '2')).out;
  assert.match(shown, /#2 {2}open {2}web {2}Say bye {2}mid/);
  assert.match(shown, /unattended attempts: red, red/);
  assert.match(shown, /escalated light -> mid by web-2 \(fixture-model\), pinned at refs\/pullboard\/attempts\/2\/[0-9a-f]{12}: 2 attempts stayed red/);
  assert.match((await box.runLocal(box.repo, 'inbox')).out, /web-2 \(fixture-model\) -> coordinator \(unknown\): #2 escalated light -> mid after 2 red attempts/);
});

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
  assert.match((await box.runLocal(webRunner, 'run', '--agent-light', good, '--attempts', '1')).out, /submitted #1/);
  const commit = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', commit);
  assert.match((await box.runLocal(box.web, 'verify', '1', 'accept', '--note', 'ran the check, then emptied the file and saw it fail')).out, /verified #1/);
  const apiRunner = (await box.runLocal(box.repo, 'worktree', 'api', '--route', 'mid')).out.match(/^made (\S+) /)[1];
  const ran = await box.runLocal(apiRunner, 'run', '--agent-light', weak, '--agent-mid', strong, '--attempts', '2', '--minutes', '2');
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /#2 attempt 1\/2: running the light agent[\s\S]*#2 escalated light -> mid[\s\S]*#2 attempt 1\/2: running the mid agent\n#2 attempt 1: green[\s\S]*submitted #2/);
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
  assert.match((await box.runLocal(dependencyRunner, 'run', '--agent-light', upstreamAgent, '--attempts', '1')).out, /submitted #1/);
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

test('sweep files one light item per flagged file, in its lane; a second sweep skips what is open [N15]', async () => {
  const box = project();
  writeFileSync(join(box.dir, 'novar.mjs'), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((n) => !n.startsWith(".") && n !== "node_modules").flatMap((n) => walk(path.join(p, n))) : [p];',
    'let found = 0;',
    'for (const file of process.argv.slice(2).flatMap(walk).filter((f) => f.endsWith(".js"))) {',
    '  fs.readFileSync(file, "utf8").split("\\n").forEach((line, i) => { const col = line.indexOf("var "); if (col >= 0) { found += 1; console.log(`${file}:${i + 1}:${col + 1}: no-var Unexpected var, use let or const.`); } });',
    '}',
    'process.exit(found ? 1 : 0);',
    '',
  ].join('\n'));
  commitFile(box, box.repo, 'web/a.js', 'var a = 1;\nvar b = 2;\n', 'chore: two vars');
  commitFile(box, box.repo, 'api/b.js', 'var c = 3;\n', 'chore: one var');
  const sweep = ['sweep', '--run', `node ${join(box.dir, 'novar.mjs')} .`, '--check', `node ${join(box.dir, 'novar.mjs')} {file}`];
  assert.match((await box.runLocal(box.web, ...sweep)).err, /COORDINATOR_ONLY/);
  assert.match((await box.runLocal(box.repo, ...sweep, '--dry-run')).out, /would file: fix 2 problems in web\/a.js \(web lane, light\)/);
  const filed = (await box.runLocal(box.repo, ...sweep));
  assert.equal(filed.code, 0, filed.err);
  assert.match(filed.out, /#1 fix 2 problems in web\/a.js \(web lane, light\)\n#2 fix 1 problem in api\/b.js \(api lane, light\)/);
  assert.match(filed.out, /3 problems in 2 files; filed 2/);
  const shown = (await box.runLocal(box.repo, 'show', '1')).out;
  assert.match(shown, new RegExp(`check: node ${join(box.dir, 'novar.mjs')} web/a.js`));
  assert.match(shown, /- line 2:1 no-var: Unexpected var, use let or const\./);
  assert.match((await box.runLocal(box.repo, ...sweep)).out, /already open: web\/a.js, api\/b.js\n3 problems in 2 files; filed 0/);
  commitFile(box, box.repo, 'docs/c.js', 'var d = 4;\n', 'chore: one more var');
  const blind = (await box.runLocal(box.repo, 'sweep', '--run', `node ${join(box.dir, 'novar.mjs')} .`, '--check', `node ${join(box.dir, 'novar.mjs')} {file} | tail -5`));
  assert.equal(blind.code, 1);
  assert.match(blind.err, /CHECK_CANNOT_FAIL\] the check passes on docs\/c.js although the checker flags problems there/);
  assert.match(blind.out, /filed 0/);
  const machineBlind = (await box.runLocal(box.repo, 'sweep', '--run', `node ${join(box.dir, 'novar.mjs')} .`, '--check', `node ${join(box.dir, 'novar.mjs')} {file} | tail -5`, '--json'));
  assert.equal(machineBlind.code, 1);
  const next = JSON.parse(machineBlind.out).error.next;
  assert.equal(next, 'Fix the check so flagged files make it fail, then run pullboard sweep again.');
  const refusalLine = blind.err.split('\n').find((line) => line.startsWith('stderr: ')) ?? blind.err;
  assert.ok(refusalLine.trimEnd().endsWith(next), blind.err);

  const checker = join(box.dir, 'novar.mjs');
  writeFileSync(checker, readFileSync(checker, 'utf8').replace('no-var Unexpected var', 'unknown-rule Unexpected var'));
  const unsupported = (await box.runLocal(box.repo, ...sweep));
  assert.equal(unsupported.code, 0, unsupported.err);
  assert.match(unsupported.out, /filed 1/);
  const pending = JSON.parse((await box.runLocal(box.repo, 'show', '3', '--json')).out);
  assert.equal(pending.item_route, 'mid', 'unknown checker rules stay mid until actually diagnosed');
});

test('pre-commit runs the fixers on fully staged files and restages them; partly staged files are left alone [C5]', async () => {
  const box = project();
  const fixer = join(box.dir, 'trim.mjs');
  writeFileSync(fixer, "import fs from 'node:fs';\nfor (const f of process.argv.slice(2)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/[ \\t]+$/gm, ''));\n");
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, fix: [{ run: `node ${fixer}`, files: ['*.js'] }] }, null, 2));
  box.git(box.repo, 'commit', '-qam', 'chore: trim trailing spaces at commit');
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  writeFileSync(join(box.repo, 'docs', 'a.js'), 'const a = 1;   \n');
  writeFileSync(join(box.repo, 'docs', 'b.md'), 'text   \n');
  writeFileSync(join(box.repo, 'docs', 'c.js'), 'const c = 1;   \n');
  box.git(box.repo, 'add', 'docs');
  writeFileSync(join(box.repo, 'docs', 'c.js'), 'const c = 1;   \nconst d = 2;\n');
  const committed = box.tryGit(box.repo, 'commit', '-q', '-m', 'docs: three files');
  assert.equal(committed.status, 0, committed.stderr);
  const committedText = (path) => box.tryGit(box.repo, 'show', `HEAD:${path}`).stdout;
  assert.equal(committedText('docs/a.js'), 'const a = 1;\n');
  assert.equal(readFileSync(join(box.repo, 'docs', 'a.js'), 'utf8'), 'const a = 1;\n');
  assert.equal(committedText('docs/b.md'), 'text   \n');
  assert.equal(committedText('docs/c.js'), 'const c = 1;   \n');
  assert.match(committed.stderr, /not fixed, because they are partly staged: docs\/c.js/);
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, fix: [{ run: 'false', files: ['*.js'] }] }, null, 2));
  box.git(box.repo, 'commit', '-qam', 'chore: a fixer that fails');
  writeFileSync(join(box.repo, 'docs', 'e.js'), 'const e = 1;   \n');
  box.git(box.repo, 'add', 'docs/e.js');
  const failed = box.tryGit(box.repo, 'commit', '-q', '-m', 'docs: one more');
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stderr, /fixer "false" failed \(1\); staged nothing from it/);
  assert.equal(committedText('docs/e.js'), 'const e = 1;   \n');
});

test('resume puts an agent back to work from the board: its claim, its branch, what came back, the next step [N19]', async () => {
  const box = project();
  box.env.PULLBOARD_VIEW_FOREGROUND = '1';
  const view = await e2e.startView(box, box.repo);
  await view.stop();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1', '--brief', 'Files: web/page.html');
  const fresh = (await box.runLocal(box.web, 'resume'));
  assert.equal(fresh.code, 0, fresh.err);
  assert.match(fresh.out, /^resume: web-1 \(fixture-model\), web lane, at /);
  assert.match(fresh.out, /branch web\/one: 0 ahead of main, 0 behind/);
  assert.match(fresh.out, /next: pullboard next \(1 ready in your lane\)/);
  (await box.runLocal(box.web, 'next'));
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'page.html'), '<h1>Hi</h1>');
  (await box.runLocal(box.repo, 'shout', 'web-1', 'the heading text is in G1'));
  const building = (await box.runLocal(box.web, 'resume')).out;
  assert.match(building, /1 file uncommitted/);
  assert.match(building, /holding #1 Page, lease \d+[mh] left/);
  assert.match(building, /files: web\/page\.html/);
  assert.match(building, /1 unread shout; newest from coordinator \(unknown\): the heading text is in G1/);
  assert.match(building, /next: build #1, commit, then pullboard submit 1/);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): page [G1]');
  assert.equal((await box.runLocal(box.web, 'submit', '1')).code, 0);
  const coordinator = (await box.runLocal(box.repo, 'resume')).out;
  assert.match(coordinator, /^resume: coordinator \(unknown\), coordinator lane, the main checkout/);
  assert.match(coordinator, /to verify: #1 web \(\d+[mhd]\)/);
  assert.match(coordinator, /next: pullboard next --verify --as coordinator/);
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  (await box.runLocal(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--clause', 'The page renders.', '--note', 'no test proves the heading\nthe rest is fine', '--as', 'coordinator'));
  const back = (await box.runLocal(box.web, 'resume')).out;
  assert.match(back, /branch web\/one: main is detached for a verification/);
  box.git(box.repo, 'switch', '-q', 'main');
  assert.match((await box.runLocal(box.web, 'resume')).out, /branch web\/one: 1 ahead of main, 0 behind/);
  assert.match(back, /sent back: #1 TEST_FAILURE by coordinator \(unknown\): no test proves the heading$/m);
  assert.match(back, /^next: pullboard next; pullboard claim 1, fix what the verifier found, and submit again$/m);
});

test('next takes work near your recent files; submit records them; show names related verified work [N20, N21]', async () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Footer', '--specs', 'G1', '--brief', 'Files: web/footer.html');
  fixtureAdd(box.run, box.repo, 'web', 'Header', '--specs', 'G1', '--brief', 'Files: web/header.html');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'header.html'), '<header>');
  const next = (await box.runLocal(box.web, 'next'));
  assert.match(next.out, /claimed #2: Header/);
  assert.match(next.out, /it touches a file you worked in recently: web\/header\.html/);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): header [G1]');
  commitFile(box, box.web, 'web/nav.html', '<nav>', 'feat(web): nav in the header [G1]');
  commitFile(box, box.repo, 'docs/notes.md', 'main moves on', 'docs: notes on main');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  assert.equal((await box.runLocal(box.web, 'submit', '2', '--no-next')).code, 0);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'show', '2', '--json')).out).item_files, 'web/header.html\nweb/nav.html', 'only the item\'s own commits, not the merge');
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  (await box.runLocal(box.repo, 'verify', '2', 'accept', '--no-next', '--note', 'emptied the header; the page lost it', '--as', 'coordinator'));
  box.git(box.repo, 'switch', '-q', 'main');
  const verifiedCommit = JSON.parse((await box.runLocal(box.repo, 'show', '2', '--json')).out).item_commit;
  box.git(box.repo, 'merge', '--no-ff', verifiedCommit, '-m', 'chore(merge): land #2 [G1]');
  assert.equal((await box.runLocal(box.repo, 'merged', '2', 'HEAD')).code, 0);
  fixtureAdd(box.run, box.repo, 'web', 'Menu', '--specs', 'G1', '--brief', 'Files: web/nav.html, web/menu.html');
  assert.match((await box.runLocal(box.repo, 'show', '3')).out, /related: #2 Header: web\/nav\.html \(git log -p -1 [0-9a-f]{12} -- web\/nav\.html\)/);
  const warm = (await box.runLocal(box.web, 'next'));
  assert.match(warm.out, /claimed #3: Menu/, 'a clean tree: the files of the items it built last are what is warm');
  assert.match(warm.out, /it touches a file you worked in recently: web\/nav\.html/);
});

test('hold pauses a lane: next names who held it and why; --off lets it go [N22]', async () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1');
  assert.match((await box.runLocal(box.web, 'hold', 'web', '--reason', 'mine')).err, /COORDINATOR_ONLY/);
  assert.match((await box.runLocal(box.repo, 'hold', 'nowhere', '--reason', 'x')).err, /NO_LANE/);
  assert.match((await box.runLocal(box.repo, 'hold', 'web', '--reason', 'G1 is being rewritten')).out, /holding the web lane: G1 is being rewritten/);
  const held = (await box.runLocal(box.web, 'next', '--take'));
  assert.equal(held.code, 1);
  assert.match(held.err, /coordinator \(unknown\) holds the web lane: G1 is being rewritten/);
  assert.match((await box.runLocal(box.web, 'claim', '1')).err, /LANE_HELD/);
  assert.match((await box.runLocal(box.web, 'resume')).out, /the web lane is held by coordinator \(unknown\): G1 is being rewritten/);
  assert.match((await box.runLocal(box.repo, 'hold', 'web', '--off')).out, /released the web lane/);
  assert.match((await box.runLocal(box.web, 'next')).out, /claimed #1: Page/);
});
