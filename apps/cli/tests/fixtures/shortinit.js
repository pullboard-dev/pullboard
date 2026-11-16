/** First-run summaries stay bounded without hiding verbose setup or touching foreign listeners [I1,I2,H5,N26]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { takeDefaultViewPort } from './view/port.js';

/** Exercise separate real first runs, including an owned listener that keeps the view port busy. */
export async function assertShortInit(t, sandbox) {
  const owner = sandbox();
  const lease = await takeDefaultViewPort(owner.dir, { agent: `init-summary-${process.pid}` });
  const held = createServer(socket => socket.destroy());
  await new Promise((done, fail) => { held.once('error', fail); held.listen(lease.port, '127.0.0.1', done); });
  t.after(async () => { await new Promise(done => held.close(done)); lease.release(); });
  const failures = [];
  /** Collect independent output assertions while allowing setup failures to retain their real cause. */
  const observe = (check) => { try { check(); } catch (error) { if (error.code !== 'ERR_ASSERTION') throw error; failures.push(error.message); } };
  for (const mode of ['plain', 'blueprint', 'busy', 'failed']) {
    for (const verbose of [false, true]) {
      const box = sandbox();
      const repo = join(box.dir, `${mode}-${verbose ? 'verbose' : 'default'}`);
      mkdirSync(repo);
      box.git(repo, 'init', '-q', '-b', 'main');
      if (mode === 'busy') {
        box.env.PULLBOARD_VIEW_BACKGROUND = '1';
        box.env.PULLBOARD_VIEW_PORT = String(lease.port);
      }
      if (mode === 'failed') {
        box.env.PULLBOARD_VIEW_BACKGROUND = '1';
        box.env.PULLBOARD_VIEW_PORT = 'not-a-port';
      }
      const args = ['init', ...(mode === 'blueprint' ? ['--blueprint', 'web-app'] : []), ...(verbose ? ['--verbose'] : [])];
      // In-process production dispatch proves the same output; a node start-up per init cost seconds on a loaded runner [C7].
      const result = await box.runLocal(repo, ...args);
      assert.equal(result.code, 0, result.err || result.out);
      const visible = result.out + result.err;
      const lines = visible.split(/\r?\n/u).filter(line => line.trim());
      const label = `${mode} ${verbose ? 'verbose' : 'default'}`;
      observe(() => assert.doesNotMatch(visible, /\b(?:kill(?:\s+-\w+)*\s+\d+|taskkill\s+\/PID\s+\d+)/iu, `${label}: init never advises killing a PID`));
      if (verbose) {
        observe(() => assert.match(visible, /sandbox_mode/u, `${label}: Codex permission details remain available`));
        observe(() => assert.match(visible, /--detach/u, `${label}: the full reviewer startup remains available`));
      } else {
        observe(() => assert.ok(lines.length <= 12, `${label}: first-run visible output has ${lines.length} lines, maximum12`));
        observe(() => assert.equal(lines.filter(line => /^Next:/u.test(line)).length, 1, `${label}: exactly one Next line`));
        observe(() => assert.match(lines.at(-1), /^Next:/u, `${label}: the one next step is last`));
        observe(() => assert.equal((visible.match(/\bpullboard (?:resume|init|relay|worktree|next)\b/gu) ?? []).length, 1, `${label}: only one actionable command`));
        observe(() => assert.doesNotMatch(visible, /sandbox_mode|--detach/u, `${label}: detailed recipes are behind verbose`));
      }
      if (mode === 'busy') {
        observe(() => assert.match(visible, new RegExp(`(?:port|Port) ${lease.port} .*in use`, 'u'), `${label}: actual port contention is reported`));
        assert.ok(held.listening, 'init leaves the owned listener running');
      }
      if (mode === 'failed' && verbose) observe(() => assert.match(visible, /PULLBOARD_VIEW_PORT is a number from 0 to 65535/u, 'verbose preserves the actual view failure diagnostic'));
      assert.ok(existsSync(join(repo, 'AGENTS.md')), 'the short report still installs agent instructions');
      assert.ok(existsSync(join(repo, '.codex', 'rules', 'pullboard.rules')), 'the short report still installs Codex rules');
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
}
