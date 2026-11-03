import { recordRunnerMeasurement } from '../../packages/config/index.js';
/** The pullboard runner command, in its own module so an item adding another command never edits these lines. */
import {
  Refused,
} from '../../packages/kernel/index.js';
import {
  addRunner,
  loadMachineSettings,
  removeRunner,
} from '../../packages/config/index.js';
import {
  recordRunnerGui,
  runnerResourceStatus,
} from '../../packages/resources/index.js';
import { validateRunner } from '../../packages/config/index.js';
import { probeRunnerTransport } from '../../packages/runners/index.js';
import {
  computeRunnerSlots,
  effectiveRunner,
} from '../../packages/runners/index.js';

/** Describe one runner's measured size and the slots the gate offers from it. */
function sizeLine(runner, settings) {
  if (runner.cores === undefined) return 'not measured (registered counts apply); run pullboard runner measure';
  const offered = effectiveRunner(runner, settings.gate?.measuredSlots === true);
  const formula = computeRunnerSlots(runner);
  return `${runner.cores} cores, ${runner.memoryMB} MB; formula ${formula.slots} slots, ${formula.browser} browser`
    + (runner.fixed === true ? '; declared count overrides' : settings.gate?.measuredSlots === true ? `; offering ${offered.slots}` : '; gate.measuredSlots is off');
}

/** List, add or remove machine-level SSH capacity without requiring a board identity or runner account. */
export async function runnerCommand(io, { first, second, rest, values }) {
  if (first === 'list') {
    if (second || rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', 'pullboard runner list');
    // Registered capacity is what each runner enforces, whatever its own settings say (#1066).
    const settings = loadMachineSettings();
    const registered = new Map((settings.runners ?? []).map(runner => [runner.host, runner]));
    const runners = runnerResourceStatus(settings.runners ?? []).map(row => {
      const runner = registered.get(row.host);
      if (!runner) return { ...row, computedSlots: null };
      const offered = effectiveRunner(runner, settings.gate?.measuredSlots === true);
      return { ...row, slots: offered.slots, browser: offered.browser,
        ...(runner.cores !== undefined ? { cores: runner.cores, memoryMB: runner.memoryMB, measuredAt: runner.measuredAt } : {}),
        computedSlots: runner.cores !== undefined ? computeRunnerSlots(runner).slots : null,
        fixed: runner.fixed === true };
    });
    io.result?.({ runners });
    io.say(runners.length ? runners.map(runner => `${runner.host}: ${runner.slots} slots, ${runner.browser} browser${runner.draining ? ' (draining)' : ''}\n  size: ${registered.has(runner.host) ? sizeLine(registered.get(runner.host), settings) : 'draining'}\n  GUI session: ${runner.gui === true ? 'yes' : runner.gui === false ? 'no' : 'unknown'}`).join('\n') : 'no runners registered');
    return 0;
  }
  if (first === 'remove') {
    if (!second || second.trim() !== second || rest.length || Object.keys(values).some(key => key !== 'json')) {
      throw new Refused('USAGE', 'pullboard runner remove <ssh-host>');
    }
    const runner = removeRunner(second);
    io.result?.({ runner });
    io.say(`${runner.draining ? 'draining' : 'removed'} runner ${runner.host}`);
    return 0;
  }
  if (first === 'measure') {
    if (rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', 'pullboard runner measure [<ssh-host>]');
    const registered = loadMachineSettings().runners ?? [];
    const targets = second === undefined ? registered : registered.filter(runner => runner.host === second);
    if (!targets.length) throw new Refused('RUNNER_NOT_REGISTERED', second === undefined ? 'no runners are registered' : `runner ${second} is not registered`, 'run pullboard runner list');
    const measured = [];
    for (const target of targets) {
      const observation = await probeRunnerTransport(target, { observeGui: true });
      if (observation.cores === undefined) { io.say(`runner ${target.host}: measurement failed (${observation.reason}); its recorded size is unchanged`); measured.push({ host: target.host, measured: false }); continue; }
      let runner;
      try { runner = recordRunnerMeasurement(target.host, { gui: observation.gui, cores: observation.cores, memoryMB: observation.memoryMB, measuredAt: new Date().toISOString() }); }
      catch (error) {
        if (error?.code !== 'RUNNER_BUSY') throw error;
        io.say(`runner ${target.host}: ${error.message}; measure it again when idle`); measured.push({ host: target.host, measured: false }); continue;
      }
      recordRunnerGui(runner.host, observation.gui);
      io.say(`measured runner ${runner.host}: ${sizeLine(runner, loadMachineSettings())}`);
      measured.push({ host: runner.host, measured: true, cores: runner.cores, memoryMB: runner.memoryMB, ...computeRunnerSlots(runner) });
    }
    io.result?.({ measured });
    return measured.some(entry => !entry.measured) ? 1 : 0;
  }
  const slotsGiven = values.slots !== undefined;
  if (first !== 'add' || !second || rest.length || slotsGiven && !/^[1-9]\d*$/u.test(values.slots)
    || values.browser !== undefined && !/^(?:0|[1-9]\d*)$/u.test(values.browser)
    || slotsGiven && values.browser === undefined || !slotsGiven && values.browser !== undefined && Number(values.browser) !== 0) {
    throw new Refused('USAGE', 'pullboard runner add <ssh-host> [--slots <positive integer>] [--browser <integer from zero through slots>] | pullboard runner measure [<ssh-host>]');
  }
  const prior = (loadMachineSettings().runners ?? []).find(runner => runner.host === second);
  const node = values.node ?? prior?.node;
  const root = values.root ?? prior?.root;
  const probed = validateRunner({ host: second, slots: 1, browser: 0,
    ...(node !== undefined ? { node } : {}), ...(root !== undefined ? { root } : {}) });
  const observation = await probeRunnerTransport(probed, { observeGui: true, discoverNode: node === undefined });
  if (node === undefined && !observation.nodePath) throw new Refused('RUNNER_SETUP', `runner ${second} did not report an absolute Node path from its login shell; install Node or pass --node <absolute-path>`);
  if (node === undefined) probed.node = observation.nodePath;
  const measuredSize = observation.cores !== undefined ? { cores: observation.cores, memoryMB: observation.memoryMB, measuredAt: new Date().toISOString() } : {};
  // Without --slots the runner's own measurement sets the count; a declared --slots is fixed and always wins.
  if (!slotsGiven && observation.cores === undefined) throw new Refused('RUNNER_NOT_MEASURED', `runner ${second} did not report its cores and memory (${observation.reason}); fix the SSH connection or declare --slots <n> --browser <n>`);
  const sized = slotsGiven ? { slots: Number(values.slots), browser: Number(values.browser), fixed: true }
    : { ...computeRunnerSlots(measuredSize), ...(values.browser === '0' ? { browser: 0 } : {}) };
  if (sized.slots === 0) throw new Refused('BAD_RUNNER', `runner ${second} has no capacity after the core and memory reserves; use a larger runner or an explicit fixed count`);
  const configured = validateRunner({ ...probed, ...sized, ...measuredSize });
  const runner = addRunner({ ...configured, gui: observation.gui });
  recordRunnerGui(runner.host, observation.gui);
  io.result?.({ runner });
  io.say(`registered runner ${runner.host}: ${runner.slots} slots, ${runner.browser} browser; GUI session: ${runner.gui === true ? 'yes' : runner.gui === false ? 'no' : 'unknown (registration probe unavailable)'}`);
  return 0;
}

/** Run `pullboard runner` and return its exit code. */
export function run(io, args) {
  return runnerCommand(io, args);
}
