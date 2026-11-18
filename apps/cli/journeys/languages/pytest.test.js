/** A plain pytest project goes through init on a scratch board: init records pytest as the gate [C7,#10616,#3705]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { GATE } from '../../tests/fixtures/languages/pytest.js';
import { PYTEST } from '../../tests/fixtures/languages/pytest.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/pytest.js';
import { pytestSandbox } from '../../tests/fixtures/languages/pytest.js';
import { writeProject } from '../../tests/fixtures/languages/pytest.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-pytest.init-records-pytest-as-the-gate: clause 1: init in a copy of the scratch pytest project records pytest as the gate [C7,#10616]', { timeout: 240_000 }, async (t) => {
  if (!PYTEST) return t.skip(UNAVAILABLE);
  const box = pytestSandbox(helpers);
  const repo = join(box.dir, 'project');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeProject(repo);
  const initialized = await box.runLocal(repo, 'init', '--json');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), GATE);
});
