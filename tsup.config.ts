import { defineConfig } from 'tsup';
import path from 'path';

export default defineConfig({
    entry: ['src/server.ts'],
    outDir: 'dist',
    format: ['cjs'],
    target: 'node20',
    clean: true,
    sourcemap: true,
    tsconfig: './tsconfig.json',
    esbuildOptions(options) {
      options.alias = {
        '@': path.resolve(__dirname, 'src'), // <-- Key part
      };
    },
  });