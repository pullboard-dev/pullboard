import { lineSettingsCommand } from '../../../../../packages/seats/index.js';
/** The pullboard settings command, in its own module so an item adding another command never edits these lines. */
import {
  SETTING_FORMS,
} from '../../logic/help.js';
import {
  signingSetting,
} from '../../../../../packages/person/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
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
  setClauseInspection,
  setGateMeasuredSlots,
  setGateLoadDispatch,
  setGateRunnersOnly,
  setGateRunnerWaitMs,
  setBoardRemote,
  setLandingPool,
  parseWorkerBudget,
  setWorkerBudget,
  workerBudget,
} from '../../../../../packages/config/index.js';
import {
  actOn,
  context,
  ordered,
  withBoard,
  withBoardRead,
} from '../entry.js';
import { boardId } from '../../../../../packages/store/index.js';
import { describeSetting } from '../../../../../packages/config/index.js';

const PRINTED = ['gateSlots', 'browserSlots', 'gate.queue.reviewsFirst', 'gate.queue.currentReleaseFirst', 'gate.queue.agingMinutes', 'gate.memoryFloorMB', 'view.background', 'relay.offerAtInit', 'gate.shortSlots', 'gate.runnersFirst', 'gate.measuredSlots', 'gate.loadAwareDispatch', 'gate.runnerBusyCeiling', 'gate.runnersOnly', 'gate.runnerWaitMs', 'workers.budget', 'inspection.clauses'];

/** Print one setting line; with --detail also its plain label and sentence beneath it. */
function sayDescribed(io, line, detail) {
  io.say(line);
  if (!detail) return;
  const described = describeSetting(line.slice(0, line.indexOf(':')));
  if (described) io.say(`  ${described.label}: ${described.description} (${described.group}, ${described.unit})`);
}

