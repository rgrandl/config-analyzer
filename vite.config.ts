import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The app is served from https://rgrandl.github.io/config-analyzer/,
// so every asset URL must be prefixed with the repository name.
export default defineConfig({
  base: '/config-analyzer/',
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
