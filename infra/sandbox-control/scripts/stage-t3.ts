#!/usr/bin/env node
/**
 * Copies this branch's server bundle (apps/server/dist, which includes the web
 * client) into the container build context. Build it first:
 *
 *   vp run --filter t3 build
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../apps/server/dist/", import.meta.url));
const target = fileURLToPath(new URL("../container/t3-dist/", import.meta.url));

if (!existsSync(`${source}bin.mjs`)) {
  console.error(`No server bundle at ${source}. Run \`vp run --filter t3 build\` first.`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
// Source maps double the image for no runtime benefit.
cpSync(source, target, { recursive: true, filter: (path) => !path.endsWith(".map") });
console.log(`Staged ${source} -> ${target}`);
