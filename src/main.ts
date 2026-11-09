import './style.css';
import sampleText from '../tests/fixtures/synthetic_export_2026-01.txt?raw';
import { Engine } from './audio/engine';
import { estimateWavBytes, renderWav } from './audio/render-wav';
import type { VoiceKey } from './audio/voices';
import { KINDS, parsePiyologText, type CalendarDate, type Kind, type ParseResult } from './parse/piyolog-text';
import { applyJitter, toNotes, type Note } from './score/notes';
import { canShareLinks, decodeSong, encodeSong, isSongFragment, SCALE_IDS, ShareLinkError, type ScaleId } from './share/codec';
import { ScoreView } from './ui/score';

const LONG_LINK_CHARS = 8000;
const LARGE_WAV_BYTES = 150 * 1024 * 1024;
const SETTINGS_KEY = 'piyobeat.settings';

const VOICES: readonly { k: VoiceKey; name: string; shape: '' | 'sq' | 'tri' }[] = [
  { k: 'breast', name: '母乳', shape: '' },
  { k: 'formula', name: 'ミルク', shape: '' },
  { k: 'expressed', name: '搾母乳', shape: '' },
  { k: 'pump', name: '搾乳', shape: 'tri' },
  { k: 'pee', name: 'おしっこ', shape: 'sq' },
  { k: 'poop', name: 'うんち', shape: 'sq' },
  { k: 'sleep', name: '睡眠', shape: 'sq' },
  { k: 'bath', name: 'お風呂', shape: '' },
  { k: 'tick', name: '時報', shape: '' },
  { k: 'bass', name: 'ベース', shape: 'sq' },
];
const KIND_NAME = Object.fromEntries(VOICES.map((v) => [v.k, v.name])) as Record<VoiceKey, string>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = { input: $('screen-input'), confirm: $('screen-confirm'), play: $('screen-play') };

// ---------- state: numbers and enums only; the pasted text is never kept ----------
let parsed: ParseResult | null = null;
let rangeStart = 0;
let rangeEnd = 0;
/** Set when playing a shared link: no calendar exists, days show as "N日目". */
let shared: { notes: Note[]; dayCount: number } | null = null;
let notes: Note[] = [];
let dayCount = 0;
let wavUrl: string | null = null;
let wavFile: File | null = null;

// ---------- settings: UI preferences only ----------
interface Settings {
  tempo: number;
  scale: ScaleId;
  snap: boolean;
}
function loadSettings(): Settings {
  const fallback: Settings = { tempo: 6, scale: 'penta', snap: true };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return {
      tempo: typeof s.tempo === 'number' && s.tempo >= 3 && s.tempo <= 20 ? s.tempo : fallback.tempo,
      scale: SCALE_IDS.includes(s.scale as ScaleId) ? (s.scale as ScaleId) : fallback.scale,
      snap: typeof s.snap === 'boolean' ? s.snap : fallback.snap,
    };
  } catch {
    return fallback;
  }
}
function saveSettings(): void {
  if (shared) return; // a link's tempo and scale are not this person's preference
  const s: Settings = { tempo: tempoEl.valueAsNumber, scale: scaleEl.value as ScaleId, snap: quantEl.checked };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private mode etc.: the page works without it.
  }
}

// ---------- elements ----------
const textEl = $<HTMLTextAreaElement>('text');
const errorEl = $('error');
const tempoEl = $<HTMLInputElement>('tempo');
const scaleEl = $<HTMLSelectElement>('scale');
const quantEl = $<HTMLInputElement>('quant');
const fromEl = $<HTMLSelectElement>('from');
const toEl = $<HTMLSelectElement>('to');
const playEl = $<HTMLButtonElement>('play');
const wavBtn = $<HTMLButtonElement>('wav');
const wavSave = $<HTMLAnchorElement>('wav-save');
const wavShare = $<HTMLButtonElement>('wav-share');
const wavStatus = $('wav-status');
const linkBtn = $<HTMLButtonElement>('link');
const linkUrl = $<HTMLInputElement>('link-url');
const linkOut = $('link-out');
const linkStatus = $('link-status');
const linkShare = $<HTMLButtonElement>('link-share');

