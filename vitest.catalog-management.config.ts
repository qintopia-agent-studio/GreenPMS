import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// This suite starts with an unmaintained catalog. Keep exact includes: Vitest's
// positional filters are additive, so a broad tests/integration filter also
// selects every unrelated integration suite.
export default mergeConfig(base, defineConfig({ test: {
  include: [
    "tests/integration/catalog-snapshot-regression.integration.test.ts",
    "tests/integration/room-catalog.integration.test.ts"
  ]
} }));
