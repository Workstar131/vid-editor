/**
 * Text to speech through OpenRouter's audio/speech endpoint.
 */
import { errorMessage } from './transcribe.js';
import { openRouterSpeech } from './openrouter.js';

export const TTS_MAX = 3000;

export const TTS_VOICES = [
  ...['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'].map((v) => ({
    id: `gemini-${v.toLowerCase()}`,
    label: v,
    hint: 'Gemini voice',
    options: { provider: 'google', voice: v },
  })),
];

/** The app can reach its same-origin OpenRouter serverless proxy. */
export function aiAvailable(ctx) {
  return Boolean(ctx?.aiChat || ctx?.textAiChat || globalThis.fetch);
}

const cache = new Map(); // `${voice}|${text}` -> Blob

/** Speech for text as an audio Blob (cached per voice and text). */
export async function synthesize(text, voiceId, { testMode = false } = {}) {
  const t = String(text || '').trim().slice(0, TTS_MAX);
  if (!t) throw new Error('Type some text first.');
  const voice = TTS_VOICES.find((v) => v.id === voiceId) || TTS_VOICES[0];
  const key = `${voice.id}|${testMode ? 'test|' : ''}${t}`;
  if (cache.has(key)) return cache.get(key);
  let blob;
  try {
    blob = await openRouterSpeech(t, { voice: voice.options?.voice || 'Kore' });
  } catch (err) {
    throw new Error(errorMessage(err, "Couldn't create the speech."));
  }
  if (!blob.size) throw new Error('The speech came back empty.');
  cache.set(key, blob);
  // Keep the cache small; it only spares repeat requests while editing.
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  return blob;
}

const EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'weba', 'audio/mp4': 'm4a' };

/** A named File for speech audio, e.g. "Speech - Hello and welcome.mp3". */
export function speechFile(blob, text) {
  const type = (blob.type || 'audio/mpeg').split(';')[0];
  const words = String(text).replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().split(/\s+/).slice(0, 5).join(' ');
  const name = `Speech - ${words.slice(0, 40) || 'voice'}.${EXT[type] || 'mp3'}`;
  return new File([blob], name, { type: type || 'audio/mpeg' });
}

/** Import speech audio and put it on an audio track at start (default: playhead). */
export async function addSpeechToTimeline(ctx, blob, text, { start } = {}) {
  const [asset] = await ctx.actions.importFiles([speechFile(blob, text)]);
  if (!asset) return null;
  return ctx.actions.addAsset(asset, start !== undefined ? { start } : {});
}
