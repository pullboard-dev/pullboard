import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { schemaRepo } from '../../../tests/fixtures/api/schema.js';
import { futureWorktree } from '../../../tests/fixtures/api/schema.js';

test('[A5, A6] removing the unmerged-schema guard lets a worktree migrate the shared board', () => {
  const fixture = schemaRepo();
  const { box, repo, dbFile } = fixture;
  futureWorktree(fixture);
  const unguarded = join(box.dir, 'unguarded');
  box.git(repo, 'worktree', 'add', '-q', unguarded, '-b', 'schema/unguarded', 'schema/future');
  const guardedSource = join(unguarded, 'packages/store/src/io/board/sqlite.js');
  const guardedText = readFileSync(guardedSource, 'utf8');
  const unguardedText = guardedText.replace(
    "  isMain = sharedSchemaOwner(file, isMain);",
    '  isMain = true;',
  );
  assert.notEqual(unguardedText, guardedText, 'the mutation removes only the unmerged-schema guard');
  writeFileSync(guardedSource, unguardedText);
  const mutationProbe = join(unguarded, '.schema-mutation-probe.mjs');
  writeFileSync(mutationProbe, `
    import { closeBoard } from './packages/store/index.js';
    import { openBoard } from './apps/lib/index.js';
    const board = openBoard(process.env.PULLBOARD_FIXTURE_BOARD, undefined, { isMain: false });
    closeBoard(board);
  `);
  const mutation = spawnSync(process.execPath, [mutationProbe], {
    cwd: unguarded,
    env: { ...box.env, PULLBOARD_FIXTURE_BOARD: dbFile },
    encoding: 'utf8',
  });
  assert.equal(mutation.status, 0, mutation.stderr + mutation.stdout);
  const mutated = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(mutated.prepare('PRAGMA user_version').get().user_version, 4,
    'removing the guard makes the linked worktree silently migrate the shared board');
  assert.ok(mutated.prepare('PRAGMA table_info(item)').all().some((column) => column.name === 'item_unmerged_probe'),
    'the guard-removal mutation installs its real schema-4 probe column');
  mutated.close();
});
