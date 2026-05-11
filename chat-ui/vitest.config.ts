// Vitest configuration for chat-ui tests.
//
// Environment: "node" is the correct default for server modules
// (profileSchema, requestBuilder, profileStore, config). Client/component
// tests opt into the DOM via a per-file directive:
//   // @vitest-environment jsdom
//
// The `@preact/preset-vite` plugin is required so component test files
// (e.g. test/client/Composer.test.ts) can import `client/src/components/
// *.tsx` modules — Vite needs the Preact JSX transform to resolve
// `react/jsx-dev-runtime` to `preact/jsx-runtime`.

import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
