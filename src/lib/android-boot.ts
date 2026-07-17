// Minimal Android boot-image (v3/v4) + vendor_boot (v3/v4) unpackers.
//
// AOSP Cuttlefish ships:
//   boot.img         — "ANDROID!" magic — contains the aarch64 kernel and
//                      (on GKI builds) an optional generic ramdisk.
//   vendor_boot.img  — "VNDRBOOT" magic — contains the vendor ramdisk(s),
//                      an optional dtb, and bootconfig.
//
// QEMU wants two files: a raw kernel and a single initramfs (cpio.gz).
// We extract:
//   kernel   ← boot.img
//   ramdisk  ← vendor_boot.vendor_ramdisk  ++  boot.generic_ramdisk (if any)
// concatenated cpio streams are a valid combined initramfs — that's how the
// Android bootloader itself feeds them to the kernel.
//
// Spec references:
//   system/tools/mkbootimg/include/bootimg/bootimg.h
//   https://source.android.com/docs/core/architecture/bootloader/boot-image-header
//   https://source.android.com/docs/core/architecture/partitions/vendor-boot-partitions

const BOOT_MAGIC = "ANDROID!";
const VENDOR_MAGIC = "VNDRBOOT";
const BOOT_PAGE = 4096; // v3+ boot images are fixed at 4096

function readMagic(view: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("ascii").decode(view.subarray(offset, offset + length));
}

function pad(n: number, page: number): number {
  const rem = n % page;
  return rem === 0 ? n : n + (page - rem);
}

export type BootImageParts = {
  headerVersion: number;
  kernel: Uint8Array;
  ramdisk: Uint8Array; // may be zero-length on GKI builds
  cmdline: string;
};

export function parseBootImage(buf: Uint8Array): BootImageParts {
  if (readMagic(buf, 0, 8) !== BOOT_MAGIC) {
    throw new Error("boot.img: missing ANDROID! magic");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // v3/v4 layout (little-endian u32s):
  //   [0]  magic[8]
  //   [8]  kernel_size
  //   [12] ramdisk_size
  //   [16] os_version
  //   [20] header_size
  //   [24..40] reserved[4]
  //   [40] header_version
  //   [44] cmdline[1536]
  const headerVersion = dv.getUint32(40, true);
  if (headerVersion < 3) {
    throw new Error(`boot.img header v${headerVersion} not supported (v3/v4 only).`);
  }
  const kernelSize = dv.getUint32(8, true);
  const ramdiskSize = dv.getUint32(12, true);
  const cmdline = new TextDecoder("ascii")
    .decode(buf.subarray(44, 44 + 1536))
    .replace(/\0+$/, "");
  let off = BOOT_PAGE; // header is padded to page 0
  const kernel = buf.subarray(off, off + kernelSize);
  off += pad(kernelSize, BOOT_PAGE);
  const ramdisk = ramdiskSize
    ? buf.subarray(off, off + ramdiskSize)
    : new Uint8Array(0);
  return { headerVersion, kernel, ramdisk, cmdline };
}

export type VendorBootParts = {
  headerVersion: number;
  pageSize: number;
  vendorRamdisk: Uint8Array;
  dtb: Uint8Array;
  bootconfig: Uint8Array;
  vendorCmdline: string;
};

export function parseVendorBootImage(buf: Uint8Array): VendorBootParts {
  if (readMagic(buf, 0, 8) !== VENDOR_MAGIC) {
    throw new Error("vendor_boot.img: missing VNDRBOOT magic");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // v3/v4 layout:
  //   [0]   magic[8]
  //   [8]   header_version
  //   [12]  page_size
  //   [16]  kernel_addr, [20] ramdisk_addr
  //   [24]  vendor_ramdisk_size
  //   [28]  cmdline[2048]
  //   [2076] tags_addr
  //   [2080] name[16]
  //   [2096] header_size
  //   [2100] dtb_size
  //   [2104] dtb_addr (u64)
  //   -- v4 adds: --
  //   [2112] vendor_ramdisk_table_size
  //   [2116] vendor_ramdisk_table_entry_num
  //   [2120] vendor_ramdisk_table_entry_size
  //   [2124] bootconfig_size
  const headerVersion = dv.getUint32(8, true);
  if (headerVersion < 3) {
    throw new Error(
      `vendor_boot.img header v${headerVersion} not supported (v3/v4 only).`,
    );
  }
  const pageSize = dv.getUint32(12, true);
  const vendorRamdiskSize = dv.getUint32(24, true);
  const vendorCmdline = new TextDecoder("ascii")
    .decode(buf.subarray(28, 28 + 2048))
    .replace(/\0+$/, "");
  const dtbSize = dv.getUint32(2100, true);
  const vendorRamdiskTableSize = headerVersion >= 4 ? dv.getUint32(2112, true) : 0;
  const bootconfigSize = headerVersion >= 4 ? dv.getUint32(2124, true) : 0;

  // Section order (each padded up to page_size):
  //   1. header
  //   2. vendor ramdisk
  //   3. dtb
  //   4. vendor_ramdisk_table (v4)
  //   5. bootconfig            (v4)
  let off = pad(2128, pageSize); // header ends at 2128 for v4; padded to page
  const vendorRamdisk = buf.subarray(off, off + vendorRamdiskSize);
  off += pad(vendorRamdiskSize, pageSize);
  const dtb = buf.subarray(off, off + dtbSize);
  off += pad(dtbSize, pageSize);
  off += pad(vendorRamdiskTableSize, pageSize); // skip
  const bootconfig = buf.subarray(off, off + bootconfigSize);
  return { headerVersion, pageSize, vendorRamdisk, dtb, bootconfig, vendorCmdline };
}

// Concatenate the vendor ramdisk with the boot.img generic ramdisk (if any).
// Both are gzipped cpio streams; the Linux initramfs loader accepts multiple
// concatenated cpio(.gz) archives, so this is the same trick Android's real
// bootloader uses.
export function combineRamdisks(
  vendor: Uint8Array,
  generic: Uint8Array,
): Uint8Array {
  if (!generic.length) return vendor;
  if (!vendor.length) return generic;
  const out = new Uint8Array(vendor.length + generic.length);
  out.set(vendor, 0);
  out.set(generic, vendor.length);
  return out;
}
