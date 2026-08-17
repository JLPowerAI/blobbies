# OCR test fixtures

Two small binaries, committed because the tests they back are about *bytes*
and a generated stand-in would not be the same bytes.

- **`hello.png`** — the words "Hello Blobbies" rendered in Helvetica, exported
  with a transparent background. The transparency is the point: an RGBA image
  flattened the naive way (`into_rgb8`) becomes black-on-black and OCRs as
  nothing, which is exactly the bug this fixture caught.
- **`bomb.png`** — 380 KB that decode to 400 megapixels. It proves the pixel
  budget in `ocr.rs` is enforced from the header, before anything is decoded.

Regenerate `bomb.png` with:

```sh
python3 - <<'EOF'
import zlib, struct
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
W = H = 20000
co = zlib.compressobj(9)
row = b'\x00' * (W + 1)
idat = b''.join([co.compress(row) for _ in range(H)] + [co.flush()])
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 0, 0, 0, 0))
       + chunk(b'IDAT', idat)
       + chunk(b'IEND', b''))
open('bomb.png', 'wb').write(png)
EOF
```

A missing fixture fails its test loudly rather than skipping: these files are
committed, so absence means a broken checkout — and a test that passed without
them would hide OCR being broken outright.
