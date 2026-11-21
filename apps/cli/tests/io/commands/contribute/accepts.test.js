/** @pullboard-test-input apps/cli/src/io/commands/contribute.js */
/** pullboard contribute check exits 0 for a record the parser accepts and reads the issue form name line as the shape. [C7] */
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

test('cli.contribute-check.a-record-the-parser-accepts-exits-0: clause 1: a record the parser accepts exits 0, and the issue form name line sets the shape [C7]', async () => {
  const file = join(box.repo, 'good.md');
  writeFileSync(file, `---\nname: Bug\n---\n\nIt broke.\n\n\`\`\`yaml\n${GOOD}\`\`\`\n`);
  const checked = await box.runLocal(box.web, 'contribute', 'check', file);
  assert.equal(checked.code, 0, `${checked.out}\n${checked.err}`);
  assert.match(checked.out, /a Bug record the parser accepts/u);
  const missing = await box.runLocal(box.web, 'contribute', 'check', join(box.repo, 'nowhere.yml'), 'Bug');
  assert.notEqual(missing.code, 0);
});
