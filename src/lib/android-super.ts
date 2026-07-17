// Parser for Android LP (liblp) dynamic-partition metadata living at the
// start of `super.img`. We use it to slice the monolithic super image into
// per-partition offsets (system_a, vendor_a, product_a, system_ext_a, …) and
// hand those to the guest kernel as a `dm-mod.create=` cmdline fragment, so
// Cuttlefish can boot without first-stage init having to talk to a real
// bootloader/gsid.
//
// Layout on disk (all little-endian, sector = 512 bytes):
//
//   offset 0       : reserved (4096 B, boot header space)
//   offset 4096    : LpMetadataGeometry (4096 B)   — primary
//   offset 8192    : LpMetadataGeometry (4096 B)   — backup
//   offset 12288   : metadata slot 0 primary  (max = geometry.metadata_max_size)
//   … alternating primary/backup slots up to metadata_slot_count
//
// A metadata slot is: LpMetadataHeader + tables (partitions, extents, groups,
// block_devices). Each table descriptor is (offset, num_entries, entry_size).
//
// Refs: platform/system/core/fs_mgr/liblp/include/liblp/metadata_format.h

export const LP_SECTOR_SIZE = 512;
export const LP_PARTITION_RESERVED_BYTES = 4096;
export const LP_METADATA_GEOMETRY_MAGIC = 0x616c4467; // "gDla" LE
export const LP_METADATA_HEADER_MAGIC = 0x414c5030;   // "0PLA" LE
export const LP_METADATA_GEOMETRY_SIZE = 4096;

export const LP_TARGET_TYPE_LINEAR = 0;
export const LP_TARGET_TYPE_ZERO = 1;

export interface LpGeometry {
  magic: number;
  structSize: number;
  metadataMaxSize: number;
  metadataSlotCount: number;
  logicalBlockSize: number;
}

export interface LpExtent {
  numSectors: bigint;
  targetType: number;
  targetData: bigint;   // sector offset on the target block device
  targetSource: number; // index into block_devices table
}

export interface LpPartition {
  name: string;
  attributes: number;
  groupIndex: number;
  extents: LpExtent[];
  // Convenience: total size in bytes assuming all extents are LINEAR.
  sizeBytes: bigint;
}

export interface LpBlockDevice {
  firstSector: bigint;   // absolute first usable sector on the underlying image
  size: bigint;
  alignment: number;
  alignmentOffset: number;
  partitionName: string; // e.g. "super"
  flags: number;
}

export interface LpMetadata {
  geometry: LpGeometry;
  majorVersion: number;
  minorVersion: number;
  partitions: LpPartition[];
  blockDevices: LpBlockDevice[];
}

// Byte reader abstraction: lets us pull metadata from an OPFS-backed
// super.img without loading multi-GiB into memory. The block-worker exposes
// `read(offset, len)`; for tests we can back it with a Uint8Array.
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>;

export function bytesToReader(buf: Uint8Array): ByteReader {
  return async (offset, length) => buf.subarray(offset, offset + length);
}

// ---- primitive decoders ----------------------------------------------------

function readU16(v: DataView, o: number) { return v.getUint16(o, true); }
function readU32(v: DataView, o: number) { return v.getUint32(o, true); }
function readU64(v: DataView, o: number) { return v.getBigUint64(o, true); }

function readCString(bytes: Uint8Array, off: number, maxLen: number): string {
  let end = off;
  const stop = off + maxLen;
  while (end < stop && bytes[end] !== 0) end++;
  return new TextDecoder("utf-8").decode(bytes.subarray(off, end));
}

// ---- geometry --------------------------------------------------------------

function parseGeometry(bytes: Uint8Array): LpGeometry {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readU32(v, 0);
  if (magic !== LP_METADATA_GEOMETRY_MAGIC) {
    throw new Error(
      `[lp] bad geometry magic 0x${magic.toString(16)}, expected 0x${LP_METADATA_GEOMETRY_MAGIC.toString(16)}`,
    );
  }
  return {
    magic,
    structSize: readU32(v, 4),
    // 32 bytes checksum @ offset 8
    metadataMaxSize: readU32(v, 40),
    metadataSlotCount: readU32(v, 44),
    logicalBlockSize: readU32(v, 48),
  };
}

// ---- header + tables -------------------------------------------------------

interface LpTableDesc { offset: number; numEntries: number; entrySize: number }

