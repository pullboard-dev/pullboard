/**
 * Doctrine init end to end on a real repo: legacy rules, outside guidance, label refresh and empty declines (D1–D4, S8).
 */
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

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, CONFIG } = e2e;

test('cli.journeys-view-e2e-doctrine.doctrine-init-preserves-legacy-rules-and: doctrine init preserves legacy rules and outside guidance, refreshes labels and refuses empty declines [D1,D2,D3,D4,S8]', async () => {
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
  const first = await box.runLocal(repo, 'init');
  assert.equal(first.code, 0, first.err);
  assert.equal(readFileSync(join(repo, 'PRACTICE.md'), 'utf8'), legacy);
  assert.equal(readFileSync(join(repo, 'ways.md'), 'utf8'), ways);
  let agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  const shown = await box.runLocal(repo, 'spec', '--json');
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
  const refreshed = await box.runLocal(repo, 'init', '--verbose');
  assert.equal(refreshed.code, 0, refreshed.err);
  assert.match(refreshed.out, /kept AGENTS.md/, 'the approved block does not depend on the doctrine, so a doctrine edit leaves it as it was');
  agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Owner guidance\n\nKeep this prefix.\n'));
  assert.ok(agents.endsWith('\nKeep this footer.\n'));
  assert.equal(agents.split('<!-- pullboard:start -->').length, 2);
  assert.equal((await box.runLocal(repo, 'init')).code, 0);
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), agents, 'managed guidance refresh is idempotent');
  writeFileSync(join(repo, 'ways.md'), '# Our ways\n\n## Rules\n- PB2 [wont]    \n');
  const bad = await box.runLocal(repo, 'spec', '--json');
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.out).error.message, /declining a standard rule needs a reason in its text/);
  writeFileSync(join(repo, 'ways.md'), '# Our ways\n\n## Rules\n- PB2 [wont] Declined. | reason: outside syntax\n');
  assert.match((await box.runLocal(repo, 'spec', 'check')).out, /unknown field/);
  writeFileSync(join(repo, 'ways.md'), updatedWays);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: retain local doctrine');
  writeFileSync(join(repo, 'ways.md'), updatedWays.replace('- PB2 [fact] Delete only after pair review.\n', ''));
  const removed = await box.runLocal(repo, 'spec', 'check');
  assert.equal(removed.code, 1);
  assert.match(removed.out, /ways.md: PB2 error:.*ids are permanent/, 'inherited PB2 cannot hide removal of a committed repo override');
});
