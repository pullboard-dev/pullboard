/** Whether a command line is one the thin hook entry may run; imports nothing, so every other command pays no load for asking [H24]. */

/** The hooks this entry serves; pre-push and the agent nudges keep the full path. */
export const THIN_HOOKS = ['pre-commit', 'pre-merge-commit', 'commit-msg'];

/** Whether a command line is one the thin entry may run: a plain commit hook with no flags. */
export function isThinHook(args, env) {
  if (args[0] !== 'hook' || !THIN_HOOKS.includes(args[1])) return false;
  if (args.slice(2).some(arg => arg.startsWith('--'))) return false;
  return !['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT',
    'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'].some(name => Boolean(env[name]));
}
