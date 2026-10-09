/** Person actions use the view when a terminal is remote or belongs to an agent [B26]. */
import { Refused } from './refused.js';

/** Markers carried by Claude Code and Codex agent subprocesses, rather than user configuration. */
export const AGENT_SHELL_MARKERS = Object.freeze([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL',
]);

/** Refuse terminal person actions in an agent shell; only the authenticated view adapter supplies view. */
export function requirePersonChannel(channel = 'terminal', environment = process.env) {
  if (!['terminal', 'view'].includes(channel)) {
    throw new Refused('B26_PERSON_CHANNEL', 'person actions use the terminal or the view; run pullboard view, the person’s channel');
  }
  if (channel === 'terminal' && AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name]))) {
    throw new Refused('B26_PERSON_CHANNEL', 'this terminal belongs to an agent; run pullboard view, the person’s channel, and let the person act there');
  }
  if (channel === 'terminal' && (environment.SSH_CONNECTION || environment.SSH_TTY)) {
    throw new Refused('B26_PERSON_CHANNEL', 'this is a remote SSH shell, not the person’s terminal; run pullboard view, the person’s channel, and let the person act there');
  }
  return channel;
}
