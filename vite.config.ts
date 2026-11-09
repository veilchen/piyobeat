import { defineConfig, type Plugin } from 'vite';

const CSP = [
  "default-src 'self'",
  "connect-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

// Build only: the dev server needs a websocket and inline styles for HMR.
function injectCsp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ],
    },
  };
}

export default defineConfig({
  // Relative paths so the same build works on GitHub Pages, Cloudflare Pages, or a custom domain.
  base: './',
  plugins: [injectCsp()],
  build: {
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as never);
