/** Set up a machine once, enroll its phone in the foreground and link later registrations [H5,H17]. */
import { join } from 'node:path';
import * as store from './board.js';
import { phoneProposal } from './relay-phone.js';
import { openApproval, restoreLinkReply } from './relay-approval.js';
import { requirePersonChannel } from './person.js';
import { repoInfo } from './git.js';
import { listApiProjects } from './projects.js';
import { acceptDeviceEnrollment, beginDeviceEnrollment, readRelayMachine, updateRelayMachine } from './relay-machine.js';
import { deliverDeviceWraps, relayDeviceRequest, relayMachineSignIn, relayMachineContext, relayRevokeDevice, relayOn, relayStatus, originRepository } from './relay.js';
import { terminalQr } from './qr.js';
import { Refused } from './refused.js';

/** Return local opt-in gaps without contacting the relay or renewing a person session. */
export function unlinkedRelayProjects() {
  const machine = readRelayMachine();
  if (!machine.autoLink) return [];
  return listApiProjects().filter(project => !machine.excluded.includes(project.root)).flatMap(project => {
    try { if (relayStatus(project.root).linked) return []; } catch { /* Preserve the registered project as a named finding. */ }
    const pending = machine.approvals.find(entry => entry.root === project.root);
    return [{ code: pending ? 'PHONE_APPROVAL_PENDING' : 'RELAY_NOT_LINKED', message: pending ? 'waiting for phone approval: ' + project.name + '; expires ' + new Date(pending.context.expires).toISOString() : 'not linked: ' + project.name + '; run pullboard relay on --all', next: pending && Date.now() < pending.context.expires ? 'Approve the named link on your paired phone.' : 'pullboard relay on --all' }];
  });
}

/** Read the registered local board identity without executing any person action. */
function projectBoard(root) {
  const board = store.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'));
  try { return store.boardId(board); } finally { store.closeBoard(board); }
}

/** Link a new project only after the paired phone explicitly approves its one durable proposal. */
export async function autoLinkProject(root, io) {
  const machine = readRelayMachine();
  if (!machine.autoLink) return;
  const project = repoInfo(root).root;
  if (machine.excluded.includes(project) || relayStatus(project).linked) return;
  const name = listApiProjects().find(entry => entry.root === project)?.name ?? project;
  try {
    let pending = machine.approvals.find(entry => entry.root === project);
    if (pending && Date.now() >= pending.context.expires) throw new Refused('PHONE_APPROVAL_EXPIRED', 'Link approval expired; run pullboard relay on --all explicitly to link this project.');
    let source;
    if (pending) source = relayMachineContext(pending.publisherRoot);
    else {
      const candidate = listApiProjects().map(entry => ({ ...entry, state: relayMachineContext(entry.root) }))
        .find(entry => entry.state?.token?.startsWith('pm_') && entry.state.account === machine.owner?.account && entry.state.url === machine.owner?.url);
      if (!candidate) throw new Refused('RELAY_SESSION', 'Run pullboard relay on --all to link this project and pair the phone.');
      source = candidate.state;
      const proposal = await phoneProposal(source, 'link', originRepository(project),
        { board: projectBoard(project), command: 'Link ' + name + '? (pullboard init)', link: true });
      const value = { root: project, publisherRoot: candidate.root, context: proposal.context, sealed: proposal.sealed, replyKey: proposal.reply.storedKey, published: false };
      pending = updateRelayMachine(state => {
        const existing = state.approvals.find(entry => entry.root === project);
        if (existing) return existing;
        state.approvals.push(value); return value;
      });
      source = relayMachineContext(pending.publisherRoot);
    }
    if (!source?.token?.startsWith('pm_')) throw new Refused('RELAY_SESSION', 'Restore the publishing board link or run pullboard relay on --all.');
    if (!pending.published) {
      await relayDeviceRequest(source, '/api/v1/devices/approvals', { method: 'POST', body: { context: pending.context, sealed: pending.sealed } }, io);
      updateRelayMachine(state => { const entry = state.approvals.find(value => value.context.id === pending.context.id); if (entry) entry.published = true; });
    }
    const document = await relayDeviceRequest(source, '/api/v1/devices/approvals/' + pending.context.id, {}, io);
    if (document.approval.state !== 'approved') {
      io.err('waiting for phone approval: ' + name + '; expires ' + new Date(pending.context.expires).toISOString() + '; local work continues.'); return;
    }
    const privateKey = await restoreLinkReply(pending.replyKey);
    const result = await openApproval(privateKey, JSON.parse(Buffer.from(document.approval.response, 'base64url').toString('utf8')), pending.context, 'reply');
    const credential = { ...result.credential, account: pending.context.account, url: source.url };
    await relayOn(project, source.url, io, { credential, quiet: true, strict: true });
    updateRelayMachine(state => { state.approvals = state.approvals.filter(entry => entry.context.id !== pending.context.id); });
  } catch (error) {
    io.err('not linked: ' + name + '; ' + (error instanceof Refused ? error.message : 'Restore the pending phone approval or run pullboard relay on --all.'));
  }
}

/** Retry only old deletion intents during an explicit foreground sign-in; never retain that session. */
async function flushRevocations(session, io) {
  for (const intent of readRelayMachine().revocations) {
    if (session.account !== intent.account || session.url !== intent.url) continue;
    await relayDeviceRequest(session, '/api/v1/devices/' + intent.deviceId, { method: 'DELETE' }, io);
    updateRelayMachine(state => { state.revocations = state.revocations.filter(entry => entry.deviceId !== intent.deviceId); });
  }
}

/** The native device revocation uses the same one-tap grant path as token revocation. */
export async function revokeRelayDevice(deviceId, io) {
  requirePersonChannel(io.personChannel);
  const device = readRelayMachine().devices.find(entry => entry.deviceId === deviceId);
  if (!device) throw new Refused('DEVICE_NOT_ENROLLED', 'Name a paired device from pullboard relay devices.');
  const roots = [io.cwd, ...listApiProjects().map(entry => entry.root)];
  for (const root of roots) {
    let state;
    try { state = relayMachineContext(root); } catch { continue; }
    if (state?.token?.startsWith('pm_') && state.account === device.account && state.url === device.url) return relayRevokeDevice(root, deviceId, io);
  }
  throw new Refused('RELAY_NOT_LINKED', 'Link a board and pair the phone with pullboard relay on --all.');
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

/** Explicit foreground sign-in repairs links; only board machine credentials survive this command. */
export async function relayOnAll(address, io) {
  requirePersonChannel(io.personChannel);
  const prior = readRelayMachine();
  // Scrub every registered legacy link before asking for or using fresh person authority.
  for (const project of listApiProjects()) { try { relayMachineContext(project.root); } catch { /* linkProjects reports invalid projects. */ } }
  const session = await relayMachineSignIn(address || prior.owner?.url, io);
  updateRelayMachine(state => { state.autoLink = true; state.owner = { account: session.account, url: session.url }; state.approvals = []; });
  await flushRevocations(session, io);
  const result = await linkProjects(session, io);
  const devices = readRelayMachine().devices.filter(device => device.account === session.account && device.url === session.url);
  const pairing = devices.length || !result.linked.length ? { paired: devices.length > 0 }
    : await pairFirstDevice(session, result.linked[0].board, result.linked, io);
  return { ...result, ...pairing, autoLink: true };
}
