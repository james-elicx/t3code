import { describe, expect, it } from "vite-plus/test";

import { advertisedHead } from "./github.ts";

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
const HEAD = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAIN = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";

describe("advertisedHead", () => {
  it("reads HEAD from a smart HTTP ref advertisement", () => {
    const advertisement =
      pkt("# service=git-upload-pack\n") +
      "0000" +
      pkt(`${HEAD} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/2\n`) +
      pkt(`${MAIN} refs/heads/feature\n`) +
      "0000";
    expect(advertisedHead(advertisement)).toBe(HEAD);
  });

  it("does not take the length prefix for part of the hash", () => {
    // The flush and length before HEAD's line are hex digits too.
    const advertisement = "0000" + pkt(`${HEAD} HEAD\0caps\n`);
    expect(advertisedHead(advertisement)).toBe(HEAD);
  });

  it("is null for an empty repository or a malformed answer", () => {
    expect(advertisedHead(pkt("# service=git-upload-pack\n") + "0000" + "0000")).toBeNull();
    expect(advertisedHead("<html>not git</html>")).toBeNull();
  });
});
