/** @pullboard-test-input apps/cli/src/io/commands/contribute.js */
/** pullboard contribute check prints the summary length against its limit and CONTRIB_SECRET for a secret-looking value. [C7] */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { GOOD } from '../../../fixtures/contribute-record.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

let box;
before(() => { box = e2e.project(); });

test('cli.contribute-check.the-check-prints-the-summary-length-against: clause 2: the check prints the summary length against its limit and CONTRIB_SECRET with line, rule, fix and skill command for a secret-looking value [C7]', async () => {
  const file = join(box.repo, 'secret.md');
  const key = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  writeFileSync(file, `---\nname: Bug\n---\n\nIt broke. My key is ${key}.\n\n\`\`\`yaml\n${GOOD}\`\`\`\n`);
  const checked = await box.runLocal(box.web, 'contribute', 'check', file);
  assert.equal(checked.code, 1, `${checked.out}\n${checked.err}`);
  const lines = checked.out.trim().split('\n');
  assert.ok(lines.some(line => /^summary \d+ of \d+ characters$/u.test(line)), checked.out);
  const secret = lines.find(line => line.startsWith('line 5:'));
  assert.ok(secret, checked.out);
  assert.match(secret, /CONTRIB_SECRET; rule: .*aws-access-key-id.*; fix: .+; skill: pullboard contribute check /u);
  assert.doesNotMatch(checked.out, new RegExp(key, 'u'));
});