/** Read or update machine capacity, or delegate explicit board-owned line inputs. */
export function settingsCommand(io, { first, second, rest, values }) {
  if (first === 'line') return lineSettingsCommand(io, { second, rest, values }, { actOn, context, ordered, withBoardRead });
  if (first === 'landing.pool') {
    if (!['on', 'off'].includes(second) || rest.length) throw new Refused('USAGE', 'pullboard settings landing.pool on|off in the board this machine should land');
    const ctx = context(io);
    const board = withBoard(ctx, boardId);
    const settings = setLandingPool(board, second === 'on');
    io.result?.({ settings, board });
    io.say(`this board's landing pool: ${second}`);
    return 0;
  }
  if (first === 'board.url' || first === 'board.token') {
    if (!second || rest.length) throw new Refused('USAGE', `pullboard settings ${first} <${first === 'board.url' ? 'url' : 'key'}>|off`);
    setBoardRemote(first.slice(6), second);
    io.result?.({ setting: first, set: second !== 'off' });
    io.say(second === 'off' ? `${first} removed` : `${first} set${first === 'board.url' ? ` to ${second}` : ''}`);
    return 0;
  }
  if (first === 'person.signed' && !rest.length) return signingSetting(io, second, { actOn });
  if (!first && !second && !rest.length) {
    const settings = loadMachineSettings();
    const queue = gateQueueSettings();
    // The result names the queue order in effect, defaults included; the file keeps only what was set.
    const offerAtInit = relayOfferEnabled();
    const shortSlots = gateShortSlots();
    const runnersOnly = settings.gate?.runnersOnly === true;
    const runnersFirst = settings.gate?.runnersFirst === true;
    const loadAwareDispatch = settings.gate?.loadAwareDispatch === true || settings.gate?.loadAwareDispatch !== false && (settings.runners ?? []).some(runner => Number.isSafeInteger(runner.cores));
    const runnerBusyCeiling = settings.gate?.runnerBusyCeiling ?? 90;
    const measuredSlots = settings.gate?.measuredSlots === true;
    io.result?.({ settings: { ...settings, ...(settings.board ? { board: { ...settings.board, ...(settings.board.token ? { token: 'set' } : {}) } } : {}), gate: { ...settings.gate, queue: { ...settings.gate?.queue, ...queue }, shortSlots, runnersFirst, runnersOnly, measuredSlots, loadAwareDispatch, runnerBusyCeiling, runnerWaitMs: gateRunnerWaitMs() }, relay: { ...settings.relay, offerAtInit } }, memoryFloorMB: memoryFloorMB(), descriptions: Object.fromEntries(PRINTED.map(key => [key, describeSetting(key)])) });
    sayDescribed(io, `gateSlots: ${settings.gateSlots}`, values.detail === true);
    sayDescribed(io, `browserSlots: ${settings.browserSlots}`, values.detail === true);
    sayDescribed(io, `gate.queue.reviewsFirst: ${queue.reviewsFirst}${queue.reviewsFirst ? '' : ' (landings first, then arrival order)'}`, values.detail === true);
    sayDescribed(io, `gate.queue.currentReleaseFirst: ${queue.currentReleaseFirst}${queue.currentReleaseFirst ? '' : ' (release priority is off)'}`, values.detail === true);
    sayDescribed(io, `gate.queue.agingMinutes: ${queue.agingMinutes}${queue.reviewsFirst || queue.currentReleaseFirst ? '' : ' (used only while reviewsFirst or currentReleaseFirst is true)'}`, values.detail === true);
    sayDescribed(io, `gate.memoryFloorMB: ${memoryFloorMB() ?? 'off (the gate queue does not wait for memory)'}`, values.detail === true);
    sayDescribed(io, `view.background: ${settings.view?.background !== false}${settings.view?.background === false ? ' (init and resume leave the view to you)' : ' (init and resume keep pullboard view running for pullboard.dev)'}`, values.detail === true);
    sayDescribed(io, `relay.offerAtInit: ${offerAtInit}${offerAtInit ? ' (init asks once to share your boards with your phone)' : ' (init stays quiet about sharing)'}`, values.detail === true);
    sayDescribed(io, `gate.shortSlots: ${shortSlots}${shortSlots ? '' : ' (off; runs that name their test files wait for a gate slot)'}`, values.detail === true);
    sayDescribed(io, `gate.runnersFirst: ${runnersFirst} (registered runners are preferred before local slots when on)`, values.detail === true);
    sayDescribed(io, `gate.loadAwareDispatch: ${loadAwareDispatch}`, values.detail === true);
    sayDescribed(io, `gate.runnerBusyCeiling: ${runnerBusyCeiling}`, values.detail === true);
    sayDescribed(io, `gate.measuredSlots: ${measuredSlots} (${measuredSlots ? 'each measured runner offers slots from its own cores and memory unless declared fixed' : 'runners offer the slot counts they were registered with'})`, values.detail === true);
    sayDescribed(io, `gate.runnersOnly: ${runnersOnly} (submit and verify wait for runners, with no local fallback when on)`, values.detail === true);
    sayDescribed(io, `gate.runnerWaitMs: ${gateRunnerWaitMs()} (runner-only submit/review refuses; other runs retain ordinary local admission)`, values.detail === true);
    const clauses = settings.inspection?.clauses === true;
    if (clauses || values.detail === true) sayDescribed(io, `inspection.clauses: ${clauses} (legacy machine value; submit uses verify.inspectClauses from accepted main)`, values.detail === true);
    const budget = workerBudget();
    sayDescribed(io, `workers.budget: ${budget?.spend ? `${budget.spend}/${budget.window} (spend pullboard run --scale may use across every live seat on this machine)` : 'off (pullboard run --scale launches no workers)'}`, values.detail === true);
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
  if (first === 'gate.loadAwareDispatch' || first === 'gate.runnerBusyCeiling') {
    if (first === 'gate.loadAwareDispatch' && !['on', 'off'].includes(second)) throw new Refused('BAD_MACHINE_SETTINGS', 'gate.loadAwareDispatch must be on or off');
    const settings = setGateLoadDispatch(first.slice(5), first === 'gate.loadAwareDispatch' ? second === 'on' : Number(second));
    io.result?.({ settings });
    io.say(`${first} set to ${second}`);
    return 0;
  }
  if (first === 'gate.measuredSlots') {
    if (!['on', 'off'].includes(second)) throw new Refused('BAD_MACHINE_SETTINGS', 'gate.measuredSlots must be on or off; run pullboard settings gate.measuredSlots on|off');
    const settings = setGateMeasuredSlots(second === 'on');
    io.result?.({ settings });
    io.say(`gate.measuredSlots set to ${second}`);
    return 0;
  }
  if (first === 'inspection.clauses') {
    if (!['on', 'off'].includes(second)) throw new Refused('BAD_MACHINE_SETTINGS', 'inspection.clauses must be on or off; run pullboard settings inspection.clauses on|off');
    const settings = setClauseInspection(second === 'on');
    io.result?.({ settings });
    io.say(`inspection.clauses set to ${second} (legacy machine value; submit uses verify.inspectClauses from accepted main)`);
    return 0;
  }
  if (first === 'gate.runnersOnly') {
    if (!['on', 'off'].includes(second)) throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnersOnly must be on or off; run pullboard settings gate.runnersOnly on|off');
    const settings = setGateRunnersOnly(second === 'on');
    io.result?.({ settings });
    io.say(`gate.runnersOnly set to ${second}`);
    return 0;
  }
  if (first === 'workers.budget') {
    const settings = setWorkerBudget(parseWorkerBudget(second));
    io.result?.({ settings });
    io.say(`workers.budget set to ${settings.workers.budget.spend} spend per ${settings.workers.budget.window}`);
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
