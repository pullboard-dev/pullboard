/** Set up a machine once, enroll its phone in the foreground and link later registrations [H5,H17]. */
import { join } from 'node:path';
import { computerName } from '../../../../seats/index.js';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import * as store from '../../../../store/index.js';
import { phoneProposal } from './phone.js';
import { publishPhoneApproval } from './phone.js';
import { warnPhoneApproval } from './phone.js';
import { openApproval } from '../../logic/relay/approval.js';
import { restoreLinkReply } from '../../logic/relay/approval.js';
import { requirePersonChannel } from '../../../../person/index.js';
import { codeIsFromMain } from '../../../../git/index.js';
import { repoInfo } from '../../../../git/index.js';
import { listApiProjects } from '../../../../seats/index.js';
import { acceptDeviceEnrollment } from './machine.js';
import { beginDeviceEnrollment } from './machine.js';
import { readRelayMachine } from './machine.js';
import { relayMachineOwner } from './machine.js';
import { updateRelayMachine } from './machine.js';
import { deliverDeviceWraps } from '../relay.js';
import { relayDeviceRequest } from '../relay.js';
import { relayLinked } from '../relay.js';
import { relayLinkAvailability } from '../relay.js';
import { relayMachineSignIn } from '../relay.js';
import { relayMachineContext } from '../relay.js';
import { relayRevokeDevice } from '../relay.js';
import { relayOn } from '../relay.js';
import { relayIo } from '../relay-io.js';
import { originRepository } from '../relay.js';
import { revokeRelayPersonSession } from '../relay.js';
import { terminalQr } from '../../../../person/light.js';
import { relayOfferEnabled } from '../../../../config/index.js';
import { Refused } from '../../../../kernel/light.js';
import { clearRelayExclusion } from './exclusion.js';
import { publishExcludedBoards } from './excluded.js';
import { plannedRelayBoard } from './relink.js';

/** Say which paired phone must approve a new board's link, and when the request ends in this computer's time. */
function approvalWait(name, pending, devices) {
  const phone = devices.find(entry => entry.deviceId === pending.context.device)?.label ?? 'your paired phone';
  const expires = new Date(pending.context.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return 'waiting for phone approval: approve linking ' + name + ' on ' + phone + ' by ' + expires;
}

/** Return local opt-in gaps without contacting the relay or renewing a person session. */
export function unlinkedRelayProjects() {
  const machine = readRelayMachine();
  if (!machine.autoLink) return [];
  return listApiProjects().filter(project => !machine.excluded.includes(project.root)).flatMap(project => {
    try { if (relayLinkAvailability(project.root).linked) return []; } catch { /* Preserve the registered project as a named finding. */ }
    const pending = machine.approvals.find(entry => entry.root === project.root);
    return [{ code: pending ? 'PHONE_APPROVAL_PENDING' : 'RELAY_NOT_LINKED', message: pending ? approvalWait(project.name, pending, machine.devices) : 'not linked: ' + project.name + '; run pullboard relay on --all', next: pending && Date.now() < pending.context.expires ? 'Approve the named link on your paired phone.' : 'pullboard relay on --all' }];
  });
}

/** Read the registered local board identity without executing any person action. */
function projectBoard(root, openBoard) {
  const board = openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
  try { return plannedRelayBoard(root, store.boardId(board)); } finally { store.closeBoard(board); }
}

/**
 * Open the credential the phone sealed to this machine's reply key and link with it. relayOn
 * uploads the sealed snapshot, then wraps the board key to each paired phone, so the key leaves
 * this machine only sealed to the phone the person approved from.
 */
async function finishApprovedLink(project, pending, source, approval, io) {
  const privateKey = await restoreLinkReply(pending.replyKey);
  const result = await openApproval(privateKey, JSON.parse(Buffer.from(approval.response, 'base64url').toString('utf8')), pending.context, 'reply');
  const credential = { ...result.credential, account: pending.context.account, url: source.url };
  const linked = await relayOn(project, source.url, io, { credential, quiet: true, strict: true });
  updateRelayMachine(state => { state.approvals = state.approvals.filter(entry => entry.context.id !== pending.context.id); });
  return linked;
}

/**
 * Read one registered board's link as a possible publisher. Another entry's refusal, such as a
 * scratch folder that is no longer a git work tree, rules out only that entry: it never speaks
 * for the board this command runs in.
 */
function publisherState(root) {
  try { return relayMachineContext(root); } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return null;
  }
}

