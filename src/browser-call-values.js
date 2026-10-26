/** Follow only local callable input-to-return command flows without evaluating JavaScript [C7,O5]. */
const IDENTIFIER = /^[$A-Z_a-z][$\w]*$/u;
const LIMIT = 256;

/** Find a matching lexical delimiter in offset-preserving executable code. */
function closeAt(text, start) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let at = start; at < text.length; at += 1) {
    if (pairs[text[at]]) stack.push(pairs[text[at]]);
    else if (')]}'.includes(text[at])) {
      if (stack.pop() !== text[at]) return -1;
      if (!stack.length) return at;
    }
  }
  return -1;
}

/** Split lexical top-level fields, preserving nested expressions and blanked string contents. */
function fields(text, separator = ',') {
  const out = [];
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    if ('([{'.includes(text[at])) {
      const end = closeAt(text, at);
      if (end < 0) return [text];
      at = end;
    } else if (text[at] === separator) { out.push(text.slice(start, at)); start = at + 1; }
  }
  out.push(text.slice(start));
  return out;
}

/** Strip expression-only wrappers; their predicates never become returned command values. */
function clean(text) {
  let value = text.trim().replace(/^await\s+/u, '').trim();
  while (value[0] === '(' && closeAt(value, 0) === value.length - 1) value = value.slice(1, -1).trim();
  return value;
}

/** Read one expression through its top-level statement or argument boundary. */
function expression(text, start) {
  let at = start;
  for (; at < text.length; at += 1) {
    if ('([{'.includes(text[at])) {
      const end = closeAt(text, at);
      if (end < 0) return text.slice(start);
      at = end;
    } else if (';,)}]'.includes(text[at]) || text[at] === '\n') break;
  }
  return text.slice(start, at);
}

/** Read the value branches of a top-level conditional without following its predicate. */
function branches(text) {
  let question = -1;
  let nested = 0;
  for (let at = 0; at < text.length; at += 1) {
    if ('([{'.includes(text[at])) { const end = closeAt(text, at); if (end < 0) break; at = end; }
    else if (text[at] === '?' && !['?', '.'].includes(text[at + 1]) && text[at - 1] !== '?') {
      if (question < 0) question = at;
      else nested += 1;
    } else if (text[at] === ':' && question >= 0) {
      if (!nested) return [text.slice(question + 1, at), text.slice(at + 1)];
      nested -= 1;
    }
  }
  return null;
}

