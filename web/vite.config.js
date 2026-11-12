import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
// One self-contained dist/index.html: the server serves it at /api/a2ui/app and an MCP App could embed it
export default defineConfig({ plugins: [react(), viteSingleFile()], build: { outDir: 'dist' } });
