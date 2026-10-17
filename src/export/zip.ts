import { deflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer (store + deflate) used to build Office Open XML packages
 * without pulling a third party dependency into the extension bundle.
 */

export interface ZipEntry {
  /** Forward slashed path inside the archive. */
  path: string;
  /** UTF-8 encoded content. */
  content: string;
  /** Set to false to store the entry uncompressed. */
  compress?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 as required by the ZIP specification. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: dosDate };
}

class BufferWriter {
  private readonly chunks: Buffer[] = [];
  private length = 0;

  get size(): number {
    return this.length;
  }

  u16(value: number): this {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeUInt16LE(value & 0xffff, 0);
    return this.push(buffer);
  }

  u32(value: number): this {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32LE(value >>> 0, 0);
    return this.push(buffer);
  }

  bytes(value: Uint8Array): this {
    return this.push(Buffer.from(value));
  }

  private push(buffer: Buffer): this {
    this.chunks.push(buffer);
    this.length += buffer.length;
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

interface PreparedEntry {
  nameBytes: Buffer;
  crc: number;
  method: number;
  compressed: Buffer;
  uncompressed: Buffer;
  offset: number;
  time: number;
  date: number;
}

/** Builds a ZIP archive from the given entries. */
export function createZipArchive(entries: readonly ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const local = new BufferWriter();
  const prepared: PreparedEntry[] = [];

  for (const entry of entries) {
    const uncompressed = Buffer.from(entry.content, 'utf8');
    const crc = crc32(uncompressed);
    const useDeflate = entry.compress !== false;
    const compressed = useDeflate ? deflateRawSync(uncompressed) : uncompressed;
    const method = useDeflate && compressed.length < uncompressed.length ? 8 : 0;
    const payload = method === 8 ? compressed : uncompressed;
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const offset = local.size;

    local
      .u32(0x04034b50)
      .u16(20)
      .u16(0x0800)
      .u16(method)
      .u16(time)
      .u16(date)
      .u32(crc)
      .u32(payload.length)
      .u32(uncompressed.length)
      .u16(nameBytes.length)
      .u16(0)
      .bytes(nameBytes)
      .bytes(payload);

    prepared.push({
      nameBytes,
      crc,
      method,
      compressed: payload,
      uncompressed,
      offset,
      time,
      date
    });
  }

  const central = new BufferWriter();
  for (const entry of prepared) {
    central
      .u32(0x02014b50)
      .u16(20)
      .u16(20)
      .u16(0x0800)
      .u16(entry.method)
      .u16(entry.time)
      .u16(entry.date)
      .u32(entry.crc)
      .u32(entry.compressed.length)
      .u32(entry.uncompressed.length)
      .u16(entry.nameBytes.length)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(entry.offset)
      .bytes(entry.nameBytes);
  }

  const end = new BufferWriter();
  end
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(prepared.length)
    .u16(prepared.length)
    .u32(central.size)
    .u32(local.size)
    .u16(0);

  return Buffer.concat([local.toBuffer(), central.toBuffer(), end.toBuffer()]);
}
