/** A GitHub member's public SSH keys, read from GitHub itself through the request adapter so no relay can add one [C7,#1429]. */
import { environmentAdapter } from '../../../../env/index.js';
import { createGithubAdapter } from './request.js';

const KEY = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+$/u;

/** The refusal every unavailable read answers with, so a caller keeps one code to handle. */
function unavailable(message) {
  return Object.assign(new Error(`[GITHUB_UNAVAILABLE] ${message}`), { name: 'Refused', code: 'GITHUB_UNAVAILABLE' });
}

/**
 * The well-formed public SSH keys on a GitHub account. The base is the PULLBOARD_GITHUB_API value (https, or loopback http for
 * tests; default https://api.github.com). A non-2xx answer, a redirect, a refused base or a request over 10 s is GITHUB_UNAVAILABLE.
 *
 * @param {string} login - The GitHub login whose keys are read.
 * @returns {Promise<string[]>} Only keys of a known SSH type.
 */
export async function githubKeys(login) {
  let adapter;
  try { adapter = createGithubAdapter(fetch, { base: environmentAdapter().get('PULLBOARD_GITHUB_API') || undefined }); } catch {
    throw unavailable('PULLBOARD_GITHUB_API must be an HTTPS address, or loopback HTTP for tests');
  }
  let keys;
  try {
    const response = await adapter.request(`/users/${encodeURIComponent(login)}/keys`, { signal: AbortSignal.timeout(10_000) }); // budget: one GitHub read, the same ceiling as a relay request.
    if (response.status < 200 || response.status > 299) throw new Error(String(response.status));
    keys = response.body;
  } catch { throw unavailable(`could not read ${login}'s SSH keys from GitHub; the key request waits for the next command`); }
  return (Array.isArray(keys) ? keys : []).map(entry => entry?.key).filter(key => typeof key === 'string' && KEY.test(key));
}
