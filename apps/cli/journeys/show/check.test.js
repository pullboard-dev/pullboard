/** The public item display preserves canonical check bytes without executing them [N30,A1]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import {
  frozenCriterion,
  loadSpec,
} from '../../../../packages/spec/index.js';
import { runFixtureExecFile } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

test('cli.journeys-show-check.show-prints-a-frozen-check-exactly: show prints a frozen check exactly as stored, with no added escaping [N30,A1]', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-show-check-')));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, PULLBOARD_HOME: join(dir, 'home'), GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const check = 'printf "%s\\n" "a quoted value"\n'
    + "printf '%s\\n' 'literal \\\\ path'\n"
    + 'touch must-not-execute';
  try {
    runFixtureExecFile('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { web: { owns: ['web/'] } } }));
    writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## Goals\n- G1 [approved, must] Show the check. | gate: test\n');
    runFixtureExecFile('git', ['add', '-A'], { cwd: repo, env });
    runFixtureExecFile('git', ['commit', '-q', '-m', 'chore: private fixture'], { cwd: repo, env });
    const board = openBoard(join(repo, '.git/pullboard/board.sqlite'));
    let digest;
    try {
      store.register(board, { lane: 'coordinator', path: repo });
      const builder = store.register(board, { lane: 'web', path: join(dir, 'builder') });
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Display shell bytes',
        criterion: 'The check stays literal.', specIds: ['G1'], check });
      store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 7_200_000,
        freeze: item => frozenCriterion(loadSpec(repo, loadConfig(repo)), item) });
      const item = store.getItem(board, id);
      digest = item.item_frozen_digest;
      assert.equal(JSON.parse(item.item_frozen).check, check, 'the fixture really freezes these exact bytes');
    } finally { store.closeBoard(board); }
    const plain = await runCliInProcess(['show', '1'], { cwd: repo, env });
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plain.stdout.includes(`check: ${check}\n`), 'plain display contains the stored multiline command verbatim');
    const json = await runCliInProcess(['show', '1', '--json'], { cwd: repo, env });
    assert.equal(json.status, 0, json.stderr);
    const result = JSON.parse(json.stdout);
    assert.equal(result.item_check, check, 'the existing JSON check field remains intact');
    assert.equal(JSON.parse(result.item_frozen).check, check, 'the existing serialized frozen field remains intact');
    assert.equal(result.checkText, check, 'JSON adds the canonical check as a normal string');
    assert.ok(json.stdout.includes(JSON.stringify(check)), 'JSON keeps standard quote and newline escaping');
    assert.equal(result.item_frozen_digest, digest, 'JSON preserves the canonical digest');
    assert.ok(plain.stdout.includes(`check digest: ${digest}\n`), 'plain display puts the complete canonical digest beside its check');
    assert.equal(existsSync(join(repo, 'must-not-execute')), false, 'display never executes the shell');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
