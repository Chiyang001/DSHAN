"""Check packaged ARM64 ELF LOAD segments, RELRO safety and ZIP alignment.

Usage: python scripts/verify-apk-pages.py app/build/outputs/apk/debug/app-debug.apk
Uses only the Python standard library; does not modify the APK.
"""

import struct
import sys
import zipfile
from pathlib import Path

PAGE = 16384
REQUIRED = {"libnode.so", "libdshbridge.so", "libdshflock.so", "libdshpty.so"}


def check_elf(data):
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("expected little-endian ELF64")
    machine = struct.unpack_from("<H", data, 18)[0]
    if machine != 183:
        raise ValueError("expected AArch64")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phnum = struct.unpack_from("<HH", data, 54)
    if phsize < 56:
        raise ValueError("invalid program header size")
    headers = [struct.unpack_from("<IIQQQQQQ", data, phoff + i * phsize)
               for i in range(phnum)]
    loads = [h for h in headers if h[0] == 1]
    if not loads:
        raise ValueError("no LOAD segments")
    for _, _, offset, vaddr, _, _, _, align in loads:
        if align < PAGE or align & (align - 1) or (vaddr - offset) % PAGE:
            raise ValueError(f"LOAD incompatible with 16 KB pages (align=0x{align:x})")
    for h in headers:
        if h[0] != 0x6474E552:  # PT_GNU_RELRO
            continue
        end = h[3] + h[6]
        rounded_end = (end + PAGE - 1) // PAGE * PAGE
        # Rounding RELRO is safe if only unmapped padding follows. It must
        # never protect writable data from the same or a different LOAD.
        for load in loads:
            if load[1] & 2 and max(end, load[3]) < min(rounded_end, load[3] + load[6]):
                raise ValueError("RELRO rounding overlaps writable LOAD data")


def verify(apk):
    failures = []
    seen = set()
    with zipfile.ZipFile(apk) as archive, open(apk, "rb") as raw:
        for entry in archive.infolist():
            if not entry.filename.startswith("lib/") or not entry.filename.endswith(".so"):
                continue
            try:
                if not entry.filename.startswith("lib/arm64-v8a/"):
                    raise ValueError("unexpected ABI: the Node runtime is ARM64-only")
                check_elf(archive.read(entry))
                if entry.compress_type == zipfile.ZIP_STORED:
                    raw.seek(entry.header_offset)
                    header = raw.read(30)
                    name_size, extra_size = struct.unpack_from("<HH", header, 26)
                    data_offset = entry.header_offset + 30 + name_size + extra_size
                    if data_offset % PAGE:
                        raise ValueError("uncompressed library is not ZIP-aligned to 16 KB")
                seen.add(Path(entry.filename).name)
                print(f"PASS {entry.filename}")
            except (ValueError, struct.error, zipfile.BadZipFile) as error:
                failures.append(f"{entry.filename}: {error}")
        failures.extend(f"missing {name}" for name in sorted(REQUIRED - seen))
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    if failures:
        return 1
    print(f"PASS {len(seen)} libraries; ELF/RELRO/ZIP checks (not a device runtime test)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python scripts/verify-apk-pages.py <apk>")
    sys.exit(verify(sys.argv[1]))