const on = Object.fromEntries(VOICES.map((v) => [v.k, true])) as Record<VoiceKey, boolean>;
const settings = loadSettings();
const engine = new Engine(settings.scale, on);
const score = new ScoreView($<HTMLCanvasElement>('cv'), engine, (r) => dayLabel(r), (t) => {
  $('now').textContent = t;
});

function show(name: keyof typeof screens): void {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  showError('');
  window.scrollTo(0, 0);
}
function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

// ---------- dates, for this person's own screen only ----------
function dateAt(index: number): string {
  const start = parsed?.startDate as CalendarDate;
  const t = new Date(Date.UTC(start.y, start.m - 1, start.d + index));
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}
function fullDateAt(index: number): string {
  const start = parsed?.startDate as CalendarDate;
  const t = new Date(Date.UTC(start.y, start.m - 1, start.d + index));
  return `${t.getUTCFullYear()}/${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}
function dayLabel(row: number): string {
  return shared ? `${row + 1}日目` : dateAt(rangeStart + row);
}

// ---------- 1. input ----------
function readText(text: string): void {
  const result = parsePiyologText(text);
  textEl.value = ''; // drop the raw text as soon as it has been read
  if (result.dayCount === 0) {
    showError('ぴよログのテキスト出力が見つかりませんでした。アプリの「テキスト出力」の内容をそのまま貼り付けてください。');
    return;
  }
  parsed = result;
  rangeEnd = result.dayCount - 1;
  rangeStart = Math.max(0, result.dayCount - 28);
  renderConfirm();
  show('confirm');
}

async function readFiles(list: FileList | null): Promise<void> {
  if (!list || list.length === 0) return;
  try {
    const texts = await Promise.all(Array.from(list).map((f) => f.text()));
    readText(texts.join('\n'));
  } catch {
    showError('ファイルを読み込めませんでした。');
  }
}

$('read').addEventListener('click', () => readText(textEl.value));
$('sample').addEventListener('click', () => readText(sampleText));
const filesEl = $<HTMLInputElement>('files');
filesEl.addEventListener('change', async () => {
  await readFiles(filesEl.files);
  filesEl.value = '';
});

// Dropping a file anywhere: without this the browser would navigate to it.
window.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  document.body.classList.toggle('dragging', !screens.input.hidden);
});
window.addEventListener('dragleave', (ev) => {
  if (ev.relatedTarget === null) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (ev) => {
  ev.preventDefault();
  document.body.classList.remove('dragging');
  if (!screens.input.hidden) void readFiles(ev.dataTransfer?.files ?? null);
});

// ---------- 2. confirm ----------
function renderConfirm(): void {
  const p = parsed!;
  $('summary-period').textContent = `${fullDateAt(0)} 〜 ${fullDateAt(p.dayCount - 1)}（${p.dayCount}日間、${p.events.length}件）`;
  const counts = $('summary-counts');
  counts.replaceChildren(
    ...KINDS.map((k: Kind) => {
      const li = document.createElement('li');
      const n = document.createElement('span');
      n.textContent = String(p.events.filter((e) => e.kind === k).length);
      li.append(KIND_NAME[k], n);
      return li;
    }),
  );
  const unread = $('summary-unread');
  unread.hidden = p.unreadable === 0;
  unread.textContent = `読めなかった記録が ${p.unreadable} 件あります。この分は曲に入りません。`;

  const options = () =>
    Array.from({ length: p.dayCount }, (_, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = fullDateAt(i);
      return o;
    });
  fromEl.replaceChildren(...options());
  toEl.replaceChildren(...options());
  syncRange();

  const presets = $('presets');
  presets.replaceChildren(
    ...[7, 14, 28]
      .filter((n) => n < p.dayCount)
      .map((n) => presetButton(`直近${n}日`, p.dayCount - n))
      .concat(presetButton('すべて', 0)),
  );
}
function presetButton(label: string, start: number): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost';
  b.textContent = label;
  b.addEventListener('click', () => {
    rangeStart = start;
    rangeEnd = parsed!.dayCount - 1;
    syncRange();
  });
  return b;
}
function syncRange(): void {
  fromEl.value = String(rangeStart);
  toEl.value = String(rangeEnd);
}
fromEl.addEventListener('change', () => {
  rangeStart = Number(fromEl.value);
  if (rangeEnd < rangeStart) rangeEnd = rangeStart;
  syncRange();
});
toEl.addEventListener('change', () => {
  rangeEnd = Number(toEl.value);
  if (rangeStart > rangeEnd) rangeStart = rangeEnd;
  syncRange();
});
$('to-play').addEventListener('click', () => {
  show('play');
  applySong();
});
$('back-input').addEventListener('click', () => {
  parsed = null;
  show('input');
});
$('back-range').addEventListener('click', () => {
  if (engine.playing) stopPlaying();
  show('confirm');
});

// ---------- 3. play ----------
function applySong(): void {
  if (shared) {
    notes = shared.notes;
    dayCount = shared.dayCount;
  } else {
    dayCount = rangeEnd - rangeStart + 1;
    notes = toNotes(parsed!.events, { startDay: rangeStart, endDay: rangeEnd, snap: quantEl.checked });
  }
  engine.setSong(notes, dayCount);
  for (const v of VOICES) {
    const n = $(`v-${v.k}`).querySelector('.n')!;
    n.textContent = String(engine.seq.filter((s) => s.key === v.k || (v.k === 'bass' && s.key === 'tick')).length);
  }
  score.setDayCount(dayCount);
  resetExports();
  if (!engine.playing) $('now').textContent = `${dayLabel(0)} 00:00`;
}

function frame(): void {
  score.draw();
  if (engine.playing) requestAnimationFrame(frame);
}
function startPlaying(from: number): void {
  engine.play(from);
  playEl.textContent = '■ 停止';
  requestAnimationFrame(frame);
}
function stopPlaying(): void {
  engine.stop();
  playEl.textContent = '▶ 再生';
  score.draw();
}
playEl.addEventListener('click', () => {
  if (engine.playing) stopPlaying();
  else startPlaying(0);
});
$<HTMLCanvasElement>('cv').addEventListener('click', (ev) => {
  const row = score.rowAt(ev.offsetY);
  if (row === null) return;
  if (engine.playing) {
    engine.unlock();
    engine.seek(row * 1440);
  } else {
    startPlaying(row * 1440);
  }
});

function setTempo(seconds: number): void {
  $('tempoV').textContent = String(seconds);
  $('bpm').textContent = `BPM ${Math.round((8 * 60) / seconds)}（3時間＝1拍）`;
  engine.setSecondsPerDay(seconds);
}
tempoEl.addEventListener('input', () => {
  setTempo(tempoEl.valueAsNumber);
  saveSettings();
  resetExports();
});
scaleEl.addEventListener('change', () => {
  engine.setScale(scaleEl.value as ScaleId);
  saveSettings();
  resetExports();
});
quantEl.addEventListener('change', () => {
  const pos = engine.playing && engine.ctx ? engine.posAt(engine.ctx.currentTime) : null;
  saveSettings();
  applySong();
  if (pos !== null) engine.seek(pos);
  score.draw();
});

const voicesBox = $('voices');
for (const v of VOICES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chip v-${v.k}`;
  b.id = `v-${v.k}`;
  b.setAttribute('aria-pressed', 'true');
  const swatch = document.createElement('span');
  swatch.className = `swatch ${v.shape}`.trim();
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = v.name;
  const n = document.createElement('span');
  n.className = 'n';
  b.append(swatch, lbl, n);
  b.addEventListener('click', () => {
    on[v.k] = !on[v.k];
    b.setAttribute('aria-pressed', String(on[v.k]));
    score.draw();
    resetExports();
    if (on[v.k]) engine.preview(v.k);
  });
  voicesBox.append(b);
}

