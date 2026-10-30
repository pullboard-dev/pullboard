/** Parse only provider-native tool-call identities; transcript text remains private [N2,C7]. */
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
