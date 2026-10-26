import { lineSettingsCommand } from '../line-settings-cli.js';
/** The pullboard settings command, in its own module so an item adding another command never edits these lines. */
import {
  SETTING_FORMS,
} from '../help.js';
import {
  Refused,
} from '../refused.js';
import {
  gateQueueSettings,
  gateShortSlots,
  gateRunnerWaitMs,
  loadMachineSettings,
  memoryFloorMB,
  relayOfferEnabled,
  setBrowserSlots,
  setGateShortSlots,
  setGateSlots,
  setGateRunnersFirst,
  setGateRunnerWaitMs,
  setLandingPool,
} from '../settings.js';
import {
  context,
  withBoard,
} from '../cli.js';
import { boardId } from '../board.js';

/** Read or update machine capacity, or delegate explicit board-owned line inputs. */
export function settingsCommand(io, { first, second, rest, values }) {
  if (first === 'line') return lineSettingsCommand(io, { second, rest, values });
  if (first === 'landing.pool') {
    if (!['on', 'off'].includes(second) || rest.length) throw new Refused('USAGE', 'pullboard settings landing.pool on|off in the board this machine should land');
    const ctx = context(io);
    const board = withBoard(ctx, boardId);
    const settings = setLandingPool(board, second === 'on');
    io.result?.({ settings, board });
    io.say(`this board's landing pool: ${second}`);
    return 0;
  }
  if (!first && !second && !rest.length) {
    const settings = loadMachineSettings();
    const queue = gateQueueSettings();
    // The result names the queue order in effect, defaults included; the file keeps only what was set.
    const offerAtInit = relayOfferEnabled();
    const shortSlots = gateShortSlots();
    const runnersFirst = settings.gate?.runnersFirst === true;
    io.result?.({ settings: { ...settings, gate: { ...settings.gate, queue: { ...settings.gate?.queue, ...queue }, shortSlots, runnersFirst, runnerWaitMs: gateRunnerWaitMs() }, relay: { ...settings.relay, offerAtInit } }, memoryFloorMB: memoryFloorMB() });
    io.say(`gateSlots: ${settings.gateSlots}`);
    io.say(`browserSlots: ${settings.browserSlots}`);
    io.say(`gate.queue.reviewsFirst: ${queue.reviewsFirst}${queue.reviewsFirst ? '' : ' (landings first, then arrival order)'}`);
    io.say(`gate.queue.currentReleaseFirst: ${queue.currentReleaseFirst}${queue.currentReleaseFirst ? '' : ' (release priority is off)'}`);
    io.say(`gate.queue.agingMinutes: ${queue.agingMinutes}${queue.reviewsFirst || queue.currentReleaseFirst ? '' : ' (used only while reviewsFirst or currentReleaseFirst is true)'}`);
    io.say(`gate.memoryFloorMB: ${memoryFloorMB() ?? 'off (the gate queue does not wait for memory)'}`);
    io.say(`view.background: ${settings.view?.background !== false}${settings.view?.background === false ? ' (init and resume leave the view to you)' : ' (init and resume keep pullboard view running for pullboard.dev)'}`);
    io.say(`relay.offerAtInit: ${offerAtInit}${offerAtInit ? ' (init asks once to share your boards with your phone)' : ' (init stays quiet about sharing)'}`);
    io.say(`gate.shortSlots: ${shortSlots}${shortSlots ? '' : ' (off; runs that name their test files wait for a gate slot)'}`);
    io.say(`gate.runnersFirst: ${runnersFirst} (registered runners are preferred before local slots when on)`);
    io.say(`gate.runnerWaitMs: ${gateRunnerWaitMs()} (then ordinary local admission; no disabled capacity is created)`);
    return 0;
  }
  if (!SETTING_FORMS.includes(first) || !second || rest.length) {
    throw new Refused('USAGE', 'pullboard settings gateSlots <n> | browserSlots <n> | gate.shortSlots <n> | gate.runnersFirst on|off');
  }
  if (first === 'gate.runnersFirst') {
    if (!['on', 'off'].includes(second)) throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnersFirst must be on or off; run pullboard settings gate.runnersFirst on|off');
    const settings = setGateRunnersFirst(second === 'on');
    io.result?.({ settings });
    io.say(`gate.runnersFirst set to ${second}`);
    return 0;
  }
  if (first === 'gate.runnerWaitMs') {
    if (!/^[1-9]\d*$/u.test(second)) throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnerWaitMs must be positive whole milliseconds; run pullboard settings gate.runnerWaitMs <n>');
    const settings = setGateRunnerWaitMs(Number(second));
    io.result?.({ settings });
    io.say(`gate.runnerWaitMs set to ${settings.gate.runnerWaitMs}`);
    return 0;
  }
  if (first === 'gate.shortSlots') {
    if (!/^(?:0|[1-9]\d*)$/u.test(second) || !Number.isSafeInteger(Number(second))) {
      throw new Refused('BAD_SHORT_SLOTS', 'gate.shortSlots must be a whole number, 0 or more; run pullboard settings gate.shortSlots <n>');
    }
    const settings = setGateShortSlots(Number(second));
    io.result?.({ settings });
    io.say(`gate.shortSlots set to ${settings.gate.shortSlots}`);
    return 0;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(second) || !Number.isSafeInteger(Number(second))) {
    if (first === 'gateSlots') throw new Refused('USAGE', 'pullboard settings gateSlots <n>');
    throw new Refused('BAD_BROWSER_SLOTS', 'browserSlots must be a whole number, 0 or more; 0 requires a registered runner');
  }
  const settings = first === 'browserSlots' ? setBrowserSlots(Number(second)) : setGateSlots(Number(second));
  io.result?.({ settings });
  io.say(`${first} set to ${settings[first]}`);
  return 0;
}

/** Run `pullboard settings` and return its exit code. */
export function run(io, args) {
  return settingsCommand(io, args);
}
