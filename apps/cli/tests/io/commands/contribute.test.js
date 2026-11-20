/** pullboard contribute check --issue N reads the record body through the injected GitHub client and prints what the file form prints [C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { run } from '../../../src/io/commands/contribute.js';

const BAD = `rows:
  - G1.2
version: "0.9.5"
ran:
\tpullboard next
bogus: yes
blocks: nothing
bar:
  - 1: the command prints a line [test]
check:
  - 1: apps/cli/tests/x.test.js > prints a line
refusal: |
  NO_LINE: nothing printed
`;

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A recording io: every line said, with the working folder the command reads from. */
function recorder(cwd) {
  const said = [];
  return { cwd, said, say: line => said.push(line) };
}

test('cli.io-commands-contribute.issue-matches-file-form: clause 1: contribute check --issue N prints the same failures and returns the same exit code as the file form for the same record body, with no network [C7]', async () => {
  const dir = e2e.project().repo;
  const file = join(dir, 'bad.yml');
  writeFileSync(file, BAD);
  const fromFile = recorder(dir);
  const fileCode = run(fromFile, { first: 'check', second: 'bad.yml', rest: ['Bug'], values: {} });
  const asked = [];
  const client = (root, repository) => ({ readIssue: number => { asked.push({ root, repository, number }); return { body: BAD }; } });
  const fromIssue = recorder(dir);
  const issueCode = run(fromIssue, { first: 'check', second: 'Bug', rest: [], values: { issue: '7' } }, { githubPullClient: client, githubRepository: (root, remote) => `owner/repo-${remote}` });
  assert.equal(fileCode, 1);
  assert.equal(issueCode, fileCode);
  assert.deepEqual(asked, [{ root: dir, repository: 'owner/repo-origin', number: 7 }]);
  const strip = lines => lines.map(line => line.replaceAll('bad.yml', 'X').replaceAll('issue #7', 'X'));
  assert.deepEqual(strip(fromIssue.said), strip(fromFile.said));
});

test('cli.io-commands-contribute.issue-read-fails: clause 2: a readIssue error is refused naming issue N with a next step, never a stack trace [C7]', () => {
  const client = () => ({ readIssue: () => { throw new Error('boom at /secret/stack.js:1'); } });
  assert.throws(
    () => run(recorder('/nowhere'), { first: 'check', second: 'Bug', rest: [], values: { issue: '9' } }, { githubPullClient: client, githubRepository: () => 'owner/repo' }),
    error => {
      assert.equal(error.code, 'ISSUE_READ');
      assert.match(error.message, /issue 9/u);
      assert.doesNotMatch(`${error.message}${error.next}`, /stack\.js|boom/u);
      assert.ok(error.next);
      return true;
    },
  );
});
