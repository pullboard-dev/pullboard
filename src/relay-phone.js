/** Native approval requests never retain a person grant or its reply key [H5,H16,H17,B26]. */
import { randomUUID } from 'node:crypto';
import { approvalContext, createApprovalReply, openApproval, sealApproval, signApprovalIntent } from './relay-approval.js';
import { readBoardKey } from './relay-key.js';
import { readRelayMachine } from './relay-machine.js';
import { requirePersonChannel } from './person.js';
import { Refused } from './refused.js';

/** Select only a phone whose public key was MAC-authenticated into this native machine's roster. */
export function approvalPhone(state) {
  const device = readRelayMachine().devices.find(entry => entry.account === state.account && entry.url === state.url);
  if (!device) throw new Refused('PHONE_NOT_PAIRED', 'Pair the phone with pullboard relay on --all before requesting this action.');
  return device;
}

/** Build a sealed immutable proposal; only new-board link replies can have a durable private key. */
export async function phoneProposal(state, action, target, { board = state.board, command, link = false } = {}) {
  if (!/^pm_[A-Za-z0-9_-]{43}$/u.test(state.token ?? '')) throw new Refused('RELAY_SESSION', 'Run pullboard relay on --all to replace the old person session with board machine credentials.');
  const phone = approvalPhone(state);
  const reply = await createApprovalReply({ link });
  const context = approvalContext({ id: randomUUID(), account: state.account, publisher: state.board, board,
    device: phone.deviceId, action, target, machine: state.machine,
    command: command ?? 'pullboard relay ' + (action === 'revoke-device' || action === 'revoke-token' ? 'revoke ' + target : 'off'), expires: Date.now() + 600_000 });
  const envelope = await sealApproval({ context, replyKey: reply.publicKey }, phone.publicKey, context, 'intent');
  const mac = await signApprovalIntent(readBoardKey(state.board), envelope);
  return { context, sealed: Buffer.from(JSON.stringify({ envelope, mac })).toString('base64url'), reply };
}

/** Retain a relay refusal's code, reason and transport metadata while identifying its exact approval. */
function approvalRefusal(context, error) {
  if (error instanceof Refused) {
    const prefix = `[${error.code}] `;
    error.message = prefix + 'Approval request ' + context.id + ': ' + error.message.slice(prefix.length);
  }
  return error;
}

/** Publish one sealed proposal, failing immediately with its request identity on a relay refusal. */
export async function publishPhoneApproval(state, proposal, io, send) {
  const { context, sealed } = proposal;
  try {
    return await send(state, '/api/v1/devices/approvals', { method: 'POST', body: { context, sealed } }, io);
  } catch (error) { throw approvalRefusal(context, error); }
}

/** Record a partial failure and its request identity without undoing the completed local action. */
export function warnPhoneApproval(proposal, error, io, next) {
  const code = error instanceof Refused ? error.code : 'PHONE_APPROVAL_UNAVAILABLE';
  let reason = error instanceof Refused ? error.message.replace(/^\[[A-Z][A-Z0-9_]*\] /u, '')
    : 'The remote approval could not be published.';
  const annotation = 'Approval request ' + proposal.context.id + ': ';
  if (reason.startsWith(annotation)) reason = reason.slice(annotation.length);
  const remote = { code, reason, requestId: proposal.context.id };
  io.remote?.(remote);
  io.err(`pullboard: [${code}] Remote approval request ${remote.requestId}: ${reason}; ${next}`);
  return remote;
}

/** Keep a person action foreground and RAM-only from its request through one-use execution. */
export async function nativePhoneAction(state, action, target, io, send) {
  requirePersonChannel(io.personChannel);
  const proposal = await phoneProposal(state, action, target);
  const { context, reply } = proposal;
  await publishPhoneApproval(state, proposal, io, send);
  io.say('Approval request ' + context.id + ': approve ' + context.command + ' on your paired phone; expires ' + new Date(context.expires).toISOString() + '.');
  let interrupted = false;
  /** Drop the RAM-only reply key when the foreground command is interrupted. */
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!interrupted && Date.now() < context.expires) {
      const document = await send(state, '/api/v1/devices/approvals/' + context.id, {}, io);
      const approved = document.approval;
      if (JSON.stringify(approvalContext(approved?.context)) !== JSON.stringify(context)) throw new Refused('PHONE_APPROVAL_AUTH', 'The approval context changed; request this action again.');
      if (approved.state === 'expired') break;
      if (approved.state === 'approved') {
        let envelope;
        try { envelope = JSON.parse(Buffer.from(approved.response, 'base64url').toString('utf8')); }
        catch { throw new Refused('PHONE_APPROVAL_AUTH', 'The phone reply was invalid; request this action again.'); }
        const result = await openApproval(reply.privateKey, envelope, context, 'reply');
        if (!/^pg_[A-Za-z0-9_-]{43}$/u.test(result.grant ?? '') || !Number.isSafeInteger(result.expires) || result.expires <= Date.now()) throw new Refused('PHONE_APPROVAL_EXPIRED', 'Request a fresh phone approval for this exact action.');
        return (await send(state, '/api/v1/devices/approvals/' + context.id + '/execute', { method: 'POST', body: { grant: result.grant } }, io)).result;
      }
      await new Promise(resolve => { setTimeout(resolve, 500); });
    }
    throw new Refused('PHONE_APPROVAL_EXPIRED', 'The action was not approved; run it again explicitly when the phone is ready.');
  } catch (error) { throw approvalRefusal(context, error); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
