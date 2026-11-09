import { KINDS } from '../parse/piyolog-text';
import { SLOT_MINUTES, SLOTS_PER_DAY, sortNotes, type Note } from '../score/notes';

export const SCALE_IDS = ['penta', 'ryukyu', 'miyako', 'lydian'] as const;
export type ScaleId = (typeof SCALE_IDS)[number];

export interface Song {
  dayCount: number;
  notes: Note[];
  /** Seconds per day, 3..20 in 0.5 steps. */
  tempo: number;
  scale: ScaleId;
}

export const MAX_DAYS = 256;
const PREFIX = 'v1.';
const HEADER_BYTES = 3;
const MAX_INFLATED_BYTES = 256 * 1024;
const SLEEP_KIND = KINDS.indexOf('sleep');
const POOP_KIND = KINDS.indexOf('poop');
const BREAST_KIND = KINDS.indexOf('breast');
const FEED_KINDS = [BREAST_KIND, KINDS.indexOf('formula'), KINDS.indexOf('expressed')];

export class ShareLinkError extends Error {}
const broken = () => new ShareLinkError('このリンクは読み取れませんでした。');

/**
 * Layout: dayCount-1, tempo*2, scale, then per note 3 bytes (sleep: 4)
 *   day(8) | slot(7) kind(3) value(4) aux(2) | [sleep length in slots(8)]
 * value: feed level, or poop amount<<2|hardness. aux: breast side, or poop "amount/hardness recorded" bits.
 * Nothing here can hold a date, a raw minute count, an ml figure or text.
 */
export function packSong(song: Song): Uint8Array {
  if (song.dayCount < 1 || song.dayCount > MAX_DAYS) throw new ShareLinkError(`共有リンクにできるのは${MAX_DAYS}日までです。期間を短くしてください。`);
  const size = song.notes.reduce((sum, n) => sum + (n.kind === 'sleep' ? 4 : 3), HEADER_BYTES);
  const out = new Uint8Array(size);
  out[0] = song.dayCount - 1;
  out[1] = Math.round(song.tempo * 2);
  out[2] = SCALE_IDS.indexOf(song.scale);
  let p = HEADER_BYTES;
  for (const n of song.notes) {
    const kind = KINDS.indexOf(n.kind);
    const slot = Math.floor(n.minute / SLOT_MINUTES);
    let value = 0;
    let aux = 0;
    if (kind === POOP_KIND) {
      value = ((n.amount ?? 0) << 2) | (n.hardness ?? 0);
      aux = (n.amount !== undefined ? 1 : 0) | (n.hardness !== undefined ? 2 : 0);
    } else if (FEED_KINDS.includes(kind)) {
      value = n.level;
      if (kind === BREAST_KIND) aux = n.side;
    }
    out[p++] = n.day;
    out[p++] = (slot << 1) | (kind >> 2);
    out[p++] = ((kind & 3) << 6) | (value << 2) | aux;
    if (kind === SLEEP_KIND) out[p++] = Math.min(255, Math.round((n.len ?? 0) / SLOT_MINUTES));
  }
  return out;
}

export function unpackSong(bytes: Uint8Array): Song {
  if (bytes.length < HEADER_BYTES) throw broken();
  const dayCount = bytes[0]! + 1;
  const tempo = bytes[1]! / 2;
  const scale = SCALE_IDS[bytes[2]!];
  if (tempo < 3 || tempo > 20 || !scale) throw broken();
  const notes: Note[] = [];
  let p = HEADER_BYTES;
  while (p < bytes.length) {
    if (p + 3 > bytes.length) throw broken();
    const day = bytes[p++]!;
    const b1 = bytes[p++]!;
    const b2 = bytes[p++]!;
    const slot = b1 >> 1;
    const kindIndex = ((b1 & 1) << 2) | (b2 >> 6);
    const value = (b2 >> 2) & 15;
    const aux = b2 & 3;
    if (day >= dayCount || slot >= SLOTS_PER_DAY) throw broken();
    const note: Note = { day, minute: slot * SLOT_MINUTES, kind: KINDS[kindIndex]!, level: 0, side: 0 };
    if (kindIndex === POOP_KIND) {
      if (aux & 1) note.amount = (value >> 2) as 0 | 1 | 2 | 3;
      if (aux & 2) note.hardness = (value & 3) as 0 | 1 | 2 | 3;
    } else if (FEED_KINDS.includes(kindIndex)) {
      if (value > 7) throw broken();
      note.level = value;
      if (kindIndex === BREAST_KIND) {
        if (aux > 2) throw broken();
        note.side = aux;
      }
    }
    if (kindIndex === SLEEP_KIND) {
      if (p >= bytes.length) throw broken();
      note.len = bytes[p++]! * SLOT_MINUTES;
    }
    notes.push(note);
  }
  return { dayCount, tempo, scale, notes: sortNotes(notes) };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw broken();
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw broken();
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      throw broken();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function pipe(bytes: Uint8Array, transform: ReadableWritablePair<Uint8Array, Uint8Array>): ReadableStream<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  return source.pipeThrough(transform);
}

export const canShareLinks = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** The URL fragment, without the leading '#'. */
export async function encodeSong(song: Song): Promise<string> {
  const packed = packSong(song);
  const deflated = await readAll(pipe(packed, new CompressionStream('deflate-raw') as never), Infinity);
  return PREFIX + toBase64Url(deflated);
}

export const isSongFragment = (fragment: string) => /^v\d+\./.test(fragment);

export async function decodeSong(fragment: string): Promise<Song> {
  if (!fragment.startsWith(PREFIX)) throw new ShareLinkError('このリンクは新しい版で作られたため、読み取れません。');
  const deflated = fromBase64Url(fragment.slice(PREFIX.length));
  let packed: Uint8Array;
  try {
    packed = await readAll(pipe(deflated, new DecompressionStream('deflate-raw') as never), MAX_INFLATED_BYTES);
  } catch {
    throw broken();
  }
  return unpackSong(packed);
}
