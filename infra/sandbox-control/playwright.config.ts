import { defineConfig, devices } from "@playwright/test";

/**
 * UI journeys against a running control plane. Locally that is `vp run dev`
 * with `vp run mock`; set BASE_URL to run the same journeys against a deployed
 * test Worker (mock-only checks skip when MOCK_URL is unreachable). Behind
 * Cloudflare Access, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are an
 * Access service token the application's policy allows.
 */
const accessServiceToken =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : undefined;

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
    ...(accessServiceToken ? { extraHTTPHeaders: accessServiceToken } : {}),
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
