/** Pure person guidance and a lightweight CLI output collector [A1,B26,C7]. */
/** The coordinator carries every seat's request for a person decision [B26]. */
export const COORDINATOR_PERSON_REQUEST = 'ask the coordinator to bring it to the person: pullboard shout coordinator --kind question "<what is needed>" --decision';

/**
 * Route presentation-only person requests for a known seat; unknown callers retain existing text.
 * This does not change a refusal receipt, actor identity or permission to make the person's move.
 *
 * @param {string} step
 * @param {{ caller?: 'seat'|'coordinator'|'person'|'unknown' }} [options]
 * @returns {string}
 */
export function personRequestStep(step, { caller } = {}) {
  return caller === 'seat' && /\bask the person\b/iu.test(step) ? COORDINATOR_PERSON_REQUEST : step;
}

/** Keep quoted user text out of generated repair-clause rewriting. */
function quotedAt(text, at) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < at; index += 1) {
    if (escaped) { escaped = false; continue; }
    if (text[index] === '\\') { escaped = true; continue; }
    if (text[index] === '"') quoted = !quoted;
  }
  return quoted;
}

/**
 * Present a generated person-request clause for a seat, keeping its reason and requested action.
 * Only the explanatory first line and an explicit final next footer are guidance; raw diagnostic
 * lines and quoted user text remain intact. Setup questions opt in to a leading imperative.
 *
 * @param {string} message
 * @param {{ caller?: 'seat'|'coordinator'|'person'|'unknown', leading?: boolean }} [options]
 * @returns {string}
 */
export function personRequestGuidance(message, { caller, leading = false } = {}) {
  if (caller !== 'seat') return message;
  const lines = String(message).split('\n');
  /** Route only an unquoted imperative, preserving clauses that explain the refusal. */
  const route = line => line.replace(/(^|[;.:]\s+|\b(?:or|and)\s+)ask the person(?=$|[\s:;])([^;\n]*)/giu,
    (whole, before, action, at) => {
      if ((!before && !leading) || quotedAt(line, at + before.length)) return whole;
      const request = action.trim().replace(/^:?\s*(?:to\s+|for\s+)?/iu, '');
      const needed = request.replace(/\bask the person(?:\s+to)?\s*/giu,
        (words, offset) => quotedAt(request, offset) ? words : '');
      return `${before}${COORDINATOR_PERSON_REQUEST}${needed ? ` (needed: ${needed})` : ''}`;
    });
  lines[0] = route(lines[0]);
  if (lines.length > 1 && /^next:[ \t]*\S/u.test(lines.at(-1))) lines[lines.length - 1] = route(lines.at(-1));
  return lines.join('\n');
}

/** Build a versioned wire envelope from an already-decided refusal; recovery policy stays with its caller. */
export function versionedRefusal({ code, message, next }, { version = 1 } = {}) {
  return { version, error: { code, message, next } };
}

/** About 2k tokens of default text, in UTF-8 bytes: what a reader acts on next [#1885]. */
export const DEFAULT_OUTPUT_BUDGET = 8192;

/**
 * Each command's declared default-text budget in UTF-8 bytes. Long-running streams (view, watch, relay, serve) and
 * the reference pages (help, tour) and the board data dump (export) are declared unbounded; every other command gets the default. Why: default
 * output is what lands in an agent's context, so a list of hundreds of rows belongs behind --detail or --json.
 */
export const OUTPUT_BUDGETS = Object.freeze({ view: Infinity, watch: Infinity, relay: Infinity, serve: Infinity,
  mcp: Infinity, hook: Infinity, help: Infinity, tour: Infinity, export: Infinity });

/** The command a CLI argument list runs: its first positional before any `--`. */
export function commandName(argv) {
  const flags = argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--'));
  return flags.find(arg => !arg.startsWith('-')) ?? null;
}

