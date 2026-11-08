import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Silences Powertools log output in test runs; assertions use spies instead.
    env: { POWERTOOLS_LOG_LEVEL: "SILENT", POWERTOOLS_DEV: "false", POWERTOOLS_TRACE_ENABLED: "false" },
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      // Synthesizes the stack in-process; esbuild bundling is skipped via context in the test.
      { extends: true, test: { name: "infra", include: ["tests/infra/**/*.test.ts"], testTimeout: 60_000 } },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Lambda entry points only wire dependencies; they are exercised by `cdk synth` bundling, not unit tests.
      exclude: ["src/functions/**"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
