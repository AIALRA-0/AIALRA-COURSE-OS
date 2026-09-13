import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/src/**/*.spec.ts", "**/src/**/*.spec.tsx", "scripts/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false
  }
});
