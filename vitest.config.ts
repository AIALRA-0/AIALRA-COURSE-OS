import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/src/**/*.spec.ts", "**/src/**/*.spec.tsx", "scripts/**/*.spec.ts"],
    // Isolated publication copies and runtime evidence are not source suites.
    exclude: ["**/node_modules/**", "**/dist/**", "var/**", "privatevar/**", ".agent-project-control/**"],
    fileParallelism: false
  }
});
