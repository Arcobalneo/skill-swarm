import { defineConfig } from 'vitest/config';
import path from 'node:path';
import 'dotenv/config';

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
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    },
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'src/**/*.test.ts'],
    },
  },
});
