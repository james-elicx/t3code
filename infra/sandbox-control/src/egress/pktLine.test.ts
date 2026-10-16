import { describe, expect, it } from "vite-plus/test";

import { PktLineError, pktLine, readReceivePackCommands, receivePackRejection } from "./pktLine.ts";

const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const join = (...parts: Array<string | Uint8Array>) => {
  const bytes = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  const out = new Uint8Array(bytes.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of bytes) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Delivers `bytes` in chunks of `size`, the way a network body arrives. */
const chunked = (bytes: Uint8Array, size: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) {
        controller.enqueue(bytes.slice(offset, offset + size));
      }
      controller.close();
    },
  });

const readAll = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const PACK = join("PACK", Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 0, 0xff, 0x00, 0x30, 0x30));

describe("readReceivePackCommands", () => {
  it("reads every ref update and replays the body byte for byte", async () => {
    const body = join(
      pktLine(`${ZERO} ${A} refs/heads/t3/abc/work\0report-status side-band-64k agent=git/2.47\n`),
      pktLine(`${A} ${B} refs/heads/t3/abc/second\n`),
      "0000",
      PACK,
    );
    // One-byte chunks prove the parser waits for whole pkt-lines across reads.
    const parsed = await readReceivePackCommands(chunked(body, 1));
    expect(parsed.updates).toEqual([
      { oldOid: ZERO, newOid: A, ref: "refs/heads/t3/abc/work" },
      { oldOid: A, newOid: B, ref: "refs/heads/t3/abc/second" },
    ]);
    expect(parsed.capabilities).toEqual(["report-status", "side-band-64k", "agent=git/2.47"]);
    expect(await readAll(parsed.body)).toEqual(body);
  });

  it("skips shallow lines and accepts sha256 object ids", async () => {
    const C = "c".repeat(64);
    const body = join(
      pktLine(`shallow ${A}\n`),
      pktLine(`${"0".repeat(64)} ${C} refs/heads/main\0report-status\n`),
      "0000",
    );
    const parsed = await readReceivePackCommands(chunked(body, 7));
    expect(parsed.updates).toEqual([{ oldOid: "0".repeat(64), newOid: C, ref: "refs/heads/main" }]);
  });

  it("treats the bare-flush probe git sends before large pushes as no updates", async () => {
    const parsed = await readReceivePackCommands(chunked(encoder.encode("0000"), 4));
    expect(parsed.updates).toEqual([]);
    expect(decoder.decode(await readAll(parsed.body))).toBe("0000");
  });

  it("rejects malformed, truncated, and signed pushes instead of guessing", async () => {
    await expect(readReceivePackCommands(chunked(encoder.encode("zzzz"), 4))).rejects.toThrow(
      PktLineError,
    );
    await expect(
      readReceivePackCommands(chunked(pktLine(`${ZERO} ${A} refs/heads/x\n`), 3)),
    ).rejects.toThrow(/ended inside its command list/);
    await expect(
      readReceivePackCommands(chunked(join(pktLine("push-cert\0report-status\n"), "0000"), 64)),
    ).rejects.toThrow(/Signed pushes/);
    await expect(
      readReceivePackCommands(chunked(join(pktLine("delete everything\n"), "0000"), 64)),
    ).rejects.toThrow(/Unrecognized/);
  });
});

describe("receivePackRejection", () => {
  const updates = [
    { oldOid: A, newOid: B, ref: "refs/heads/main" },
    { oldOid: A, newOid: B, ref: "refs/heads/t3/abc/work" },
  ];
  const refused = new Map([["refs/heads/main", "not yours"]]);

  it("reports every ref as rejected, with each refused ref's own reason", () => {
    const report = decoder.decode(
      receivePackRejection({ updates, capabilities: ["report-status"] }, refused),
    );
    expect(report).toBe(
      "000eunpack ok\n" +
        "0021ng refs/heads/main not yours\n" +
        "004bng refs/heads/t3/abc/work push refused because another ref was refused\n" +
        "0000",
    );
  });

  it("wraps the report in side-band channel 1 when the client asked for it", () => {
    const plain = receivePackRejection({ updates, capabilities: [] }, refused);
    const banded = receivePackRejection({ updates, capabilities: ["side-band-64k"] }, refused);
    const length = Number.parseInt(decoder.decode(banded.subarray(0, 4)), 16);
    expect(banded[4]).toBe(1);
    expect(banded.subarray(5, length)).toEqual(plain);
    expect(decoder.decode(banded.subarray(length))).toBe("0000");
  });
});
