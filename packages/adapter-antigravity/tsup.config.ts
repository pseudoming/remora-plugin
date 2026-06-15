import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/install.ts', 'src/**/*.ts', 'src/mcp/git-mcp.ts'],
  format: ['cjs'],
  outDir: 'dist',
  external: ['better-sqlite3'],
  noExternal: ['@remora/core'],
  bundle: true,
  clean: false,
  dts: false,
  minify: true,
  sourcemap: false
});
