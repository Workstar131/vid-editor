/**
 * One OpenRouter chat-completions reply as it arrives. Yields { type: 'text',
 * text }, { type: 'tool', id, name, input }, and { type: 'cut' } if the model
 * stops at its token limit. Production streams always go through the same-origin
 * serverless proxy, which keeps OPENROUTER_API_KEY off the client.
 */
export async function* aiChatStream(messages, { model, tools, maxTokens, signal } = {}, streamFn = null) {
  const stream = streamFn || (await import('./openrouter.js')).openRouterStream;
  yield* stream(messages, { model, tools, maxTokens, signal });
}

/** Parse tool-call arguments that may arrive as JSON text; preserve malformed data for a readable error. */
export function toolInput(input) {
  if (typeof input !== 'string') return input ?? {};
  try {
    return input.trim() ? JSON.parse(input) : {};
  } catch {
    return { __unreadable: input };
  }
}

/** An Error for whatever the upstream proxy returned. */
export function aiError(e) {
  if (e instanceof Error) return e;
  const inner = e?.error && typeof e.error === 'object' ? e.error : e;
  const message = inner?.message || (typeof e?.error === 'string' ? e.error : '') || (typeof e === 'string' ? e : '') || 'The AI did not answer';
  return Object.assign(new Error(message), { code: inner?.code || e?.code });
}

/** Whether a request failed because the prompt exceeds model context. */
export function tooLongForAi(error) {
  const said = `${String(error?.message || error || '').trim()} ${String(error?.code || '')}`;
  return /context.{0,24}(length|window|limit|size)|(?<!took )too long|too many tokens|maximum.*tokens|token limit/i.test(said);
}

/** A failed request in user-facing language. */
export function friendlyAiError(error, { firstMessage = false } = {}) {
  const text = String(error?.message || error || '').trim();
  const code = String(error?.code || '');
  if (tooLongForAi(error)) return firstMessage ? 'This message is too long for the AI. Shorten it.' : 'This chat has grown too long for the AI. Start a new chat to carry on.';
  if (/rate.?limit|too many requests|\b429\b|overloaded|try again later/i.test(`${text} ${code}`)) return 'The AI service is busy. Wait a moment, then try again.';
  if (/insufficient.?(funds|credit|balance)|out of credit|quota|usage.?limit|allowance|billing|payment required|\b402\b/i.test(`${text} ${code}`)) return 'Your OpenRouter account has reached its usage limit or needs billing attention.';
  if (/sign.?in|not signed|unauthori[sz]ed|\b401\b|auth(entication)? (required|failed)/i.test(`${text} ${code}`)) return 'OpenRouter authentication failed. Check the server API key configuration.';
  if (/network|failed to fetch|offline|timed? ?out|took too long|deadline exceeded|context canceled|ECONN|connection/i.test(text)) return 'The AI service could not be reached. Check your connection.';
  return text ? `The AI service said: ${text.slice(0, 300)}` : 'The AI service did not answer.';
}
