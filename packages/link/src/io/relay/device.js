import { cancellationOutcome } from '../../logic/relay/poll.js';
import { waitForDevicePoll } from '../../logic/relay/poll.js';
import { Refused } from '../../../../kernel/light.js';
import { request } from '../relay.js';

const ROSTER_READ_IO = Object.freeze({ ignoreRelayEnvironmentToken: true, err: ignoreRosterNotice });

/** Cancel one device ticket without the already-aborted caller signal. */
async function cancelDeviceFlow(url, ticket, io) {
  let result;
  try { result = await request({ url }, '/auth/device/cancel', { method: 'POST', body: { ticket } }, io); }
  catch {
    throw new Refused('OAUTH_CLEANUP', 'the relay could not confirm cleanup of the cancelled sign-in; retry before linking boards');
  }
  if (result.cancelled !== true) throw new Refused('OAUTH_CLEANUP', 'the relay did not confirm cleanup of the cancelled sign-in; retry before linking boards');
}

/** Revoke only the fresh person session created by this explicit device sign-in. */
export async function revokeRelayPersonSession(session, io) {
  if (!session || typeof session.token !== 'string' || !/^ps_[A-Za-z0-9_-]{43}$/.test(session.token) || typeof session.id !== 'string') {
    throw new Refused('OAUTH_CLEANUP', 'the relay session could not be identified for cancellation cleanup');
  }
  const result = await request({ url: session.url, token: session.token }, '/auth/tokens/revoke', { method: 'POST', body: { id: session.id } }, io);
  if (result.id !== session.id || result.revoked !== true) throw new Refused('OAUTH_CLEANUP', 'the relay did not confirm cleanup of the cancelled sign-in; retry before linking boards');
}

/** Sign in with the caller's cancellation signal; no board credential is persisted here. */
export async function deviceSignIn(url, io, { signal, intent, onSignIn } = {}) {
  cancellationOutcome(signal);
  const client = { url };
  const flow = await request(client, '/auth/device/start', { method: 'POST', body: intent ? { intent } : {}, signal }, io);
  try {
    cancellationOutcome(signal);
    io.stderr.write(intent
      ? `Sign in with GitHub for board ${intent.boardName} from ${intent.host}: open ${flow.verificationURL} and enter ${flow.userCode}. After sign-in, confirm the link in your browser: ${flow.confirmationURL}\n`
      : `Sign in with GitHub: open ${flow.verificationURL} and enter ${flow.userCode}\n`);
    if (intent && typeof flow.confirmationURL !== 'string') throw new Refused('RELAY_RESPONSE', 'the relay did not provide a board confirmation page; sign in again');
    let expires = Date.now() + flow.expiresIn * 1000;
    // The view receives only the public device instructions. The ticket stays in this stack.
    onSignIn?.({ verificationURL: flow.verificationURL, userCode: flow.userCode, expiresAt: expires, relayUrl: url });
    let confirmationPending = false;
    let signed;
    let wait = flow.interval;
    do {
      await waitForDevicePoll(wait, signal);
      if (!confirmationPending && Date.now() >= expires) throw new Refused('OAUTH_EXPIRED', 'GitHub device sign-in expired; run pullboard relay on again');
      signed = await request(client, '/auth/device/poll', { method: 'POST', body: { ticket: flow.ticket }, signal }, io);
      cancellationOutcome(signal);
      if (signed.pendingConfirmation && Number.isSafeInteger(signed.confirmationExpiresIn)) {
        confirmationPending = true;
        expires = Date.now() + signed.confirmationExpiresIn * 1000;
      }
      wait = signed.retryAfter ?? flow.interval;
    } while (signed.pending);
    const token = signed.token;
    if (!/^ps_[A-Za-z0-9_-]{43}$/.test(token)) throw new Refused('RELAY_RESPONSE', 'the relay did not issue a person session; sign in again');
    return signed;
  } catch (error) {
    if (signal?.aborted || error.code === 'OAUTH_CANCELLED') {
      await cancelDeviceFlow(url, flow.ticket, io);
      throw new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked');
    }
    throw error;
  }
}

/** Share the existing bounded transport only with fixed account/device endpoints. */
export async function relayDeviceRequest(session, path, options, io) {
  if (!path.startsWith('/api/v1/devices/')) throw new Refused('DEVICE_ENDPOINT', 'Use a supported relay device action.');
  return await request(session, path, options, io);
}

/** Ignore notices from courtesy roster reads; disconnected boards keep their local labels and dates. */
function ignoreRosterNotice() {}

/** Read only the fixed, board-scoped roster resources through the CLI's existing outbound transport. */
export async function relayRosterRead(state, path) {
  const board = typeof state?.board === 'string' && /^[0-9a-f]{32}$/u.test(state.board);
  const allowed = typeof path === 'string' && (path === '/api/v1/devices' || /^\/api\/v1\/devices\/device-[0-9a-f]{32}$/u.test(path) ||
    (board && path === `/auth/machines?board=${state.board}`));
  if (!allowed) throw new Refused('RELAY_ROSTER_PATH', 'the roster requested an unsupported relay resource');
  return request(state, path, { method: 'GET', signal: AbortSignal.timeout(5000) }, ROSTER_READ_IO);
}
