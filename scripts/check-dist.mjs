// Fails the build if the bundle could talk to the network or the CSP is missing (SPEC §1-1, §7).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const FORBIDDEN = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket/,
  /EventSource/,
  /sendBeacon/,
  /importScripts/,
  /indexedDB/,
  /sessionStorage/,
  /document\.cookie/,
  /https?:\/\/(?!www\.w3\.org\/)/,
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const problems = [];
for (const file of walk(DIST)) {
  if (!/\.(js|css|html)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${file.slice(DIST.length)}: ${re}`);
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const head = html.slice(html.indexOf('<head>'));
const firstTag = /<meta[^>]*>|<script|<link/.exec(head.replace('<head>', ''))?.[0] ?? '';
if (!firstTag.includes('Content-Security-Policy')) problems.push('index.html: the CSP meta is not the first tag in <head>');
if (!html.replaceAll('&#39;', "'").includes("connect-src 'none'")) problems.push("index.html: CSP lacks connect-src 'none'");
if (/\sstyle\s*=|<style/.test(html)) problems.push('index.html: inline styles are blocked by the CSP');
if (/<script(?![^>]*\bsrc=)/.test(html)) problems.push('index.html: inline scripts are blocked by the CSP');

if (problems.length) {
  console.error('dist check failed:\n' + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log('dist check passed');