/** Link a new project only after the paired phone explicitly approves its one durable proposal. */
export async function autoLinkProject(root, io, { openBoard } = {}) {
  if (typeof openBoard !== 'function') throw new TypeError('automatic relay linking requires the caller-supplied openBoard port');
  const machine = readRelayMachine();
  if (!machine.autoLink) return;
  const project = repoInfo(root).root;
  if (machine.excluded.includes(project) || relayLinked(project)) return;
  const repository = originRepository(project, { optional: true });
  if (!repository) return;
  const name = listApiProjects().find(entry => entry.root === project)?.name ?? project;
  let pending = machine.approvals.find(entry => entry.root === project);
  // Only the command that publishes the request prints the wait; later commands poll quietly.
  let announce = false;
  try {
    if (pending && Date.now() >= pending.context.expires) throw new Refused('PHONE_APPROVAL_EXPIRED', 'Link approval expired; run pullboard relay on --all explicitly to link this project.');
    let source;
    if (pending) source = relayMachineContext(pending.publisherRoot);
    else {
      const candidate = listApiProjects().map(entry => ({ ...entry, state: publisherState(entry.root) }))
        .find(entry => entry.state?.token?.startsWith('pm_') && entry.state.account === machine.owner?.account && entry.state.url === machine.owner?.url);
      // With the relay off no board here can publish the request, so a move prints only its result;
      // doctor and resume still name each unlinked board.
      if (!candidate) return;
      source = candidate.state;
      const proposal = await phoneProposal(source, 'link', repository,
        { board: projectBoard(project, openBoard), command: 'Link ' + name + '? (pullboard init)', link: true, root: project });
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
      await publishPhoneApproval(source, pending, io, relayDeviceRequest);
      announce = true;
      updateRelayMachine(state => { const entry = state.approvals.find(value => value.context.id === pending.context.id); if (entry) entry.published = true; });
    }
    const document = await relayDeviceRequest(source, '/api/v1/devices/approvals/' + pending.context.id, {}, io);
    if (document.approval.state !== 'approved') {
      if (announce) io.err(approvalWait(name, pending, machine.devices) + '; local work continues.');
      return;
    }
    await finishApprovedLink(project, pending, source, document.approval, io);
    io.err('linked: ' + name);
  } catch (error) {
    if (pending) {
      warnPhoneApproval(pending, error, io, 'Local registration is complete; run pullboard relay on --all explicitly to link this project.');
      return;
    }
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

/** Recover an unavailable phone using a new provider proof kept only for this foreground action. */
async function revokeDeviceWithSignIn(device, io) {
  const controller = new AbortController();
  /** Cancel the new device flow without retaining a person credential. */
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let session;
  try {
    io.say('Sign in again with GitHub to revoke this device; approval on that device is not needed.');
    session = await relayMachineSignIn(device.url, io, { signal: controller.signal });
    if (session.outcome) throw new Refused('DEVICE_REVOKE_CANCELLED',
      'GitHub sign-in ' + session.outcome + '; no device was revoked. Run pullboard relay revoke ' + device.deviceId + ' when ready.');
    if (session.account !== device.account || session.url !== device.url) throw new Refused('DEVICE_ACCOUNT',
      'Sign in to the GitHub account that paired this device, then run pullboard relay revoke ' + device.deviceId + ' again.');
    const reply = await relayDeviceRequest(session, '/api/v1/devices/' + device.deviceId,
      { method: 'DELETE', signal: controller.signal }, io);
    if (reply.recorded !== true) throw new Refused('RELAY_RESPONSE',
      'The relay did not confirm device revocation; check pullboard relay devices and retry the same revoke command.');
    updateRelayMachine(state => {
      state.devices = state.devices.filter(entry => entry.deviceId !== device.deviceId);
      state.revocations = state.revocations.filter(entry => entry.deviceId !== device.deviceId);
    });
    return { deviceId: device.deviceId, revoked: true,
      notice: 'Revoked device; keys it already received remain known. Board key rotation is separate.' };
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (session?.token) await revokeRelayPersonSession(session, io);
  }
}

/** Use another paired phone when available; the device being revoked never approves itself. */
export async function revokeRelayDevice(deviceId, io) {
  requirePersonChannel(io.personChannel);
  const machine = readRelayMachine();
  const device = machine.devices.find(entry => entry.deviceId === deviceId);
  if (!device) throw new Refused('DEVICE_NOT_ENROLLED', 'Name a paired device from pullboard relay devices.');
  const otherPhone = machine.devices.some(entry => entry.deviceId !== deviceId && entry.account === device.account && entry.url === device.url);
  if (otherPhone) {
    const roots = [io.cwd, ...listApiProjects().map(entry => entry.root)];
    for (const root of roots) {
      let state;
      try { state = relayMachineContext(root); } catch { continue; }
      if (state?.token?.startsWith('pm_') && state.account === device.account && state.url === device.url) return relayRevokeDevice(root, deviceId, io);
    }
  }
  return revokeDeviceWithSignIn(device, io);
}

/**
 * Link non-excluded registry entries and report an explicit outcome for every registered project.
 * With `only`, link just the board of that name and clear its exclusion; the others are left as they were.
 * Why: an excluded board's skip line names the one command that relinks it, so the person is never left without a way out [C7,#9416].
 * `link` and `projects` are the seams a test passes in place of the relay and the registry.
 *
 * @param {any} session
 * @param {any} io
 * @param {{onBoardOutcome?: Function, waiting?: Set<string>, only?: string, link?: Function, projects?: {root: string, name: string}[]}} [options]
 */
export async function linkProjects(session, io, { onBoardOutcome, waiting = new Set(), only, link = relayOn, projects = listApiProjects() } = {}) {
  const machine = readRelayMachine();
  const linked = [];
  const failed = [];
  if (only !== undefined && !projects.some(project => project.name === only)) {
    throw new Refused('USAGE', `No registered board is named ${only}; registered boards: ${projects.map(project => project.name).join(', ') || 'none'}; run pullboard relay on --all --only <name> with one of those names.`);
  }
  for (const project of projects) {
    if (only !== undefined && project.name !== only) continue;
    if (only === undefined && machine.excluded.includes(project.root)) {
      onBoardOutcome?.({ root: project.root, name: project.name, outcome: 'skipped', reason: 'Excluded from automatic linking on this machine.' });
      io.say(`Did not link ${project.name}: it is excluded from automatic linking on this machine. To link it, run: pullboard relay on --all --only ${project.name}`);
      continue;
    }
    // A board whose link card is on the phone waits for that tap; see waitForLinkApprovals.
    if (waiting.has(project.root)) continue;
    try {
      const result = await link(project.root, session.url, io, { session, quiet: true, strict: true });
      if (only !== undefined) clearRelayExclusion(project.root);
      linked.push({ project: project.name, root: project.root, board: result.board });
      onBoardOutcome?.({ root: project.root, name: project.name, outcome: 'linked', reason: '' });
      io.say(`Linked ${project.name}.`);
    } catch (error) {
      const reason = error instanceof Refused ? error.message : 'Restore this registered project and retry.';
      failed.push({ project: project.name, root: project.root, reason });
      onBoardOutcome?.({ root: project.root, name: project.name, outcome: 'failed', reason });
      io.err(`Did not link ${project.name}: ${reason}`);
    }
  }
  const total = only === undefined ? projects.length : 1;
  io.say(`Linked ${linked.length} of ${total} registered ${total === 1 ? 'board' : 'boards'}.`);
  return { linked, failed };
}

/** Name the published, unexpired phone link cards this run can wait for on a phone already paired. */
function waitingLinkApprovals(session) {
  const machine = readRelayMachine();
  if (!machine.devices.some(device => device.account === session.account && device.url === session.url)) return [];
  const registered = new Set(listApiProjects().map(project => project.root));
  return machine.approvals.filter(entry => {
    if (!entry.published || Date.now() >= entry.context.expires || entry.context.account !== session.account) return false;
    if (machine.excluded.includes(entry.root) || !registered.has(entry.root)) return false;
    let source;
    try { source = relayMachineContext(entry.publisherRoot); } catch { return false; }
    return Boolean(source?.token?.startsWith('pm_')) && source.url === session.url;
  });
}

/**
 * Keep this foreground run open until the phone answers each waiting link card, then link that
 * board in the same run. Without this wait the phone that just approved sees a board it cannot
 * read until the computer happens to run another command (walkthrough-090 issue 15).
 */
async function waitForLinkApprovals(waiting, io, { signal } = {}) {
  const linked = [];
  const failed = [];
  const name = root => listApiProjects().find(project => project.root === root)?.name ?? root;
  let open = [...waiting];
  for (const pending of open) {
    io.say('waiting for phone approval: ' + name(pending.root) + '; tap Link project on your phone before ' + new Date(pending.context.expires).toISOString() + '.');
  }
  let interrupted = false;
  /** Stop waiting without undoing a link; the next command still finishes an approved card. */
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (open.length && !signal?.aborted && !interrupted) {
      for (const pending of [...open]) {
        if (signal?.aborted || interrupted) break;
        const project = name(pending.root);
        try {
          if (Date.now() >= pending.context.expires) throw new Refused('PHONE_APPROVAL_EXPIRED', 'Link approval expired; run pullboard relay on --all to link this board.');
          const source = relayMachineContext(pending.publisherRoot);
          const document = await relayDeviceRequest(source, '/api/v1/devices/approvals/' + pending.context.id, { signal }, io);
          if (document.approval.state === 'expired') throw new Refused('PHONE_APPROVAL_EXPIRED', 'Link approval expired; run pullboard relay on --all to link this board.');
          if (document.approval.state !== 'approved') continue;
          const result = await finishApprovedLink(pending.root, pending, source, document.approval, io);
          linked.push({ project, root: pending.root, board: result.board });
          io.say('linked: ' + project);
        } catch (error) {
          if (signal?.aborted && error.code === 'OAUTH_CANCELLED') break;
          const reason = error instanceof Refused ? error.message.replace(/^\[[A-Z][A-Z0-9_]*\] /u, '') : 'Restore this registered project and retry.';
          failed.push({ project, root: pending.root, reason });
          io.err(`not linked: ${project}; ${reason}`);
        }
        open = open.filter(entry => entry !== pending);
      }
      if (open.length) await waitForPairingPoll(signal);
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  for (const pending of open) io.say('stopped waiting for phone approval: ' + name(pending.root) + '; after you tap Link project, the next pullboard command on this computer finishes the link.');
  return { linked, failed };
}

/** Wait for the next pairing poll or an abort without leaving an abort listener behind. */
function waitForPairingPoll(signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Publish a one-use locator and wait in this command; cancellation never undoes linked boards. */
async function pairFirstDevice(session, board, linked, io, { signal, onPairingURL, pairAdditional = false } = {}) {
  const retryCommand = pairAdditional ? 'pullboard relay pair --new-browser' : 'pullboard relay on --all';
  if (signal?.aborted) {
    io.say(pairAdditional ? 'Boards linked; browser pairing cancelled. Run ' + retryCommand + ' for a fresh code.' : 'Boards linked; phone pairing cancelled. Run pullboard relay on --all for a fresh code.');
    return { paired: false, interrupted: false, pairingOutcome: 'cancelled', pairingCleanup: 'not-published' };
  }
  const pending = beginDeviceEnrollment(board, session);
  const path = '/api/v1/devices/enrollments/' + pending.locator;
  const link = session.url + '/#device=' + pending.locator + '.' + pending.secret;
  let interrupted = false;
  let pairingOutcome = 'expired';
  let pairingCleanup = 'not-published';
  let locatorMayExist = false;
  let deviceId;
  /** Stop foreground polling without discarding successful board links or saving a partial device. */
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    locatorMayExist = true;
    try { await relayDeviceRequest(session, path, { method: 'POST', body: {}, signal }, io); }
    catch (error) {
      if (signal?.aborted && error.code === 'OAUTH_CANCELLED') pairingOutcome = 'cancelled';
      else throw error;
    }
    if (signal?.aborted || interrupted) pairingOutcome = 'cancelled';
    else if (onPairingURL) onPairingURL({ url: link, expires: pending.expires });
    else {
      io.say(pairAdditional ? 'Now waiting for another browser to pair. Open this link in that browser, or scan the code on your phone.' : 'Now waiting for a phone to pair. On your phone, scan the code below or open this link.');
      io.say((pairAdditional ? 'Pair this browser: ' : 'Pair your phone once: ') + link);
      try { io.say(terminalQr(link)); }
      catch (error) { if (error.code !== 'PAIR_LINK_LONG') throw error; io.say('Open the pairing link above.'); }
      // Ctrl-C reaches the stop handler above, which keeps every linked board and exits cleanly.
      io.say(`To skip pairing, press Ctrl-C. The linked boards stay linked, and ${retryCommand} gives a fresh code later. This code works until ${new Date(pending.expires).toISOString()}.`);
    }
    while (!signal?.aborted && !interrupted && Date.now() < pending.expires) {
      let result;
      try { result = await relayDeviceRequest(session, path, { signal }, io); }
      catch (error) {
        if (signal?.aborted && error.code === 'OAUTH_CANCELLED') { pairingOutcome = 'cancelled'; break; }
        throw error;
      }
      if (signal?.aborted || interrupted) { pairingOutcome = 'cancelled'; break; }
      if (result.enrollment) {
        // Cancellation may prevent acceptance only before its asynchronous authentication starts.
        if (signal?.aborted) { pairingOutcome = 'cancelled'; break; }
        const device = await acceptDeviceEnrollment(result.enrollment);
        await relayDeviceRequest(session, '/api/v1/devices/' + device.deviceId, { method: 'POST', body: {} }, io);
        await relayDeviceRequest(session, path, { method: 'DELETE' }, io);
        locatorMayExist = false;
        pairingCleanup = 'confirmed';
        for (const project of linked) await deliverDeviceWraps(project.root, io);
        io.say(pairAdditional ? 'Browser paired; current and future linked boards will appear here.' : 'Phone paired; current and future linked boards will appear here.');
        deviceId = device.deviceId;
        pairingOutcome = 'paired';
        break;
      }
      await waitForPairingPoll(signal);
    }
    if (pairingOutcome !== 'paired' && (signal?.aborted || interrupted)) pairingOutcome = 'cancelled';
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { updateRelayMachine(state => { if (state.pending?.locator === pending.locator) state.pending = null; }); }
    finally {
      if (locatorMayExist) {
        // Cleanup is independent of the caller's aborted signal; never claim deletion if unconfirmed.
        try {
          await relayDeviceRequest(session, path, { method: 'DELETE' }, io);
          pairingCleanup = 'confirmed';
        } catch { pairingCleanup = 'unconfirmed'; }
      }
    }
  }
  if (pairingOutcome === 'paired') return { paired: true, deviceId, pairingOutcome, pairingCleanup };
  io.say((onPairingURL
    ? `Boards linked; ${pairAdditional ? 'browser' : 'phone'} pairing ${pairingOutcome}. Run ${retryCommand} for a fresh code.`
    : 'Boards linked; ' + (pairAdditional ? 'browser' : 'phone') + ' pairing stopped. Run ' + retryCommand + ' for a fresh code.')
    + (pairingCleanup === 'unconfirmed' ? ' The relay may retain this request until it expires.' : ''));
  return { paired: false, interrupted: interrupted || Boolean(signal?.aborted), pairingOutcome, pairingCleanup };
}

/** Explicit foreground sign-in repairs links; only board machine credentials survive this command. */
export async function relayOnAll(address, io, { signal, onPairingURL, onSignIn, onLinking, onBoardOutcome, pairAdditional = false, name, only } = {}) {
  const label = computerName(name);
  requirePersonChannel(io.personChannel);
  // A cancelled or declined sign-in must not migrate machine state or scrub existing board links.
  const owner = relayMachineOwner();
  const session = await relayMachineSignIn(address || owner?.url, io, { signal, onSignIn });
  if (session.outcome) return session;
  if (signal?.aborted) {
    await revokeRelayPersonSession(session, io);
    return { outcome: 'cancelled' };
  }
  io.say(`Signed in to GitHub as ${session.login || `account ${session.account}`}.`);
  try { await flushRevocations(session, io); }
  catch (error) {
    if (!signal?.aborted) throw error;
    await revokeRelayPersonSession(session, io);
    return { outcome: 'cancelled' };
  }
  if (signal?.aborted) {
    await revokeRelayPersonSession(session, io);
    return { outcome: 'cancelled' };
  }
  // From this synchronous commit point onward the first board-link attempt is underway; later
  // cancellation must not claim that already-started link writes were rolled back.
  onLinking?.();
  if (label !== undefined) updateRelayMachine(machine => { machine.computerName = label; });
  // The view's sign-in links every board itself; a terminal run waits for cards already on the phone.
  const waiting = onPairingURL || only !== undefined ? [] : waitingLinkApprovals(session);
  const waitingIds = new Set(waiting.map(entry => entry.context.id));
  updateRelayMachine(state => { state.autoLink = true; state.owner = { account: session.account, ...(session.login ? { login: session.login } : {}), url: session.url }; state.approvals = state.approvals.filter(entry => waitingIds.has(entry.context.id)); });
  const result = await linkProjects(session, io, { onBoardOutcome, only, waiting: new Set(waiting.map(entry => entry.root)) });
  const devices = readRelayMachine().devices.filter(device => device.account === session.account && device.url === session.url);
  if (devices.length && !pairAdditional) io.say('Your phone is already paired; the linked boards appear there.');
  const pairing = (devices.length && !pairAdditional) || !result.linked.length ? { paired: devices.length > 0 }
    : await pairFirstDevice(session, result.linked[0].board, result.linked, io, { signal, onPairingURL, pairAdditional });
  const approved = await waitForLinkApprovals(waiting, io, { signal });
  result.linked.push(...approved.linked);
  result.failed.push(...approved.failed);
  await publishExcludedBoards(session, io, relayDeviceRequest);
  return { ...result, ...pairing, autoLink: true };
}

/**
 * Run pullboard relay on --all in the foreground and return its exit code [H5,H17]. Ctrl-C or
 * SIGTERM cancels the sign-in cleanly. Init's offer calls this same function, so a yes at init
 * signs in, links and pairs exactly as the command does, with the same words.
 *
 * @param {string | undefined} address - The relay to use; the machine's saved relay when omitted.
 * @param {any} io
 * @param {{pairAdditional?: boolean}} options - Explicitly enroll one more browser; default setup stays idempotent.
 * @returns {Promise<number>}
 */
export async function relayOnAllCommand(address, io, { pairAdditional = false, name, only } = {}) {
  const controller = new AbortController();
  const cancelSignIn = () => controller.abort();
  process.once('SIGINT', cancelSignIn);
  process.once('SIGTERM', cancelSignIn);
  let result;
  try { result = await relayOnAll(address, io, { signal: controller.signal, pairAdditional, name, only }); }
  finally { process.off('SIGINT', cancelSignIn); process.off('SIGTERM', cancelSignIn); }
  io.result?.(result);
  if (result.outcome) {
    io.say(result.outcome === 'declined' ? 'GitHub sign-in was declined; no boards were linked.'
      : result.outcome === 'expired' ? 'GitHub device sign-in expired; no boards were linked.'
        : 'GitHub device sign-in was cancelled; no boards were linked.');
    return 1;
  }
  return result.failed.length ? 1 : 0;
}

/**
 * Read one line from the person's terminal, or null when the terminal closes first. Readline runs
 * without its own terminal handling, so the terminal echoes the answer and Ctrl-C stays a signal.
 *
 * @param {any} io
 * @param {string} question
 * @returns {Promise<string | null>}
 */
function askLine(io, question) {
  return new Promise((resolve) => {
    const reader = createInterface({ input: io.stdin, output: io.stdout, terminal: false });
    let answer = null;
    reader.once('line', (line) => { answer = line; reader.close(); });
    reader.once('close', () => { io.stdin.pause?.(); resolve(answer); });
    io.stdout.write(question);
  });
}

/**
 * End init with the offer to share with the phone [H5,H17,B26]: ask a person at their own
 * terminal once, and on Enter or y run pullboard relay on --all through the same function the
 * command uses. An agent shell, CI or a run without a terminal is never asked and gets the
 * command for later; the caller-supplied relayOfferAtInit (init.js) decides which. Returns init's exit code.
 *
 * @param {string} root - The repository init just set up.
 * @param {any} io
 * @returns {Promise<number>}
 */
export async function offerRelayAtInit(root, io, { details = true, offerPorts } = {}) {
  for (const name of ['relayOfferAtInit', 'acceptsRelayOffer']) {
    if (typeof offerPorts?.[name] !== 'function') throw new TypeError(`relay offer requires the caller-supplied ${name} port`);
  }
  const { relayOfferAtInit, acceptsRelayOffer, RELAY_OFFER_QUESTION, RELAY_LATER } = offerPorts;
  const shared = relayLinked(root) || readRelayMachine().autoLink;
  const offer = relayOfferAtInit({ enabled: relayOfferEnabled(), shared, stdin: io.stdin, stdout: io.stdout });
  if (offer === 'none') return 0;
  if (offer === 'ask' && acceptsRelayOffer(await askLine(io, RELAY_OFFER_QUESTION))) return await relayOnAllCommand(undefined, io);
  if (details) io.say(RELAY_LATER);
  return 0;
}

// These operations belong to this view process. No ticket, person session, or pairing URL is
// serialized into the machine record or returned as part of an operation's public status.
const viewSignIns = new Map();
const VIEW_INTENT_LIMIT = 32;
const VIEW_RESULT_LIFETIME_MS = 10 * 60_000;
const VIEW_TERMINAL_STATES = new Set(['done', 'declined', 'expired', 'cancelled', 'pairing-stopped']);

/** Forget finished operations after a bounded retention period without disturbing live cleanup. */
function pruneViewSignIns() {
  const now = Date.now();
  for (const [id, operation] of viewSignIns) {
    if (operation.finishedAt && now - operation.finishedAt >= VIEW_RESULT_LIFETIME_MS) viewSignIns.delete(id);
  }
  while (viewSignIns.size >= VIEW_INTENT_LIMIT) {
    const finished = [...viewSignIns].find(([, operation]) => operation.finishedAt);
    if (!finished) break;
    viewSignIns.delete(finished[0]);
  }
}

/** Read a process-local operation without accepting an arbitrary relay ticket or person credential. */
function viewSignInIntent(intentId) {
  pruneViewSignIns();
  const operation = typeof intentId === 'string' && viewSignIns.get(intentId);
  if (!operation) throw new Refused('VIEW_SIGN_IN_UNKNOWN', 'this view sign-in is no longer available; start sign-in again');
  return operation;
}

/** Return only public outcomes, never the private controller, ticket, or pairing capability. */
function viewSignInPublic(operation) {
  return {
    state: operation.state,
    boards: operation.boards.map(board => ({ ...board })),
    ...(operation.error ? { error: { ...operation.error } } : {}),
    ...(operation.pairingCleanup ? { pairingCleanup: operation.pairingCleanup } : {}),
  };
}

/** Keep upstream diagnostics useful without reflecting a bearer accidentally included in an error. */
function viewSignInReason(message) {
  return String(message).replace(/\b(?:ps_|pa_|pm_|pd_|pg_|ghu_|ghs_)[A-Za-z0-9_-]{20,}\b/gu, '[redacted credential]');
}

/** Validate the provider's public device instructions before the view opens a browser address. */
function viewDeviceInstructions(flow) {
  let verification;
  let relay;
  try { verification = new URL(flow.verificationURL); relay = new URL(flow.relayUrl); } catch { /* Refuse below. */ }
  const loopback = hostname => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  if (!verification || !relay || verification.username || verification.password || verification.hash
    || !((verification.protocol === 'https:' && verification.hostname === 'github.com'
      && verification.port === '' && verification.pathname === '/login/device' && !verification.search)
      || (verification.protocol === 'http:' && loopback(verification.hostname)
        && relay.protocol === 'http:' && loopback(relay.hostname) && verification.pathname === '/login/device' && !verification.search))
    || typeof flow.userCode !== 'string' || !/^[\x21-\x7e]{1,128}$/u.test(flow.userCode)
    || !Number.isSafeInteger(flow.expiresAt) || flow.expiresAt <= Date.now()) {
    throw new Refused('VIEW_SIGN_IN_RESPONSE', 'the relay returned invalid sign-in instructions; check its address and start again');
  }
  return { verificationURL: verification.href, userCode: flow.userCode, expiresAt: flow.expiresAt };
}

/** Start the existing device flow in RAM; the view receives only its public link, code and id. */
export async function startViewSignIn({ relayUrl, signal, relayPorts } = {}) {
  if (signal?.aborted) throw new Refused('OAUTH_CANCELLED', 'sign-in was cancelled before it started; no board was linked');
  pruneViewSignIns();
  if ([...viewSignIns.values()].some(operation => !operation.finishedAt)) {
    throw new Refused('VIEW_SIGN_IN_BUSY', 'this view is already signing in; finish or cancel that sign-in first');
  }
  const intentId = randomUUID();
  const operation = { state: 'waiting', boards: [], controller: new AbortController(), pairing: null, finishedAt: null };
  const abortStarting = () => operation.controller.abort();
  signal?.addEventListener('abort', abortStarting, { once: true });
  viewSignIns.set(intentId, operation);
  let resolveReady;
  let rejectReady;
  let published = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // The established linking path still owns authorization and pairing. Its terminal IO is a
  // sink; progress enters this operation only through typed callbacks, never parsed text.
  const io = relayIo({ ...relayPorts, personChannel: 'view' });
  operation.finished = Promise.resolve().then(() => relayOnAll(relayUrl, io, {
    signal: operation.controller.signal,
    onSignIn(flow) {
      let instructions;
      try { instructions = viewDeviceInstructions(flow); }
      catch (error) { operation.controller.abort(); rejectReady(error); throw error; }
      published = true;
      resolveReady({ intentId, ...instructions });
    },
    onLinking() { operation.state = 'linking'; },
    onBoardOutcome(board) {
      operation.boards = operation.boards.filter(prior => prior.root !== board.root);
      operation.boards.push({ ...board, reason: viewSignInReason(board.reason) });
    },
    onPairingURL(pairing) { operation.state = 'pairing'; operation.pairing = { ...pairing }; },
  })).then(result => {
    operation.state = result.outcome ?? (result.pairingOutcome && result.pairingOutcome !== 'paired' ? 'pairing-stopped' : 'done');
    if (result.pairingCleanup) operation.pairingCleanup = result.pairingCleanup;
    if (result.pairingCleanup === 'unconfirmed') operation.error = { code: 'VIEW_PAIRING_CLEANUP',
      message: 'boards remain linked; the relay could not confirm phone-pairing cleanup and may retain the request until it expires' };
    if (!published) rejectReady(new Refused(result.outcome === 'cancelled' ? 'OAUTH_CANCELLED' : 'VIEW_SIGN_IN_STOPPED',
      'sign-in stopped before instructions were available; no board was linked'));
  }, error => {
    operation.state = 'done';
    operation.error = { code: error instanceof Refused ? error.code : 'VIEW_SIGN_IN_FAILED',
      message: error instanceof Refused ? viewSignInReason(error.message) : 'sign-in could not finish; check the relay and try again' };
    if (!published) rejectReady(error);
  }).finally(() => {
    operation.pairing = null;
    operation.finishedAt = Date.now();
  });
  try { return await ready; }
  catch (error) {
    // A rejected instruction response must not hide a later failure to cancel its real ticket.
    await operation.finished;
    if (operation.error?.code === 'OAUTH_CLEANUP') throw new Refused(operation.error.code, operation.error.message);
    throw error;
  } finally { signal?.removeEventListener('abort', abortStarting); }
}

/** Poll only public operation progress; core, not the browser, polls the private relay ticket. */
export function viewSignInStatus(intentId) {
  return viewSignInPublic(viewSignInIntent(intentId));
}

/** Give the authenticated view server a transient pairing redirect, never a JSON status field. */
export function viewSignInPairingNavigation(intentId) {
  const operation = viewSignInIntent(intentId);
  if (operation.controller.signal.aborted || operation.state !== 'pairing' || !operation.pairing || operation.pairing.expires <= Date.now()) {
    throw new Refused('VIEW_PAIRING_NOT_READY', 'phone pairing is not waiting; read this sign-in’s current status');
  }
  return { ...operation.pairing };
}

/** Cancel and await actual cleanup, preserving linked boards if linking already began. */
export async function cancelViewSignIn(intentId) {
  const operation = viewSignInIntent(intentId);
  if (operation.state === 'linking') {
    throw new Refused('VIEW_SIGN_IN_LINKING', 'board linking has started and will finish as one batch; stop phone pairing when it begins');
  }
  if (!VIEW_TERMINAL_STATES.has(operation.state)) {
    // Stop publishing the capability synchronously; remote deletion may still be pending.
    operation.pairing = null;
    operation.controller.abort();
  }
  await operation.finished;
  return viewSignInPublic(operation);
}
