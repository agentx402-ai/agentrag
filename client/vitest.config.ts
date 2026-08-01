import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "text-summary"],
      // Measured at 100/100/100/100 after closing every money-path gap Task 7 found
      // (up from 95.98/93.22/98.11/97.74 stmts/branches/funcs/lines beforehand — see
      // task-7-report.md). Thresholds sit a hair under that, not pinned to it: a bare 100
      // everywhere is a ratchet with zero slack, failing the whole workspace test run the
      // moment a single future branch (e.g. a defensive guard added ahead of its own test,
      // same style as several already in index.ts) is momentarily uncovered. `functions`
      // stays at 100 — an entirely untested new function is never a borderline case worth
      // tolerating, and each one is a coarse ~1.9%-of-53 jump so it can't drift there by
      // accident. `branches` gets the most slack (95, ~12 of 236) since it is the most
      // granular metric: every new `if`/`??`/ternary adds two at once, so it swings fastest
      // on an honest in-progress change. `statements`/`lines` sit between the two (98, ~6
      // lines of headroom). All four still fail well before coverage could drift back
      // toward the pre-Task-7 numbers above.
      thresholds: {
        statements: 98,
        branches: 95,
        functions: 100,
        lines: 98,
      },
    },
  },
});
