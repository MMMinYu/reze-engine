"""Convert an OpenEXR equirectangular HDRI to Radiance .hdr (RGBE).

Blender Python uses internal OpenImageIO to load EXR, then we write the
Radiance format ourselves (it's simple: ASCII header + scanline-encoded RGBE).

Run:
  /Applications/Blender.app/Contents/MacOS/Blender \\
    --background --python scripts/exr_to_hdr.py -- input.exr output.hdr
"""

import bpy
import sys
import struct
import math

def load_exr_as_floats(path):
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = "Linear"
    w, h = img.size
    # img.pixels is flat RGBARGBA... in scanline order, bottom-to-top
    px = list(img.pixels)
    return w, h, px


def write_hdr(path, w, h, px_rgba_bottom_up):
    # Flip vertically so top-left is scanline 0 (Radiance convention: top-down)
    # Also strip alpha channel.
    rgb = bytearray()
    # Write header
    hdr = (
        "#?RADIANCE\n"
        "FORMAT=32-bit_rle_rgbe\n"
        "EXPOSURE=1.0000000000000\n"
        "\n"
        f"-Y {h} +X {w}\n"
    )
    with open(path, "wb") as f:
        f.write(hdr.encode("ascii"))
        # Encode per-scanline RGBE, top-down
        for y in range(h - 1, -1, -1):
            scanline_rgbe = bytearray(w * 4)
            for x in range(w):
                i = (y * w + x) * 4
                r, g, b = px_rgba_bottom_up[i], px_rgba_bottom_up[i + 1], px_rgba_bottom_up[i + 2]
                m = max(r, g, b)
                if m < 1e-32:
                    scanline_rgbe[x * 4 : x * 4 + 4] = b"\x00\x00\x00\x00"
                else:
                    m2, e = math.frexp(m)
                    scale = m2 * 256.0 / m
                    scanline_rgbe[x * 4 + 0] = max(0, min(255, int(r * scale)))
                    scanline_rgbe[x * 4 + 1] = max(0, min(255, int(g * scale)))
                    scanline_rgbe[x * 4 + 2] = max(0, min(255, int(b * scale)))
                    scanline_rgbe[x * 4 + 3] = max(0, min(255, e + 128))
            # Uncompressed (no RLE) — simpler, file stays ~small enough
            f.write(bytes(scanline_rgbe))


def main():
    argv = sys.argv
    dashdash = argv.index("--") if "--" in argv else -1
    args = argv[dashdash + 1 :] if dashdash >= 0 else []
    if len(args) < 2:
        print("usage: blender --background --python exr_to_hdr.py -- <in.exr> <out.hdr>")
        sys.exit(1)
    in_path, out_path = args[0], args[1]
    w, h, px = load_exr_as_floats(in_path)
    print(f"loaded {in_path}: {w}x{h}, {len(px)} floats")
    write_hdr(out_path, w, h, px)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
