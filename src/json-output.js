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
 * the reference pages (help, tour) are declared unbounded; every other command gets the default. Why: default
 * output is what lands in an agent's context, so a list of hundreds of rows belongs behind --detail or --json.
 */
export const OUTPUT_BUDGETS = Object.freeze({ view: Infinity, watch: Infinity, relay: Infinity, serve: Infinity,
  mcp: Infinity, hook: Infinity, help: Infinity, tour: Infinity });

/** The command a CLI argument list runs: its first positional before any `--`. */
export function commandName(argv) {
  const flags = argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--'));
  return flags.find(arg => !arg.startsWith('-')) ?? null;
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

/**
 * Collect one command's output; text mode writes immediately and JSON mode writes one document.
 * Long-running view explicitly flushes its address before waiting for a shutdown signal.
 */
export function commandOutput(argv, streams, { version = 1, refusalDocument: suppliedRenderer, loadRefusal } = {}) {
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
  const notice = 512;
  let printed = 0, withheld = 0, withheldNext = null;
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
    if (budget === Infinity) return streams.stdout.write(`${line}\n`);
    // One message may hold many lines, such as a red gate's output; each printed line is cut and counted alone.
    for (const part of String(line).split('\n')) {
      const text = `${cutLine(part)}\n`;
      const size = Buffer.byteLength(text);
      if (withheld || printed + size > budget - notice) {
        withheld += 1;
        if (/^next:/u.test(part)) withheldNext = part;
        continue;
      }
      printed += size;
      streams.stdout.write(text);
    }
  };
  const flush = (code) => {
    if (!enabled && withheld && !written) {
      written = true;
      streams.stdout.write(`${withheld} more lines withheld to keep this output within ${budget} bytes; add --detail for all of it, or --json\n`);
      if (withheldNext) streams.stdout.write(`${withheldNext}\n`);
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
    } else {
      // A native versioned document, such as export, already owns its public shape.
      let native;
      if (messages.length === 1) {
        try { native = JSON.parse(messages[0]); } catch { /* Ordinary command prose is kept as messages. */ }
      }
      document = native && !Array.isArray(native) && typeof native.version === 'number'
        ? { ...native, ...(diagnostics.length ? { diagnostics } : {}) } : { version: version, messages, ...(diagnostics.length ? { diagnostics } : {}) };
    }
    if (remote) document.remote = remote;
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
