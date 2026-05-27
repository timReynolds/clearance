import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 850,
    modulePreload: {
      polyfill: false,
    },
    outDir: "dist/public",
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.split(path.sep).join("/");

          if (
            normalizedId.includes("/node_modules/react/") ||
            normalizedId.includes("/node_modules/react-dom/") ||
            normalizedId.includes("/node_modules/scheduler/")
          ) {
            return "react-vendor";
          }

          if (
            normalizedId.includes("/node_modules/@base-ui/") ||
            normalizedId.includes("/node_modules/@floating-ui/")
          ) {
            return "ui-vendor";
          }

          if (normalizedId.includes("/node_modules/@pierre/diffs/")) {
            return "diff-viewer";
          }

          if (
            normalizedId.includes("/node_modules/shiki/") ||
            normalizedId.includes("/node_modules/@shikijs/core/") ||
            normalizedId.includes("/node_modules/@shikijs/engine-javascript/") ||
            normalizedId.includes("/node_modules/@shikijs/engine-oniguruma/") ||
            normalizedId.includes("/node_modules/@shikijs/transformers/") ||
            normalizedId.includes("/node_modules/@shikijs/types/") ||
            normalizedId.includes("/node_modules/@shikijs/vscode-textmate/")
          ) {
            return "syntax-core";
          }

          if (normalizedId.includes("/node_modules/lucide-react/")) {
            return "icons";
          }

          return undefined;
        },
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./web"),
    },
  },
});
