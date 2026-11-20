/** A plain Python unittest project goes through init on a scratch board: init records python3 -m unittest as the gate [C7,#10559,#3705]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { GATE } from '../../tests/fixtures/languages/python.js';
import { PYTHON } from '../../tests/fixtures/languages/python.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/python.js';
import { pythonSandbox } from '../../tests/fixtures/languages/python.js';
import { writeProject } from '../../tests/fixtures/languages/python.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-python.init-in-a-copy-of-the: clause 1: init in a copy of the scratch unittest project records python3 -m unittest discover as the gate [C7,#10559]', { timeout: 240_000 }, async (t) => {
  if (!PYTHON) return t.skip(UNAVAILABLE);
  const box = pythonSandbox(helpers);
  const repo = join(box.dir, 'project');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeProject(repo);
  const initialized = await box.runLocal(repo, 'init', '--json');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), GATE);
});
