/** A publish run from an agent shell pushes from its private worktree instead of refusing NOT_JOINED (GitHub #25). */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('pullboard publish from an agent shell pushes the green head [GH25]', () => {
  const box = e2e.sandbox();
  delete box.env.NODE_TEST_CONTEXT;
  const project = e2e.project('node --test test/publish.test.js', box, { withWorktree: false });
  const { repo } = project;
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'test/publish.test.js'), "import { test } from 'node:test';\ntest('green', () => {});\n");
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  config.landing = { ...config.landing, manualOverride: true, publish: 'separate' };
  fixtureProjectPolicy(repo, { config });
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-qm', 'test: add publish contract');
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'init', '--bare', '-q', remote);
  box.git(repo, 'remote', 'add', 'origin', remote);
  // The coordinator is a Claude Code agent: its shell carries the agent markers and a session id.
  box.env.CLAUDECODE = '1';
  box.env.CLAUDE_CODE_SESSION_ID = 'coordinator-publish-gh25';
  const published = box.run(repo, 'publish');
  assert.equal(published.code, 0, published.out + published.err);
  assert.doesNotMatch(published.out + published.err, /NOT_JOINED/);
  const branch = box.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  assert.equal(box.git(remote, 'rev-parse', branch).trim(), box.git(repo, 'rev-parse', 'HEAD').trim());
});
