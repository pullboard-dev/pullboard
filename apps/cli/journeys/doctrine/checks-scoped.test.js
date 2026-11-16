import { holdDoctrine } from '../../../../packages/doctrine/index.js';
import { holdDoctrineAsync } from '../../../../packages/doctrine/index.js';
/** A doctrine rule's check, held asynchronously and scoped at submit [D1,D3,C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  checkedProject as checkedProjectOf,
  commitWeb,
} from '../../tests/fixtures/doctrine/checked-project.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const checkedProject = (fields, extraRows) => checkedProjectOf(project, fields, extraRows);

test('the asynchronous doctrine hold preserves candidate and base ratchet decisions [D1,D3,C7]', async () => {
  const box = await checkedProject('count: 2');
  commitWeb(box, { 'a.html': 'TODO retained\n' }, 'feat(web): lower the count [G1]');
  const options = { mainCommit: box.git(box.repo, 'rev-parse', 'HEAD'), commit: box.git(box.web, 'rev-parse', 'HEAD') };
  assert.deepEqual(await holdDoctrineAsync(box.web, options), holdDoctrine(box.web, options));
  commitWeb(box, { 'a.html': 'TODO one\nTODO two\nTODO three\n' }, 'feat(web): expose a new problem [G1]');
  options.commit = box.git(box.web, 'rev-parse', 'HEAD');
  await assert.rejects(holdDoctrineAsync(box.web, options), error => error.code === 'RATCHET_ROSE' && error.message.includes('rose to 3'));
});

test('a submit hold runs scoped checks only for affected paths or checker code [D1,D3,C7]', async () => {
  const box = await checkedProject('count: 2 | files: web/a.html', [
    '- Q5 [approved, must] A local checker stays green. | gate: check node web/checker.js | count: 0 | files: api',
    '- Q6 [approved, must] An unscoped check stays green. | gate: check true | count: 0',
  ]);
  writeFileSync(join(box.repo, 'web', 'checker.js'), 'process.exit(0);\n');
  box.git(box.repo, 'add', 'web/checker.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add checker');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const mainCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  const seen = [];
  const run = async () => holdDoctrineAsync(box.web, { mainCommit, commit: box.git(box.web, 'rev-parse', 'HEAD'),
    // Main's own measure runs once per main commit (#2575); only the candidate's runs show the scoping.
    runCheck: async (commit, command) => { if (commit !== mainCommit) seen.push(command); return { problems: [], broken: '', seconds: 0 }; } });
  commitWeb(box, { 'unrelated.txt': 'unrelated\n' }, 'feat(web): unrelated [G1]');
  await run();
  assert.deepEqual(seen, ['true']);
  seen.length = 0;
  await run();
  assert.deepEqual(seen, [], 'the same tree reuses the unscoped rule receipt');
  commitWeb(box, { 'a.html': 'done\n' }, 'feat(web): touch a gated path [G1]');
  await run();
  assert.deepEqual(seen, ['grep -rn TODO web', 'true']);
  seen.length = 0;
  commitWeb(box, { 'checker.js': 'process.exit(1);\n' }, 'feat(web): change checker [G1]');
  await run();
  assert.deepEqual(seen, ['grep -rn TODO web', 'node web/checker.js', 'true']);
});
