/** A plain C# dotnet project goes through init on a scratch board: init records dotnet test as the gate [C7,#10675,#3705]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { DOTNET } from '../../tests/fixtures/languages/csharp.js';
import { GATE } from '../../tests/fixtures/languages/csharp.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/csharp.js';
import { dotnetSandbox } from '../../tests/fixtures/languages/csharp.js';
import { writeProject } from '../../tests/fixtures/languages/csharp.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-csharp.init-records-dotnet-test-as-the-gate: clause 1: init in a copy of the scratch dotnet project records dotnet test as the gate [C7,#10675]', { timeout: 240_000 }, async (t) => {
  if (!DOTNET) return t.skip(UNAVAILABLE);
  const box = dotnetSandbox(helpers);
  const repo = join(box.dir, 'project');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeProject(repo);
  const initialized = await box.runLocal(repo, 'init', '--json');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), GATE);
});
