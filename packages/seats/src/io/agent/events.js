/** Project-local agent nudges never grant trust or replace another tool's hooks [I6]. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
} from 'node:path';

export const AGENT_HOOK_EVENTS = ['SessionStart', 'Stop'];
const CLAUDE_HOOK_EVENTS = [...AGENT_HOOK_EVENTS, 'SessionEnd'];
export const LEGACY_RESUME_HOOK =
  'm=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/..; for p in node_modules/.bin/pullboard "$m/node_modules/.bin/pullboard"; do [ -x "$p" ] && exec "$p" resume; done; command -v pullboard >/dev/null && exec pullboard resume; true';
const SOURCES = [['Claude Code', '.claude/settings.json', CLAUDE_HOOK_EVENTS], ['Codex', '.codex/hooks.json', AGENT_HOOK_EVENTS]];

/** Resolve the same local/main/PATH installations as I6; a missing executable is a silent no-op. */
export function agentHookCommand(event) {
  if (!CLAUDE_HOOK_EVENTS.includes(event)) throw new Error('unsupported agent hook event');
  return 'm=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/..; '
    + `for p in node_modules/.bin/pullboard "$m/node_modules/.bin/pullboard"; do [ -x "$p" ] && exec "$p" hook ${event}; done; `
    + `command -v pullboard >/dev/null || exit 0; exec pullboard hook ${event}`;
}

/** Recognize only the exact command this installer owns. */
function owned(handler) {
  return handler?.type === 'command' && CLAUDE_HOOK_EVENTS.some(event => handler.command === agentHookCommand(event)
    || handler.command === `pullboard hook ${event}`);
}

/** Never follow project configuration through a symlink into a user's home. */
function regularProjectPath(root, name) {
  const file = join(root, name), parent = dirname(file);
  for (const path of [parent, file]) {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) return false;
    const inside = relative(realpathSync(root), realpathSync(path));
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) return false;
  }
  return !existsSync(file) || lstatSync(file).isFile();
}

/** Read an existing object without replacing malformed settings or hook arrays. */
function settingsAt(root, name, events) {
  if (!regularProjectPath(root, name)) throw new Error('configuration is not a regular project file');
  const value = existsSync(join(root, name)) ? JSON.parse(readFileSync(join(root, name), 'utf8')) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.hooks !== undefined && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks))) throw new Error('configuration is not an object');
  for (const event of events) if (value.hooks?.[event] !== undefined
      && (!Array.isArray(value.hooks[event]) || value.hooks[event].some(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks)))) throw new Error('hook groups are not arrays');
  return value;
}

/** Merge or remove only Pullboard's exact handlers, preserving unrelated settings and groups. */
export function configureAgentHooks(root, { remove = false, legacyResume = LEGACY_RESUME_HOOK, onWrite = () => {} } = {}) {
  return SOURCES.map(([vendor, name, events]) => {
    try {
      if (remove && !existsSync(join(root, name))) return `${vendor} agent hooks are not installed`;
      const value = settingsAt(root, name, events), before = JSON.stringify(value);
      value.hooks ??= {};
      for (const event of events) {
        const groups = value.hooks[event] ?? [];
        const kept = groups.flatMap(group => {
          const hooks = group.hooks.filter(handler => !owned(handler)
            && !(vendor === 'Claude Code' && legacyResume && event === 'SessionStart' && handler?.command === legacyResume));
          return hooks.length || Object.keys(group).some(key => key !== 'hooks') ? [{ ...group, hooks }] : [];
        });
        if (!remove) {
          const nudge = { hooks: [{ type: 'command', command: agentHookCommand(event), timeout: 5 }] };
          // Observe activity before an existing custom Claude resume without rewriting the user's command.
          if (vendor === 'Claude Code' && event === 'SessionStart' && JSON.stringify(kept).includes('pullboard resume')) kept.unshift(nudge);
          else kept.push(nudge);
        }
        if (kept.length) value.hooks[event] = kept;
        else delete value.hooks[event];
      }
      if (!Object.keys(value.hooks).length) delete value.hooks;
      const changed = JSON.stringify(value) !== before;
      if (changed) {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        const temporary = join(root, name) + `.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        renameSync(temporary, join(root, name));
        onWrite(name);
      }
      if (remove) return `removed Pullboard's ${vendor} agent nudges from ${name}`;
      return vendor === 'Claude Code'
        ? `${changed ? 'added a' : 'kept the'} Claude Code session hook and Stop reminder in ${name}`
        : `${changed ? 'installed' : 'kept'} Codex agent nudges in ${name}; review and trust them with /hooks`;
    } catch {
      return `${vendor} agent hook warning: kept ${name} unchanged; repair its project-local JSON and run pullboard hooks`;
    }
  });
}

/** File presence is installation evidence, never proof that a vendor trusted a definition. */
export function agentHookStatus(root) {
  return SOURCES.map(([vendor, name, supportedEvents]) => {
    let events = [];
    try {
      const value = settingsAt(root, name, supportedEvents);
      events = supportedEvents.filter(event => value.hooks?.[event]?.some(group => group.hooks.some(handler => owned(handler)
        && [agentHookCommand(event), `pullboard hook ${event}`].includes(handler.command))));
    } catch { /* Invalid configuration remains visibly inactive. */ }
    return { vendor, configured: existsSync(join(root, name)), events, trust: vendor === 'Codex' ? 'unverified' : null };
  });
}
