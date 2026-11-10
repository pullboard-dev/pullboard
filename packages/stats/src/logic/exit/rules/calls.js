/** Parse only provider-native tool-call identities; transcript text remains private [N2,C7]. */
/**
 * The newest native call's whole prompt (input plus cached reads plus cache writes) and its model, or null when
 * the log records no usage. Why: a session's cost grows with the context each call re-reads, not with claim totals [C7].
 */
export function nativeLastPrompt(provider, bytes) {
  if (!['codex', 'claude'].includes(provider)) return null;
  const whole = (...parts) => parts.every(part => part === undefined || Number.isSafeInteger(part) && part >= 0)
    ? parts.reduce((sum, part) => sum + (part ?? 0), 0) : null;
  let last = null, model = null;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { return null; }
    if (provider === 'claude' && row?.type === 'assistant' && row.message?.usage && typeof row.message.model === 'string') {
      const usage = row.message.usage;
      last = whole(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
      model = row.message.model;
    } else if (provider === 'codex' && row?.type === 'turn_context' && typeof row.payload?.model === 'string') model = row.payload.model;
    else if (provider === 'codex' && row?.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info?.last_token_usage)
      last = whole(row.payload.info.last_token_usage.input_tokens);
  }
  return last === null ? null : { tokens: last, model };
}

/** Distinct IDs deduplicate streamed native records without counting tool results or transcript prose. */
export function nativeToolCallIds(provider, bytes) {
  if (!['codex', 'claude'].includes(provider)) return null;
  const ids = new Set();
  let observed = false;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { return null; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    observed ||= provider === 'codex' ? ['session_meta', 'turn_context', 'response_item', 'event_msg'].includes(row.type)
      : ['assistant', 'user', 'system'].includes(row.type);
    const calls = provider === 'codex'
      ? row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(row.payload?.type) ? [row.payload.call_id] : []
      : row.type === 'assistant' && Array.isArray(row.message?.content)
        ? row.message.content.filter(part => part?.type === 'tool_use').map(part => part.id) : [];
    for (const id of calls) {
      if (typeof id !== 'string' || !id || id.length > 1024) return null;
      ids.add(id);
    }
  }
  return observed ? [...ids] : null;
}
