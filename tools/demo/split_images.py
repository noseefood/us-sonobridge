"""Package exact atlas pixels as on-demand, lossless 256px images."""
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from PIL import Image, ImageChops
import json

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'static/demo/atlases'
if not SOURCE.exists():
    SOURCE = ROOT / 'refs/demo-build/atlases'
DEST = ROOT / 'static/demo/frames'

def export(path):
    atlas = Image.open(path).convert('RGB')
    folder = DEST / path.stem
    folder.mkdir(parents=True, exist_ok=True)
    tiles = [(f'us-{s}-{d}', d, s) for s in range(5) for d in range(5)]
    tiles += [('label', 1, 5), ('ct', 2, 5)]
    tiles += [(f'guidance-{s}', s, 6) for s in range(5)]
    sizes = {}
    for name, col, row in tiles:
        tile = atlas.crop((col*256, row*256, (col+1)*256, (row+1)*256))
        out = folder / f'{name}.webp'
        tile.save(out, lossless=True, method=4, exact=True)
        with Image.open(out) as restored:
            assert ImageChops.difference(tile, restored.convert('RGB')).getbbox() is None, out
        sizes[name] = out.stat().st_size
    return {'pose': path.stem, 'atlas_bytes': path.stat().st_size, 'sizes': sizes}

if __name__ == '__main__':
    with ProcessPoolExecutor(max_workers=6) as pool:
        records = list(pool.map(export, sorted(SOURCE.glob('*.webp'))))
    report = {'poses': len(records), 'images': sum(len(r['sizes']) for r in records),
              'pixel_comparison': 'all pixels identical to original atlases',
              'atlas_bytes': sum(r['atlas_bytes'] for r in records),
              'frame_bytes': sum(sum(r['sizes'].values()) for r in records),
              'default_output_bytes': next(r['sizes']['us-2-4'] for r in records if r['pose']=='110'),
              'records': records}
    (ROOT/'refs/demo-build/frame_packaging.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='records'}))
