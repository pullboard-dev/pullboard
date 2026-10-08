/** Versioned command results and refusals for tools that drive the CLI (A1). */

/** A shape's required top-level fields; optional fields may be added within this version. */
function shape(fields) {
  return { required: { version: 'number', ...fields } };
}

/** The CLI JSON v1 catalog, shared with API documentation and contract checks (A1). */
export const JSON_SHAPES = {
  version: 1,
  commands: {
    help: shape({ help: 'string' }),
    version: shape({ release: 'string' }),
    init: shape({ root: 'string', notes: 'array' }),
    hooks: shape({ notes: 'array' }),
    join: shape({ agent: 'string', lane: 'string', route: 'string', path: 'string' }),
    worktree: shape({ agent: 'string', lane: 'string', route: 'string', path: 'string', branch: 'string', prompt: 'string' }),
    resume: shape({ me: 'object', all: 'array', requests: 'array', holding: 'array', sentBack: 'array', awaiting: 'array', toVerify: 'array', toMerge: 'array', open: 'array', stale: 'array', holds: 'array', unread: 'number', newest: 'array', root: 'string', dirty: 'number', next: 'string' }),
    whoami: shape({ id: 'string', lane: 'string', path: 'string' }),
    lanes: shape({ lanes: 'object', shared: 'array', coordinator: 'string' }),
    resources: shape({ resources: 'array' }),
    settings: shape({ settings: 'object' }),
    relay: shape({ linked: 'boolean', board: 'string', url: 'string', link: 'string', sequence: 'number', behind: 'number' }),
    list: shape({ items: 'array' }),
    roadmap: shape({ milestones: 'array' }),
    'milestone add': shape({ milestone: 'object' }),
    'milestone items': shape({ milestone: 'object' }),
    'milestone move': shape({ milestone: 'object' }),
    'milestone edit': shape({ milestone: 'object' }),
    'milestone remove': shape({ milestone: 'object' }),
    show: shape({ item_id: 'number', item_title: 'string', item_lane: 'string', item_status: 'string', verdicts: 'array', thread: 'array' }),
    status: shape({ me: 'object', mine: 'array', stats: 'object', reviewQueue: 'object', unread: 'number' }),
    doctor: shape({ problems: 'array' }),
    inbox: shape({ shouts: 'array' }),
    decisions: shape({ decisions: 'array' }),
    ledger: shape({ items: 'array', stats: 'object' }),
    log: shape({ events: 'array' }),
    add: shape({ item: 'object' }),
    edit: shape({ item: 'object' }),
    fact: shape({ item: 'number', fact: 'object' }),
    escalate: shape({ id: 'number', from: 'string', to: 'string' }),
    run: shape({ messages: 'array' }),
    sweep: shape({ messages: 'array' }),
    next: shape({ item: 'object', review: 'boolean', held: 'boolean', shared: 'array' }),
    check: shape({ id: 'number', green: 'boolean', seconds: 'number', check: 'string', report: 'string' }),
    claim: shape({ id: 'number', renewed: 'boolean', leaseUntil: 'string', digest: 'string' }),
    hold: shape({ lane: 'string', held: 'boolean' }),
    release: shape({ id: 'number' }),
    submit: shape({ id: 'number', commit: 'string', pin: 'string', gate: 'object' }),
    done: shape({ id: 'number', commit: 'string', pin: 'string', gate: 'object' }),
    verify: shape({ id: 'number', decision: 'string', reason: 'string' }),
    merged: shape({ id: 'number', commit: 'string' }),
    withdraw: shape({ id: 'number', reason: 'string' }),
    refreeze: shape({ id: 'number', after: 'string' }),
    shout: shape({ id: 'number', decision: 'boolean' }),
    answer: shape({ id: 'number', answers: 'number' }),
    pass: shape({ id: 'number', answers: 'number' }),
    tour: shape({ messages: 'array' }),
    lifecycle: shape({ markdown: 'string' }),
    view: shape({ url: 'string', port: 'number' }),
    'view export': shape({ path: 'string' }),
    serve: shape({ url: 'string', port: 'number' }),
    forget: shape({ root: 'string' }),
    prompt: shape({ role: 'string', text: 'string' }),
    gate: shape({ green: 'boolean', report: 'string' }),
    export: shape({ tables: 'object' }),
    import: shape({ tables: 'array' }),
    spec: shape({ rows: 'array' }),
    'spec check': shape({ rows: 'array' }),
    'spec view': shape({ path: 'string' }),
    'spec show': shape({ row: 'object', standing: 'object' }),
    'spec unmet': shape({ rows: 'array' }),
    'spec signoff': shape({ count: 'number', by: 'string', ids: 'array', evidence: 'array' }),
    'spec signers': shape({ added: 'boolean', by: 'string', path: 'string', initial: 'boolean' }),
    'spec approve': shape({ decisions: 'array' }),
    'spec decline': shape({ decisions: 'array' }),
    'spec apply': shape({ applied: 'array', files: 'array' }),
    'hook pre-commit': shape({ messages: 'array' }),
    'hook pre-merge-commit': shape({ messages: 'array' }),
    'hook commit-msg': shape({ messages: 'array' }),
    'hook pre-push': shape({ messages: 'array' }),
  },
  http: {
    boards: shape({ boards: 'array' }),
    state: shape({ state: 'object' }),
    events: shape({ events: 'array' }),
    move: shape({ event: 'object', result: 'object' }),
    request: shape({ event: 'object', result: 'object' }),
    stream: shape({ event: 'object' }),
  },
  error: shape({ error: 'object' }),
  errorFields: { code: 'string', message: 'string', next: 'string' },
};

