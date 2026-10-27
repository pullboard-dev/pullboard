/** Shared real-session lane routing fixtures, with real Git checkouts and native claims [N2,B13,L2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';

/** Run the public CLI in one private session without letting a peer inherit its identity. */
export function crossLaneFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const session = 'cross-lane-owner-session';
  /** Each command gets its actual invoking session, and the surrounding fixture keeps none. */
  function runAs(identity, cwd, ...args) {
    const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
    box.env.CLAUDECODE = '1';
    box.env.CLAUDE_CODE_SESSION_ID = identity;
    try { return box.run(cwd, ...args); }
    finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete box.env[name];
        else box.env[name] = value;
      }
    }
  }
  /** Demand real command success before interpreting its versioned result. */
  function json(result) {
    assert.equal(result.code, 0, `${result.out}\n${result.err}`);
    return JSON.parse(result.out);
  }
  /** An existing seat is joined by the actual owner session, rather than a test-only owner flag. */
  function seat(name, lane, identity, route = 'strong') {
    const root = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, 'main');
    return { ...json(runAs(identity, root, 'join', lane, '--route', route, '--model', 'Cross-lane test', '--json')), root };
  }
  /** Add an ordinary routed item through the coordinator CLI with its lane's approved row. */
  function add(lane, title, route = 'strong') {
    return json(box.run(box.repo, 'add', lane, title, '--specs', lane === 'api' ? 'G2' : 'G1', '--route', route,
      ...(route === 'strong' ? [] : ['--criterion', 'The item can be built and checked from its brief.', '--check', 'true',
        '--brief', `Files: ${lane}/${route}.js\nChange: build the fixture item\nTest: the check proves the fixture`]), '--json')).item.item_id;
  }
  /** Keep the test's queue order explicit without touching a production board. */
  function milestone(name, id) {
    json(box.run(box.repo, 'milestone', 'add', name, '--items', String(id), '--json'));
  }
  /** Read the local checkout binding only; a session digest must never become board metadata. */
  function binding(root) {
    return JSON.parse(readFileSync(join(resolve(root, box.git(root, 'rev-parse', '--git-dir')), 'pullboard-checkout-session.json'), 'utf8'));
  }
  return { ...box, session, runAs, json, seat, add, milestone, binding };
}

