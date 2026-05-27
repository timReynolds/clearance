import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