/** Extract a concrete repair from existing refusals, retaining their original guidance. */
function nextStep(message) {
  const match = /(?:; |\. |: )((?:run|install|upgrade|fix|restore|commit|check out|set|give|use|reject|ask your coordinator|answer from the main checkout|the coordinator|to keep looking|never work around)\b[\s\S]*)/i.exec(message);
  return match?.[1] ?? 'Run pullboard help, correct the reported problem, and retry the command.';
}

/** A refusal shared by the CLI and API, retaining its rule and repair guidance (A1, A2). */
export function refusalDocument(error) {
  const message = String(error.message).replace(/^\[[A-Z][A-Z0-9_]*\] /, '');
  return { version: JSON_SHAPES.version, error: { code: error.code ?? 'INTERNAL', message, next: nextStep(message) } };
}

/**
 * Collect one command's output; text mode writes immediately and JSON mode writes one document.
 * Long-running view explicitly flushes its address before waiting for a shutdown signal.
 */
export function commandOutput(argv, streams) {
  let enabled = argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--')).includes('--json');
  let result;
  let refusal;
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
      document = refusalDocument({ code: refusal?.code ?? match?.[1] ?? (code === 2 ? 'USAGE' : 'COMMAND_FAILED'), message });
    } else if (result !== undefined) {
      document = { version: JSON_SHAPES.version, ...result, ...(diagnostics.length ? { diagnostics } : {}) };
    } else {
      // A native versioned document, such as export, already owns its public shape.
      let native;
      if (messages.length === 1) {
        try { native = JSON.parse(messages[0]); } catch { /* Ordinary command prose is kept as messages. */ }
      }
      document = native && !Array.isArray(native) && typeof native.version === 'number'
        ? { ...native, ...(diagnostics.length ? { diagnostics } : {}) } : { version: JSON_SHAPES.version, messages, ...(diagnostics.length ? { diagnostics } : {}) };
    }
    streams.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  };
  return {
    ...streams,
    stdout: { get isTTY() { return enabled ? false : streams.stdout.isTTY; }, write: (text) => streams.stdout.write(text) },
    say: (line) => emit(streams.stdout, messages, line),
    err: (line) => emit(streams.stderr, diagnostics, line),
    result: (value) => { result = value; },
    refusal: (error) => { refusal = error; },
    jsonMode: (value) => { enabled = Boolean(value); },
    flush,
  };
}
