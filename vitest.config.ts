import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    server: {
      deps: {
        // OMP ships Bun-specific imports, including HTML loaded as text.
        external: [/@oh-my-pi\//],
      },
    },
  },
});
