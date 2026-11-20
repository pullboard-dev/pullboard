/** @pullboard-test-input source-cell packages/commits */
/** Accepted contribution records are saved under their sha256 and read back exactly [C7,#3915]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { readAcceptedRecord } from '../../index.js';
import { saveAcceptedRecord } from '../../index.js';

const ASK = 'have: a flaky board\nwant: guidance\n';

test('commits.io-accepted-record.clause-1-snapshot-by-hash: clause 1: saving an accepted record writes it unchanged under its sha256 and returns that hash, saving it again returns the same hash, reading by that hash returns the exact text, and an unknown hash is refused with a named fix [C7,#3915]', () => {
  const { root } = privateFixtureFiles('pb-accepted-');
  const dir = join(root, 'accepted-records');
  try {
    const hash = saveAcceptedRecord(dir, ASK, 'Ask');
    assert.equal(hash, createHash('sha256').update(ASK).digest('hex'));
    assert.equal(readFileSync(join(dir, hash), 'utf8'), ASK);
    assert.equal(statSync(join(dir, hash)).mode & 0o777, 0o600);
    assert.equal(saveAcceptedRecord(dir, ASK, 'Ask'), hash);
    assert.equal(readAcceptedRecord(dir, hash), ASK);
    assert.throws(() => saveAcceptedRecord(dir, 'nonsense: 1\n', 'Ask'), { code: 'CONTRIB_KEY' });
    const unknown = createHash('sha256').update('never saved').digest('hex');
    assert.throws(() => readAcceptedRecord(dir, unknown), error => error.code === 'ACCEPTED_RECORD_UNKNOWN' && /fix:/u.test(error.message));
    assert.throws(() => readAcceptedRecord(dir, '../escape'), { code: 'ACCEPTED_RECORD_UNKNOWN' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
