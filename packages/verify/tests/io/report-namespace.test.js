/** Each flow report version keeps its projections and cursor under its own namespace, inside the proof counter prefix (#2288). */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  PROOF_COUNTER_PREFIX,
  clearProofCounters,
  proofCounter,
} from '../../src/io/proof/counters.js';
import { FLOW_REPORT_VERSION } from '../../../stats/light.js';

const V2 = `${PROOF_COUNTER_PREFIX}v2:`;

/** A bare in-memory board_meta table holding the given key and value pairs. */
function metaDb(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  for (const [key, value] of rows) db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(key, JSON.stringify({ data: value, numbers: [] }));
  return db;
}

test('clause 1: each FLOW_REPORT_VERSION reads only its own namespace and a clear keeps every report namespace [R1,R2]', () => {
  const db = metaDb([
    [`${V2}report-summary`, { version: 2, mark: 'legacy' }],
    [`${V2}report-v${FLOW_REPORT_VERSION - 1}:summary`, { version: FLOW_REPORT_VERSION - 1, mark: 'older' }],
    [`${V2}report-v${FLOW_REPORT_VERSION}:summary`, { version: FLOW_REPORT_VERSION, mark: 'own' }],
    [`${V2}report-v${FLOW_REPORT_VERSION + 1}:summary`, { version: FLOW_REPORT_VERSION + 1, mark: 'newer' }],
    [`${V2}summary`, { last: 3 }],
    [`${V2}item:1`, { id: 1 }],
  ]);
  try {
    assert.equal(proofCounter({ db }, 'report-summary').mark, 'own', 'the report cursor is read from this version\'s namespace, not the legacy or another version\'s');
    clearProofCounters({ db });
    const left = db.prepare('SELECT meta_key FROM board_meta ORDER BY meta_key').all().map(row => row.meta_key);
    assert.deepEqual(left, [
      `${V2}report-summary`,
      `${V2}report-v${FLOW_REPORT_VERSION - 1}:summary`,
      `${V2}report-v${FLOW_REPORT_VERSION}:summary`,
      `${V2}report-v${FLOW_REPORT_VERSION + 1}:summary`,
    ].sort(), 'a clear removes ordinary proof counters and leaves every report namespace as stored');
  } finally { db.close(); }
});

test('clause 1: this version\'s namespace sits inside PROOF_COUNTER_PREFIX [R1,R2]', () => {
  const db = metaDb([]);
  try {
    db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`${V2}report-v${FLOW_REPORT_VERSION}:summary`, '{"data":{"mark":"x"},"numbers":[]}');
    assert.equal(proofCounter({ db }, 'report-summary').mark, 'x');
    assert.ok(`${V2}report-v${FLOW_REPORT_VERSION}:summary`.startsWith(PROOF_COUNTER_PREFIX));
  } finally { db.close(); }
});
