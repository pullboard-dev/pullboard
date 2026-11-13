/** Real private Git, SQLite and loopback GitHub-protocol fixtures [B3,R3]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from './e2e.js';
import { startFixtureChild } from './child.js';
import { fixtureAdd } from './testkit.js';
import { joinFixtureSeat } from './testkit.js';

/** Run the actual CLI without blocking the loopback provider's event loop. */
export async function runBridgeCLI(box, ...args) {
  return runBridgeCLIAs(box, { cwd: box.repo, env: box.env }, ...args);
}

/** Run one fixture command in an explicitly scoped shell, without changing the shared fixture environment. */
export async function runBridgeCLIAs(box, { cwd = box.repo, env = box.env } = {}, ...args) {
  const child = startFixtureChild(process.execPath, [box.BIN, ...args],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
  const [code, signal] = await once(child, 'close');
  return { code, signal, out, err };
}

/** Configure a private repo whose proof is an actual bounded test of tracked content. */
export function bridgeProject(t, mode = 'release') {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const scratch = helpers.sandbox();
  const gate = join(scratch.dir, 'bridge-gate.mjs');
  const gateCalls = join(scratch.dir, 'gate-calls.jsonl');
  /** Read the same immutable gate log without changing its raw bytes or missing-file behavior. */
  function readGateCalls() {
    return readFileSync(gateCalls, 'utf8');
  }
  writeFileSync(gate, [
    "import { readFileSync, appendFileSync } from 'node:fs';",
    "import { execFileSync } from 'node:child_process';",
    `appendFileSync(${JSON.stringify(gateCalls)}, JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }) + '\\n');`,
    "let red = false; for (const file of ['web/one.js', 'web/two.js', 'web/three.js']) { try { if (readFileSync(file, 'utf8').includes('RED')) red = true; } catch (error) { if (error.code !== 'ENOENT') throw error; } }",
    "console.log('TAP version 13'); console.log((red ? 'not ok' : 'ok') + ' 1 - bridge project content stays green');",
    "console.log('1..1'); console.log('# tests 1'); console.log('# pass ' + (red ? 0 : 1)); console.log('# fail ' + (red ? 1 : 0)); console.log('# skipped 0'); process.exitCode = red ? 1 : 0;",
  ].join('\n'));
  const box = helpers.project(`node ${JSON.stringify(gate)}`, scratch);
  // Submit proves synchronously here: a queued handoff would verify before any proof receipt exists.
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { ...config.submit, handoff: false } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: submit proves synchronously in the bridge fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const published = box.git(remote, 'rev-parse', 'main');
  // URL rewriting is confined to this private repo: the production bridge sees a GitHub remote,
  // while every real Git transfer goes only to the owned local bare repository.
  box.git(box.repo, 'remote', 'set-url', 'origin', 'https://github.com/fixture/repository.git');
  box.git(box.repo, 'config', `url.${remote}.insteadOf`, 'https://github.com/fixture/repository.git');
  return { ...box, ...helpers, remote, published, gateCalls, readGateCalls, mode };
}

/** Opt in through a real coordinator commit, or the new item merge before its landing receipt. */
function enableBridgeMode(box, item) {
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, publish: { pullRequest: box.mode }, approvers: ['fixture-person'] }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  if (item) {
    assert.equal(box.git(box.repo, 'show', '-s', '--format=%P', 'HEAD').split(' ').length, 2,
      'the coordinator adds configuration to the new merge before recording it, not a recorded item');
    assert.match(box.git(box.repo, 'show', '-s', '--format=%B', 'HEAD'),
      new RegExp(`^Pullboard-Item: #${item}$`, 'mu'));
  }
  box.git(box.repo, 'commit', '-q', ...(item ? ['--amend', '--no-edit']
    : ['-m', 'chore: opt in to private pull request bridge [G1]']));
}

