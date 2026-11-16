import { test } from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeDerived } from '../../src/io/proof/derived.js';
import { DERIVED_SETTING } from '../../src/io/proof/derived.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

test('measure 9020 [C7]', () => {
  process.env[DERIVED_SETTING] = '1';
  const N = 100_000;
  const mk = () => { const db = new DatabaseSync(join(privateFixtureFiles('m9020-').root, 'board.sqlite')); db.exec('PRAGMA journal_mode=WAL'); return { db }; };
  const old = mk();
  writeDerived(old, ['warm', '1']);
  const sql = 'INSERT INTO proof_derived.proof_counter(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value';
  let t0 = performance.now();
  for (let i = 0; i < N; i++) { old.db.prepare(sql).run(`k:${i % 50}`, String(i)); old.db.prepare(sql).run(`j:${i % 50}`, String(i)); }
  const before = performance.now() - t0;
  const fresh = mk();
  t0 = performance.now();
  for (let i = 0; i < N; i++) writeDerived(fresh, [`k:${i % 50}`, String(i), `j:${i % 50}`, String(i)]);
  const after = performance.now() - t0;
  console.log(`MEASURE9020 events=${N} per-call-prepare=${before.toFixed(0)}ms cached=${after.toFixed(0)}ms ratio=${(before / after).toFixed(2)}`);
});
