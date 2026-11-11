/** Publish explicit exclusion facts without sending repository names or paths to the relay [H5,H17]. */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { originRepository } from '../../../../seats/index.js';
import { listApiProjects } from '../../../../seats/index.js';
import { readRelayMachine } from './machine.js';
import { updateRelayMachine } from './machine.js';
import { wrapForRecordedDevice } from './machine.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { generateBoardKey } from '../../../../kernel/index.js';
import { seal } from '../../../../kernel/index.js';
import { Refused } from '../../../../kernel/light.js';

/** Rebuild and seal this machine's current list using only its locally authenticated device roster. */
export async function publishExcludedBoards(session, io, request) {
  const machine = readRelayMachine();
  if (machine.owner?.account !== session.account || machine.owner?.url !== session.url) return;
  const person = /^ps_[A-Za-z0-9_-]{43}$/u.test(session.token ?? '');
  const publisher = /^pm_[A-Za-z0-9_-]{43}$/u.test(session.token ?? '') && session.machine === machine.machine;
  if (!person && !publisher) return;
  const names = listApiProjects().filter(project => machine.excluded.includes(project.root)).map(project => {
    const repository = originRepository(project.root, { optional: true });
    if (!repository) throw new Refused('EXCLUDED_REPOSITORY', 'Restore a GitHub origin for each excluded project, then run pullboard relay on --all.');
    return repository;
  });
  if (names.length > 256) throw new Refused('EXCLUDED_INVENTORY', 'Publish at most 256 excluded boards from one machine.');
  if (!names.length && (machine.exclusionsPublished?.account !== session.account || machine.exclusionsPublished?.url !== session.url)) return;
  const label = hostname().replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80) || 'Your computer';
  const publication = { machine: machine.machine, label, count: names.length, engine: ENGINE_VERSION, sealed: '', wraps: [] };
  if (names.length) {
    const id = createHash('sha256').update('pullboard-exclusions-v1:' + session.account + ':' + machine.machine).digest('hex').slice(0, 32);
    const key = await generateBoardKey();
    const plain = new TextEncoder().encode(JSON.stringify({ account: session.account, machine: machine.machine, label, names }));
    publication.sealed = Buffer.from(await seal(key, plain, { boardId: id, kind: 'snapshot', sequence: 0 })).toString('base64url');
    for (const device of machine.devices.filter(device => device.account === session.account && device.url === session.url)) {
      const wrapped = await wrapForRecordedDevice(key, { board: id, device: device.deviceId, engine: ENGINE_VERSION }, session);
      publication.wraps.push({ device: device.deviceId, wrapped: Buffer.from(JSON.stringify(wrapped)).toString('base64url') });
    }
  }
  await request(session, '/api/v1/devices/exclusions', { method: 'POST', body: publication }, io);
  updateRelayMachine(state => { state.exclusionsPublished = names.length ? { account: session.account, url: session.url } : null; });
}

/**
 * Publish changed exclusions without retaining a person session or blocking local opt-out.
 * Link readers and transport come from the caller to keep this module independent of relay.js.
 */
export async function publishOffExclusions(state, io, { loadLink, linkFile, request }) {
  const machine = readRelayMachine();
  const candidates = state ? [state] : [];
  for (const project of listApiProjects()) {
    try { const linked = loadLink(linkFile(project.root)); if (linked) candidates.push(linked); }
    catch { /* An unrelated broken link cannot prevent local exclusion. */ }
  }
  const publisher = candidates.find(value => value.machine === machine.machine
    && value.account === machine.owner?.account && value.url === machine.owner?.url
    && /^pm_[A-Za-z0-9_-]{43}$/u.test(value.token ?? ''));
  if (!publisher) return;
  try { await publishExcludedBoards(publisher, io, request); }
  catch { io.err('Excluded locally; the relay exclusion notice could not be updated. Run pullboard relay on --all when the relay is reachable.'); }
}
