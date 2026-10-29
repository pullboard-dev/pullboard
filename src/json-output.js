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
  const flush = (code) => {
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
    // A refusal keeps its whole shape; only a successful read is trimmed to the requested keys.
    if (fields && !refusal && !document.error) document = selectFields(document, fields);
    if (remote) document.remote = remote;
    streams.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  };
  return {
    ...streams,
    recordedMove: false,
    physicalStdoutIsTTY: Boolean(streams.stdout.isTTY),
    stdout: { get isTTY() { return enabled ? false : streams.stdout.isTTY; }, write: (text) => streams.stdout.write(text) },
    say: (line) => emit(streams.stdout, messages, line),
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
