/** Every help example supplies each required flag in its primary usage [O3]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';

/** Read required flag groups, keeping mutually exclusive alternatives together. */
function requiredFlags(usage) {
  const flags = [];
  let optionalDepth = 0;
  for (let index = 0; index < usage.length; index += 1) {
    if (usage[index] === '[') optionalDepth += 1;
    else if (usage[index] === ']') optionalDepth = Math.max(0, optionalDepth - 1);
    else if (optionalDepth === 0 && usage.startsWith('--', index)) {
      const match = usage.slice(index).match(/^--[a-z][a-z-]*(?:\|--[a-z][a-z-]*)*/u);
      if (match) {
        // `--remove | --board <url>` spaced alternatives are one group, like `--remove|--board`.
        if (flags.length && usage.slice(0, index).trimEnd().endsWith('|')) flags[flags.length - 1].push(...match[0].split('|'));
        else flags.push(match[0].split('|'));
        index += match[0].length - 1;
      }
    }
  }
  return flags;
}

test('help example flag groups preserve alternatives and optional nesting [O3]', () => {
  assert.deepEqual(requiredFlags('pullboard command --first <id> --add|--remove ids [--optional]'),
    [['--first'], ['--add', '--remove']]);
  assert.deepEqual(requiredFlags('pullboard command [--one [--nested]] --required'), [['--required']]);
  assert.deepEqual(requiredFlags('pullboard runner install-serve <host> --remove | --board <url> [--key <key>]'), [['--remove', '--board']]);
});

test('every help example carries its required flags [O3]', async () => {
  const { help$HELP: HELP } = await import('../../index.js');
  for (const [name, declaration] of Object.entries(HELP.commands)) {
    const usage = declaration.usages[0];
    for (const alternatives of requiredFlags(usage)) {
      const present = alternatives.filter((flag) => declaration.example.split(/\s+/u).includes(flag));
      assert.equal(present.length, 1,
        `${name}: ${declaration.example} must include exactly one of ${alternatives.join('|')} from ${usage}`);
    }
  }
});

test('an unjoined worktree gets a model-bearing join instruction [O3]', async (context) => {
  const helpers = createE2eHelpers();
  context.after(helpers.cleanup);
  const box = helpers.sandbox();
  box.env.PULLBOARD_MODEL = 'fixture-model';
  const project = helpers.project(undefined, box);
  const unjoined = join(box.dir, 'unjoined');
  box.git(project.repo, 'worktree', 'add', '-q', '--detach', unjoined);
  box.env.AI_AGENT = '1';
  box.env.CODEX_THREAD_ID = 'unjoined-help-example-fixture';
  const refused = await box.runLocal(unjoined, 'claim', '1');
  assert.equal(refused.code, 1, refused.err);
  assert.match(refused.err, /\[NOT_JOINED\].*run pullboard join <lane> --model "<model name>"/);
});

/** Split a help example into the words a shell would hand the command, honouring double quotes. */
function words(example) {
  return [...example.matchAll(/"([^"]*)"|(\S+)/gu)].map((found) => found[1] ?? found[2]).slice(1);
}

test('no help example is a placeholder word [O3,C7]', async () => {
  const { help$HELP: HELP } = await import('../../index.js');
  // The top-level pages (`pullboard help <command>`); sub-command pages are a later pass.
  for (const [name, declaration] of Object.entries(HELP.commands).filter(([key]) => !key.includes(' '))) {
    const example = declaration.example.replace(/\btest-value\b/gu, '');
    assert.doesNotMatch(example, /(?:^|[\s"\[])value(?:$|[\s"\]])/u, `${name}: "${declaration.example}" still has the placeholder word "value"`);
  }
});

test('the examples that need no existing item run as written on a fresh board [O3,C7]', async (context) => {
  const { help$HELP: HELP } = await import('../../index.js');
  const box = crossLaneFixture(context);
  for (const name of ['shout', 'milestone', 'search', 'blueprint', 'settings']) {
    const ran = await box.runLocal(box.repo, ...words(HELP.commands[name].example));
    assert.equal(ran.code, 0, `${name}: ${HELP.commands[name].example}\n${ran.out}${ran.err}`);
  }
  // The decision form of shout, as the printed usage gives it, works for a worker seat with no --kind.
  const web = box.seat('help-web', 'web', box.session);
  const usage = HELP.commands.shout.usages.find((line) => line.includes('--decision'));
  assert.match(usage, /pullboard shout \[<to>\] <text> --decision/u);
  const asked = await box.runAsLocal(box.session, web.root, 'shout', 'Which release goes first?', '--decision');
  assert.equal(asked.code, 0, asked.out + asked.err);
  assert.match(asked.out, /asked coordinator[^\n]* for a decision as #\d+/u);
  const coordinator = await box.runLocal(box.repo, 'shout', 'Which release goes first?', '--decision');
  assert.equal(coordinator.code, 0, coordinator.out + coordinator.err);
});
