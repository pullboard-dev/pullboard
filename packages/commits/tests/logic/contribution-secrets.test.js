/** @pullboard-test-input packages/commits/src/logic/contribution-secrets.js */
/** The secret scan names the line and kind of an AWS key id, a GitHub token and a private key header, and ignores ordinary text [C7,#3912]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contributionSecrets } from '../../src/logic/contribution-secrets.js';

// Fixtures are built by concatenation so no whole fake secret sits in this file.
const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const CLASSIC = 'gh' + 'p_' + 'a'.repeat(36);
const FINE = 'github' + '_pat_' + 'b'.repeat(50);
const KEY = '-----' + 'BEGIN RSA PRIVATE ' + 'KEY-----';

test('commits.logic-contribution-secrets.clause-1-contributionsecrets-returns-the: clause 1: contributionSecrets returns the line and kind of an AWS key id, GitHub tokens and a private key header [C7]', () => {
  const text = ['intro', `key ${AWS} here`, `token=${CLASSIC}`, KEY, `pat ${FINE}`].join('\n');
  assert.deepEqual(contributionSecrets(text), [
    { line: 2, kind: 'aws-access-key-id' },
    { line: 3, kind: 'github-token' },
    { line: 4, kind: 'private-key' },
    { line: 5, kind: 'github-token' },
  ]);
});

test('commits.logic-contribution-secrets.clause-1-contributionsecrets-returns-an: clause 1: contributionSecrets returns an empty list for ordinary text including a 40-hex commit sha [C7]', () => {
  assert.deepEqual(contributionSecrets(`Fixed in ${'0123456789abcdef'.repeat(2)}01234567\nplain words, ghp is not a token`), []);
  assert.deepEqual(contributionSecrets(''), []);
});
