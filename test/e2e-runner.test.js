/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, startFixtureChild as spawn, runFixtureChild as spawnSync } from './fixture-child.js';
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
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseSpec } from '../src/spec.js';
import { checkAtCommit } from '../src/trusted-policy.js';
import * as store from '../src/board.js';

import { createE2eHelpers } from './e2e-helpers.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('an item carries a brief to whoever claims it; a light agent sees only its tier [B10, B13, B14]', () => {
  const box = project();
  writeFileSync(join(box.dir, 'brief.md'), LIGHT_BRIEF);
  assert.equal(box.run(box.repo, 'add', 'web', 'Design', 'the', 'page', '--specs', 'G1').code, 0);
  assert.match(box.run(box.repo, 'add', 'web', 'Copy', '--route', 'light', '--brief-file', join(box.dir, 'brief.md')).err, /NO_BRIEF.*--criterion.*--check/);
  assert.match(box.run(box.repo, 'add', 'web', 'Copy', '--brief', 'x', '--brief-file', 'y').err, /USAGE.*give the brief once/);
  const foreign = box.run(box.repo, 'add', 'web', 'Copy', '--route', 'light', '--criterion', 'c', '--check', 'true', '--brief', LIGHT_BRIEF.replace('web/page.js', 'api/server.js'));
  assert.match(foreign.err, /BRIEF_LANE.*api\/server.js \(api's\)/);
  const added = box.run(box.repo, 'add', 'web', 'Copy', 'the', 'header', '--route', 'light', '--criterion', 'the page shows the header', '--check', 'test -f web/page.js', '--brief-file', join(box.dir, 'brief.md'), '--wait');
  assert.equal(added.code, 0, added.err);
  assert.equal(added.out.trim(), `#2\ncheck baseline red at main ${box.git(box.repo, 'rev-parse', 'main')}: test -f web/page.js`);
  assert.match(box.run(box.repo, 'list').out, /#2 {2}open {2}web {2}Copy the header {2}light/);
  assert.doesNotMatch(box.run(box.repo, 'list', '--route', 'light').out, /Design the page/);
  const made = box.run(box.repo, 'worktree', 'web', '--route', 'light');
  assert.match(made.out, /joined as web-2 in the web lane, on the light route/);
  const light = made.out.match(/^made (\S+) /)[1];
  assert.match(box.run(light, 'whoami').out, /^web-2 \(web lane, light route\)/);
  const next = box.run(light, 'next');
  assert.match(next.out, /claimed #2: Copy the header\ncriterion: the page shows the header\ncheck: test -f web\/page.js {3}\(run it before you submit\)\nbrief:\n {2}Files:\n {2}- web\/page.js/);
  assert.match(box.run(light, 'claim', '1').err, /ROUTE/);
  assert.match(box.run(box.web, 'next').out, /claimed #1: Design the page/);
  assert.equal(box.run(box.repo, 'edit', '1', '--brief', 'Start from the sketch in docs/page.md.').code, 0);
  assert.match(box.run(box.web, 'show', '1').out, /brief:\n {2}Start from the sketch in docs\/page.md./);
  assert.match(box.run(box.web, 'edit', '2', '--brief', 'mine').err, /NOT_YOURS/);
});

test('run builds routed items unattended: the failure feeds the next attempt; red work escalates, pinned [N14, B15]', () => {
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
  assert.equal(box.run(box.repo, 'add', 'web', 'Greet', 'on', 'the', 'page', '--specs', 'G1', '--route', 'light', '--criterion', 'the page says Hi', '--check', has('web/page.js', 'Hi'), '--brief', brief('web/page.js')).code, 0);
  assert.equal(box.run(box.repo, 'add', 'web', 'Say', 'bye', '--route', 'light', '--criterion', 'the footer says Bye', '--check', has('web/footer.js', 'Bye'), '--brief', brief('web/footer.js')).code, 0);
  const made = box.run(box.repo, 'worktree', 'web', '--route', 'light');
  const light = made.out.match(/^made (\S+) /)[1];
  assert.match(box.run(box.repo, 'run', '--agent', `sh ${agent}`).err, /MAIN_IS_COORDINATOR/);
  assert.match(box.run(light, 'run', '--agent-mid', `sh ${agent}`).err, /ROUTE.*joined on the light route, so it cannot take mid items/);
  const ran = box.run(light, 'run', '--agent-light', `sh ${agent}`, '--attempts', '2', '--minutes', '2');
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /#1 attempt 1: red[\s\S]*#1 attempt 2: green \(agent \d+s, check \d+s\)\nsubmitted #1/);
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
  const shown = box.run(box.repo, 'show', '2').out;
  assert.match(shown, /#2 {2}open {2}web {2}Say bye {2}mid/);
  assert.match(shown, /unattended attempts: red, red/);
  assert.match(shown, /escalated light -> mid by web-2, pinned at refs\/pullboard\/attempts\/2\/[0-9a-f]{12}: 2 attempts stayed red/);
  assert.match(box.run(box.repo, 'inbox').out, /web-2 -> coordinator: #2 escalated light -> mid after 2 red attempts/);
});

test('one runner climbs the tiers: an escalated item goes to the next command, with the earlier tries; it merges the verified work an item waits on [N16]', () => {
  const box = project();
  const script = (name, lines) => {
    writeFileSync(join(box.dir, name), ['#!/bin/sh', 'mkdir -p web api', ...lines, ''].join('\n'));
    return `sh ${join(box.dir, name)}`;
  };
  const good = script('web.sh', ["echo \"export const title = 'Hi';\" > web/page.js"]);
  const weak = script('weak.sh', ['echo nope > api/server.js']);
  const strong = script('strong.sh', ['grep -q "Earlier tries by a lighter model" "$PULLBOARD_PACK" && echo "export const served = true;" > api/server.js']);
  const brief = (file) => LIGHT_BRIEF.replace('web/page.js', file);
  box.run(box.repo, 'add', 'web', 'Greet', '--route', 'light', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', brief('web/page.js'));
  box.run(box.repo, 'add', 'api', 'Serve', 'the', 'page', '--after', '1', '--route', 'light', '--criterion', 'serves it', '--check', 'test -f web/page.js && grep -q served api/server.js', '--brief', brief('api/server.js'));
  const webRunner = box.run(box.repo, 'worktree', 'web', '--route', 'light').out.match(/^made (\S+) /)[1];
  assert.match(box.run(webRunner, 'run', '--agent-light', good, '--attempts', '1').out, /submitted #1/);
  const commit = JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', commit);
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--note', 'ran the check, then emptied the file and saw it fail').out, /verified #1/);
  const apiRunner = box.run(box.repo, 'worktree', 'api', '--route', 'mid').out.match(/^made (\S+) /)[1];
  const ran = box.run(apiRunner, 'run', '--agent-light', weak, '--agent-mid', strong, '--attempts', '2', '--minutes', '2');
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /#2 attempt 1\/2: running the light agent[\s\S]*#2 escalated light -> mid[\s\S]*#2 attempt 1\/2: running the mid agent\n#2 attempt 1: green[\s\S]*submitted #2/);
  assert.match(ran.out, /runner done: 1 submitted, 1 escalated/);
  assert.equal(box.tryGit(apiRunner, 'merge-base', '--is-ancestor', commit, 'HEAD').status, 0);
  const packs = join(box.dir, 'repo', '.git', 'worktrees', apiRunner.split('/').at(-1), 'pullboard', 'packs');
  assert.match(readFileSync(join(packs, '2-mid-1.md'), 'utf8'), /## Earlier tries by a lighter model\n- 2 attempts stayed red/);
  assert.equal(existsSync(join(packs, '2-light-1.md')), true);
});

test('the runner returns a claimed dependent item when its verified dependency conflicts [B8,V1,R1]', () => {
  const box = project();
  const localRunner = box.run(box.repo, 'worktree', 'api', '--route', 'light').out.match(/^made (\S+) /)[1];
  const dependencyRunner = box.run(box.repo, 'worktree', 'api', '--route', 'light').out.match(/^made (\S+) /)[1];
  mkdirSync(join(localRunner, 'api'));
  writeFileSync(join(localRunner, 'api', 'server.js'), "export const source = 'local';\n");
  box.git(localRunner, 'add', 'api/server.js');
  box.git(localRunner, 'commit', '-q', '-m', 'feat(api): local server variant [G2]');

  const brief = LIGHT_BRIEF.replace('web/page.js', 'api/server.js');
  box.run(box.repo, 'add', 'api', 'Upstream API', '--route', 'light', '--specs', 'G2', '--criterion', 'serves the upstream API',
    '--check', 'grep -q upstream api/server.js', '--brief', brief);
  const upstreamAgent = `sh ${join(box.dir, 'upstream.sh')}`;
  writeFileSync(join(box.dir, 'upstream.sh'), '#!/bin/sh\nmkdir -p api\nprintf "export const source = upstream;\\n" > api/server.js\n');
  assert.match(box.run(dependencyRunner, 'run', '--agent-light', upstreamAgent, '--attempts', '1').out, /submitted #1/);
  const dependencyCommit = JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', dependencyCommit);
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--note', 'The exact upstream API check passed.').out, /verified #1/);

  box.run(box.repo, 'add', 'api', 'Dependent API', '--after', '1', '--route', 'light', '--specs', 'G2', '--criterion', 'integrates upstream API',
    '--check', 'grep -q upstream api/server.js', '--brief', brief);
  const blocked = box.run(localRunner, 'run', '--agent-light', 'true', '--attempts', '1');
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.err, /MERGE_CONFLICT/);
  assert.equal(JSON.parse(box.run(box.repo, 'show', '2', '--json').out).item_status, 'open', 'the automatic claimed-item release remains unchanged');
});

test('sweep files one light item per flagged file, in its lane; a second sweep skips what is open [N15]', () => {
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
  assert.match(box.run(box.web, ...sweep).err, /COORDINATOR_ONLY/);
  assert.match(box.run(box.repo, ...sweep, '--dry-run').out, /would file: fix 2 problems in web\/a.js \(web lane, light\)/);
  const filed = box.run(box.repo, ...sweep);
  assert.equal(filed.code, 0, filed.err);
  assert.match(filed.out, /#1 fix 2 problems in web\/a.js \(web lane, light\)\n#2 fix 1 problem in api\/b.js \(api lane, light\)/);
  assert.match(filed.out, /3 problems in 2 files; filed 2/);
  const shown = box.run(box.repo, 'show', '1').out;
  assert.match(shown, new RegExp(`check: node ${join(box.dir, 'novar.mjs')} web/a.js`));
  assert.match(shown, /- line 2:1 no-var: Unexpected var, use let or const\./);
  assert.match(box.run(box.repo, ...sweep).out, /already open: web\/a.js, api\/b.js\n3 problems in 2 files; filed 0/);
  commitFile(box, box.repo, 'docs/c.js', 'var d = 4;\n', 'chore: one more var');
  const blind = box.run(box.repo, 'sweep', '--run', `node ${join(box.dir, 'novar.mjs')} .`, '--check', `node ${join(box.dir, 'novar.mjs')} {file} | tail -5`);
  assert.equal(blind.code, 1);
  assert.match(blind.err, /CHECK_CANNOT_FAIL\] the check passes on docs\/c.js although the checker flags problems there/);
  assert.match(blind.out, /filed 0/);
  const machineBlind = box.run(box.repo, 'sweep', '--run', `node ${join(box.dir, 'novar.mjs')} .`, '--check', `node ${join(box.dir, 'novar.mjs')} {file} | tail -5`, '--json');
  assert.equal(machineBlind.code, 1);
  const next = JSON.parse(machineBlind.out).error.next;
  assert.equal(next, 'Fix the check so flagged files make it fail, then run pullboard sweep again.');
  assert.ok(blind.err.trimEnd().endsWith(next), blind.err);
});

test('pre-commit runs the fixers on fully staged files and restages them; partly staged files are left alone [C5]', () => {
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

test('resume puts an agent back to work from the board: its claim, its branch, what came back, the next step [N19]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--brief', 'Files: web/page.html');
  const fresh = box.run(box.web, 'resume');
  assert.equal(fresh.code, 0, fresh.err);
  assert.match(fresh.out, /^resume: web-1, web lane, at /);
  assert.match(fresh.out, /branch web\/one: 0 ahead of main, 0 behind/);
  assert.match(fresh.out, /next: pullboard next \(1 ready in your lane\)/);
  box.run(box.web, 'next');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'page.html'), '<h1>Hi</h1>');
  box.run(box.repo, 'shout', 'web-1', 'the heading text is in G1');
  const building = box.run(box.web, 'resume').out;
  assert.match(building, /1 file uncommitted/);
  assert.match(building, /holding #1 Page, lease \d+[mh] left/);
  assert.match(building, /files: web\/page\.html/);
  assert.match(building, /1 unread shout; newest from coordinator: the heading text is in G1/);
  assert.match(building, /next: build #1, commit, then pullboard submit 1/);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): page [G1]');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  const coordinator = box.run(box.repo, 'resume').out;
  assert.match(coordinator, /^resume: coordinator, coordinator lane, the main checkout/);
  assert.match(coordinator, /to verify: #1 web \(\d+[mhd]\)/);
  assert.match(coordinator, /next: pullboard next --verify --as coordinator/);
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note', 'no test proves the heading\nthe rest is fine', '--as', 'coordinator');
  const back = box.run(box.web, 'resume').out;
  assert.match(back, /branch web\/one: main is detached for a verification/);
  box.git(box.repo, 'switch', '-q', 'main');
  assert.match(box.run(box.web, 'resume').out, /branch web\/one: 1 ahead of main, 0 behind/);
  assert.match(back, /sent back: #1 TEST_FAILURE by coordinator: no test proves the heading$/m);
  assert.match(back, /next: pullboard claim 1, fix what the verifier found, and submit again/);
});

test('next takes work near your recent files; submit records them; show names related verified work [N20, N21]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Footer', '--specs', 'G1', '--brief', 'Files: web/footer.html');
  box.run(box.repo, 'add', 'web', 'Header', '--specs', 'G1', '--brief', 'Files: web/header.html');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'header.html'), '<header>');
  const next = box.run(box.web, 'next');
  assert.match(next.out, /claimed #2: Header/);
  assert.match(next.out, /it touches a file you worked in recently: web\/header\.html/);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): header [G1]');
  commitFile(box, box.web, 'web/nav.html', '<nav>', 'feat(web): nav in the header [G1]');
  commitFile(box, box.repo, 'docs/notes.md', 'main moves on', 'docs: notes on main');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  assert.equal(box.run(box.web, 'submit', '2').code, 0);
  assert.equal(JSON.parse(box.run(box.web, 'show', '2', '--json').out).item_files, 'web/header.html\nweb/nav.html', 'only the item\'s own commits, not the merge');
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  box.run(box.repo, 'verify', '2', 'accept', '--note', 'emptied the header; the page lost it', '--as', 'coordinator');
  box.git(box.repo, 'switch', '-q', 'main');
  box.run(box.repo, 'add', 'web', 'Menu', '--specs', 'G1', '--brief', 'Files: web/nav.html, web/menu.html');
  assert.match(box.run(box.repo, 'show', '3').out, /related: #2 Header: web\/nav\.html \(git log -p -1 [0-9a-f]{12} -- web\/nav\.html\)/);
  const warm = box.run(box.web, 'next');
  assert.match(warm.out, /claimed #3: Menu/, 'a clean tree: the files of the items it built last are what is warm');
  assert.match(warm.out, /it touches a file you worked in recently: web\/nav\.html/);
});

test('hold pauses a lane: next names who held it and why; --off lets it go [N22]', () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1');
  assert.match(box.run(box.web, 'hold', 'web', '--reason', 'mine').err, /COORDINATOR_ONLY/);
  assert.match(box.run(box.repo, 'hold', 'nowhere', '--reason', 'x').err, /NO_LANE/);
  assert.match(box.run(box.repo, 'hold', 'web', '--reason', 'G1 is being rewritten').out, /holding the web lane: G1 is being rewritten/);
  const held = box.run(box.web, 'next');
  assert.equal(held.code, 1);
  assert.match(held.err, /coordinator holds the web lane: G1 is being rewritten/);
  assert.match(box.run(box.web, 'claim', '1').err, /LANE_HELD/);
  assert.match(box.run(box.web, 'resume').out, /the web lane is held by coordinator: G1 is being rewritten/);
  assert.match(box.run(box.repo, 'hold', 'web', '--off').out, /released the web lane/);
  assert.match(box.run(box.web, 'next').out, /claimed #1: Page/);
});
