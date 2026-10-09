/** Set up a machine once, enroll its phone in the foreground and link later registrations [H5,H17]. */
import { repoInfo } from './git.js';
import { listApiProjects } from './projects.js';
import { acceptDeviceEnrollment, beginDeviceEnrollment, readRelayMachine, removeRecordedDevice, updateRelayMachine } from './relay-machine.js';
import { deliverDeviceWraps, relayDeviceRequest, relayMachineSignIn, relayOn, relayOrigin, relayStatus } from './relay.js';
import { terminalQr } from './qr.js';
import { Refused } from './refused.js';

/** Return local opt-in gaps without contacting the relay or renewing a person session. */
export function unlinkedRelayProjects() {
  const machine = readRelayMachine();
  if (!machine.autoLink) return [];
  return listApiProjects().filter(project => !machine.excluded.includes(project.root)).flatMap(project => {
    try { if (relayStatus(project.root).linked) return []; } catch { /* Preserve the registered project as a named finding. */ }
    return [{ code: 'RELAY_NOT_LINKED', message: `not linked: ${project.name} (sign in again: pullboard relay on --all)`, next: 'pullboard relay on --all' }];
  });
}

/** Link one registered project through the previously authorized machine session, with no prompt. */
export async function autoLinkProject(root, io) {
  const machine = readRelayMachine();
  if (!machine.autoLink) return;
  const project = repoInfo(root).root;
  if (machine.excluded.includes(project)) return;
  const name = listApiProjects().find(entry => entry.root === project)?.name ?? project;
  try {
    if (!machine.session) throw new Refused('RELAY_SESSION', 'sign in again: pullboard relay on --all');
    await relayOn(project, machine.session.url, io, { session: machine.session, quiet: true, strict: true });
  } catch (error) {
    io.err(`not linked: ${name} (sign in again: pullboard relay on --all); ${error instanceof Refused ? error.message : 'restore the registered project and retry'}`);
  }
}

/** Retry durable revocation intents using only the corresponding saved account session. */
async function flushRevocations(io) {
  const machine = readRelayMachine();
  for (const intent of machine.revocations) {
    if (!machine.session || machine.session.account !== intent.account || machine.session.url !== intent.url) {
      throw new Refused('RELAY_SESSION', 'Sign in to the paired account with pullboard relay on --all to finish device revocation.');
    }
    await relayDeviceRequest(machine.session, '/api/v1/devices/' + intent.deviceId, { method: 'DELETE' }, io);
    updateRelayMachine(state => { state.revocations = state.revocations.filter(entry => entry.deviceId !== intent.deviceId); });
  }
}

/** Revoke locally first; a remote outage leaves a durable deletion intent instead of future wraps. */
export async function revokeRelayDevice(deviceId, io) {
  removeRecordedDevice(deviceId);
  await flushRevocations(io);
  return { deviceId, revoked: true, notice: 'Revoked device; keys it already received remain known. Board key rotation is separate.' };
}

/** Link every non-excluded registry entry, collecting project-specific partial failures. */
async function linkProjects(session, io) {
  const machine = readRelayMachine();
  const linked = [];
  const failed = [];
  for (const project of listApiProjects()) {
    if (machine.excluded.includes(project.root)) continue;
    try {
      const result = await relayOn(project.root, session.url, io, { session, quiet: true, strict: true });
      linked.push({ project: project.name, root: project.root, board: result.board });
      io.say(`linked: ${project.name}`);
    } catch (error) {
      const reason = error instanceof Refused ? error.message : 'Restore this registered project and retry.';
      failed.push({ project: project.name, root: project.root, reason });
      io.err(`not linked: ${project.name}; ${reason}`);
    }
  }
  return { linked, failed };
}

/** Publish a one-use public locator and wait in this command; no service or unattended daemon is added. */
async function pairFirstDevice(session, board, linked, io) {
  const pending = beginDeviceEnrollment(board, session);
  const path = '/api/v1/devices/enrollments/' + pending.locator;
  await relayDeviceRequest(session, path, { method: 'POST', body: {} }, io);
  const link = session.url + '/#device=' + pending.locator + '.' + pending.secret;
  io.say('Pair your phone once: ' + link);
  try { io.say(terminalQr(link)); }
  catch (error) { if (error.code !== 'PAIR_LINK_LONG') throw error; io.say('Open the pairing link above.'); }
  let interrupted = false;
  /** End foreground pairing without discarding successful board links or saving a partial device. */
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!interrupted && Date.now() < pending.expires) {
      const result = await relayDeviceRequest(session, path, {}, io);
      if (interrupted) break;
      if (result.enrollment) {
        const device = await acceptDeviceEnrollment(result.enrollment);
        await relayDeviceRequest(session, '/api/v1/devices/' + device.deviceId, { method: 'POST', body: {} }, io);
        await relayDeviceRequest(session, path, { method: 'DELETE' }, io);
        for (const project of linked) await deliverDeviceWraps(project.root, io);
        io.say('Phone paired; current and future linked boards will appear here.');
        return { paired: true, deviceId: device.deviceId };
      }
      await new Promise(resolve => { setTimeout(resolve, 500); });
    }
    io.say('Boards linked; phone pairing stopped. Run pullboard relay on --all for a fresh code.');
    return { paired: false, interrupted };
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    updateRelayMachine(state => { if (state.pending?.locator === pending.locator) state.pending = null; });
    // Best-effort remove the public locator. Its relay lifetime remains ten minutes on an outage.
    try { await relayDeviceRequest(session, path, { method: 'DELETE' }, io); } catch { /* Never undo completed links after a pairing timeout. */ }
  }
}

/** Save the account session once, link all projects and only wait when this Mac has no paired phone. */
export async function relayOnAll(address, io) {
  const prior = readRelayMachine();
  let session = prior.session;
  const requestedOrigin = address ? relayOrigin(address) : undefined;
  if (requestedOrigin && session?.url !== requestedOrigin) session = null;
  if (session) {
    try {
      const identity = await relayDeviceRequest(session, '/api/v1/devices/session', {}, io);
      if (identity.account !== session.account) throw new Refused('RELAY_SESSION', 'Sign in again to this account.');
    } catch (error) { if (error.code !== 'AUTH_REQUIRED') throw error; session = null; }
  }
  session ??= await relayMachineSignIn(address || prior.session?.url, io);
  updateRelayMachine(state => { state.autoLink = true; state.session = session; });
  await flushRevocations(io);
  const result = await linkProjects(session, io);
  const devices = readRelayMachine().devices.filter(device => device.account === session.account && device.url === session.url);
  const pairing = devices.length || !result.linked.length ? { paired: devices.length > 0 }
    : await pairFirstDevice(session, result.linked[0].board, result.linked, io);
  return { ...result, ...pairing, autoLink: true };
}
