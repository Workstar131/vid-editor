import { afterEach, describe, expect, it, vi } from 'vitest';
import mediaHandler from '../api/media.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body = '') { this.body = body; return this; },
  };
}

function req(op, body, extra = {}) {
  return { ...extra, method: body === undefined ? 'GET' : 'POST', url: `/api/media?op=${op}`, headers: { host: 'video.example', ...extra.headers }, body };
}

function jsonUpstream(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, headers: { get: () => 'application/json' } };
}

describe('serverless OpenRouter media proxy', () => {
  it('fails clearly when OPENROUTER_API_KEY is missing', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const res = response();
    await mediaHandler(req('image', { prompt: 'cat' }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/OPENROUTER_API_KEY/);
  });

  it('rejects cross-origin browser calls before reaching OpenRouter', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'server-secret');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const res = response();
    await mediaHandler(req('image', { prompt: 'cat' }, { headers: { origin: 'https://attacker.example' } }), res);
    expect(res.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the API key server-side, applies attribution headers, and falls back to an allowed image model', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'server-secret');
    vi.stubEnv('OPENROUTER_SITE_URL', 'https://video.example');
    vi.stubEnv('OPENROUTER_APP_NAME', 'Video Studio Test');
    const fetch = vi.fn().mockResolvedValue(jsonUpstream({ data: [{ b64_json: 'AA==' }] }));
    vi.stubGlobal('fetch', fetch);
    const res = response();
    await mediaHandler(req('image', { prompt: 'cat', model: 'expensive/unlisted' }, { headers: { origin: 'https://video.example' } }), res);
    expect(res.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/images', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer server-secret', 'HTTP-Referer': 'https://video.example', 'X-Title': 'Video Studio Test' }),
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('openai/gpt-image-2');
    expect(res.body).not.toContain('server-secret');
  });

  it('requests actual speech audio from OpenRouter and forwards the playable bytes', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'server-secret');
    const audio = Buffer.from([0, 0, 255, 127]);
    const upstream = {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'audio/pcm' : null },
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    };
    const fetch = vi.fn().mockResolvedValue(upstream);
    vi.stubGlobal('fetch', fetch);
    const res = response();
    await mediaHandler(req('speech', { input: 'Hello, this is the narration.', voice: 'Kore' }), res);
    expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/audio/speech', expect.objectContaining({ method: 'POST' }));
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      model: 'google/gemini-3.8-flash-tts',
      input: 'Hello, this is the narration.',
      voice: 'Kore',
      response_format: 'pcm',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('audio/wav');
    const wav = Buffer.from(res.body);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(44)).toEqual(audio);
  });

  it('returns a readable message for nested OpenRouter TTS provider errors', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'server-secret');
    const providerError = JSON.stringify({ error: { message: 'Gemini TTS only supports response_format="pcm". Got "mp3".', code: 400 } });
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: providerError } }) });
    vi.stubGlobal('fetch', fetch);
    const res = response();
    await mediaHandler(req('speech', { input: 'Narration', voice: 'Kore' }), res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.message).toBe('Gemini TTS only supports response_format="pcm". Got "mp3".');
  });

  it('clamps video settings to the selected OpenRouter model capability envelope', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'server-secret');
    const fetch = vi.fn().mockResolvedValue(jsonUpstream({ id: 'job-1', status: 'pending' }));
    vi.stubGlobal('fetch', fetch);
    const res = response();
    await mediaHandler(req('video-start', { model: 'bytedance/seedance-2.5', prompt: 'cat', duration: 30, aspect_ratio: '3:2', resolution: '1080p' }), res);
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload).toMatchObject({ model: 'bytedance/seedance-2.5', duration: 30, aspect_ratio: '16:9', resolution: '720p' });
    expect(fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/videos');
  });
});
