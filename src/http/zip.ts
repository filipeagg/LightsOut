/**
 * Minimal ZIP writer for project export (SU-06, DESIGN §14.5).
 *
 * A zip is the one archive format a Windows user can open with a double click, and the export
 * is the only way out of a `LO_WORKSPACE_MODE=volume` install. The format needed here is the
 * 1989 one — local headers, deflate, a central directory — so it is written by hand with
 * `node:zlib` rather than pulling an archiver dependency in for it (ST-03).
 *
 * Scope on purpose: no zip64, no encryption, no directory entries. Anything large enough to
 * need zip64 is a project that should be cloned, not downloaded.
 *
 * Reading was added for the project bundle (PM-14): an archive this system writes is an archive
 * it has to be able to read back, and the same 1989 format read by hand is a smaller surface than
 * a dependency that also does encryption, zip64 and symlinks — none of which a bundle may contain.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntry = {
  /** Path inside the archive, forward slashes, no leading slash. */
  name: string;
  data: Buffer;
  /** Modification time; defaults to now. */
  mtime?: Date;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair (FAT resolution: two seconds, years from 1980). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/").replace(/^\/+/, ""), "utf8");
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data);
    // Storing is smaller than deflating for already-compressed or tiny payloads.
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // External attributes: regular file, 0644, in the high word. The shift overflows into a
    // negative int32 without the unsigned coercion, which writeUInt32LE rejects outright.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

/** What `readZip` refuses, as one exception type, so a caller can say which archive was bad. */
export class ZipError extends Error {}

/**
 * Read an archive back into its entries.
 *
 * Driven by the central directory rather than by scanning for local headers: the central
 * directory is the authority on what an archive contains, and a reader that trusts local headers
 * can be shown entries the directory never listed. Refusals are deliberate and total — an
 * encrypted entry, an unknown compression method, a zip64 archive and a size that disagrees with
 * the stored CRC are each an error, never a best effort, because the caller is about to write
 * these bytes into somebody's workspace.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new ZipError("zip64 archives are not read here");

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new ZipError("central directory entry not found where the archive says it is");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    if (flags & 0x0001) throw new ZipError("encrypted entries are not read here");
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipError(`local header missing for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = buffer.subarray(start, start + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body);
    else throw new ZipError(`unsupported compression method ${method} for ${name}`);

    if (data.length !== uncompressedSize) {
      throw new ZipError(`${name} does not have the size the archive claims`);
    }
    if (crc32(data) !== crc) throw new ZipError(`${name} fails its checksum`);

    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * The end-of-central-directory record, found by scanning backwards.
 *
 * It has no fixed position because it carries a variable-length comment, and a comment may
 * legally contain the signature — so the record is only accepted when the length it declares
 * agrees with where it was found.
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue;
    if (i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) return i;
  }
  throw new ZipError("not a zip archive: no end-of-central-directory record");
}
