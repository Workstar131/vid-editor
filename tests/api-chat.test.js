import { afterEach, describe, expect, it, vi } from 'vitest';
import chatHandler from '../api/chat.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function response() {
  return {
    statusCode: 200, headers: {}, body: '',
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; return this; },
    json(value) { this.body = JSON.stringify(value); return this; },
    end(value = '') { this.body += value; return this; },
  };
}
const request = (body, headers = {}) => ({ method: 'POST', headers: { host: 'studio.example', ...headers }, body });

describe('serverless OpenRouter chat proxy', () => {
  it('forwards same-origin requests with server-side key and attribution, ignoring arbitrary model selection', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'server-secret');
    vi.stubEnv('OPENROUTER_SITE_URL', 'https://studio.example');
    vi.stubEnv('OPENROUTER_APP_NAME', 'Studio');
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    vi.stubGlobal('fetch', fetch);
    const res = response();
    await chatHandler(request({ model: 'arbitrary/expensive-model', messages: [{ role: 'user', content: 'hi' }] }, { origin: 'https://studio.example' }), res);
    expect(res.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer server-secret', 'HTTP-Referer': 'https://studio.example', 'X-Title': 'Studio' }),
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('openai/gpt-4.1');
    expect(res.body).not.toContain('server-secret');
  });

  it('blocks cross-origin calls before contacting OpenRouter', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'server-secret');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const res = response();
    await chatHandler(request({ messages: [{ role: 'user', content: 'hi' }] }, { origin: 'https://attacker.example' }), res);
    expect(res.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects too many messages and missing credentials', async () => {
    const res = response();
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await chatHandler(request({ messages: [] }), res);
    expect(res.statusCode).toBe(503);
    vi.stubEnv('OPENROUTER_API_KEY', 'server-secret');
    const invalid = response();
    await chatHandler(request({ messages: Array.from({ length: 101 }, () => ({ role: 'user', content: 'x' })) }), invalid);
    expect(invalid.statusCode).toBe(400);
  });
});
