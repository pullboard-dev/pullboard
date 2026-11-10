/** Relay devices, relay off and relay join name phones, joined computers and boards the way the person gave them [H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  devicesText,
  phoneAndJoinedComputer,
  plainCommand,
} from '../../tests/fixtures/relay/setup.js';

test('relay devices names phones and joined computers with paired date and boards [H17]', async (t) => {
  const { box, phone, joined } = await phoneAndJoinedComputer(t);
  const { lines, names } = await devicesText(box, []);
  const day = value => new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const board = names[0];
  const phoneLine = lines.find(line => line.startsWith('Kitchen phone (phone): '));
  assert.ok(phoneLine, 'the phone is named by its label');
  assert.match(phoneLine, new RegExp(`^Kitchen phone \\(phone\\): paired ${day(phone.createdAt)}, last seen (?!unknown)[^;]+; reads ${board}$`, 'u'),
    'the phone line has its paired date, a last seen time and the board it reads');
  const computerLine = lines.find(line => line.includes('(computer): '));
  assert.ok(computerLine, 'the joined computer is listed on the linked computer');
  assert.match(computerLine, new RegExp(`^Study computer \\(computer\\): joined ${day(Date.now())}, last seen (?!unknown)[^;]+; reads ${board}$`, 'u'),
    'the joined computer is named by the person, with its joined date, last seen and board');
  assert.equal(lines.length, 2, 'one line each, with no ids');
  assert.ok(!/[0-9a-f]{64}/u.test(lines.join('\n')) && !lines.join('\n').includes(phone.deviceId), 'ids and fingerprints stay out of the default view');
  const verbose = await devicesText(box, ['--verbose']);
  assert.ok(verbose.lines.some(line => line.includes(phone.deviceId) && /fingerprint [0-9a-f]{64}$/u.test(line)), '--verbose adds the phone id and fingerprint');
  const json = await box.cli('relay', 'devices');
  assert.equal(json.code, 0, 'relay devices --json succeeds');
  const [phoneJson] = json.document.devices;
  assert.equal(json.document.devices.length, 1, 'the linked computer lists its one paired phone');
  assert.deepEqual([phoneJson.deviceId, phoneJson.label, phoneJson.pairedHere, phoneJson.createdAt, phoneJson.revoked, phoneJson.boards],
    [phone.deviceId, 'Kitchen phone', true, phone.createdAt, false, [board]], 'JSON names the phone with its paired date, status and board');
  assert.ok(Number.isSafeInteger(phoneJson.seen), 'JSON carries the relay last seen time');
  assert.ok(!('fingerprint' in phoneJson) && !/[0-9a-f]{64}/u.test(JSON.stringify(json.document)), 'default JSON leaves the fingerprint out');
  const verboseJson = await box.cli('relay', 'devices', '--verbose');
  assert.match(verboseJson.document.devices[0].fingerprint, /^[0-9a-f]{64}$/u, 'JSON adds the fingerprint only with --verbose');
  // The joined computer never paired the phone: it lists it by short id from the relay, with its status and board.
  const there = await joined.cli('relay', 'devices');
  assert.equal(there.code, 0, 'relay devices succeeds on the joined computer');
  assert.equal(there.document.computers[0].name, 'Kitchen computer', 'on --all retains the explicit computer name');
  assert.equal(there.document.devices.length, 1, "the joined computer lists the linked computer's phone");
  const [phoneThere] = there.document.devices;
  assert.deepEqual([phoneThere.deviceId, phoneThere.pairedHere, phoneThere.label, phoneThere.revoked, phoneThere.boards],
    [phone.deviceId, false, null, false, [joined.joined.name]], 'the joined computer knows the phone by id, paired on another computer');
  assert.ok(Number.isSafeInteger(phoneThere.seen) && !('fingerprint' in phoneThere), 'it carries last seen and no fingerprint');
  const plain = plainCommand(joined.root, joined.env, ['relay', 'devices']);
  const shown = await plain.done;
  assert.equal(shown.code, 0, shown.stderr);
  const otherLine = shown.stdout.split('\n').find(line => line.includes('(phone): '));
  assert.match(otherLine ?? '', new RegExp(`^Phone ${phone.deviceId.slice(-8)} \\(phone\\): paired on another computer, last seen (?!unknown)[^;]+; reads ${joined.joined.name}$`, 'u'),
    'the joined computer says the phone was paired on another computer, with its short id, last seen and board');

  // Revoke through a separate authenticated person request, leaving this computer's local
  // pairing record intact. A stale local roster must not claim the phone still reads this board.
  const person = await box.phoneSession();
  const headers = { authorization: 'Bearer ' + person.token };
  const revoked = await fetch(box.origin + '/api/v1/devices/' + phone.deviceId, { method: 'DELETE', headers });
  assert.equal(revoked.status, 200, 'an authenticated external revoke removes the remote device grant');
  const phoneGrant = await fetch(box.origin + '/api/v1/devices/' + phone.deviceId + '/boards', { headers });
  assert.equal(phoneGrant.status, 403, 'the revoked phone cannot read its board grants');
  assert.equal((await phoneGrant.json()).error.code, 'DEVICE_REVOKED', 'the relay fails closed for the revoked phone');
  const afterRevoke = await box.cli('relay', 'devices');
  assert.equal(afterRevoke.code, 0, 'the local roster remains available after the remote revoke');
  assert.equal(afterRevoke.document.devices.length, 1, 'the paired phone remains in local pairing history');
  const [stillPaired] = afterRevoke.document.devices;
  assert.deepEqual([stillPaired.deviceId, stillPaired.pairedHere, stillPaired.label, stillPaired.revoked],
    [phone.deviceId, true, 'Kitchen phone', true], 'the local phone entry remains and reflects revocation');
  assert.deepEqual(stillPaired.boards, [], 'the revoked phone no longer appears to read a board');
  const afterRevokeThere = await joined.cli('relay', 'devices');
  assert.equal(afterRevokeThere.code, 0, 'the other computer can still read its device roster');
  assert.deepEqual(afterRevokeThere.document.devices, [], 'the other computer does not restore the revoked phone from local history');
});

test('relay off names joined computers by the person-given name [H17]', async (t) => {
  const { box, joined } = await phoneAndJoinedComputer(t);
  const off = await box.cli('relay', 'off');
  assert.equal(off.code, 0, 'relay off unlinks this computer');
  assert.deepEqual(off.document.joined, ['Study computer'], 'the joined computer is named by the person');
  assert.deepEqual(off.document.affectedMachines, [joined.machine], 'the stable machine id stays beside the name');
  assert.ok(off.document.notice.includes('If you approve deletion, joined computers Study computer lose the shared copy'),
    'the warning names the joined computer by its explicit name before the phone approves the delete');
});

test('relay join names the board it joined [H17]', async (t) => {
  const { joined } = await phoneAndJoinedComputer(t);
  const { name, board, notice } = joined.joined;
  assert.equal(typeof name, 'string');
  assert.equal(notice, 'Joined ' + name + '. This brought one board; for another, run pullboard relay pair in that board on the linked computer. Run pullboard status to read it.',
    'join names the board and says it brought one board');
  assert.ok(!notice.includes(board), 'the board id stays out of the join message');
});
