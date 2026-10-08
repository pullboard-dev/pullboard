/** Disposable demo identity and clock isolation (I13,A10). */
import { AGENT_SHELL_MARKERS } from '../../src/person.js';

export const FIXED_TIME = '2026-10-06T12:00:00.000Z';

/** Model a private person terminal; fix both Git identities so host defaults cannot change commits. */
export function isolatedEnv(home, clockShim, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_OPTIONS' && !AGENT_SHELL_MARKERS.includes(key)));
  return { ...env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home, NODE_OPTIONS: `--import ${JSON.stringify(clockShim)}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Pullboard demo', GIT_AUTHOR_EMAIL: 'demo@pullboard.invalid', GIT_COMMITTER_NAME: 'Pullboard demo', GIT_COMMITTER_EMAIL: 'demo@pullboard.invalid', GIT_AUTHOR_DATE: FIXED_TIME, GIT_COMMITTER_DATE: FIXED_TIME };
}

