import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-test",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5173 --strictPort",
    reuseExistingServer: !process.env.CI,
    url: "http://127.0.0.1:5173",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
