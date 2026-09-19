import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

export default mergeConfig(base, defineConfig({ test: {
  env: { PMS_TEST_MAINTAINED_CATALOG: "true" },
  // Fault-injection cases perform many full transactions within one test.
  testTimeout: 120_000,
  include: ["stay-date-changes", "admin-historical-stay-corrections", "core-operations", "move-unit-stage11",
    "checkout-reversal", "stage12-order-terminal", "whole-room-occupants"]
    .map((name) => `tests/integration/${name}.integration.test.ts`)
} }));