/** Preserve diagnostic reports, byte-oriented exports and long-running protocols; interactive commands own one final action. */
export function interactiveNext(command, argv = []) {
  // Rigor's plain diagnostic report owns its body; drafting and quality commands still guide an action.
  if (command === 'rigor' && !argv.some(arg => ['draft', 'quality', '--draft-splits', '--draft-quality'].includes(arg.split('=')[0]))) return false;
  return !['export', 'hook', 'mcp', 'view', 'watch', 'serve', 'relay', 'health', 'maintenance'].includes(command);
}

/** Choose one immediate action from acknowledged output, without reserving work or guessing a verdict. */
export function successfulNext(command, result) {
  const following = result?.next;
  if (typeof following === 'string' && following.trim()) return following;
  const item = following?.item ?? (command === 'next' ? result?.item : null);
  if (item?.item_id) return `pullboard show ${item.item_id}`;
  if (command === 'claim') return 'git status';
  if (command === 'submit') return 'pullboard next --take';
  if (command === 'tour') return 'pullboard view';
  if (['help', 'version'].includes(command)) return 'pullboard status';
  return command === 'next' ? 'nothing for this seat: end your turn' : 'pullboard next';
}

/** The longest single default-text line in UTF-8 bytes; one agents: line once ran to 54 KB [#1885]. */
export const LINE_BUDGET = 1024;

/** Cut one over-long default-text line at a character boundary, saying where the rest is. */
export function cutLine(line) {
  if (Buffer.byteLength(line) <= LINE_BUDGET) return line;
  const marker = ' … (cut; --detail shows the whole line)';
  let kept = '';
  for (const character of line) {
    if (Buffer.byteLength(kept + character) > LINE_BUDGET - Buffer.byteLength(marker)) break;
    kept += character;
  }
  return kept + marker;
}

/** One command's declared default-text budget in UTF-8 bytes. */
export function outputBudget(command) {
  return Object.hasOwn(OUTPUT_BUDGETS, command ?? '') ? OUTPUT_BUDGETS[command] : DEFAULT_OUTPUT_BUDGET;
}

/** The keys named by --fields a,b,c or --fields=a,b,c before any `--`, or null when the flag is absent. */
export function requestedFields(argv) {
  const flags = argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--'));
  const at = flags.findIndex(arg => arg === '--fields' || arg.startsWith('--fields='));
  if (at < 0) return null;
  const value = flags[at] === '--fields' ? flags[at + 1] ?? '' : flags[at].slice('--fields='.length);
  const fields = value.split(',').map(field => field.trim()).filter(Boolean);
  return fields.length ? fields : null;
}

/**
 * Keep only the named keys of a successful JSON document: named top-level keys (a flat record such as show, or a
 * cursor such as next), and every top-level array of rows that carries a named key, each row trimmed to the named
 * keys (list, queue, inbox). Why: agents piped about 15.8k JSON reads through scripts just to pick fields [#1895].
 * The version always stays; a list whose rows carry none of the named keys is dropped rather than left as {} rows.
 */
export function selectFields(document, fields) {
  const wanted = new Set(fields);
  const row = value => value && typeof value === 'object' && !Array.isArray(value);
  const trimmed = { version: document.version };
  for (const [key, value] of Object.entries(document)) {
    if (key === 'version') continue;
    if (wanted.has(key)) trimmed[key] = value;
    else if (Array.isArray(value) && value.length && value.every(row)
      && value.some(entry => fields.some(field => Object.hasOwn(entry, field)))) {
      trimmed[key] = value.map(entry => Object.fromEntries(Object.entries(entry).filter(([name]) => wanted.has(name))));
    }
  }
  return trimmed;
}

/**
 * Collect one command's output; text mode writes immediately and JSON mode writes one document.
 * Long-running view explicitly flushes its address before waiting for a shutdown signal.
 */
