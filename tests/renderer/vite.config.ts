// Vite server for the renderer test harness page. Serves tests/renderer/ as
// root so harness.ts can import the real terminal modules from src/.
import { defineConfig } from 'vite';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  server: { port: 5199, strictPort: true },
});
