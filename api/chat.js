/** Vercel serverless proxy for OpenRouter chat completions. Keep OPENROUTER_API_KEY server-side. */
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ALLOWED_MODELS = new Set([DEFAULT_MODEL]);

function send(res, status, payload) {
  res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: { message: 'Method not allowed' } });
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return send(res, 503, { error: { message: 'OpenRouter is not configured on the server.' } });

  try {
    const origin = req.headers?.origin;
    const host = String(req.headers?.host || '').toLowerCase();
    if (origin) {
      try {
        if (new URL(origin).host.toLowerCase() !== host) return send(res, 403, { error: { message: 'Cross-origin chat requests are not allowed.' } });
      } catch { return send(res, 403, { error: { message: 'Invalid request origin.' } }); }
    }
    let body = req.body;
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return send(res, 413, { error: { message: 'Request body is too large.' } });
      body = JSON.parse(body);
    }
    if (body && typeof body === 'object' && Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
      return send(res, 413, { error: { message: 'Request body is too large.' } });
    }
    if (!body || !Array.isArray(body.messages) || body.messages.length > 100) {
      return send(res, 400, { error: { message: 'A messages array is required (maximum 100 messages).' } });
    }
    const model = ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
    const payload = {
      model,
      messages: body.messages,
      stream: body.stream === true,
      ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
      ...(body.max_tokens && Number.isFinite(Number(body.max_tokens)) ? { max_tokens: Math.min(32000, Math.max(1, Number(body.max_tokens))) } : {}),
      ...(body.temperature != null && Number.isFinite(Number(body.temperature)) ? { temperature: Math.min(2, Math.max(0, Number(body.temperature))) } : {}),
    };
    const upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5517',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Video Studio',
      },
      body: JSON.stringify(payload),
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(upstream.status).json({ error: { message: detail.slice(0, 2000) || `OpenRouter returned ${upstream.status}` } });
    }
    if (!payload.stream) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(upstream.status).json(await upstream.json());
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    return res.end();
  } catch (error) {
    console.error('OpenRouter proxy request failed:', error?.message || error);
    return send(res, 502, { error: { message: 'Could not reach OpenRouter. Please try again.' } });
  }
}