window.addEventListener('resize', () => score.resize());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => score.draw());

// ---------- 4. share: WAV ----------
function resetWav(): void {
  if (wavUrl) URL.revokeObjectURL(wavUrl);
  wavUrl = null;
  wavFile = null;
  wavSave.hidden = true;
  wavSave.removeAttribute('href');
  wavShare.hidden = true;
  wavStatus.textContent = '';
}
/** The song changed, so anything already made from it is stale. */
function resetExports(): void {
  resetWav();
  linkOut.hidden = true;
  linkUrl.value = '';
  const bytes = estimateWavBytes(dayCount, tempoEl.valueAsNumber);
  $('wav-size').textContent = `約${Math.max(1, Math.round(bytes / 1024 / 1024))}MB。${bytes > LARGE_WAV_BYTES ? 'スマホでは書き出せないことがあります。テンポを速くするか、期間を短くしてください。' : ''}`;
}

wavBtn.addEventListener('click', async () => {
  wavBtn.disabled = true;
  wavStatus.textContent = '書き出しています…';
  try {
    const blob = await renderWav({ notes, dayCount, secondsPerDay: tempoEl.valueAsNumber, scale: scaleEl.value as ScaleId, on });
    resetWav();
    wavUrl = URL.createObjectURL(blob);
    wavSave.href = wavUrl;
    wavSave.hidden = false;
    wavFile = new File([blob], 'piyobeat.wav', { type: 'audio/wav' });
    wavShare.hidden = !navigator.canShare?.({ files: [wavFile] });
    wavStatus.textContent = `できました（${(blob.size / 1024 / 1024).toFixed(1)}MB）。`;
  } catch {
    wavStatus.textContent = '書き出せませんでした。テンポを速くするか、期間を短くしてお試しください。';
  } finally {
    wavBtn.disabled = false;
  }
});
wavShare.addEventListener('click', () => {
  if (wavFile) void navigator.share({ files: [wavFile] }).catch(() => {});
});

