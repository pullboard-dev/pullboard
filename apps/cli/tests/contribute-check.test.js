/** pullboard contribute check prints every parser failure of a record file with its rule, fix and skill command, and exits nonzero [C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { GOOD } from './fixtures/contribute-record.js';
import { createE2eHelpers } from './fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

let box;
before(() => { box = e2e.project(); });

test('cli.contribute-check.a-record-with-several-failures-prints-each: clause 1: a record with several failures prints each one as field or line, rule, fix and skill command and exits nonzero [C7]', async () => {
  const file = join(box.repo, 'bad.yml');
  writeFileSync(file, GOOD.replace('ran: pullboard next', 'ran:\n\tpullboard next').replace('blocks: nothing', 'bogus: yes\nblocks: nothing'));
  const checked = await box.runLocal(box.web, 'contribute', 'check', file, 'Bug');
  assert.equal(checked.code, 1, `${checked.out}\n${checked.err}`);
  const lines = checked.out.trim().split('\n');
  const tab = lines.find(line => line.startsWith('line 5:'));
  assert.ok(tab, checked.out);
  assert.match(tab, /CONTRIB_TAB; rule: .*; fix: indent with two spaces; skill: pullboard contribute check /u);
  const key = lines.find(line => line.startsWith('bogus:'));
  assert.ok(key, checked.out);
  assert.match(key, /CONTRIB_KEY; rule: the key is not in the closed field list; fix: .+; skill: pullboard contribute check /u);
  assert.match(lines.at(-1), /^[2-9] failures in /u);
});

test('cli.contribute-check.a-record-the-parser-accepts-exits-0: clause 1: a record the parser accepts exits 0, and the issue form name line sets the shape [C7]', async () => {
  const file = join(box.repo, 'good.md');
  writeFileSync(file, `---\nname: Bug\n---\n\nIt broke.\n\n\`\`\`yaml\n${GOOD}\`\`\`\n`);
  const checked = await box.runLocal(box.web, 'contribute', 'check', file);
  assert.equal(checked.code, 0, `${checked.out}\n${checked.err}`);
  assert.match(checked.out, /a Bug record the parser accepts/u);
  const missing = await box.runLocal(box.web, 'contribute', 'check', join(box.repo, 'nowhere.yml'), 'Bug');
  assert.notEqual(missing.code, 0);
});

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
