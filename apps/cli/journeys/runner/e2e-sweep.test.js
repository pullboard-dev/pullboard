/**
 * End to end on real repos: sweep, pre-commit, resume and next (N15, C5, N19, N20, N21).
 */
/** @pullboard-test-input source-cell apps/cli apps/lib store */

import assert from 'node:assert/strict';
import {
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
import {
  fixtureAdd,
  fixtureProjectPolicy,
} from '../../tests/fixtures/testkit.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, launch,
} = e2e;

/** Commit one file as fixture setup: git plumbing without the repository's hooks, which each cost a Node launch; no case here is about a hook except the pre-commit case, which commits through tryGit [C7]. */
function commitFile(box, cwd, path, text, message) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), text);
  box.git(cwd, 'add', '-A');
  return box.git(cwd, 'commit', '-q', '-m', message);
}

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
  fixtureProjectPolicy(box.repo, { config: { ...config, fix: [{ run: `node ${fixer}`, files: ['*.js'] }] } });
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
  fixtureProjectPolicy(box.repo, { config: { ...config, fix: [{ run: 'false', files: ['*.js'] }] } });
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
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--brief', 'Files: web/page.html');
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
  // A pulled submit queues its gate: the item is to verify once the local runner's receipt is applied [P7].
  await settledGateJob(box, 1);
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
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Footer', '--specs', 'G1', '--brief', 'Files: web/footer.html');
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Header', '--specs', 'G1', '--brief', 'Files: web/header.html');
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
  await settledGateJob(box, 2); // the pulled gate records the item's files when its receipt applies [C7,#7283]
  assert.equal(JSON.parse((await box.runLocal(box.web, 'show', '2', '--json')).out).item_files, 'web/header.html\nweb/nav.html', 'only the item\'s own commits, not the merge');
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  (await box.runLocal(box.repo, 'verify', '2', 'accept', '--no-next', '--note', 'emptied the header; the page lost it', '--as', 'coordinator'));
  box.git(box.repo, 'switch', '-q', 'main');
  const verifiedCommit = JSON.parse((await box.runLocal(box.repo, 'show', '2', '--json')).out).item_commit;
  box.git(box.repo, 'merge', '--no-ff', verifiedCommit, '-m', 'chore(merge): land #2 [G1]');
  assert.equal((await box.runLocal(box.repo, 'merged', '2', 'HEAD')).code, 0);
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Menu', '--specs', 'G1', '--brief', 'Files: web/nav.html, web/menu.html');
  assert.match((await box.runLocal(box.repo, 'show', '3')).out, /related: #2 Header: web\/nav\.html \(git log -p -1 [0-9a-f]{12} -- web\/nav\.html\)/);
  const warm = (await box.runLocal(box.web, 'next'));
  assert.match(warm.out, /claimed #3: Menu/, 'a clean tree: the files of the items it built last are what is warm');
  assert.match(warm.out, /it touches a file you worked in recently: web\/nav\.html/);
});
