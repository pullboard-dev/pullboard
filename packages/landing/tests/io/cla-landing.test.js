/** The landing step records each new CLA signer once and a returning signer never again [C7,#3308]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { recordClaSigners } from '../../src/io/step/cla.js';

const SENTENCE = 'I have read CLA.md and I agree to it.';
const CLA = 'CLA text at the PR base\n';
const prFor = (people) => ({
  commits: people.map(({ login, id }, index) => ({ sha: `${index}`.padStart(40, 'a'), login, id, message: 'feat: x', parents: ['p'] })),
  comments: people.map(({ login, id }) => ({ id, user_id: id, login, body: SENTENCE, url: `https://github.test/pr/1#c${id}`, created_at: '2026-11-16T10:00:00Z' })),
});

/** A signatures file in a private scratch folder; `text()` reads its current bytes. */
function withFile() {
  const scratch = privateFixtureFiles('pullboard-cla-landing-');
  scratch.write('cla-signatures.json', JSON.stringify({ exempt: [], signatures: [] }));
  return { path: join(scratch.root, 'cla-signatures.json'), text: () => scratch.read('cla-signatures.json').toString('utf8') };
}

test('landing.cla-landing.landing-a-pr-appends-one-entry: clause 1: landing a PR appends one entry per new signer with the CLA hash [C7,#3308]', () => {
  const { path, text } = withFile();
  const recorded = recordClaSigners({ pr: prFor([{ login: 'ann', id: 1 }, { login: 'bob', id: 2 }]), signaturesPath: path, claText: CLA, now: '2026-11-16T12:00:00Z' });
  assert.deepEqual(recorded, ['ann', 'bob']);
  const { signatures } = JSON.parse(text());
  assert.deepEqual(signatures.map((entry) => entry.login), ['ann', 'bob']);
  assert.equal(signatures[0].cla_sha256, createHash('sha256').update(CLA).digest('hex'));
  assert.equal(signatures[0].comment_url, 'https://github.test/pr/1#c1');
});

test('landing.cla-landing.a-second-landing-by-the-same: clause 2: a second landing by the same signer appends nothing [C7,#3308]', () => {
  const { path, text } = withFile();
  const pr = prFor([{ login: 'ann', id: 1 }]);
  recordClaSigners({ pr, signaturesPath: path, claText: CLA });
  const before = text();
  assert.deepEqual(recordClaSigners({ pr, signaturesPath: path, claText: CLA }), []);
  assert.equal(text(), before);
});
