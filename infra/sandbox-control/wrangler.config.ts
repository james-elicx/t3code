import { defineWranglerConfig } from "wrangler/experimental-config";

// Build settings for `cf`, which builds this project with Wrangler. The Worker
// itself is configured in cloudflare.config.ts.
export default defineWranglerConfig({
  // The hosted web client, built by `vp run build:web`.
  assetsDirectory: "./.web-dist",
  dev: { port: 8787 },
});
