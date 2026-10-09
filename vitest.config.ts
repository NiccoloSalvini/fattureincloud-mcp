import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // agent/session worktrees live inside the repo
    exclude: [...configDefaults.exclude, ".claude/**", "build/**"],
  },
});
