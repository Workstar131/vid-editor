/** Server-side proxy for OpenRouter image, speech, transcription, and video APIs. */
const BASE = 'https://openrouter.ai/api/v1';
const DEFAULTS = {
  image: 'openai/gpt-image-2',
  speech: 'google/gemini-3.8-flash-tts',
  transcription: 'openai/whisper-large-v3',
  video: 'minimax/hailuo-3',
};
const ALLOWED_MODELS = {
  image: new Set(['openai/gpt-image-2', 'openai/gpt-image-2.5-sunburst', 'google/gemini-3-pro-image', 'google/gemini-nano-banana-2.1', 'bytedance-seed/seedream-5-0-flash']),
  video: new Set(['bytedance/seedance-2.5', 'google/veo-3.1', 'bytedance/seedance-2.0', 'alibaba/happyhorse-1.1', 'minimax/hailuo-3', 'black-forest-labs/flux-3-video', 'alibaba/wan-2.7', 'bytedance/seedance-2.0-mini', 'google/veo-3.1-lite']),
};
export const config = { maxDuration: 300 };
const VIDEO_CAPS = {
  'bytedance/seedance-2.5': { durations: { min: 4, max: 30 }, resolutions: ['480p', '720p'], aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] },
  'google/veo-3.1': { durations: [4, 6, 8], resolutions: ['720p', '1080p', '4K'], aspects: ['16:9', '9:16'] },
  'bytedance/seedance-2.0': { durations: { min: 4, max: 15 }, resolutions: ['480p', '720p', '1080p', '4K'], aspects: ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'] },
  'alibaba/happyhorse-1.1': { durations: { min: 3, max: 15 }, resolutions: ['720p', '1080p'], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'] },
  'minimax/hailuo-3': { durations: { min: 5, max: 15 }, resolutions: ['2K'], aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
  'black-forest-labs/flux-3-video': { durations: { min: 5, max: 20 }, resolutions: ['720p', '1080p', '2K', '4K'], aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
  'alibaba/wan-2.7': { durations: { min: 2, max: 10 }, resolutions: ['720p', '1080p'], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
  'bytedance/seedance-2.0-mini': { durations: { min: 4, max: 15 }, resolutions: ['480p', '720p'], aspects: ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'] },
  'google/veo-3.1-lite': { durations: [4, 6, 8], resolutions: ['720p', '1080p'], aspects: ['16:9', '9:16'] },
};

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(payload));
}
function openRouterHeaders(key, type = 'application/json') {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': type,
    'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5517',
    'X-Title': process.env.OPENROUTER_APP_NAME || 'Video Studio',
  };
}
function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
function readableProviderError(text) {
  let value = text;
  for (let i = 0; i < 4; i++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); continue; } catch { return value; }
    }
    const nested = value?.error?.message || value?.message;
    if (typeof nested === 'string') { value = nested; continue; }
    break;
  }
  return typeof value === 'string' ? value : 'OpenRouter speech generation failed.';
}
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (Buffer.byteLength(text) > 22 * 1024 * 1024) throw Object.assign(new Error('Request exceeds the 22 MB limit.'), { status: 413 });
  return text ? JSON.parse(text) : {};
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: { message: 'Method not allowed.' } });
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return json(res, 503, { error: { message: 'OpenRouter is not configured on the server. Set OPENROUTER_API_KEY in Vercel.' } });
  const url = new URL(req.url, 'http://localhost');
  const op = url.searchParams.get('op');
  const origin = req.headers.origin;
  const host = String(req.headers.host || '').toLowerCase();
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return json(res, 403, { error: { message: 'Cross-origin media requests are not allowed.' } });
    } catch { return json(res, 403, { error: { message: 'Invalid request origin.' } }); }
  }
  try {
    if (req.method === 'POST' && op === 'image') {
      const body = await readJson(req);
      const payload = {
        model: ALLOWED_MODELS.image.has(body.model) ? body.model : DEFAULTS.image,
        prompt: String(body.prompt || '').slice(0, 4000),
        n: 1,
        aspect_ratio: body.aspect_ratio || '16:9',
        output_format: 'png',
        quality: body.quality || 'medium',
        ...(Array.isArray(body.input_references) && body.input_references.length ? { input_references: body.input_references } : {}),
      };
      const upstream = await fetch(`${BASE}/images`, { method: 'POST', headers: openRouterHeaders(key), body: JSON.stringify(payload) });
      const result = await upstream.json().catch(() => ({}));
      return json(res, upstream.status, upstream.ok ? result : { error: result.error || { message: 'OpenRouter image generation failed.' } });
    }

    if (req.method === 'POST' && op === 'speech') {
      const body = await readJson(req);
      const upstream = await fetch(`${BASE}/audio/speech`, {
        method: 'POST',
        headers: openRouterHeaders(key),
        body: JSON.stringify({
          model: body.model === DEFAULTS.speech ? body.model : DEFAULTS.speech,
          input: String(body.input || '').slice(0, 3000),
          voice: body.voice || 'nova',
          response_format: 'pcm',
          ...(body.instructions ? { instructions: String(body.instructions).slice(0, 1000) } : {}),
        }),
      });
      if (!upstream.ok) {
        const text = await upstream.text();
        return json(res, upstream.status, { error: { message: readableProviderError(text).slice(0, 2000) } });
      }
      res.status(200);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(pcmToWav(Buffer.from(await upstream.arrayBuffer())));
    }

    if (req.method === 'POST' && op === 'transcribe') {
      const body = await readJson(req);
      const bytes = Buffer.from(String(body.audio_base64 || ''), 'base64');
      if (!bytes.length) return json(res, 400, { error: { message: 'Audio data is required.' } });
      if (bytes.length > 20 * 1024 * 1024) return json(res, 413, { error: { message: 'Audio exceeds the 20 MB upload limit.' } });
      const form = new FormData();
      form.set('file', new Blob([bytes], { type: body.content_type || 'audio/wav' }), body.filename || 'audio.wav');
      form.set('model', body.model === DEFAULTS.transcription ? body.model : DEFAULTS.transcription);
      form.set('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      if (body.language && body.language !== 'auto') form.set('language', body.language);
      const upstream = await fetch(`${BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5517', 'X-Title': process.env.OPENROUTER_APP_NAME || 'Video Studio' },
        body: form,
      });
      const result = await upstream.json().catch(() => ({}));
      return json(res, upstream.status, upstream.ok ? result : { error: result.error || { message: 'OpenRouter transcription failed.' } });
    }

    if (req.method === 'POST' && op === 'video-start') {
      const body = await readJson(req);
      const model = ALLOWED_MODELS.video.has(body.model) ? body.model : DEFAULTS.video;
      const caps = VIDEO_CAPS[model];
      const requestedDuration = Number(body.duration) || (Array.isArray(caps.durations) ? caps.durations[0] : caps.durations.min);
      const duration = Array.isArray(caps.durations)
        ? caps.durations.reduce((best, value) => Math.abs(value - requestedDuration) < Math.abs(best - requestedDuration) ? value : best, caps.durations[0])
        : Math.min(caps.durations.max, Math.max(caps.durations.min, requestedDuration));
      const payload = {
        model,
        prompt: String(body.prompt || '').slice(0, 4000),
        duration,
        aspect_ratio: caps.aspects.includes(body.aspect_ratio) ? body.aspect_ratio : '16:9',
        resolution: caps.resolutions.includes(body.resolution) ? body.resolution : caps.resolutions[caps.resolutions.length - 1],
        ...(body.generate_audio === false ? { generate_audio: false } : {}),
        ...(Array.isArray(body.frame_images) && body.frame_images.length ? { frame_images: body.frame_images.slice(0, 2) } : {}),
      };
      if (body.negative_prompt) payload.negative_prompt = String(body.negative_prompt).slice(0, 1000);
      const upstream = await fetch(`${BASE}/videos`, { method: 'POST', headers: openRouterHeaders(key), body: JSON.stringify(payload) });
      const result = await upstream.json().catch(() => ({}));
      return json(res, upstream.status, upstream.ok ? result : { error: result.error || { message: 'OpenRouter video generation failed.' } });
    }

    if (req.method === 'GET' && op === 'video-status') {
      const id = url.searchParams.get('id');
      if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return json(res, 400, { error: { message: 'A valid video job id is required.' } });
      const upstream = await fetch(`${BASE}/videos/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5517', 'X-Title': process.env.OPENROUTER_APP_NAME || 'Video Studio' } });
      const result = await upstream.json().catch(() => ({}));
      return json(res, upstream.status, upstream.ok ? result : { error: result.error || { message: 'Could not check video status.' } });
    }

    if (req.method === 'GET' && op === 'video-content') {
      const id = url.searchParams.get('id');
      const index = Math.max(0, Number(url.searchParams.get('index')) || 0);
      if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return json(res, 400, { error: { message: 'A valid video job id is required.' } });
      const upstream = await fetch(`${BASE}/videos/${encodeURIComponent(id)}/content?index=${index}`, { headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5517', 'X-Title': process.env.OPENROUTER_APP_NAME || 'Video Studio' } });
      if (!upstream.ok) return json(res, upstream.status, { error: { message: 'Could not download the generated video.' } });
      res.status(200);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(Buffer.from(await upstream.arrayBuffer()));
    }
    return json(res, 404, { error: { message: 'Unknown media operation.' } });
  } catch (error) {
    const status = error?.status || 502;
    console.error('OpenRouter media proxy failed:', error?.message || error);
    return json(res, status, { error: { message: error?.message || 'OpenRouter media request failed.' } });
  }
}
