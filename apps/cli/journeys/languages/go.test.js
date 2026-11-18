/** A plain Go module goes through init on a scratch board: init records go test ./... as the gate [C7,#10612,#3705]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { GATE } from '../../tests/fixtures/languages/go.js';
import { GO } from '../../tests/fixtures/languages/go.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/go.js';
import { goSandbox } from '../../tests/fixtures/languages/go.js';
import { writeProject } from '../../tests/fixtures/languages/go.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-go.init-records-go-test-as-the-gate: clause 1: init in a copy of the scratch Go module records go test ./... as the gate [C7,#10612]', { timeout: 240_000 }, async (t) => {
  if (!GO) return t.skip(UNAVAILABLE);
  const box = goSandbox(helpers);
  const repo = join(box.dir, 'project');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeProject(repo);
  const initialized = await box.runLocal(repo, 'init', '--json');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), GATE);
});
