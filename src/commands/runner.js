/** The pullboard runner command, in its own module so an item adding another command never edits these lines. */
import {
  Refused,
} from '../refused.js';
import {
  addRunner,
  loadMachineSettings,
  removeRunner,
} from '../settings.js';
import {
  recordRunnerGui,
  runnerResourceStatus,
} from '../resources.js';
import { validateRunner } from '../settings-read.js';
import { probeRunnerTransport } from '../runner-transport.js';

/** List, add or remove machine-level SSH capacity without requiring a board identity or runner account. */
export async function runnerCommand(io, { first, second, rest, values }) {
  if (first === 'list') {
    if (second || rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', 'pullboard runner list');
    // Registered capacity is what each runner enforces, whatever its own settings say (#1066).
    const runners = runnerResourceStatus(loadMachineSettings().runners ?? []);
    io.result?.({ runners });
    io.say(runners.length ? runners.map(runner => `${runner.host}: ${runner.slots} slots, ${runner.browser} browser${runner.draining ? ' (draining)' : ''}\n  GUI session: ${runner.gui === true ? 'yes' : runner.gui === false ? 'no' : 'unknown'}`).join('\n') : 'no runners registered');
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
  if (first !== 'add' || !second || rest.length || !/^[1-9]\d*$/u.test(values.slots ?? '')
    || !/^(?:0|[1-9]\d*)$/u.test(values.browser ?? '')) {
    throw new Refused('USAGE', 'pullboard runner add <ssh-host> --slots <positive integer> --browser <integer from zero through slots>');
  }
  const configured = validateRunner({ host: second, slots: Number(values.slots), browser: Number(values.browser),
    ...(values.node !== undefined ? { node: values.node } : {}), ...(values.root !== undefined ? { root: values.root } : {}) });
  const observation = await probeRunnerTransport(configured, { observeGui: true });
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
