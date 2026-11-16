/** Shared setup for the schema journeys: a copied Pullboard checkout with a board, and a worktree one schema version ahead [A5,A6]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../child.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { copyPackageFiles } from '../copy.js';
import { fixtureProjectPolicy } from '../testkit.js';
import { sandbox } from './project.js';

/**
 * Copy this checkout into a fresh Git repo, create its board at the current schema and return helpers to run its own CLI.
 * Why a copy: each worktree must import its committed source, so a schema change in one never reaches this checkout.
 */
export function schemaRepo() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  const sourceRoot = resolve(import.meta.dirname, '../../../../..');
  mkdirSync(repo);
  copyPackageFiles(sourceRoot, repo);
  fixtureProjectPolicy(repo, {
    config: { gate: 'true', spec: 'SPEC.md', practice: 'PRACTICE.md', lanes: { app: { owns: ['src/'], specs: ['G1'] } }, shared: [] },
    spec: '# Schema fixture\n\n## G · Goals\n- G1 [approved, must] The board is preserved. | gate: true\n',
  });
  writeFileSync(join(repo, 'PRACTICE.md'), '');
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up schema fixture');
  /** Run the fixture's own CLI so each worktree imports its committed source. */
  const runFixture = (cwd, ...args) => spawnSync(process.execPath, [join(cwd, 'apps/cli/pullboard.js'), ...args], { cwd, env: box.env, encoding: 'utf8' });
  const initialized = runFixture(repo, 'status', '--json');
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  return { box, repo, sourceRoot, runFixture, dbFile: join(repo, '.git', 'pullboard', 'board.sqlite') };
}

/** Add a linked worktree on branch schema/future that commits a schema-4 migration the shared board has not had. */
export function futureWorktree({ box, repo }) {
  const linked = join(box.dir, 'future');
  box.git(repo, 'worktree', 'add', '-q', linked, '-b', 'schema/future');
  assert.equal(box.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), box.git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  assert.notEqual(box.git(repo, 'rev-parse', '--path-format=absolute', '--git-dir'), box.git(linked, 'rev-parse', '--path-format=absolute', '--git-dir'));
  const schemaSource = join(linked, 'packages', 'store', 'src/io/board/schema/source.js');
  const migrateSource = join(linked, 'packages', 'store', 'src/io/board/migrate.js');
  const oldSource = readFileSync(schemaSource, 'utf8');
  const oldMigrations = readFileSync(migrateSource, 'utf8');
  const migration = "  ['shout', 'shout_request_outcome', \"TEXT NOT NULL DEFAULT ''\"],\n];";
  assert.ok(oldSource.includes('export const SCHEMA_VERSION = 3;'));
  assert.ok(oldMigrations.includes(migration));
  const newMigrations = oldMigrations.replace(migration, migration.replace('\n];', "\n  ['item', 'item_unmerged_probe', 'INTEGER NOT NULL DEFAULT 0'],\n];"));
  assert.notEqual(newMigrations, oldMigrations, 'the unmerged worktree carries a real schema-4 migration');
  writeFileSync(schemaSource, oldSource.replace('export const SCHEMA_VERSION = 3;', 'export const SCHEMA_VERSION = 4;'));
  writeFileSync(migrateSource, newMigrations);
  box.git(linked, 'add', schemaSource, migrateSource);
  box.git(linked, 'commit', '-q', '-m', 'feat: simulate an unmerged schema bump');
  return linked;
}