/** Build, verify and locally land two real items before enabling the opt-in publisher. */
export function landBridgeItems(box, { independent = false, briefs = [] } = {}) {
  const entries = [];
  for (const [index, name] of ['one', 'two'].entries()) {
    const path = index === 0 ? box.web : join(box.dir, 'web-two');
    if (index) {
      box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/two', path, 'main');
      assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
    }
    if (independent) {
      const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
      try {
        store.register(board, { lane: 'coordinator', path: box.repo, parent: 'fixture-pr-reviewer' });
        store.register(board, { lane: 'web', path, parent: `fixture-pr-builder-${index}` });
      } finally { store.closeBoard(board); }
    }
    const add = fixtureAdd(box.run, box.repo, 'web', `private bridge ${name}`, '--specs', 'G1',
      '--criterion', `private ${name} remains correct`, '--check', 'test ! -f RED', '--route', 'strong',
      ...(briefs[index] === undefined ? [] : ['--brief', briefs[index]]), '--json');
    assert.equal(add.code, 0, add.err);
    const id = JSON.parse(add.out).item.item_id;
    assert.equal(box.run(path, 'claim', String(id)).code, 0);
    const file = `web/${name}.js`;
    assert.equal(box.commitFile(box, path, file, "export const result = 'PASS';\n", `feat(web): bridge ${name} [G1]`).status, 0);
    const commit = box.git(path, 'rev-parse', 'HEAD');
    const submitted = box.run(path, 'submit', String(id));
    assert.equal(submitted.code, 0, submitted.err);
    box.git(box.repo, 'switch', '-q', '--detach', commit);
    try {
      const reviewed = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'private bridge proof passed');
      assert.equal(reviewed.code, 0, reviewed.err);
    } finally { box.git(box.repo, 'switch', '-q', 'main'); }
    box.git(box.repo, 'merge', '-q', '--no-ff', '-m', `chore(merge): private bridge ${name} [G1]`, ...(independent ? ['-m', `Pullboard-Item: #${id}`] : []), commit);
    if (independent && index === 0) enableBridgeMode(box, id);
    const merged = box.run(box.repo, 'merged', String(id), box.git(box.repo, 'rev-parse', 'HEAD'));
    assert.equal(merged.code, 0, merged.err);
    entries.push({ id, commit, file });
  }
  if (!independent) enableBridgeMode(box);
  return entries;
}

