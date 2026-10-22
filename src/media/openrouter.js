/** Browser-side OpenRouter adapter. All requests go to our serverless proxy; secrets never ship to the client. */
import { aiError, toolInput } from './ai-chat.js';
export const OPENROUTER_MODEL = 'openai/gpt-4.1';
const ENDPOINT = '/api/chat';

export async function openRouterCompletion(messages, { model = OPENROUTER_MODEL, tools, maxTokens, signal, temperature } = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({ messages, model, ...(tools?.length ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}), ...(temperature != null ? { temperature } : {}) }),
  });
  if (!response.ok) {
    let payload;
    try { payload = await response.json(); } catch { payload = { error: { message: `AI request failed (${response.status})` } }; }
    throw aiError(Object.assign(new Error(payload?.error?.message || `AI request failed (${response.status})`), { code: String(response.status) }));
  }
  return response.json();
}

export async function* openRouterStream(messages, { model = OPENROUTER_MODEL, tools, maxTokens, signal } = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    signal,
    body: JSON.stringify({ messages, model, stream: true, ...(tools?.length ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
  });
  if (!response.ok) {
    let payload;
    try { payload = await response.json(); } catch { payload = { error: { message: `AI request failed (${response.status})` } }; }
    throw aiError(Object.assign(new Error(payload?.error?.message || `AI request failed (${response.status})`), { code: String(response.status) }));
  }
  if (!response.body) throw new Error('The AI response did not include a stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let calls = new Map();
  const processLine = (line) => {
    if (!line.startsWith('data:')) return [];
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return data === '[DONE]' ? [{ type: 'done' }] : [];
    let event;
    try { event = JSON.parse(data); } catch { return []; }
    if (event.error) throw aiError(event.error);
    const delta = event.choices?.[0]?.delta || {};
    const out = [];
    if (delta.content) out.push({ type: 'text', text: delta.content });
    for (const item of delta.tool_calls || []) {
      const prev = calls.get(item.index) || { id: '', name: '', arguments: '' };
      prev.id += item.id || '';
      prev.name += item.function?.name || '';
      prev.arguments += item.function?.arguments || '';
      calls.set(item.index, prev);
    }
    if (event.choices?.[0]?.finish_reason) {
      for (const call of calls.values()) out.push({ type: 'tool', id: call.id, name: call.name, input: toolInput(call.arguments) });
      calls = new Map();
      if (event.choices[0].finish_reason === 'length') out.push({ type: 'cut' });
    }
    return out;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) for (const part of processLine(line)) if (part.type !== 'done') yield part;
      if (done) break;
    }
    if (buffer) for (const part of processLine(buffer)) if (part.type !== 'done') yield part;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw aiError(error);
  } finally {
    reader.releaseLock();
  }
}

/** One-shot chat helper with the legacy {message:{content}} reply shape used by text utilities. */
export async function openRouterChat(input, options = {}) {
  const messages = Array.isArray(input) ? input : [{ role: 'user', content: String(input ?? '') }];
  const result = await openRouterCompletion(messages, options);
  return { message: result?.choices?.[0]?.message || {}, usage: result?.usage };
}

const MEDIA_ENDPOINT = '/api/media';
async function mediaRequest(op, { method = 'POST', body, signal, accept = 'application/json', query = '' } = {}) {
  const response = await fetch(`${MEDIA_ENDPOINT}?op=${op}${query}`, {
    method,
    headers: body === undefined ? { Accept: accept } : { 'Content-Type': 'application/json', Accept: accept },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!response.ok) {
    let payload;
    try { payload = accept === 'application/json' ? await response.json() : { error: { message: await response.text() } }; }
    catch { payload = { error: { message: `OpenRouter request failed (${response.status})` } }; }
    throw aiError(Object.assign(new Error(payload?.error?.message || `OpenRouter request failed (${response.status})`), { code: String(response.status) }));
  }
  return response;
}

async function blobDataUrl(blob) {
  if (blob?.blob) blob = blob.blob;
  if (typeof blob === 'string' && blob.startsWith('data:')) blob = await (await fetch(blob)).blob();
  if (blob?.size > 1_000_000 && typeof createImageBitmap === 'function') {
    try {
      const image = await createImageBitmap(blob);
      const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close?.();
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82)) || blob;
    } catch { /* retain the source image if this browser cannot decode it */ }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read image data.'));
    reader.readAsDataURL(blob);
  });
}