// ---------- 4. share: link ----------
linkBtn.addEventListener('click', async () => {
  linkBtn.disabled = true;
  try {
    const base = toNotes(parsed!.events, { startDay: rangeStart, endDay: rangeEnd, snap: true });
    const linkNotes = $<HTMLInputElement>('jitter').checked ? applyJitter(base, dayCount) : base;
    const fragment = await encodeSong({ dayCount, notes: linkNotes, tempo: tempoEl.valueAsNumber, scale: scaleEl.value as ScaleId });
    const url = `${location.origin}${location.pathname}#${fragment}`;
    linkUrl.value = url;
    linkOut.hidden = false;
    linkShare.hidden = !('share' in navigator);
    linkStatus.textContent =
      url.length > LONG_LINK_CHARS
        ? `リンクが長いため（${url.length}文字）、送れないアプリがあります。期間を短くしてください。`
        : `${url.length}文字のリンクです。`;
  } catch (e) {
    linkOut.hidden = false;
    linkStatus.textContent = e instanceof ShareLinkError ? e.message : 'リンクを作れませんでした。';
  } finally {
    linkBtn.disabled = false;
  }
});
$('link-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(linkUrl.value);
    linkStatus.textContent = 'コピーしました。';
  } catch {
    linkUrl.select();
    linkStatus.textContent = 'コピーできなかったので、選択した文字列を手でコピーしてください。';
  }
});
linkShare.addEventListener('click', () => {
  void navigator.share({ url: linkUrl.value }).catch(() => {});
});

// ---------- 5. opening a shared link ----------
async function openFragment(fragment: string): Promise<boolean> {
  if (!isSongFragment(fragment)) return false;
  try {
    if (!canShareLinks()) throw new ShareLinkError('このブラウザでは共有リンクを開けません。新しいバージョンのブラウザでお試しください。');
    const song = await decodeSong(fragment);
    if (engine.playing) stopPlaying();
    shared = { notes: song.notes, dayCount: song.dayCount };
    tempoEl.value = String(song.tempo);
    setTempo(song.tempo);
    scaleEl.value = song.scale;
    engine.setScale(song.scale);
    $('shared-banner').hidden = false;
    $('link-panel').hidden = true;
    $('quant-wrap').hidden = true;
    show('play');
    applySong();
  } catch (e) {
    show('input');
    showError(e instanceof ShareLinkError ? e.message : 'このリンクは読み取れませんでした。');
  }
  return true;
}

window.addEventListener('hashchange', () => location.reload());

async function init(): Promise<void> {
  tempoEl.value = String(settings.tempo);
  setTempo(settings.tempo);
  scaleEl.value = settings.scale;
  quantEl.checked = settings.snap;
  if (!canShareLinks()) $('link').setAttribute('disabled', '');
  if (await openFragment(location.hash.slice(1))) return;
  show('input');
}
void init();
