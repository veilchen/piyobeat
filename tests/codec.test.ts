import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePiyologText, type Event, type Kind } from '../src/parse/piyolog-text';
import { applyJitter, sortNotes, toNotes, type Note } from '../src/score/notes';
import { decodeSong, encodeSong, packSong, packSongV2, ShareLinkError, unpackSong, unpackSongV2, type Song } from '../src/share/codec';
import v1Link from './fixtures/v1-link.json';

const FIXTURE = readFileSync(new URL('./fixtures/synthetic_export_2026-01.txt', import.meta.url), 'utf8');

function songOf(text: string): Song {
  const r = parsePiyologText(text);
  return { dayCount: r.dayCount, tempo: 6, scale: 'penta', notes: toNotes(r.events, { startDay: 0, endDay: r.dayCount - 1, snap: true }) };
}

describe('share link', () => {
  it('round-trips the song exactly', async () => {
    const song = songOf(FIXTURE);
    expect(await decodeSong(await encodeSong(song))).toEqual(song);
  });

  it('round-trips every kind and qualifier', () => {
    const notes: Note[] = [];
    const kinds: Kind[] = ['breast', 'formula', 'expressed', 'pump', 'pee', 'poop', 'bath', 'sleep'];
    kinds.forEach((kind, i) => notes.push({ day: 255, minute: i * 15, kind, level: 0, side: 0, ...(kind === 'sleep' ? { len: 840 } : {}) }));
    notes.push({ day: 255, minute: 1425, kind: 'breast', level: 7, side: 2 });
    notes.push({ day: 255, minute: 1425, kind: 'formula', level: 7, side: 0 });
    for (const amount of [0, 1, 2, 3] as const) for (const hardness of [0, 1, 2, 3] as const) {
      notes.push({ day: 255, minute: 1425, kind: 'poop', level: 0, side: 0, amount, hardness });
    }
    notes.push({ day: 255, minute: 1425, kind: 'poop', level: 0, side: 0, amount: 3 });
    notes.push({ day: 255, minute: 1425, kind: 'poop', level: 0, side: 0, hardness: 3 });
    const song: Song = { dayCount: 256, tempo: 20, scale: 'lydian', notes };
    const sorted = { ...song, notes: sortNotes(notes) };
    expect(unpackSong(packSong(song))).toEqual(sorted);
    expect(unpackSongV2(packSongV2(song))).toEqual(sorted);
  });

  it('makes v2 links', async () => {
    expect(await encodeSong(songOf(FIXTURE))).toMatch(/^v2\./);
  });

  it('still opens a link made in v1, as the same song', async () => {
    expect(v1Link.fragment).toMatch(/^v1\./);
    // Same notes; only the order of notes sharing a quarter hour has been made canonical since.
    const expected = { ...v1Link.song, notes: sortNotes(v1Link.song.notes as Note[]) };
    expect(await decodeSong(v1Link.fragment)).toEqual(expected);
    expect(await decodeSong(await encodeSong(v1Link.song as Song))).toEqual(expected);
  });

  it('v2 is much shorter than v1 for the same song', async () => {
    const v2 = await encodeSong(v1Link.song as Song);
    expect(v2.length).toBeLessThan(v1Link.fragment.length * 0.6);
  });

  it('keeps tempo and scale', async () => {
    const song = { ...songOf(FIXTURE), tempo: 3.5, scale: 'miyako' as const };
    const out = await decodeSong(await encodeSong(song));
    expect([out.tempo, out.scale]).toEqual([3.5, 'miyako']);
  });

  it('jitter is fixed once encoded', async () => {
    const song = songOf(FIXTURE);
    const jittered = { ...song, notes: applyJitter(song.notes, song.dayCount) };
    const link = await encodeSong(jittered);
    expect(await decodeSong(link)).toEqual(await decodeSong(link));
    expect((await decodeSong(link)).notes).toEqual(jittered.notes);
  });

  it('stays within a few KB for 28 busy days', async () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
    const events: Event[] = [];
    for (let day = 0; day < 28; day++) {
      for (let i = 0; i < 40; i++) {
        const kind = (['breast', 'pee', 'formula', 'poop'] as const)[rnd(4)]!;
        events.push({ day, minute: rnd(1440), kind, left: rnd(20), right: rnd(20), ml: rnd(160) });
      }
    }
    const link = await encodeSong({ dayCount: 28, tempo: 6, scale: 'penta', notes: toNotes(events, { startDay: 0, endDay: 27, snap: true }) });
    expect(link.length).toBeLessThan(3000);
  });

  it('refuses too many days', () => {
    expect(() => packSong({ dayCount: 257, tempo: 6, scale: 'penta', notes: [] })).toThrow(ShareLinkError);
  });
});

describe('hostile links', () => {
  const pack = (bytes: number[]) => unpackSong(Uint8Array.from(bytes));

  it.each<[string, number[]]>([
    ['empty', []],
    ['bad tempo', [0, 0, 0]],
    ['tempo too high', [0, 41, 0]],
    ['unknown scale', [0, 12, 9]],
    ['truncated note', [0, 12, 0, 0, 0]],
    ['day beyond dayCount', [0, 12, 0, 1, 0, 0]],
    ['slot beyond the day', [0, 12, 0, 0, 0xc0, 0]],
    ['truncated sleep', [0, 12, 0, 0, 1, 0xc0]],
    ['feed level out of range', [0, 12, 0, 0, 0, 0b00111100]],
    ['bad breast side', [0, 12, 0, 0, 0, 0b00000011]],
  ])('rejects %s', (_name, bytes) => {
    expect(() => pack(bytes)).toThrow(ShareLinkError);
  });

  it.each<[string, number[]]>([
    ['v2 empty body', [0, 12, 0]],
    ['v2 truncated counts', [0, 12, 0, 0, 0, 0]],
    ['v2 slot beyond the range', [0, 12, 0, 0, 0, 0, 0, 1, 96, 0, 0, 0]],
    ['v2 endless varint', [0, 12, 0, 255, 255, 255, 255]],
    ['v2 trailing bytes', [0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]],
    ['v2 missing value', [0, 12, 0, 1, 0]],
    ['v2 feed level out of range', [0, 12, 0, 0, 1, 0, 8, 0, 0, 0, 0, 0, 0]],
    ['v2 bad breast side', [0, 12, 0, 1, 0, 24, 0, 0, 0, 0, 0, 0, 0]],
    ['v2 bad poop value', [0, 12, 0, 0, 0, 0, 0, 0, 1, 0, 64, 0, 0]],
  ])('rejects %s', (_name, bytes) => {
    expect(() => unpackSongV2(Uint8Array.from(bytes))).toThrow(ShareLinkError);
  });

  it('accepts a minimal valid v2 body', () => {
    expect(unpackSongV2(Uint8Array.from([0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0])).notes).toEqual([]);
  });

  it.each(['v1.', 'v1.!!!!', 'v1.AAAA', 'v2.', 'v2.AAAA', 'v3.AAAA', 'nope'])('rejects fragment %s', async (fragment) => {
    await expect(decodeSong(fragment)).rejects.toBeInstanceOf(ShareLinkError);
  });

  it('rejects a decompression bomb', async () => {
    const huge = new Uint8Array(4 * 1024 * 1024);
    const stream = new Blob([huge]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const deflated = new Uint8Array(await new Response(stream).arrayBuffer());
    const b64 = btoa(String.fromCharCode(...deflated)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(decodeSong('v1.' + b64)).rejects.toBeInstanceOf(ShareLinkError);
  });
});
