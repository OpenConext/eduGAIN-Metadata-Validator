import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default defineConfig({
  ...viteConfig,
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['validator.js'],
      reporter: ['text', 'clover'],
      thresholds: {
        statements: 98,
        branches: 94,
        functions: 100,
        lines: 98,
      },
    },
  },
});
