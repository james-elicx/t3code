import { defineConfig, devices } from "@playwright/test";

/**
 * UI journeys against a running control plane. Locally that is `vp run dev`
 * with `vp run mock`; set BASE_URL to run the same journeys against a
 * deployed test domain (mock-only checks skip when MOCK_URL is unreachable).
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  // A sandbox boots, clones, and starts T3 and Claude before the first message.
  timeout: 8 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8787",
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
