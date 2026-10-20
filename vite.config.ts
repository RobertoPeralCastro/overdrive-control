import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths so the build works from any subfolder (GitHub Pages, etc.).
  base: './',
  server: { host: true },
});