export function commandOutput(argv, streams, { version = 1, refusalDocument: suppliedRenderer, loadRefusal, nextActions = true } = {}) {
  const command = commandName(argv);
  const guidanceCommand = command === 'help' || argv.includes('--help') || !command && !argv.includes('--version') ? 'help' : command;
  // Installed Git hooks use --version's last line as a protocol handshake, unlike interactive `version`.
  const helpSubject = command !== 'help' && command != null
    || command === 'help' && argv.filter(arg => !arg.startsWith('-')).length > 1;
  const finalAction = nextActions && (guidanceCommand === 'help'
    ? !helpSubject : interactiveNext(command, argv) && !argv.includes('--version'));
  let explicitNext, lastLine, previousLine;
  let renderer = suppliedRenderer;
  let preparing;
  /** Load recovery declarations only when this command actually needs a refusal document. */
  async function prepareRefusal() {
    if (!renderer) {
      if (typeof loadRefusal !== 'function') throw new Error('the output collector needs its caller’s lazy refusal renderer');
      renderer = await (preparing ??= loadRefusal());
    }
  }
  /** Keep rendering synchronous after the explicit asynchronous refusal boundary. */
  function documentFor(error, options) {
    if (!renderer) throw new Error('prepare refusal rendering before displaying a command error');
    return renderer(error, options);
  }
  let enabled = argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--')).includes('--json');
  // Default text stops at the command's budget; --detail prints everything, as --json always does [#1885].
  const flagArgs = argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--'));
  const budget = flagArgs.includes('--detail') ? Infinity : outputBudget(commandName(argv));
  // Room kept for the closing count line and a final next step, itself cut to one line, inside the budget.
  const notice = LINE_BUDGET + 256;
  let printed = 0, withheld = 0, withheldNext = null;
  const fields = requestedFields(argv);
  let result;
  let refusal;
  let remote;
  let caller = 'unknown';
  let callerRoot;
  let written = false;
  const messages = [];
  const diagnostics = [];
  const emit = (target, lines, line) => {
    if (enabled) lines.push(String(line));
    else target.write(`${line}\n`);
  };
  /** Write one default-text line within the budget, keeping only a count (and a final next step) of the rest. */
  const say = (line) => {
    if (enabled) return emit(streams.stdout, messages, line);
    // A whole JSON document printed as text (export) owns its bytes.
    if (/^\s*[[{]/u.test(String(line))) {
      lastLine = previousLine = String(line).split('\n').at(-1);
      return streams.stdout.write(`${line}\n`);
    }
    // Preserve native body positions; only identical adjacent action lines are redundant.
    for (const part of String(line).split('\n')) {
      const action = finalAction && (/^next:[ \t]*\S/iu.test(part)
        || command === 'handoff' && /^pullboard shout --item \d+/u.test(part));
      if (action) explicitNext = part.replace(/^next:[ \t]*/iu, '');
      const duplicate = action && previousLine === part;
      previousLine = part;
      if (duplicate) continue;
      const shown = budget === Infinity ? part : cutLine(part);
      const text = `${shown}\n`;
      const size = Buffer.byteLength(text);
      if (withheld || printed + size > budget - notice) {
        withheld += 1;
        if (/^next:/u.test(part)) withheldNext = cutLine(part);
        continue;
      }
      printed += size;
      lastLine = shown;
      streams.stdout.write(text);
    }
  };
  const flush = (code) => {
    if (!enabled && !written) {
      written = true;
      if (withheld) {
        lastLine = `${withheld} more lines withheld to keep this output within ${budget} bytes; add --detail for all of it, or --json`;
        streams.stdout.write(lastLine + '\n');
      }
      const focusedIdle = guidanceCommand === 'next' && result?.idleReason === 'focus'
        && result.reasons?.length === 1 && result.reasons[0].endsWith('overflow is off.');
      const cleanDoctor = command === 'doctor' && lastLine === 'board is clean' && !withheld;
      if (!code && !refusal && finalAction && !focusedIdle && !cleanDoctor) {
        const action = explicitNext ?? withheldNext?.replace(/^next:[ \t]*/u, '') ?? successfulNext(guidanceCommand, result);
        const footer = cutLine(`next: ${action.replace(/[\r\n]+/gu, ' ')}`);
        if (lastLine?.toLowerCase() !== footer.toLowerCase()
          && !(command === 'handoff' && lastLine === explicitNext)) streams.stdout.write(footer + '\n');
      }
      else if (withheldNext) streams.stdout.write(`${withheldNext}\n`);
      return;
    }
    if (!enabled || written) return;
    written = true;
    let document;
    if (refusal || (code && result === undefined)) {
      const text = refusal?.message ?? [...diagnostics, ...messages].join('\n');
      const match = /\[([A-Z][A-Z0-9_]*)\]\s*([\s\S]*)/.exec(text);
      const message = refusal ? text.replace(/^\[[A-Z][A-Z0-9_]*\] /, '') : match?.[2] ?? text;
      document = documentFor({ code: refusal?.code ?? match?.[1] ?? (code === 2 ? 'USAGE' : 'COMMAND_FAILED'), message, next: refusal?.next }, { caller });
    } else if (result !== undefined) {
      document = { version: version, ...result, ...(diagnostics.length ? { diagnostics } : {}) };
      // `next` is a selector; the frozen bar and criterion belong in `show`, not its bounded offer.
      if (command === 'next' && document.item && typeof document.item === 'object') {
        document.item = { ...document.item };
        delete document.item.item_frozen;
        delete document.item.item_criterion;
      }
    } else {
      // A native versioned document, such as export, already owns its public shape.
      let native;
      if (messages.length === 1) {
        try { native = JSON.parse(messages[0]); } catch { /* Ordinary command prose is kept as messages. */ }
      }
      document = native && !Array.isArray(native) && typeof native.version === 'number'
        ? { ...native, ...(diagnostics.length ? { diagnostics } : {}) } : { version: version, messages, ...(diagnostics.length ? { diagnostics } : {}) };
    }
    if (refusal?.testOutput) {
      const { counts, failures, omittedFailures, logPath, mainFailures } = refusal.testOutput;
      Object.assign(document, { counts, failures, omittedFailures, logPath, ...(mainFailures ? { mainFailures } : {}) });
    }
    // A refusal keeps its whole shape; only a successful read is trimmed to the requested keys.
    if (fields && !refusal && !document.error) document = selectFields(document, fields);
    if (remote) document.remote = remote;
    // Existing cursor metadata stays intact; field projection owns its exact selected shape.
    if (!code && !refusal && !document.error && finalAction && !fields && typeof document.next === 'number') {
      document.nextAction = explicitNext ?? successfulNext(guidanceCommand, result);
    }
    streams.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  };
  return {
    ...streams,
    recordedMove: false,
    physicalStdoutIsTTY: Boolean(streams.stdout.isTTY),
    stdout: { get isTTY() { return enabled ? false : streams.stdout.isTTY; }, write: (text) => streams.stdout.write(text) },
    say,
    err: (line) => emit(streams.stderr, diagnostics, line),
    result: (value) => { result = value; },
    refusal: (error) => { refusal = error; },
    // A successfully checked person channel stays the display caller for this command.
    caller: (value, root) => { if (caller !== 'person') { caller = value; callerRoot = root; } },
    callerKnown: (root) => caller === 'person' || caller !== 'unknown' && callerRoot === root,
    callerRole: () => caller,
    guidance: (message, options = {}) => personRequestGuidance(message, { ...options, caller }),
    refusalDocument: (error) => documentFor(error, { caller }),
    prepareRefusal,
    remote: (value) => { remote = value; },
    exitCode: (code) => code || (remote ? 1 : 0),
    jsonMode: (value) => { enabled = Boolean(value); },
    flush,
  };
}
