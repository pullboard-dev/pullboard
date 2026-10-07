/** Versioned command results and refusals for tools that drive the CLI (A1). */

/** Extract a concrete repair from existing refusals, retaining their original guidance. */
function nextStep(message) {
  const match = /(?:; |\. |: )((?:run|fix|restore|commit|check out|set|give|use|the coordinator|to keep looking|never work around)\b[\s\S]*)/i.exec(message);
  return match?.[1] ?? 'Run pullboard help, correct the reported problem, and retry the command.';
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
      const match = /\[([A-Z_]+)\]\s*([\s\S]*)/.exec(text);
      const message = refusal ? text.replace(/^\[[A-Z_]+\] /, '') : match?.[2] ?? text;
      document = { version: 1, error: { code: refusal?.code ?? match?.[1] ?? (code === 2 ? 'USAGE' : 'COMMAND_FAILED'), message, next: nextStep(message) } };
    } else if (result !== undefined) {
      document = { version: 1, ...result };
    } else {
      // A native versioned document, such as export, already owns its public shape.
      let native;
      if (messages.length === 1) {
        try { native = JSON.parse(messages[0]); } catch { /* Ordinary command prose is kept as messages. */ }
      }
      document = native && !Array.isArray(native) && typeof native.version === 'number'
        ? native : { version: 1, messages, ...(diagnostics.length ? { diagnostics } : {}) };
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
