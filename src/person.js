/** Person actions use the view when a terminal is remote or belongs to an agent [B26]. */
import { createHash } from 'node:crypto';
import { Refused } from './refused.js';

/** Markers carried by Claude Code and Codex agent subprocesses, rather than user configuration. */
export const AGENT_SHELL_MARKERS = Object.freeze([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL',
]);

/** SSH transport markers removed from test child environments that act as the person. */
export const SSH_SHELL_MARKERS = Object.freeze(['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']);

/** Session identifiers belong beside the shell markers; only their digest reaches the local checkout binding. */
export const AGENT_SESSION_IDS = Object.freeze(['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']);

/** Distinguish agent sessions, including one stable session for an agent shell with no identifier. */
export function agentSessionDigest(environment = process.env) {
  if (!AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name]))) return null;
  const name = AGENT_SESSION_IDS.find((key) => Boolean(environment[key]));
  const identity = name ? [name, environment[name]] : ['agent-shell-without-session'];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

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
