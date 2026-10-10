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
import { fetchFresh } from './http-fixture.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('view serves every project on this machine, on loopback, behind its secret and its own Host [N26, I8]', async () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  box.run(box.repo, 'shout', 'web-1', 'the heading is in G1');
  const registry = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'projects.json'), 'utf8'));
  assert.deepEqual(registry.projects.map((entry) => entry.root), [box.repo]);
  const view = await startView(box, box.repo);
  try {
    assert.equal((await fetchFresh(`${view.base}/`)).status, 403, 'no secret');
    const badSecret = await fetchFresh(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': 'guess' } });
    assert.equal(badSecret.status, 401, 'a wrong secret');
    assert.equal((await badSecret.json()).error.code, 'AUTH_REQUIRED');
    const page = await view.page();
    assert.match(await page.text(), /<title>Pullboard<\/title>/);
    const { boards, warnings, project: shown } = await view.state(box.repo);
    assert.deepEqual(boards.map((entry) => [entry.root, entry.name]), [[box.repo, 'repo']]);
    assert.deepEqual(warnings, []);
    assert.equal(shown.items.filter((item) => item.status === 'open').length, 1);
    assert.deepEqual(shown.items.map((item) => [item.id, item.title, item.status, item.specs]), [[1, 'Page', 'open', ['G1']]]);
    assert.equal(shown.shouts[0].shout_text, 'the heading is in G1');
    assert.deepEqual(shown.spec.map((row) => [row.id, row.status]), [['G1', 'approved'], ['G2', 'approved']]);
    assert.ok(shown.agents.some((agent) => agent.agent_id === 'web-1'));
    const rebound = await new Promise((done) => {
      request({ host: '127.0.0.1', port: view.link.port, path: '/api/v1/boards', headers: { host: `evil.example:${view.link.port}`, 'x-pullboard-key': view.key } }, (res) => done(res.statusCode)).end();
    });
    assert.equal(rebound, 401, 'the right secret from another Host, as DNS rebinding would send it');
  } finally {
    await view.stop();
  }
});

test('from the view the person adds items, shouts and holds lanes, through the CLI and its refusals [N27]', async () => {
  const box = project();
  const view = await startView(box, box.repo);
  try {
    const added = await view.act(box.repo, { verb: 'add', args: { lane: 'web', title: 'From the view', specs: 'G1' } });
    assert.equal(added.status, 200, JSON.stringify(added.document));
    assert.equal(added.document.event.event_kind, 'add');
    assert.equal(added.document.result.item.item_title, 'From the view');
    assert.equal(JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_title, 'From the view');
    const refused = await view.act(box.repo, { verb: 'add', args: { lane: 'web', title: 'Ghost', specs: 'Z9' } });
    assert.equal(refused.status, 409);
    assert.equal(refused.document.error.code, 'UNKNOWN_SPEC');
    const shouted = await view.act(box.repo, { verb: 'shout', args: { to: 'web', text: 'from the person' } });
    assert.equal(shouted.status, 200);
    assert.equal(shouted.document.event.event_kind, 'shout');
    assert.match(box.run(box.web, 'inbox').out, /coordinator \(unknown\) -> web: from the person/);
    const held = await view.act(box.repo, { verb: 'hold', args: { lane: 'web', reason: 'G1 is changing' } });
    assert.equal(held.status, 200);
    assert.equal(held.document.event.event_kind, 'hold');
    assert.equal(held.document.event.event_by, 'person');
    assert.equal(JSON.parse(held.document.event.event_detail).channel, 'view');
    assert.match(box.run(box.web, 'next').err, /person holds the web lane: G1 is changing/);
    const released = await view.act(box.repo, { verb: 'hold', args: { lane: 'web', off: true } });
    assert.equal(released.status, 200);
    assert.equal(released.document.event.event_kind, 'unhold');
    assert.equal(released.document.event.event_by, 'person');
    assert.equal(JSON.parse(released.document.event.event_detail).channel, 'view');
    const unknown = await view.act(box.dir, { verb: 'shout', args: { to: 'all', text: 'x' } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.document.error.code, 'NO_BOARD');
    const before = await view.state(box.repo);
    const target = before.boards.find((entry) => entry.root === box.repo);
    const stranger = await fetchFresh(`${view.base}/api/v1/boards/${encodeURIComponent(target.id)}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'shout', args: { to: 'all', text: 'unauthorized move' } }),
    });
    assert.equal(stranger.status, 401);
    assert.equal((await stranger.json()).error.code, 'AUTH_REQUIRED');
    assert.deepEqual((await view.state(box.repo)).project.shouts, before.project.shouts, 'an unauthenticated move cannot write a shout');
  } finally {
    await view.stop();
  }
});

test('the view answers a request line no URL parser accepts with 403, and keeps serving [N26]', async () => {
  const box = project();
  const view = await startView(box, box.repo);
  try {
    const reply = await new Promise((done) => {
      const socket = connect(Number(view.link.port), '127.0.0.1', () => socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${view.link.port}\r\nConnection: close\r\n\r\n`));
      let text = '';
      socket.on('data', (chunk) => { text += chunk; });
      socket.on('close', () => done(text));
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
    assert.equal((await view.page()).status, 200, 'still serving');
  } finally {
    await view.stop();
  }
});

