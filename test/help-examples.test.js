/** Every help example supplies each required flag in its primary usage [O3]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

/** Read flags that appear outside optional square-bracket groups in a usage line. */
function requiredFlags(usage) {
  const flags = [];
  let optionalDepth = 0;
  for (let index = 0; index < usage.length; index += 1) {
    if (usage[index] === '[') optionalDepth += 1;
    else if (usage[index] === ']') optionalDepth = Math.max(0, optionalDepth - 1);
    else if (optionalDepth === 0 && usage.startsWith('--', index)) {
      const match = usage.slice(index).match(/^--[a-z][a-z-]*/u);
      if (match) flags.push(match[0]);
    }
  }
  return [...new Set(flags)];
}

test('every help example carries its required flags [O3]', async () => {
  const { HELP } = await import('../src/help.js');
  for (const [name, declaration] of Object.entries(HELP.commands)) {
    const usage = declaration.usages[0];
    for (const flag of requiredFlags(usage)) {
      assert.ok(declaration.example.split(/\s+/u).includes(flag), `${name}: ${declaration.example} must include ${flag} from ${usage}`);
    }
  }
});

test('an unjoined worktree gets a model-bearing join instruction [O3]', (context) => {
  const helpers = createE2eHelpers();
  context.after(helpers.cleanup);
  const box = helpers.sandbox();
  box.env.PULLBOARD_MODEL = 'fixture-model';
  const project = helpers.project(undefined, box);
  const unjoined = join(box.dir, 'unjoined');
  box.git(project.repo, 'worktree', 'add', '-q', '--detach', unjoined);
  box.env.AI_AGENT = '1';
  box.env.CODEX_THREAD_ID = 'unjoined-help-example-fixture';
  const refused = box.run(unjoined, 'claim', '1');
  assert.equal(refused.code, 1, refused.err);
  assert.match(refused.err, /\[NOT_JOINED\].*run pullboard join <lane> --model "<model name>"/);
});
