"""Export the manuscript figures used on the project page as WebP (run after the paper figures change).

  python3 tools/export_paper_figures.py [path/to/paper]

Each PDF in <paper>/figure/ is rasterized with pdftoppm at the listed widths and saved under static/images/.
The script prints the sha256[:12] of every written file for the ?v= cache keys in index.html.
"""
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PAPER = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "6a899f637b1e6ec99e80b42c"
OUT = ROOT / "static/images"
# paper figure -> (page file stem, widths); a single width writes <stem>.webp, several write <stem>-<width>.webp
FIGURES = {
    "fig_teaser": ("method-overview", [800, 1600]),               # Fig. 1
    "fig_datagen2": ("virtual-acquisition", [800, 1600]),              # Fig. 2
    "fig_method7": ("bridge-training", [800, 1440, 3200]),        # Fig. 3
    "fig_tsne_combined": ("tsne", [800, 1600]),                   # Fig. 4
    "fig10_comparison": ("liver-kidney-comparison", [1200, 2400]),  # Fig. 5
    "fig_correspondence": ("liver-correspondence", [800, 1600]),  # Fig. 6
    "fig13_ablation_comparison": ("liver-ablation", [1200, 2400]),  # Fig. 7
}


def main():
    with tempfile.TemporaryDirectory() as tmp:
        for fig, (stem, widths) in FIGURES.items():
            pdf = PAPER / "figure" / f"{fig}.pdf"
            png = Path(tmp) / f"{fig}.png"
            subprocess.run(["pdftoppm", "-png", "-singlefile", "-r", "600", str(pdf), str(png.with_suffix(""))],
                           check=True)
            master = Image.open(png).convert("RGB")
            for w in widths:
                name = f"{stem}.webp" if len(widths) == 1 else f"{stem}-{w}.webp"
                h = round(master.height * w / master.width)
                img = master.resize((w, h), Image.LANCZOS)
                img.save(OUT / name, format="WEBP", quality=92, method=6)
                digest = hashlib.sha256((OUT / name).read_bytes()).hexdigest()[:12]
                print(f"{name}\t{w}x{h}\t{digest}")


if __name__ == "__main__":
    main()