/** Stand in for GitHub over real HTTP, refusing every merge endpoint. */
export async function bridgeProvider(t, box) {
  const state = { requests: [], pulls: [], checks: [], statuses: [], annotations: [], annotationsByRun: {}, next: 1,
    references: { pulls: { 7: { number: 7, user: { login: 'pr-author' } } },
      issues: { 6: { number: 6, user: { login: 'issue-author' } } } } };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://localhost');
    state.requests.push({ method: req.method, path: url.pathname, body });
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname.endsWith('/merge') && req.method !== 'GET') return reply(403, { message: 'agents never merge' });
    if (url.pathname === '/repos/fixture/repository/pulls') {
      if (req.method === 'GET') return reply(200, state.pulls.filter(p => p.state === (url.searchParams.get('state') ?? 'open') &&
        (!url.searchParams.get('head') || url.searchParams.get('head') === 'fixture:' + p.head.ref)));
      if (req.method === 'POST') {
        const head = box.git(box.remote, 'rev-parse', `refs/heads/${body.head}`);
        const pull = { number: state.next++, html_url: `https://github.com/fixture/repository/pull/${state.next - 1}`,
          title: body.title, body: body.body, state: 'open', merged: false, user: { login: 'pr-author' },
          head: { ref: body.head, sha: head }, base: { ref: body.base, sha: box.git(box.remote, 'rev-parse', body.base) }, merged_by: null, merge_commit_sha: null };
        state.pulls.push(pull); return reply(201, pull);
      }
    }
    const commitsRoute = /^\/repos\/fixture\/repository\/pulls\/(\d+)\/commits$/u.exec(url.pathname);
    if (commitsRoute) {
      const pull = state.pulls.find(p => p.number === Number(commitsRoute[1]));
      const commits = box.git(box.remote, 'rev-list', `${pull.base.sha}..${pull.head.sha}`).split('\n').filter(Boolean);
      return reply(200, commits.slice((Number(url.searchParams.get('page') ?? 1) - 1) * 100,
        Number(url.searchParams.get('page') ?? 1) * 100).map(sha => ({ sha })));
    }
    if (/\/issues\/\d+\/comments$/u.test(url.pathname) || /\/pulls\/\d+\/reviews$/u.test(url.pathname)) return reply(200, []);
    const filesRoute = /\/pulls\/(\d+)\/files$/u.exec(url.pathname);
    if (filesRoute) {
      const pull = state.pulls.find(p => p.number === Number(filesRoute[1]));
      const files = box.git(box.remote, 'diff', '--name-only', `${pull.base.sha}...${pull.head.sha}`).split('\n').filter(Boolean);
      return reply(200, files.map(filename => ({ filename })));
    }
    const issueRoute = /^\/repos\/fixture\/repository\/issues\/(\d+)$/u.exec(url.pathname);
    if (issueRoute && req.method === 'GET') {
      const issue = state.references.issues[issueRoute[1]];
      return issue ? reply(200, issue) : reply(404, { message: 'missing private issue' });
    }
    const pullRoute = /^\/repos\/fixture\/repository\/pulls\/(\d+)$/u.exec(url.pathname);
    if (pullRoute) {
      const pull = state.pulls.find(p => p.number === Number(pullRoute[1]));
      if (!pull) {
        const reference = state.references.pulls[pullRoute[1]];
        return reference ? reply(200, reference) : reply(404, { message: 'missing private pull' });
      }
      if (req.method === 'PATCH') {
        Object.assign(pull, { title: body.title, body: body.body });
        pull.head.sha = box.git(box.remote, 'rev-parse', `refs/heads/${pull.head.ref}`);
      }
      pull.commits = box.git(box.remote, 'rev-list', `${pull.base.sha}..${pull.head.sha}`).split('\n').filter(Boolean).length;
      return reply(200, pull);
    }
    const statusRoute = /^\/repos\/fixture\/repository\/statuses\/([a-f0-9]+)$/u.exec(url.pathname);
    if (statusRoute && req.method === 'POST') {
      const status = { ...body, sha: statusRoute[1] };
      state.statuses.push(status); return reply(201, status);
    }
    if (/\/commits\/[a-f0-9]+\/check-runs$/u.test(url.pathname)) return reply(200, { total_count: state.checks.length, check_runs: state.checks });
    const annotations = /\/check-runs\/(\d+)\/annotations$/u.exec(url.pathname);
    if (annotations) return reply(200, state.annotationsByRun[annotations[1]] ?? state.annotations);
    if (/\/commits\/[a-f0-9]+\/status$/u.test(url.pathname)) {
      const sha = url.pathname.split('/').at(-2);
      const statuses = [...new Map(state.statuses.filter(status => status.sha === sha).map(status => [status.context, status])).values()];
      return reply(200, { state: statuses.some(status => status.state !== 'success') ? 'failure' : 'success', statuses });
    }
    return reply(404, { message: 'unexpected private provider endpoint' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adapter = join(box.dir, 'private-gh.mjs');
  writeFileSync(adapter, [
    "const args=process.argv.slice(2); if(args[0]!=='api') throw new Error('only gh api is permitted');",
    "const endpoint=args.find(a=>a.startsWith('repos/')); if(!endpoint) throw new Error('missing API endpoint');",
    "const i=args.indexOf('--method'); const method=i<0?'GET':args[i+1]; let input=''; if(args.includes('--input'))for await(const chunk of process.stdin)input+=chunk;",
    `const response=await fetch(${JSON.stringify(origin)}+'/'+endpoint,{method,headers:{'content-type':'application/json'},...(input?{body:input}:{})});`,
    "process.stdout.write(await response.text()); if(!response.ok)process.exitCode=1;",
  ].join('\n'));
  const shim = join(box.dir, 'bin/gh');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${adapter}" "$@"\n`);
  chmodSync(shim, 0o755);
  return state;
}

/** Fix only the linked private repair through the same real item lifecycle. */
export function landBridgeRepair(box, id, file, { independent = false } = {}) {
  const path = join(box.dir, `repair-${id}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/repair-${id}`, path, 'main');
  assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
  if (independent) {
    const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
    try { store.register(board, { lane: 'web', path, parent: 'fixture-pr-repair-builder' }); }
    finally { store.closeBoard(board); }
  }
  const edited = box.run(box.repo, 'edit', String(id), '--criterion', 'the private CI finding is repaired',
    '--check', 'test ! -f RED', '--brief', 'Change the named private web fixture and retain the linked finding.');
  assert.equal(edited.code, 0, edited.err);
  assert.equal(box.run(path, 'claim', String(id)).code, 0);
  assert.equal(box.commitFile(box, path, file, "export const result = 'PASS FIXED';\n", 'fix(web): repair private CI finding [G1]').status, 0);
  const commit = box.git(path, 'rev-parse', 'HEAD');
  const submitted = box.run(path, 'submit', String(id));
  assert.equal(submitted.code, 0, submitted.err);
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const accepted = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'private repair proof passed');
    assert.equal(accepted.code, 0, accepted.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  box.git(box.repo, 'merge', '-q', '--no-ff', '-m', 'chore(merge): land private CI repair [G1]', ...(independent ? ['-m', `Pullboard-Item: #${id}`] : []), commit);
  const merged = box.run(box.repo, 'merged', String(id), box.git(box.repo, 'rev-parse', 'HEAD'));
  assert.equal(merged.code, 0, merged.err);
  return commit;
}

/** Perform an actual private merge outside the product, with a separately reported provider actor. */
export function mergeBridgeAs(box, pull, actor, type = 'User') {
  const person = join(box.dir, `person-${pull.number}`);
  box.git(box.dir, 'clone', '-q', '--branch', 'main', box.remote, person);
  box.git(person, 'fetch', '-q', 'origin', pull.head.ref);
  box.git(person, 'merge', '-q', '--no-ff', '-m', 'chore: external private proposal merge [G1]', 'FETCH_HEAD');
  box.git(person, 'push', '-q', 'origin', 'main');
  pull.state = 'closed'; pull.merged = true;
  pull.merge_commit_sha = box.git(person, 'rev-parse', 'HEAD');
  pull.merged_by = { login: actor, type, id: pull.number + 1000 };
}

/** Read the real private gate invocations, retaining their exact Git heads. */
export function gateHeads(box) {
  return box.readGateCalls().trim().split('\n').map(line => JSON.parse(line).head);
}
