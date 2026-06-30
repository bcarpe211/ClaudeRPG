#!/usr/bin/env python3
# Crop a region of the world sheet with a 24px red grid overlay, upscaled, so
# tile (col,row) offsets can be read by eye. Usage:
#   python3 scripts/dev/crop-sheet.py <col0> <row0> <cols> <rows> <scale> <out.png>
import sys
from PIL import Image, ImageDraw
SHEET = "assets/oryx_16-bit_fantasy_1.1/oryx_16bit_fantasy_world_trans.png"
TILE = 24
col0, row0, cols, rows, scale = (int(a) for a in sys.argv[1:6])
out = sys.argv[6]
im = Image.open(SHEET).convert("RGBA")
box = (col0*TILE, row0*TILE, (col0+cols)*TILE, (row0+rows)*TILE)
c = im.crop(box).resize((cols*TILE*scale, rows*TILE*scale), Image.NEAREST)
bg = Image.new("RGBA", c.size, (40, 40, 40, 255)); bg.alpha_composite(c)
d = ImageDraw.Draw(bg)
for i in range(cols+1):
    d.line([(i*TILE*scale, 0), (i*TILE*scale, bg.height)], fill=(255, 0, 0, 160))
for j in range(rows+1):
    d.line([(0, j*TILE*scale), (bg.width, j*TILE*scale)], fill=(255, 0, 0, 160))
bg.convert("RGB").save(out)
print(f"wrote {out}: {cols}x{rows} tiles from sheet ({col0},{row0})")
