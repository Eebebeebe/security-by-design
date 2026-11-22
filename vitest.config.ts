import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integrationstests teilen sich eine Datenbank -> nicht parallel ausführen.
    fileParallelism: false,
    testTimeout: 15_000,
    reporters: ['default'],
  },
});