interface LpHeaderV1_0 {
  major: number;
  minor: number;
  headerSize: number;
  tablesSize: number;
  partitions: LpTableDesc;
  extents: LpTableDesc;
  groups: LpTableDesc;
  blockDevices: LpTableDesc;
}

function parseHeader(bytes: Uint8Array): LpHeaderV1_0 {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readU32(v, 0);
  if (magic !== LP_METADATA_HEADER_MAGIC) {
    throw new Error(
      `[lp] bad header magic 0x${magic.toString(16)}, expected 0x${LP_METADATA_HEADER_MAGIC.toString(16)}`,
    );
  }
  // struct LpMetadataHeader (v1.0):
  //   u32 magic; u16 major; u16 minor; u32 header_size;
  //   u8  header_checksum[32]; u32 tables_size; u8 tables_checksum[32];
  //   LpMetadataTableDescriptor partitions;    // (offset u32, num u32, size u32)
  //   LpMetadataTableDescriptor extents;
  //   LpMetadataTableDescriptor groups;
  //   LpMetadataTableDescriptor block_devices;
  const major = readU16(v, 4);
  const minor = readU16(v, 6);
  const headerSize = readU32(v, 8);
  // header_checksum @ 12..44
  const tablesSize = readU32(v, 44);
  // tables_checksum @ 48..80
  const td = (o: number): LpTableDesc => ({
    offset: readU32(v, o),
    numEntries: readU32(v, o + 4),
    entrySize: readU32(v, o + 8),
  });
  return {
    major, minor, headerSize, tablesSize,
    partitions:   td(80),
    extents:      td(92),
    groups:       td(104),
    blockDevices: td(116),
  };
}

function parsePartitions(tables: Uint8Array, desc: LpTableDesc): Omit<LpPartition, "extents" | "sizeBytes">[] {
  const out: Omit<LpPartition, "extents" | "sizeBytes">[] = [];
  const v = new DataView(tables.buffer, tables.byteOffset, tables.byteLength);
  for (let i = 0; i < desc.numEntries; i++) {
    const base = desc.offset + i * desc.entrySize;
    // struct LpMetadataPartition:
    //   char name[36]; u32 attributes; u32 first_extent_index;
    //   u32 num_extents; u32 group_index;
    const name = readCString(tables, base, 36);
    const attributes = readU32(v, base + 36);
    const firstExtent = readU32(v, base + 40);
    const numExtents = readU32(v, base + 44);
    const groupIndex = readU32(v, base + 48);
    out.push({ name, attributes, groupIndex, /* stash indices via closure */
      // @ts-expect-error temp scratch
      _first: firstExtent, _num: numExtents });
  }
  return out;
}

function parseExtents(tables: Uint8Array, desc: LpTableDesc): LpExtent[] {
  const v = new DataView(tables.buffer, tables.byteOffset, tables.byteLength);
  const out: LpExtent[] = [];
  for (let i = 0; i < desc.numEntries; i++) {
    const base = desc.offset + i * desc.entrySize;
    // struct LpMetadataExtent:
    //   u64 num_sectors; u32 target_type; u64 target_data; u32 target_source;
    out.push({
      numSectors:  readU64(v, base),
      targetType:  readU32(v, base + 8),
      targetData:  readU64(v, base + 12),
      targetSource: readU32(v, base + 20),
    });
  }
  return out;
}

function parseBlockDevices(tables: Uint8Array, desc: LpTableDesc): LpBlockDevice[] {
  const v = new DataView(tables.buffer, tables.byteOffset, tables.byteLength);
  const out: LpBlockDevice[] = [];
  for (let i = 0; i < desc.numEntries; i++) {
    const base = desc.offset + i * desc.entrySize;
    // struct LpMetadataBlockDevice:
    //   u64 first_logical_sector; u32 alignment; u32 alignment_offset;
    //   u64 size; char partition_name[36]; u32 flags;
    out.push({
      firstSector:     readU64(v, base),
      alignment:       readU32(v, base + 8),
      alignmentOffset: readU32(v, base + 12),
      size:            readU64(v, base + 16),
      partitionName:   readCString(tables, base + 24, 36),
      flags:           readU32(v, base + 60),
    });
  }
  return out;
}

// ---- public API ------------------------------------------------------------