/** Read a local function expression, retaining return spans but excluding nested callable bodies. */
function callable(text, environment) {
  const value = clean(text);
  let params;
  let body;
  const declared = /^(?:async\s+)?function(?:\s+[$A-Z_a-z][$\w]*)?\s*\(/u.exec(value);
  if (declared) {
    const start = declared[0].length - 1;
    const end = closeAt(value, start);
    if (end < 0) return null;
    params = value.slice(start + 1, end);
    body = value.slice(end + 1).trim();
  } else {
    const arrow = /^(?:async\s+)?(\([^]*\)|[$A-Z_a-z][$\w]*)\s*=>\s*/u.exec(value);
    if (!arrow) return null;
    // Greedy parentheses may cross a nested arrow; accept only the balanced parameter span.
    const prefix = value.replace(/^async\s+/u, '');
    const end = prefix[0] === '(' ? closeAt(prefix, 0) + 1 : /^[$A-Z_a-z][$\w]*/u.exec(prefix)?.[0].length;
    if (!end || !/^\s*=>/u.test(prefix.slice(end))) return null;
    params = prefix[0] === '(' ? prefix.slice(1, end - 1) : prefix.slice(0, end);
    body = prefix.slice(end).replace(/^\s*=>\s*/u, '');
  }
  if (body[0] !== '{') return { params: fields(params), returns: [body], environment };
  const last = closeAt(body, 0);
  if (last < 0) return null;
  const content = body.slice(1, last);
  const returns = [];
  // Skip a nested function's complete body when collecting the enclosing function's returns.
  for (let at = 0; at < content.length; at += 1) {
    const rest = content.slice(at);
    const nested = /^(?:async\s+)?function(?:\s+[$A-Z_a-z][$\w]*)?\s*\(/u.exec(rest);
    if (nested) {
      const end = closeAt(content, at + nested[0].length - 1);
      const first = end + 1 + content.slice(end + 1).search(/\S/u);
      if (end >= 0 && content[first] === '{') { at = closeAt(content, first); if (at < 0) break; continue; }
    }
    const arrowStart = /^(?:async\s+)?[$A-Z_a-z][$\w]*\s*=>\s*\{/u.exec(rest);
    let arrowBody = arrowStart ? at + arrowStart[0].length - 1 : -1;
    if (content[at] === '(') {
      const parameters = closeAt(content, at);
      const tail = parameters < 0 ? null : /^\s*=>\s*\{/u.exec(content.slice(parameters + 1));
      if (tail) arrowBody = parameters + tail[0].length;
    }
    if (arrowBody >= 0) { at = closeAt(content, arrowBody); if (at < 0) break; continue; }
    const found = /^return\b[ \t]*/u.exec(rest);
    if (found && (at === 0 || !/[$\w]/u.test(content[at - 1]))) {
      returns.push(expression(content, at + found[0].length));
    }
  }
  return { params: fields(params), returns, environment };
}

/** Separate an executable callee and its actual argument expressions. */
function invocation(text) {
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '(') {
      const end = closeAt(text, at);
      if (end === text.length - 1) return { callee: text.slice(0, at).replace(/\?\.$/u, '').trim(), args: fields(text.slice(at + 1, end)) };
      if (end < 0) return null;
      at = end;
    } else if ('[{'.includes(text[at])) { const end = closeAt(text, at); if (end < 0) return null; at = end; }
  }
  return null;
}

/** Bind a formal, including simple object/array patterns, to the caller's unevaluated actual value. */
function bind(pattern, actual, environment) {
  const parts = fields(pattern, '=');
  const target = clean(parts[0]);
  const values = [actual, ...parts.slice(1).map(expr => ({ expr, environment }))].filter(Boolean);
  if (IDENTIFIER.test(target)) { environment.set(target, values); return; }
  if (target[0] === '{' && closeAt(target, 0) === target.length - 1) {
    for (const field of fields(target.slice(1, -1))) {
      const pair = fields(field, ':');
      const key = pair[0].trim();
      if (!IDENTIFIER.test(key)) continue;
      bind(pair.length > 1 ? pair.slice(1).join(':') : key,
        { projection: key, values }, environment);
    }
  } else if (target[0] === '[' && closeAt(target, 0) === target.length - 1) {
    fields(target.slice(1, -1)).forEach((field, index) => {
      if (field.trim()) bind(field, { projection: String(index), values }, environment);
    });
  }
}

/**
 * Add missing actual-argument flows to the existing command-only classifier. Existing binding
 * entries may supply every assignment RHS as `expressions: string[]`; these must be lexical code,
 * not raw string contents. The callbacks retain the caller's current literal/member policy.
 * Unknown external calls do not inherit every input's taint: finder/runtime exceptions stay local.
 *
 * @param {string} code offset-preserving lexical executable code
 * @param {Map<string, {expressions?: string[]}>} bindings existing local binding union
 * @param {{unresolved:(expression:string)=>boolean,named:(name:string)=>boolean}} policy
 * @returns {(expression:string)=>boolean}
 */
export function makeCallableCommandChecker(code, bindings, { unresolved, named }) {
  const declarations = new Map();
  for (const found of code.matchAll(/\bfunction\s+([$A-Z_a-z][$\w]*)\s*\(/gu)) {
    const end = closeAt(code, found.index + found[0].length - 1);
    const body = end + 1 + code.slice(end + 1).search(/\S/u);
    if (end < 0 || code[body] !== '{') continue;
    const last = closeAt(code, body);
    if (last >= 0) declarations.set(found[1], [...declarations.get(found[1]) ?? [], code.slice(found.index, last + 1)]);
  }
  const environments = new WeakMap();
  let environmentId = 0;
  /** Evaluate only symbolic local return values, carrying closures rather than running source. */
  function values(input, budget, trail = new Set()) {
    if (budget.left-- <= 0) return [{ unknown: true }];
    if (input.projection !== undefined) {
      return input.values.flatMap(value => values(value, budget, trail)).flatMap(value => {
        if (!value.expr) return value.callable ? [] : [value];
        const text = clean(value.expr);
        const key = input.projection;
        if (text[0] === '{' && closeAt(text, 0) === text.length - 1) {
          const row = fields(text.slice(1, -1)).find(field => fields(field, ':')[0].trim() === key);
          if (row) { const pair = fields(row, ':'); return values({ expr: pair.length > 1 ? pair.slice(1).join(':') : key, environment: value.environment }, budget, trail); }
          return [{ unknown: true }];
        }
        if (text[0] === '[' && closeAt(text, 0) === text.length - 1 && /^\d+$/u.test(key)) {
          const entry = fields(text.slice(1, -1))[Number(key)];
          return entry === undefined ? [{ unknown: true }] : values({ expr: entry, environment: value.environment }, budget, trail);
        }
        return [{ expr: /^\d+$/u.test(key) ? `${text}[${key}]` : `${text}.${key}`, environment: value.environment }];
      });
    }
    const text = clean(input.expr ?? '');
    const environment = input.environment ?? new Map();
    if (!text) return [];
    if (!environments.has(environment)) environments.set(environment, ++environmentId);
    const signature = `${environments.get(environment)}:${text}`;
    if (trail.has(signature)) return [{ unknown: true }];
    const next = new Set(trail).add(signature);
    const fn = callable(text, environment);
    if (fn) return [{ callable: fn }];
    const conditional = branches(text);
    if (conditional) return conditional.flatMap(expr => values({ expr, environment }, budget, next));
    if (IDENTIFIER.test(text)) {
      const local = environment.get(text);
      if (local) return local.flatMap(value => values(value, budget, next));
      const assigned = bindings.get(text)?.expressions ?? [];
      const expressions = [...assigned, ...declarations.get(text) ?? []];
      if (expressions.length) return expressions.flatMap(expr => values({ expr, environment }, budget, next));
      return [{ expr: text, environment, browser: named(text) }];
    }
    const returnedMember = /^(.*)\.\s*([$A-Z_a-z][$\w]*)$/u.exec(text);
    if (returnedMember && returnedMember[1].trimEnd().endsWith(')')) {
      return values({ projection: returnedMember[2], values: [{ expr: returnedMember[1], environment }] }, budget, next);
    }
    const call = invocation(text);
    if (call) {
      const callees = values({ expr: call.callee, environment }, budget, next);
      return callees.flatMap(value => {
        if (!value.callable) return value.unknown ? [value] : [];
        const closure = new Map(value.callable.environment);
        value.callable.params.forEach((formal, index) => bind(formal, { expr: call.args[index] ?? '', environment }, closure));
        return value.callable.returns.flatMap(expr => values({ expr, environment: closure }, budget, next));
      });
    }
    const member = /^([$A-Z_a-z][$\w]*)\s*\.\s*([$A-Z_a-z][$\w]*)$/u.exec(text);
    if (member && environment.has(member[1])) return values({ projection: member[2], values: environment.get(member[1]) }, budget, next);
    return [{ expr: text, environment }];
  }
  return expressionText => values({ expr: expressionText, environment: new Map() }, { left: LIMIT })
    .some(value => value.unknown || value.browser || value.expr && unresolved(value.expr));
}
