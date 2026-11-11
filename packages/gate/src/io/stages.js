/** Shared local and registered-runner gate accounting [B3,R3,C7]. */
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Preserve accounting for the generated landing gate plus affected phase. Both phase bodies must
 * already be readable without groups; arbitrary subshells still have no guessed account [C7,V4].
 */
export function gateStages(command) {
  const source = String(command).trim();
  const separator = '\n) && ';
  const boundary = source.lastIndexOf(separator);
  if (!source.startsWith('(\n') || boundary < 0) return ordinaryStages(source);
  const gate = ordinaryStages(source.slice(2, boundary));
  const affected = ordinaryStages(source.slice(boundary + separator.length));
  if (!gate || !affected) return null;
  gate[0] = { ...gate[0], groupStart: true };
  gate[gate.length - 1] = { ...gate.at(-1), groupEnd: true };
  return [...gate, ...affected];
}

/**
 * Split a gate command into its top-level stages, the commands joined by `&&`, `||`, `;` or a newline,
 * and each stage into its pipeline components, the commands joined by `|`. Anything the split cannot
 * read for certain (a subshell, a group, command substitution, a heredoc, a comment, a background job,
 * `|&` or an open quote) returns null, so no stage or component is ever guessed [B3,R3].
 *
 * @param {string} command
 * @returns {Array<{ text: string, op: string, pipeline: string[] }> | null}
 */
function ordinaryStages(command) {
  const source = String(command).trim();
  const stages = [];
  let current = '';
  let segment = '';
  let pipeline = [];
  let quote = null;
  let variable = 0;
  /** Append text to both the stage and its current pipeline component. */
  const add = (text) => { current += text; segment += text; };
  /** Close the current pipeline component; an empty or line-continued component is unreadable. */
  const pipe = () => {
    if (!segment.trim() || /\\$/u.test(segment.trim())) return false;
    pipeline.push(segment.trim());
    segment = '';
    return true;
  };
  /** Close the current stage with the operator that follows it; an empty stage is unreadable. */
  const close = (op) => {
    if (!current.trim() || /\\$/u.test(current.trim()) || !pipe()) return false;
    stages.push({ text: current.trim(), op, pipeline });
    current = '';
    pipeline = [];
    return true;
  };
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    const next = source[at + 1];
    if (quote === "'") { add(char); if (char === "'") quote = null; continue; }
    if (char === '\\') { add(next === '\n' ? ' ' : char + (next ?? '')); at += 1; continue; }
    if (char === '`' || (char === '$' && next === '(')) return null;
    if (quote === '"') { add(char); if (char === '"') quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; add(char); continue; }
    // Compound shell grammar is opaque here: splitting its separators would change execution.
    if ((at === 0 || /[\s;&|]/u.test(source[at - 1]))
      && /^(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function)(?=$|[\s;&|])/u.test(source.slice(at))) return null;
    if (char === '$' && next === '{') { variable += 1; add('${'); at += 1; continue; }
    if (char === '}' && variable) { variable -= 1; add(char); continue; }
    if ('(){}#'.includes(char) || (char === '<' && (next === '<' || next === '('))) return null;
    if (char === '&') {
      if (next === '&') { if (!close('&&')) return null; at += 1; continue; }
      if (next === '>' || source[at - 1] === '>' || source[at - 1] === '<') { add(char); continue; }
      return null;
    }
    if (char === '|' && next === '|') { if (!close('||')) return null; at += 1; continue; }
    if (char === '|') {
      if (source[at - 1] === '>') { add(char); continue; }
      if (next === '&' || variable || !pipe()) return null;
      current += char;
      continue;
    }
    if (char === ';') { if (next === ';' || !close(';')) return null; continue; }
    if (char === '\n') { if (current.trim() && !close(';')) return null; continue; }
    add(char);
  }
  if (quote || variable || !current.trim() || /\\$/u.test(current.trim()) || !close('')) return null;
  return stages;
}

/**
 * Wrap each stage so the shell prints its start and its exit status between private marker lines.
 * Control flow is unchanged: each wrapper exits with its stage's status, and an `exit` inside a
 * stage still ends the run, which leaves that stage without an end marker and so unaccounted.
 * A pipeline's components each keep their own exit status and their own standard output in
 * private files instead of the run's output, since a marker written into a pipe would land in the
 * next component's input. A failure is then credited only to the component that printed it [B3,R3].
 */
export function stagedScript(stages, marker, pipes) {
  /** Quote one private file of a component for the shell. */
  const file = (index, at, kind) => `'${join(String(pipes), `${index}-${at}.${kind}`).replaceAll("'", "'\\''")}'`;
  /** One component that records its own status and output, then exits with that status. */
  const component = (text, index, at) => `{ { {\n${text}\n}; printf '%s\\n' "$?" >> ${file(index, at, 'status')}; } | tee ${file(index, at, 'out')}; `
    + `pullboard_pipe_status=$(tail -n 1 ${file(index, at, 'status')} 2>/dev/null); (exit "\${pullboard_pipe_status:-125}"); }`;
  return stages.map((stage, index) => {
    const body = stage.pipeline.length > 1 ? stage.pipeline.map((text, at) => component(text, index, at)).join(' | ') : stage.text;
    return `${stage.groupStart ? '(\n' : ''}{ printf '\\n${marker} begin ${index}\\n'; {\n${body}\n}; pullboard_stage_status=$?; `
      + `printf '\\n${marker} end ${index} %s\\n' "$pullboard_stage_status"; (exit "$pullboard_stage_status"); } ${stage.op}${stage.groupEnd ? '\n) &&' : ''}`;
  }).join('\n');
}

/**
 * Read each pipeline component's own status and, when it failed, its own output. A component that
 * recorded no status, or more than one, has a null status, so a line forged into its private file
 * can only make its stage unaccounted [B3,R3].
 */
export function readPipes(split, pipes, limit = Infinity) {
  /** Read one private component file, or null when the component never wrote it. */
  const read = (index, at, kind) => {
    const path = join(pipes, `${index}-${at}.${kind}`);
    return existsSync(path) && statSync(path).size <= limit ? readFileSync(path, 'utf8') : null;
  };
  return split.map((stage, index) => (stage.pipeline.length > 1 ? stage.pipeline.map((_, at) => {
    const lines = (read(index, at, 'status') ?? '').split('\n').filter(Boolean);
    const status = lines.length === 1 && /^\d+$/u.test(lines[0]) ? Number(lines[0]) : null;
    return { status, output: status ? read(index, at, 'out') : null };
  }) : null));
}

/** Cut a staged run's output back to the command's own lines and each stage's lines and status. */
export function readStages(output, marker, count) {
  const stages = Array.from({ length: count }, () => ({ status: null, lines: [], began: false }));
  const kept = [];
  let open = null;
  const lines = output.split('\n');
  for (const [index, line] of lines.entries()) {
    const found = line.startsWith(`${marker} `) ? /^(?:\S+) (begin|end) (\d+)(?: (\d+))?$/u.exec(line) : null;
    if (found) {
      if (kept.length && kept.at(-1) === '' && lines[index - 1] === '') kept.pop();
      const stage = stages[Number(found[2])];
      if (!stage) { open = null; continue; }
      if (found[1] === 'begin') { stage.began = true; open = stage; }
      else { stage.status = found[3] === undefined ? null : Number(found[3]); open = null; }
      continue;
    }
    kept.push(line);
    if (open) open.lines.push(line);
  }
  return { output: kept.join('\n'), stages: stages.map(({ status, lines: own, began }) => ({ status: began ? status : null, output: own.join('\n') })) };
}

