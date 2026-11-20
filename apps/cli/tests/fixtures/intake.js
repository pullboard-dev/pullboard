/** Private GitHub/Docker protocol stand-ins; neither is actual outside code or containment evidence. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { createE2eHelpers } from './e2e.js';
import { repoPath } from '../../../../packages/kernel/light.js';

/** Quote an owned fixture path for the tiny executable shim. */
function word(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Install a private executable without changing the real user's PATH or tools. */
function executable(box, name, source) {
  const script = join(box.dir, name + '.cjs');
  writeFileSync(script, source);
  const path = repoPath(box.dir, `bin/${name}`);
  writeFileSync(path, `#!/bin/sh\nexec ${word(process.execPath)} ${word(script)} "$@"\n`, { mode: 0o755 });
  return path;
}

/** Run a private CLI command that must succeed and parse its single JSON document. */
export function fixtureJSON(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return JSON.parse(result.out);
}

/** The same call as fixtureJSON, answered through box.runIn (in this process by default), so a journey starts no node process per call [C7]. */
export async function fixtureJSONIn(box, cwd, ...args) {
  const result = await box.runIn(cwd, ...args, '--json');
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return JSON.parse(result.out);
}

/** Build a real outside commit/ref and an independently initialized trusted receiving board. */
export function intakeFixture(t, { baseFiles = {} } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox();
  box.env.PULLBOARD_MODEL = 'private intake fixture model';
  box.env.HOME = join(box.dir, 'empty-host-home');
  mkdirSync(box.env.HOME);
  for (const name of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[name];
  // Fresh private canaries detect credential forwarding; they are never real account secrets.
  box.env.GH_TOKEN = randomUUID();
  box.env.HOST_SECRET = randomUUID();
  const made = helpers.project('node --test test/contribution.test.js', box);
  for (const [path, content] of Object.entries(baseFiles)) {
    mkdirSync(dirname(join(made.repo, path)), { recursive: true });
    writeFileSync(join(made.repo, path), content);
  }
  if (Object.keys(baseFiles).length) {
    box.git(made.repo, 'add', '-A');
    box.git(made.repo, 'commit', '-q', '-m', 'chore: seed trusted boundary fixture');
  }
  const base = box.git(made.repo, 'rev-parse', 'HEAD');
  const fork = join(box.dir, 'outside-fork');
  box.git(box.dir, 'clone', '-q', '--no-hardlinks', made.repo, fork);
  mkdirSync(join(fork, 'apps/relay/src/io/deploy'), { recursive: true });
  mkdirSync(join(fork, 'test'), { recursive: true });
  writeFileSync(join(fork, 'apps/relay/src/io/deploy/outside.js'), 'export const outside = true;\n');
  writeFileSync(join(fork, 'test/contribution.test.js'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { outside } from '../apps/relay/src/io/deploy/outside.js'; test('outside change [V2]',()=>assert.equal(outside,true));\n");
  box.git(fork, 'add', '-A');
  box.git(fork, 'commit', '-q', '--author', 'Outside Contributor <outside@example.test>', '-m', 'feat: outside fixture\n\nSigned-off-by: Outside Contributor <outside@example.test>');
  const commit = box.git(fork, 'rev-parse', 'HEAD');
  const tree = box.git(fork, 'rev-parse', 'HEAD^{tree}');
  const origin = join(box.dir, 'outside-origin.git');
  box.git(box.dir, 'clone', '-q', '--bare', made.repo, origin);
  box.git(origin, 'fetch', '-q', fork, 'HEAD:refs/pull/7/head');
  box.git(made.repo, 'remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  box.git(made.repo, 'config', `url.file://${origin}.insteadOf`, 'https://github.com/fixture/project.git');
  const facts = join(box.dir, 'github-facts.json');
  const ghLog = join(box.dir, 'github-calls.jsonl');
  const pull = { number: 7, title: 'Outside fixture change', state: 'open', body: 'Fixes #6',
    html_url: 'https://github.com/fixture/project/pull/7', user: { login: 'outside-contributor' },
    head: { sha: commit, ref: 'outside-change', repo: { clone_url: 'https://github.com/fixture/project.git' } },
    base: { sha: base, ref: 'main', repo: { full_name: 'fixture/project' } },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' };
  writeFileSync(facts, JSON.stringify({ pull, issue: { number: 6, title: 'Outside issue', body: 'The outside behavior works.', state: 'open',
    user: { login: 'issue-author' }, html_url: 'https://github.com/fixture/project/issues/6', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' } }));
  executable(box, 'gh', `const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(args)+'\\n');
const facts=JSON.parse(fs.readFileSync(${JSON.stringify(facts)},'utf8'));
const route=(args.find(arg=>arg.startsWith('repos/')||arg.startsWith('/repos/'))||'').replace(/^\\//,'').split('?')[0];
let value;
if(args[0]==='repo'&&args[1]==='view') value={nameWithOwner:'fixture/project',defaultBranchRef:{name:'main'}};
else if(args[0]!=='api'||args.includes('-X')||(args.includes('--method')&&args[args.indexOf('--method')+1]!=='GET')) { process.stderr.write('fixture refuses posting or unknown commands'); process.exit(2); }
else if(route==='repos/fixture/project/pulls/7') value=facts.pull;
else if(route==='repos/fixture/project/pulls/7/files') value=facts.files||[{filename:'apps/relay/src/io/deploy/outside.js',status:'added'},{filename:'test/contribution.test.js',status:'added'}];
else if(route==='repos/fixture/project/pulls/7/reviews') value=[];
else if(route==='repos/fixture/project/issues/6') value=facts.issue;
else if(route==='repos/fixture/project/issues/6/comments') value=facts.issueComments||[];
else if(route==='repos/fixture/project/issues/7/comments') value=[{user:{login:'maintainer'},author_association:'MEMBER',body:'Recorded for review.'}];
else if(route==='repos/fixture/project') value={full_name:'fixture/project',default_branch:'main',owner:{login:'fixture'}};
else { process.stderr.write('unrecognized fixture GitHub route '+route); process.exit(2); }
process.stdout.write(JSON.stringify(args.includes('--slurp')?[value]:value));\n`);
  return { ...made, ...box, base, commit, tree, fork, origin, facts, ghLog, pull };
}

/** Configure a Docker CLI protocol double, explicitly not a real container/runtime proof. */
export function configureFixtureSandbox(box, { images = null } = {}) {
  const dockerLog = join(box.dir, 'docker-calls.jsonl');
  const minimum = images?.minimum ?? 'node@sha256:' + '1'.repeat(64);
  const current = images?.current ?? 'node@sha256:' + '2'.repeat(64);
  const docker = executable(box, 'fixture-docker', `const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(dockerLog)},JSON.stringify({args,secret:process.env.HOST_SECRET??null,credential:process.env.GH_TOKEN??null})+'\\n');
const image=args.find(arg=>arg.includes('@sha256:'))||''; const minimum=image===${JSON.stringify(minimum)};
if(args[0]==='image'&&args[1]==='inspect') process.stdout.write(JSON.stringify([{Id:'sha256:'+(minimum?'a':'b').repeat(64),RepoDigests:[image],Config:{Env:['PATH=/usr/local/bin:/usr/bin:/bin']}}]));
else if(args[0]==='info') process.stdout.write(JSON.stringify({ServerVersion:'29.0.0',OSType:'linux'}));
else if(args[0]==='version') process.stdout.write('29.0.0');
else if(args[0]==='run') {
  const cid=args.indexOf('--cidfile'); if(cid>=0) fs.writeFileSync(args[cid+1],'c'.repeat(64));
  if(args.includes('--version')) process.stdout.write(minimum?'v22.13.1':'v24.21.0');
  else if(args.includes('-p')||args.includes('--eval')||args.some(arg=>arg.includes('node -p '))) process.stdout.write(JSON.stringify({node:minimum?'22.13.1':'24.21.0',platform:'linux',arch:'arm64'}));
  else { const baseline=args.includes('pullboard.sandbox.stage=baseline'); process.stdout.write('TAP version 13\\n'+(baseline?'not ok':'ok')+' 1 - fixture sandbox stage\\n1..1\\n# tests 1\\n# pass '+(baseline?'0':'1')+'\\n# fail '+(baseline?'1':'0')+'\\n# skipped 0\\n'); if(baseline) process.exitCode=1; }
} else if(args[0]==='inspect') process.stdout.write('[]');
else if(!['rm','kill'].includes(args[0])) { process.stderr.write('unknown fixture Docker command'); process.exit(2); }\n`);
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.sandbox = { provider: 'docker', executable: docker, endpoint: 'unix:///fixture/docker.sock', images: { minimum, current } };
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private stand-in sandbox');
  return { dockerLog, minimum, current };
}

/** Read only this fixture's recorded transport calls. */
export function calls(path) {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** Advance only this owned fork/ref and its public metadata; never execute its contributed program. */
export function advanceOutsideFixture(box, path, content, remove = []) {
  for (const deleted of remove) unlinkSync(join(box.fork, deleted));
  mkdirSync(dirname(join(box.fork, path)), { recursive: true });
  writeFileSync(join(box.fork, path), content);
  box.git(box.fork, 'add', '-A');
  box.git(box.fork, 'commit', '-q', '--author', 'Outside Contributor <outside@example.test>', '-m', 'feat: revise owned outside fixture\n\nSigned-off-by: Outside Contributor <outside@example.test>');
  const commit = box.git(box.fork, 'rev-parse', 'HEAD');
  box.git(box.origin, 'fetch', '-q', box.fork, '+HEAD:refs/pull/7/head');
  const facts = JSON.parse(readFileSync(box.facts, 'utf8'));
  facts.pull.head.sha = commit;
  facts.files = box.git(box.fork, 'diff', '--name-only', `${box.base}...${commit}`).split('\n').filter(Boolean).map(filename => ({ filename, status: 'added' }));
  writeFileSync(box.facts, JSON.stringify(facts));
  return { commit, tree: box.git(box.fork, 'rev-parse', 'HEAD^{tree}') };
}
