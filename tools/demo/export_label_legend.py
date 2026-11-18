"""Export tiny per-view legend metadata from the shipped lossless label tracks."""
import argparse
import json
from pathlib import Path
import runpy

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--labels', type=Path, required=True, help='Native sonobridge_core/data/labels.py')
args = parser.parse_args()
native = runpy.run_path(str(args.labels))
palette = native['PALETTE']
names = native['LABEL_NAMES']
rgb_key = lambda rgb: int(rgb[0]) << 16 | int(rgb[1]) << 8 | int(rgb[2])
color_ids = {rgb_key(rgb): i for i, rgb in enumerate(palette)}
records = {}
for organ in ('liver', 'kidney'):
    folder = ROOT / 'static/demo' / organ
    manifest = json.loads((folder / 'manifest-v4.json').read_text())
    masks = [0] * len(manifest['poses'])
    rotations = len(manifest['rotations'])
    size = manifest['tile_size']
    for j in range(rotations):
        pixels = np.asarray(Image.open(folder / manifest['tracks'] / f'label-r{j:02d}.webp').convert('RGB'), dtype=np.uint32)
        encoded = pixels[:, :, 0] << 16 | pixels[:, :, 1] << 8 | pixels[:, :, 2]
        for i in range(len(manifest['positions'])):
            colors = np.unique(encoded[:, i * size:(i + 1) * size])
            unknown = set(map(int, colors)) - color_ids.keys()
            assert not unknown, f'{organ}, view {i * rotations + j}: unknown palette colors {unknown}'
            # Black includes pixels outside the fan and is not an organ label.
            masks[i * rotations + j] = sum(1 << color_ids[int(color)] for color in colors if color)
    records[organ] = masks

labels = [[i, name, '#%02x%02x%02x' % tuple(palette[i])] for i, name in enumerate(names) if i]
target = ROOT / 'static/js/label-legend.js'
target.write_text('// Generated from native label semantics and the shipped lossless label tracks.\n'
                  '// Regenerate with tools/demo/export_label_legend.py --labels <native labels.py>.\n'
                  'export const labelPalette=' + json.dumps(labels, separators=(',', ':')) + ';\n'
                  'export const labelPoseMasks=' + json.dumps(records, separators=(',', ':')) + ';\n')
print(f'{target.name}: {sum(map(len, records.values()))} views, {target.stat().st_size} bytes')
