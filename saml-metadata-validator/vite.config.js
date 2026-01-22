import { defineConfig } from 'vite';

// Vite configuration for the SAML Metadata Validator app
// - base: './' keeps asset URLs relative in the production build
// - optimizeDeps.exclude avoids prebundling xmllint-wasm (its worker file path confuses the dep optimizer)
// - resolve.alias ensures the browser entry is used
// - worker.format 'es' keeps module workers consistent in dev/build
// - assetsInclude includes wasm explicitly (usually handled by Vite, added here defensively)
export default defineConfig({
  base: './',
  optimizeDeps: {
    exclude: ['xmllint-wasm'],
  },
  resolve: {
    alias: {
      'xmllint-wasm': 'xmllint-wasm/index-browser.mjs',
    },
  },
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.wasm'],
});
