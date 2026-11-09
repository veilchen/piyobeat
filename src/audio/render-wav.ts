import type { Note } from '../score/notes';
import type { ScaleId } from '../share/codec';
import { buildSeq, playItem } from './engine';
import { Voices, type VoiceKey } from './voices';

const SAMPLE_RATE = 44100;
const TAIL_SECONDS = 2.5;
const BYTES_PER_SECOND = SAMPLE_RATE * 2 * 2;

export const estimateWavBytes = (dayCount: number, secondsPerDay: number) =>
  Math.round((dayCount * secondsPerDay + TAIL_SECONDS) * BYTES_PER_SECOND);

export interface RenderOptions {
  notes: readonly Note[];
  dayCount: number;
  secondsPerDay: number;
  scale: ScaleId;
  on: Readonly<Record<VoiceKey, boolean>>;
}

export async function renderWav(opts: RenderOptions): Promise<Blob> {
  const seconds = opts.dayCount * opts.secondsPerDay + TAIL_SECONDS;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const voices = new Voices(ctx, opts.scale);
  const rate = 1440 / opts.secondsPerDay;
  for (const item of buildSeq(opts.notes, opts.dayCount)) {
    playItem(voices, item, item.at / rate, rate, opts.on);
  }
  return encodeWav(await ctx.startRendering());
}

/** 16-bit PCM. The output holds audio samples and the fixed header below, and no metadata. */
export function encodeWav(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'length' | 'sampleRate' | 'getChannelData'>): Blob {
  const channels = buffer.numberOfChannels;
  const dataBytes = buffer.length * channels * 2;
  const out = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(out);
  const ascii = (p: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let p = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (const ch of data) {
      const s = Math.max(-1, Math.min(1, ch[i]!));
      v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}
