/** Membership authority comes from committed policy or exact local SSH proofs, never a relay assertion [E17]. */
import { mainPolicy } from './trusted-policy.js';
import { Refused } from './refused.js';
import {
  boardMembersBytes,
  boardMembersDocument,
} from './board-members.js';
import {
  signSshVouch,
  verifySshVouch,
} from './relay-ssh-proof.js';

const NAMESPACE = 'pullboard-board-members';
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sameRepository = sameLogin;

/** Read only the approvers from the accepted committed policy. */
function approvers(root) {
  const list = mainPolicy(root).config.approvers;
  return Array.isArray(list) ? list : [];
}

/** Fingerprint the current accepted approvers and native member revision across asynchronous proof lookups. */
export function memberAuthorityStamp(root, document) {
  return JSON.stringify([approvers(root).map(login => login.toLowerCase()).sort(), document]);
}

/** Prepare the exact next revision with the local key, then independently prove its committed approver ownership. */
export async function prepareBoardMembers(root, state, logins, { githubKeys, revision, signingKey } = {}) {
  const by = state.login;
  if (!approvers(root).some(login => sameLogin(login, by))) {
    throw new Refused('NOT_APPROVER', `${by ?? 'this person'} is not a committed approver; ask an approver named in pullboard.json to publish board members`);
  }
  if (logins != null && !Array.isArray(logins)) throw new Refused('BOARD_MEMBERS_INVALID', 'board members must be a list of GitHub logins');
  const members = logins == null ? [] : [...logins];
  const unsigned = { body: { v: 1, board: state.board, repository: state.repository, revision, members }, by };
  // Validate before signing, without accepting or retaining a mutable caller container.
  const checked = boardMembersDocument({ ...unsigned, signature: '-----BEGIN SSH SIGNATURE-----\nvalidation\n' });
  const bytes = boardMembersBytes(checked);
  const signature = signSshVouch(bytes, NAMESPACE, signingKey);
  if (!await verifySshVouch(bytes, signature, by, githubKeys, NAMESPACE)) {
    throw new Refused('RELAY_KEY_VOUCH', `the signing key is not a current GitHub SSH key of committed approver ${by}; select that person's SSH key`);
  }
  return boardMembersDocument({ ...checked, signature });
}

/** Authorize a requester using only current committed policy or independently verified exact signed documents. */
export async function authorizeMember(root, state, document, login, { githubKeys, identity } = {}) {
  if (typeof login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(login)) {
    throw new Refused('RELAY_NOT_MEMBER', 'the key requester has no valid GitHub login');
  }
  const owners = approvers(root);
  if (owners.some(owner => sameLogin(owner, login))) return true;
  const body = identity?.body;
  if (body && Object.keys(identity).sort().join(',') === 'body,signature' &&
      Object.keys(body).sort().join(',') === 'board,login,repository,v' && body.v === 1 &&
      body.board === state.board && sameRepository(body.repository, state.repository) && sameLogin(body.login, login)) {
    const bytes = JSON.stringify(['pullboard-person-identity', { v: 1, board: body.board, repository: body.repository, login: body.login }]);
    if (await verifySshVouch(bytes, identity.signature, login, githubKeys, 'pullboard-person-identity')) return true;
  }
  if (document) {
    const checked = boardMembersDocument(document);
    if (checked.body.board === state.board && sameRepository(checked.body.repository, state.repository) &&
        owners.some(owner => sameLogin(owner, checked.by)) && checked.body.members.some(member => sameLogin(member, login)) &&
        await verifySshVouch(boardMembersBytes(checked), checked.signature, checked.by, githubKeys, NAMESPACE)) return true;
  }
  throw new Refused('RELAY_NOT_MEMBER', `${login} is not a trusted member of this board; a committed approver must publish a signed board member list naming ${login}`);
}
