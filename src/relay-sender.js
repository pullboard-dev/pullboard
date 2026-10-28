/** Preserve the sender front door while supplying its actual declared operation authority [H16,C7]. */
import { declaredMoveActor } from './move-registry.js';
import { validPresence } from './person-presence.js';
import { relaySenderPolicy } from './state-relay-sender-policy.js';
export { validPresence } from './person-presence.js';
const policy = relaySenderPolicy({ declaredMoveActor, validPresence });
export const relayMoveActor = policy.relayMoveActor;
export const validRelaySender = policy.validRelaySender;
export const personAuthority = policy.personAuthority;
export const relaySenderProblem = policy.relaySenderProblem;
export const credentialActor = policy.credentialActor;
export const operationIntent = policy.operationIntent;
