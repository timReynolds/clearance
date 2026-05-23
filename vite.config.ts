import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    modulePreload: {
      polyfill: false,
    },
    outDir: "dist/public",
  },
  plugins: [react()],
});