export async function openRouterImage({ prompt, model = 'openai/gpt-image-2', aspectRatio = '16:9', reference = null, signal } = {}) {
  const input_references = reference ? [{ type: 'image_url', image_url: { url: await blobDataUrl(reference) } }] : undefined;
  const response = await mediaRequest('image', { body: { prompt, model, aspect_ratio: aspectRatio, ...(input_references ? { input_references } : {}) }, signal });
  const result = await response.json();
  const item = result?.data?.[0] || result?.images?.[0] || result?.choices?.[0]?.message?.images?.[0];
  const dataUrl = item?.b64_json ? `data:${item.mime_type || item.media_type || 'image/png'};base64,${item.b64_json}`
    : item?.url || item?.image_url?.url || item?.data_url;
  if (!dataUrl) throw new Error('OpenRouter returned no generated image.');
  if (dataUrl.startsWith('data:')) {
    const resp = await fetch(dataUrl);
    return resp.blob();
  }
  const image = await fetch(dataUrl, { credentials: 'omit' });
  if (!image.ok) throw new Error('The generated image could not be downloaded.');
  return image.blob();
}

export async function openRouterSpeech(input, { voice = 'nova', signal } = {}) {
  const response = await mediaRequest('speech', { body: { input, voice, model: 'google/gemini-3.8-flash-tts' }, signal, accept: 'audio/mpeg' });
  return response.blob();
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export async function openRouterTranscription(file, { language = 'auto', signal } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const response = await mediaRequest('transcribe', { body: {
    filename: file.name || 'audio.wav', content_type: file.type || 'audio/wav', audio_base64: bytesToBase64(bytes), language,
  }, signal });
  return response.json();
}

export async function openRouterVideo({ model = 'minimax/hailuo-3', prompt, duration = 5, aspectRatio = '16:9', resolution = '720p', firstFrame, lastFrame, generateAudio = true, negativePrompt = '', signal, onProgress } = {}) {
  const frame_images = [];
  if (firstFrame) frame_images.push({ type: 'image_url', image_url: { url: await blobDataUrl(firstFrame) }, frame_type: 'first_frame' });
  if (lastFrame) frame_images.push({ type: 'image_url', image_url: { url: await blobDataUrl(lastFrame) }, frame_type: firstFrame ? 'last_frame' : 'first_frame' });
  const start = await mediaRequest('video-start', { body: { model, prompt, duration, aspect_ratio: aspectRatio, resolution, generate_audio: generateAudio, negative_prompt: negativePrompt, frame_images }, signal });
  const submitted = await start.json();
  const job = submitted?.data || submitted;
  const id = job?.id || job?.job_id || job?.generation_id;
  if (!id) throw new Error('OpenRouter did not return a video job id.');
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 15000);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const statusResponse = await mediaRequest('video-status', { method: 'GET', query: `&id=${encodeURIComponent(id)}`, signal });
    const statusPayload = await statusResponse.json();
    const status = statusPayload?.data || statusPayload;
    onProgress?.(status);
    if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'expired') {
      throw new Error(status.error?.message || status.error || `Video generation ${status.status}.`);
    }
    if (status.status === 'completed') {
      const directUrl = (status.urls || status.unsigned_urls || [])[0];
      if (typeof directUrl === 'string') {
        try {
          const direct = await fetch(directUrl, { credentials: 'omit', signal });
          if (direct.ok) {
            const blob = await direct.blob();
            if (blob.size) return blob;
          }
        } catch { /* fall back to the authenticated download proxy */ }
      }
      const content = await mediaRequest('video-content', { method: 'GET', query: `&id=${encodeURIComponent(id)}&index=0`, accept: 'video/mp4', signal });
      const blob = await content.blob();
      if (!blob.size) throw new Error('OpenRouter returned an empty video.');
      return blob;
    }
  }
  throw new Error('Video generation timed out while waiting for OpenRouter. Check the generation in your OpenRouter account before retrying.');
}
