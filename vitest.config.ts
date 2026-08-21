import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
      globals: false,
      hookTimeout: 30_000,
      include: ["test/**/*.test.ts"],
      environment: "node"
    }
});
