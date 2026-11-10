import { createHash } from 'node:crypto';
import { AGENT_SESSION_IDS } from '../kernel/light.js';
import { AGENT_SHELL_MARKERS } from '../kernel/light.js';

/** Distinguish agent sessions, including one stable session for an agent shell with no identifier. */
export function agentSessionDigest(environment = process.env) {
  if (!AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name]))) return null;
  const name = AGENT_SESSION_IDS.find((key) => Boolean(environment[key]));
  const identity = name ? [name, environment[name]] : ['agent-shell-without-session'];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export {
  hasInputSplit,
} from './src/logic/split.js';
