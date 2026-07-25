/**
 * The export archive is written by hand (SU-06), so it gets tested by hand: the bytes must be a
 * zip that a stock unzip would accept, and the payload must survive the round trip intact.
 */
import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildZip } from "../src/http/zip.js";

/** Read the archive back the way an unzip does: central directory first, then each local entry. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);

  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const method = zip.readUInt16LE(localOffset + 8);
    const compressed = zip.readUInt32LE(localOffset + 18);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(start, start + compressed);
    out.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

describe("buildZip", () => {
  it("round-trips text, binary and compressible payloads", () => {
    const text = Buffer.from("# STATE\n\nmanaged block\n", "utf8");
    const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
    const compressible = Buffer.from("x".repeat(4096), "utf8");

    const entries = readZip(
      buildZip([
        { name: "p/doc/STATE.md", data: text },
        { name: "p/.git/objects/ab/cdef", data: binary },
        { name: "p/big.txt", data: compressible },
      ]),
    );

    expect([...entries.keys()]).toEqual(["p/doc/STATE.md", "p/.git/objects/ab/cdef", "p/big.txt"]);
    expect(entries.get("p/doc/STATE.md")).toEqual(text);
    expect(entries.get("p/.git/objects/ab/cdef")).toEqual(binary);
    expect(entries.get("p/big.txt")).toEqual(compressible);
  });

  it("stores rather than deflates when deflating would not help", () => {
    // Six incompressible bytes: the deflate wrapper alone is bigger than the payload.
    const zip = buildZip([{ name: "tiny", data: Buffer.from([7, 9, 11, 13, 17, 19]) }]);
    expect(zip.readUInt16LE(8)).toBe(0); // local header, method 0 = stored
    expect(readZip(zip).get("tiny")).toEqual(Buffer.from([7, 9, 11, 13, 17, 19]));
  });

  it("normalises backslashes and leading slashes in entry names", () => {
    const entries = readZip(buildZip([{ name: "/p\\doc\\PLAN.md", data: Buffer.from("x") }]));
    expect([...entries.keys()]).toEqual(["p/doc/PLAN.md"]);
  });

  it("writes an empty but valid archive", () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
    expect(readZip(zip).size).toBe(0);
  });
});
