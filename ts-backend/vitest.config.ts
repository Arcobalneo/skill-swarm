import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    env: {
      // Use real API keys from environment for regression tests.
      // Falls back to dummy values so unit tests that mock the router still pass.
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'test-deepseek-key',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'test-gemini-key',
    },
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'src/**/*.test.ts'],
    },
  },
});