export async function parseSuperMetadata(read: ByteReader): Promise<LpMetadata> {
  // Geometry: primary at 4096, backup at 8192. Try primary first, fall back.
  let geomBytes = await read(LP_PARTITION_RESERVED_BYTES, LP_METADATA_GEOMETRY_SIZE);
  let geometry: LpGeometry;
  try {
    geometry = parseGeometry(geomBytes);
  } catch {
    geomBytes = await read(LP_PARTITION_RESERVED_BYTES + LP_METADATA_GEOMETRY_SIZE, LP_METADATA_GEOMETRY_SIZE);
    geometry = parseGeometry(geomBytes);
  }

  // Slot 0 metadata sits right after the two geometry blocks.
  const slot0Offset = LP_PARTITION_RESERVED_BYTES + 2 * LP_METADATA_GEOMETRY_SIZE;
  const slotBytes = await read(slot0Offset, geometry.metadataMaxSize);

  const header = parseHeader(slotBytes);
  const tables = slotBytes.subarray(header.headerSize, header.headerSize + header.tablesSize);

  const partHdrs = parsePartitions(tables, header.partitions);
  const extents = parseExtents(tables, header.extents);
  const blockDevices = parseBlockDevices(tables, header.blockDevices);

  const partitions: LpPartition[] = partHdrs.map((p) => {
    // @ts-expect-error temp scratch
    const first = p._first as number; const num = p._num as number;
    const es = extents.slice(first, first + num);
    const total = es.reduce((a, e) => a + e.numSectors, 0n) * BigInt(LP_SECTOR_SIZE);
    return {
      name: p.name, attributes: p.attributes, groupIndex: p.groupIndex,
      extents: es, sizeBytes: total,
    };
  });

  return { geometry, majorVersion: header.major, minorVersion: header.minor, partitions, blockDevices };
}

// ---- dm-linear cmdline builder --------------------------------------------

// Build a `dm-mod.create=` value the kernel understands, one dm-linear device
// per LP partition. Each partition maps its extents onto `/dev/block/<super>`.
// Sector counts and start offsets are in 512-byte sectors, as dm expects.
//
// Kernel cmdline format (see Documentation/admin-guide/device-mapper/dm-init):
//   dm-mod.create="<name>,<uuid>,<minor>,<flags>,<table_row>[;<name>,...,<row>]"
// A table_row is: "<logical_start> <num_sectors> <target_type> <target_args>"
// Multiple rows are separated by ',' within the same device entry.
//
// We emit read-only (ro) linear mappings; UUID and minor are left blank so the
// kernel auto-assigns.
export function buildDmCreateCmdline(
  meta: LpMetadata,
  opts: { superDev?: string; partitions?: string[]; readOnly?: boolean } = {},
): string {
  const superDev = opts.superDev ?? "/dev/block/by-name/super";
  const readOnly = opts.readOnly ?? true;
  const wanted = new Set(opts.partitions ?? meta.partitions.map((p) => p.name));

  const parts: string[] = [];
  for (const p of meta.partitions) {
    if (!wanted.has(p.name)) continue;
    const flags = readOnly ? "ro" : "rw";
    const rows: string[] = [];
    let logical = 0n;
    for (const e of p.extents) {
      if (e.targetType !== LP_TARGET_TYPE_LINEAR) {
        // zero-extents are rare in Cuttlefish; skip loudly so the caller notices.
        console.warn(`[lp] skipping non-linear extent on ${p.name}: type=${e.targetType}`);
        continue;
      }
      rows.push(`${logical} ${e.numSectors} linear ${superDev} ${e.targetData}`);
      logical += e.numSectors;
    }
    // dm-mod.create uses ',' as row separator inside a device entry, but ',' is
    // ALSO the field separator. Kernel docs resolve this by requiring rows to be
    // joined with ',' as-is; the parser knows the first 4 fields are the device
    // header. Devices themselves are separated by ';'.
    parts.push(`${p.name},,,${flags},${rows.join(",")}`);
  }
  return `dm-mod.create="${parts.join(";")}"`;
}

// Human-readable summary for the boot log panel.
export function summarizeMetadata(meta: LpMetadata): string {
  const lines: string[] = [];
  lines.push(`LP v${meta.majorVersion}.${meta.minorVersion}  slots=${meta.geometry.metadataSlotCount}  block=${meta.geometry.logicalBlockSize}`);
  for (const bd of meta.blockDevices) {
    lines.push(`  block: ${bd.partitionName}  first_sector=${bd.firstSector}  size=${bd.size}`);
  }
  for (const p of meta.partitions) {
    const mib = Number(p.sizeBytes / 1024n / 1024n);
    lines.push(`  part:  ${p.name.padEnd(20)} ${mib.toString().padStart(6)} MiB  extents=${p.extents.length}`);
  }
  return lines.join("\n");
}
