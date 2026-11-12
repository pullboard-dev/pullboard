/** next serves only the seat bound to the worktree it runs in, in that seat's lane, whatever session its seats share (GH #27). */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { join } from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The one agent session every seat below shares, as subagents of one Claude Code session do. */
const SESSION = 'shared-session-27';

/** Run `work` with the shared session id set on the CLI, as a local agent shell has it. */
async function shared(box, work) {
  const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
  box.env.CLAUDECODE = '1';
  box.env.CLAUDE_CODE_SESSION_ID = SESSION;
  try { return await work(); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete box.env[name];
      else box.env[name] = value;
    }
  }
}

/** Make a seat checkout in `lane` and join it under the shared session. */
async function seat(box, lane) {
  const root = join(box.dir, `${lane}-seat`);
  box.git(box.repo, 'worktree', 'add', '-q', root, '-b', `${lane}/seat`);
  const joined = await shared(box, async () => joinFixtureSeat(box, root, lane, { model: FIXTURE_MODEL }));
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { root, id: JSON.parse(joined.out).agent };
}

/** The seat ids on the board. */
async function seatIds(box) {
  return JSON.parse((await box.runLocal(box.repo, 'agents', '--json')).out).agents.map(agent => agent.agent_id ?? agent.id).sort();
}

test('clause 1: next in an api seat never claims in the web lane or opens a seat when its session also holds a web seat [GH27]', async () => {
  const box = e2e.project();
  const web = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Web only work', check: 'true', args: ['--specs', 'G1'] });
  const api = await seat(box, 'api');
  const other = await seat(box, 'web');
  const before = await seatIds(box);
  const next = await shared(box, async () => (await box.runLocal(api.root, 'next')));
  const all = `${next.out}\n${next.err}`;
  assert.equal(next.code, 0, all);
  assert.doesNotMatch(next.out, /claimed #/u, all);
  assert.doesNotMatch(all, /you hold #|work in web-/u, all);
  assert.match((await box.runLocal(box.repo, 'show', String(web.item_id))).out, new RegExp(`^#${web.item_id}\\s+open\\b`, 'mu'));
  assert.deepEqual(await seatIds(box), before, 'next opened no new seat');
  assert.ok(other.id);
});

test('clause 2: two seats of one session each run next and release in their own lane without NOT_YOURS [GH27]', async () => {
  const box = e2e.project();
  const webItem = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Web work', check: 'true', args: ['--specs', 'G1'] });
  const apiItem = fileFixtureItem(box, box.repo, { lane: 'api', title: 'Api work', check: 'true', args: ['--specs', 'G1'] });
  const api = await seat(box, 'api');
  const web = await seat(box, 'web');
  const before = await seatIds(box);
  for (const [who, item] of [[api, apiItem], [web, webItem]]) {
    const id = String(item.item_id);
    const next = await shared(box, async () => (await box.runLocal(who.root, 'next')));
    assert.equal(next.code, 0, `${next.out}\n${next.err}`);
    assert.match(next.out, new RegExp(`claimed #${id}:`, 'u'), next.out);
    assert.match((await box.runLocal(box.repo, 'show', id)).out, new RegExp(`^#${id}\\s+claimed ${who.id}\\b`, 'mu'));
    const released = await shared(box, async () => (await box.runLocal(who.root, 'release', id, '--reason', 'OTHER', '--note', 'fixture')));
    assert.equal(released.code, 0, `${released.out}\n${released.err}`);
    assert.doesNotMatch(`${released.out}${released.err}`, /NOT_YOURS/u);
  }
  assert.deepEqual(await seatIds(box), before, 'no seat was opened by either next');
});
