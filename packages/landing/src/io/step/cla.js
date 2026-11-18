/** The landing step that records each new CLA signer of a landed pull request in the signatures file [C7,#3308]. */
import { appendClaSignatures } from '../../../../gate/light.js';
import { evaluateCla } from '../../../../gate/light.js';
import { readClaSignatures } from '../../../../gate/light.js';

/**
 * Append one signature entry for each new signer of a landed pull request.
 * `pr` is `{commits, comments}` as the CLA check reads it; `claText` is CLA.md at the PR base.
 * Why one append per signer: each entry keeps its own comment url and time, and a signer already in the file is never a
 * new signer, so a returning contributor's later landing appends nothing.
 *
 * @returns {string[]} the logins recorded, in order
 */
export function recordClaSigners({ pr, signaturesPath, claText, now }) {
  const { newSigners } = evaluateCla(pr, readClaSignatures(signaturesPath));
  for (const signer of newSigners) appendClaSignatures(signaturesPath, [signer], claText, now);
  return newSigners.map((signer) => signer.login);
}
