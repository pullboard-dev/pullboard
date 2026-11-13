import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { schemaRepo } from '../../../tests/fixtures/api/schema.js';
import { futureWorktree } from '../../../tests/fixtures/api/schema.js';

test('[A5, A6] relay records and the API warn with the unmerged-schema refusal and never migrate the shared board', () => {
  const fixture = schemaRepo();
  const { box, repo, dbFile, runFixture } = fixture;
  const linked = futureWorktree(fixture);
  const before = readFileSync(dbFile);
  const relayProbe = join(linked, '.schema-relay-probe.mjs');
  writeFileSync(relayProbe, `
    import { localRecords } from './packages/link/index.js';
    import { openBoard } from './apps/lib/index.js';
    try {
      localRecords(openBoard, process.env.PULLBOARD_FIXTURE_REPO, (board) => board.db.prepare('PRAGMA user_version').get());
      console.log(JSON.stringify({ code: 'UNEXPECTED_OPEN' }));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, message: error.message }));
    }
  `);
  const relayRecords = spawnSync(process.execPath, [relayProbe], {
    cwd: repo, env: { ...box.env, PULLBOARD_FIXTURE_REPO: repo }, encoding: 'utf8',
  });
  assert.equal(relayRecords.status, 0, relayRecords.stderr + relayRecords.stdout);
  const relayRefusal = JSON.parse(relayRecords.stdout);
  assert.equal(relayRefusal.code, 'UNMERGED_SCHEMA', 'relay localRecords uses its source worktree identity even from main cwd');
  assert.match(relayRefusal.message, /worktree expects board schema 4, newer than the shared board's version 3/);
  assert.deepEqual(readFileSync(dbFile), before, 'relay localRecords refuses before it can migrate the shared board');


  const surfaceProbe = join(linked, '.schema-surface-probe.mjs');
  writeFileSync(surfaceProbe, `
    import { serveApi } from './packages/api/index.js'; import { viewApiPorts } from './apps/view/index.js'; import { refusalDocument } from './apps/cli/index.js';
    import { openBoard, openBoardForRead } from './apps/lib/index.js';
    const apiBoardOpeners = { openBoard, openBoardForRead };
    const root = process.env.PULLBOARD_FIXTURE_REPO;
    const project = { root, name: 'schema fixture', project: '', added: '2026-01-01T00:00:00.000Z' };
    const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret: 'api-probe', runCommand: async () => 0, projects: () => [project], isMain: true });
    try {
      const listing = await fetch(api.url).then((response) => response.json());
      console.log(JSON.stringify({
        apiWarnings: listing.warnings?.map((warning) => warning.error.error.code) ?? [],
        apiNext: listing.warnings?.map((warning) => warning.error.error.next) ?? [],
      }));
    } finally {
      await api.close();
    }
  `);
  const surfaces = spawnSync(process.execPath, [surfaceProbe], {
    cwd: linked,
    env: { ...box.env, PULLBOARD_FIXTURE_REPO: repo },
    encoding: 'utf8',
  });
  assert.equal(surfaces.status, 0, surfaces.stderr + surfaces.stdout);
  const surfaceResult = JSON.parse(surfaces.stdout);
  assert.deepEqual(surfaceResult.apiWarnings, ['UNMERGED_SCHEMA'], 'API warnings retain the actionable source-version refusal');
  assert.match(surfaceResult.apiNext[0], /merge this code into the main checkout first/);
  assert.deepEqual(readFileSync(dbFile), before, 'API reads from the linked worktree must not migrate the shared board');

});
