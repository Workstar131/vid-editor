import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRouterChat, openRouterCompletion, openRouterStream, OPENROUTER_MODEL } from '../src/media/openrouter.js';

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter browser adapter', () => {
  it('posts non-streaming requests to the same-origin proxy and normalizes legacy chat output', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const result = await openRouterChat('Hi');
    expect(fetch).toHaveBeenCalledWith('/api/chat', expect.objectContaining({ method: 'POST' }));
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload).toMatchObject({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: 'Hi' }] });
    expect(result.message.content).toBe('Hello');
  });

  it('parses streamed text and assembles function-call argument fragments', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Checking"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_","arguments":"{\\"x\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"project","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetch = vi.fn().mockResolvedValue(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const parts = [];
    for await (const part of openRouterStream([{ role: 'user', content: 'Check' }], { tools: [{ type: 'function', function: { name: 'get_project' } }] })) parts.push(part);
    expect(parts).toEqual([
      { type: 'text', text: 'Checking' },
      { type: 'tool', id: 'call_1', name: 'get_project', input: { x: 1 } },
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body).stream).toBe(true);
  });

  it('surfaces proxy errors with the HTTP status code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'missing key' } }), { status: 503 })));
    await expect(openRouterCompletion([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ message: 'missing key', code: '503' });
  });
});
