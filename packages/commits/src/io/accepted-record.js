/** Accepted contribution records are kept as snapshots named by the sha256 of their exact bytes, so an item files from the stored record, never the live body; the caller passes the accepted-records store directory [C7,#3915]. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from "../../../kernel/light.js";
import { parseContributionRecord } from "../logic/contribution.js";

const HASH = /^[0-9a-f]{64}$/u;

/** The accepted-records store inside a repository's pullboard state folder (the caller names the folder). */
export function acceptedRecordsDir(stateDir) {
  return join(stateDir, 'accepted-records');
}

/**
 * Save a record text that parseContributionRecord accepts, unchanged, under the sha256 hex of its bytes; a snapshot is never overwritten.
 *
 * @param {string} dir the snapshot directory
 * @param {string} text the record text
 * @param {string} shape one of CONTRIBUTION_SHAPES
 * @returns {string} the sha256 hex that names the snapshot
 */
export function saveAcceptedRecord(dir, text, shape) {
  parseContributionRecord(text, shape);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { writeFileSync(join(dir, hash), text, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return hash;
}

/**
 * Read a snapshot by its hash: the exact text that was saved.
 *
 * @param {string} dir the snapshot directory
 * @param {string} hash a sha256 hex from saveAcceptedRecord
 * @returns {string} the record text
 */
export function readAcceptedRecord(dir, hash) {
  const fix = 'use the hash saveAcceptedRecord returned, or accept the record again';
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new Refused('ACCEPTED_RECORD_UNKNOWN', `"${String(hash).slice(0, 80)}" is not a sha256 hex hash; fix: ${fix}`, fix);
  let text;
  try { text = readFileSync(join(dir, hash), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') throw new Refused('ACCEPTED_RECORD_UNKNOWN', `no accepted record has hash ${hash}; fix: ${fix}`, fix);
    throw error;
  }
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== hash) throw new Refused('ACCEPTED_RECORD_CORRUPT', `the snapshot ${hash} no longer hashes to its name; fix: accept the record again`, 'accept the record again');
  return text;
}
