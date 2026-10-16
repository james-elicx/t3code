/**
 * Reads the ref-update commands at the front of a `git-receive-pack` request
 * body without consuming the pack behind them.
 *
 * Smart HTTP push sends `*shallow (command-list | push-cert)` as pkt-lines,
 * a flush, optional push options, then the packfile. Only the command list
 * matters for authorization; the rest is replayed byte for byte.
 */

export interface RefUpdate {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export class PktLineError extends Error {}

/** Commands are a few hundred bytes; anything this large is not a push we accept. */
const MAX_COMMAND_SECTION_BYTES = 1024 * 1024;
const COMMAND = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/;
const decoder = new TextDecoder();

interface Parsed {
  readonly updates: ReadonlyArray<RefUpdate>;
  /** Capabilities the client announced on its first command, e.g. `report-status`. */
  readonly capabilities: ReadonlyArray<string>;
  /** Bytes up to and including the flush that ends the command list. */
  readonly consumed: number;
}

/** Parses the command list from `bytes`, or returns null when more input is needed. */
export function parseCommandList(bytes: Uint8Array): Parsed | null {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  for (;;) {
    if (bytes.length - offset < 4) return null;
    const lengthHex = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(lengthHex)) {
      throw new PktLineError(`Invalid pkt-line length "${lengthHex}".`);
    }
    const length = Number.parseInt(lengthHex, 16);
    if (length === 0) return { updates, capabilities, consumed: offset + 4 };
    if (length < 4) throw new PktLineError(`Unexpected special pkt-line ${lengthHex}.`);
    if (bytes.length - offset < length) return null;
    let line = decoder.decode(bytes.subarray(offset + 4, offset + length));
    offset += length;

    if (line.endsWith("\n")) line = line.slice(0, -1);
    // The first command carries capabilities after a NUL.
    const nul = line.indexOf("\0");
    if (nul !== -1) {
      capabilities = line
        .slice(nul + 1)
        .split(" ")
        .filter(Boolean);
      line = line.slice(0, nul);
    }
    if (line.startsWith("shallow ")) continue;
    if (line.startsWith("push-cert")) {
      throw new PktLineError("Signed pushes are not supported from a sandbox.");
    }
    const match = COMMAND.exec(line);
    if (!match) throw new PktLineError(`Unrecognized receive-pack command "${line}".`);
    updates.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
}

/**
 * Buffers just enough of `body` to read its ref updates, and returns them with
 * a stream that replays the whole body unchanged.
 */
export async function readReceivePackCommands(
  body: ReadableStream<Uint8Array> | null,
): Promise<ReceivePackCommands> {
  if (body === null) return { updates: [], capabilities: [], body: new Blob([]).stream() };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = new Uint8Array(0);
  let done = false;
  let parsed: Parsed | null = null;

  while (parsed === null && !done) {
    const next = await reader.read();
    done = next.done;
    if (next.value) {
      chunks.push(next.value);
      const joined = new Uint8Array(buffered.length + next.value.length);
      joined.set(buffered);
      joined.set(next.value, buffered.length);
      buffered = joined;
    }
    if (buffered.length > MAX_COMMAND_SECTION_BYTES) {
      await reader.cancel();
      throw new PktLineError("The receive-pack command list is too large.");
    }
    parsed = parseCommandList(buffered);
  }
  if (parsed === null) {
    // git sends a bare flush as a probe before large pushes; anything else is truncated.
    if (buffered.length === 0) {
      return { updates: [], capabilities: [], body: new Blob([]).stream() };
    }
    throw new PktLineError("The receive-pack request ended inside its command list.");
  }

  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { updates: parsed.updates, capabilities: parsed.capabilities, body: replay };
}

export interface ReceivePackCommands {
  readonly updates: ReadonlyArray<RefUpdate>;
  readonly capabilities: ReadonlyArray<string>;
  /** The full request body, replayed from the first byte. */
  readonly body: ReadableStream<Uint8Array>;
}

const encoder = new TextEncoder();

/** Encodes one pkt-line. */
export function pktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const out = new Uint8Array(bytes.length + 4);
  out.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")));
  out.set(bytes, 4);
  return out;
}

const FLUSH = encoder.encode("0000");

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * A receive-pack status report that refuses every ref, so git prints
 * `! [remote rejected] <ref> (<reason>)` instead of an opaque HTTP error.
 * `rejected` maps refs to their own reason; other refs fail as part of the
 * same all-or-nothing push.
 */
export function receivePackRejection(
  commands: Pick<ReceivePackCommands, "updates" | "capabilities">,
  rejected: ReadonlyMap<string, string>,
): Uint8Array {
  const report = concat([
    pktLine("unpack ok\n"),
    ...commands.updates.map((update) =>
      pktLine(
        `ng ${update.ref} ${rejected.get(update.ref) ?? "push refused because another ref was refused"}\n`,
      ),
    ),
    FLUSH,
  ]);
  if (!commands.capabilities.some((cap) => cap === "side-band" || cap === "side-band-64k")) {
    return report;
  }
  // Wrap the report in side-band channel 1, in packets small enough for plain side-band.
  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < report.length; offset += 990) {
    packets.push(pktLine(concat([Uint8Array.of(1), report.subarray(offset, offset + 990)])));
  }
  return concat([...packets, FLUSH]);
}