test('nothing a person types on the view sits inside what the refresh rewrites [N27]', () => {
  const page = cockpitSource();
  const rewritten = [...page.matchAll(/\$\('([a-z-]+)'\)\.innerHTML = /g)].map((match) => match[1]);
  assert.ok(['lanes', 'chain', 'detail', 'needs'].every((id) => rewritten.includes(id)), 'the refresh rewrites these');
  for (const id of rewritten) {
    const opening = new RegExp(`id="${id}"[^>]*>([^]*?)</`).exec(page);
    assert.doesNotMatch(opening ? opening[1] : '', /<(input|textarea|form)/, `#${id} starts with no form`);
  }
  assert.doesNotMatch(page.slice(page.indexOf('<script>')), /<input|<textarea|createElement\('(form|input|textarea)'\)/, 'the script never builds a field a refresh could erase');
});

test('the view keeps the board layout people know: switcher, tabs, a list and its detail, every verdict and the history [N26, N27]', async () => {
  const box = project();
  box.run(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--criterion', 'renders a heading');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  box.run(box.web, 'submit', '1');
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  box.run(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--note', 'no heading', '--as', 'coordinator');
  box.git(box.repo, 'switch', '-q', 'main');
  const view = await startView(box, box.repo);
  try {
    const page = await (await view.page()).text();
    for (const region of ['id="proj-switch"', 'data-tab="items"', 'data-tab="shouts"', 'data-tab="spec"', 'data-tab="doctrine"', 'data-tab="activity"', 'id="chain"', 'id="detail"', 'id="add-form"', 'id="hold-form"']) {
      assert.ok(page.includes(region), region);
    }
    assert.match(
      page,
      /const filing = \[\.\.\.working\.filter\(\(l\) => p\.owning\.includes\(l\)\), 'coordinator', \.\.\.working\.filter\(\(l\) => !p\.owning\.includes\(l\)\)\]/,
      'new items default to a lane that owns folders, then the coordinator, verifier lanes last',
    );
    const item = (await view.state(box.repo)).project.items[0];
    assert.deepEqual(item.verdicts.map((verdict) => [verdict.decision, verdict.reason, verdict.note]), [['REJECT', 'TEST_FAILURE', 'no heading']]);
    assert.deepEqual(item.history.map((event) => event.kind), ['add', 'claim', 'submit', 'reject']);
    assert.equal(item.criterion, 'renders a heading');
  } finally {
    await view.stop();
  }
});

test('the view rebuilds the page only when the board changed, so a refresh cannot swallow a click [N26]', () => {
  const page = cockpitSource();
  assert.match(page, /if \(text !== seen\) \{\s*seen = text;\s*data = next;\s*render\(\);\s*\}/);
});

test('doctrine init preserves legacy rules and outside guidance, refreshes labels and refuses empty declines [D1,D2,D3,D4,S8]', () => {
  const box = sandbox();
  const repo = join(box.dir, 'doctrine');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const legacy = '# Legacy practice\n\n## Local\n- L1 [fact] Keep the existing local rule.\n';
  const ways = '# Our ways\n\n## Rules\n- PB2 [fact] Delete only after team review.\n- PB8 [wont] This fixture stores only generated data.\n- R1 [fact] Keep the configured legacy rule.\n';
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: 'true', practice: 'ways.md' }));
  writeFileSync(join(repo, 'PRACTICE.md'), legacy);
  writeFileSync(join(repo, 'ways.md'), ways);
  writeFileSync(join(repo, 'AGENTS.md'), '# Owner guidance\n\nKeep this prefix.\n');
  const first = box.run(repo, 'init');
  assert.equal(first.code, 0, first.err);
  assert.equal(readFileSync(join(repo, 'PRACTICE.md'), 'utf8'), legacy);
  assert.equal(readFileSync(join(repo, 'ways.md'), 'utf8'), ways);
  let agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /PB1 \(standard 1\)/);
  assert.match(agents, /PB2 \(repo\) \[fact\] Delete only after team review/);
  assert.match(agents, /PB8 \(repo\) \[wont\] This fixture stores only generated data/);
  assert.doesNotMatch(agents, /PB2 \(standard 1\)/);
  const shown = box.run(repo, 'spec', '--json');
  assert.equal(shown.code, 0, shown.out);
  const document = JSON.parse(shown.out);
  assert.equal(document.version, 1);
  assert.equal(document.rows.length, 13);
  const inherited = document.rows.filter(row => row.origin === 'standard');
  assert.equal(inherited.length, 10);
  assert.ok(inherited.every(row => row.version === 1 && row.reason === ''));
  assert.deepEqual(document.rows.filter(row => row.origin === 'repo').map(row => [row.id, row.version, row.reason, row.file]), [
    ['PB2', null, '', 'ways.md'], ['PB8', null, 'This fixture stores only generated data.', 'ways.md'], ['R1', null, '', 'ways.md'],
  ]);
  writeFileSync(join(repo, 'AGENTS.md'), agents + '\nKeep this footer.\n');
  const updatedWays = ways.replace('Delete only after team review.', 'Delete only after pair review.');
  writeFileSync(join(repo, 'ways.md'), updatedWays);
  const refreshed = box.run(repo, 'init');
  assert.equal(refreshed.code, 0, refreshed.err);
  assert.match(refreshed.out, /updated the pullboard section/);
  agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Owner guidance\n\nKeep this prefix.\n'));
  assert.ok(agents.endsWith('\nKeep this footer.\n'));
  assert.match(agents, /PB2 \(repo\).*Delete only after pair review/);
  assert.equal(agents.split('<!-- pullboard:start -->').length, 2);
  assert.equal(box.run(repo, 'init').code, 0);
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), agents, 'managed guidance refresh is idempotent');
  writeFileSync(join(repo, 'ways.md'), '# Our ways\n\n## Rules\n- PB2 [wont]    \n');
  const bad = box.run(repo, 'spec', '--json');
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.out).error.message, /declining a standard rule needs a reason in its text/);
  writeFileSync(join(repo, 'ways.md'), '# Our ways\n\n## Rules\n- PB2 [wont] Declined. | reason: outside syntax\n');
  assert.match(box.run(repo, 'spec', 'check').out, /unknown field/);
  writeFileSync(join(repo, 'ways.md'), updatedWays);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: retain local doctrine');
  writeFileSync(join(repo, 'ways.md'), updatedWays.replace('- PB2 [fact] Delete only after pair review.\n', ''));
  const removed = box.run(repo, 'spec', 'check');
  assert.equal(removed.code, 1);
  assert.match(removed.out, /ways.md: PB2 error:.*ids are permanent/, 'inherited PB2 cannot hide removal of a committed repo override');
});

/** Build an adversarial Git object directly; submit must be safe even when no commit hook ran. */
