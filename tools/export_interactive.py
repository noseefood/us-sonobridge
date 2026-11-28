"""Assets for the two interactive figures of the project page (run with the common_us environment).

  ~/miniconda3/envs/common_us/bin/python tools/export_interactive.py [bridge] [compare]

bridge  -> static/interactive/bridge/: the record of paper Fig. 1 (validation index 7110, seed 1) refined step by
           step by SonoBridge and by the UNSB baseline of Table III (no anatomical guidance): frames 0..5 = simulated image, states 1..4,
           output. Same models and sampling as figure/scripts/export_bridge_assets.py (the paper's Fig. 1 assets);
           the script checks that the SonoBridge states reproduce figure/assets/c4_state*.png. Overlays: liver
           boundary and visible fine structure from the source labels, and the boundary of the modeled shadow.
compare -> static/interactive/compare/<view>/: the five views of paper Fig. 5 from figure/assets/fig10_liver and
           figure/assets/fig11_kidney (all eight methods, the simulated input, CT, labels, real reference), resized
           to the native acquisition aspect, plus a label-contour overlay.
Writes static/interactive/manifest.json.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
PAPER = ROOT.parent / "6a899f637b1e6ec99e80b42c"
FIG = PAPER / "figure"
OUT = ROOT / "static/interactive"
VIOLET_L, VIOLET_D, BLUE = (207, 200, 244), (142, 128, 230), (77, 146, 206)


def webp(img, path, quality=90):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="WEBP", quality=quality, method=6)


def contour(mask, width=2):
    edge = mask ^ ndimage.binary_erosion(mask, iterations=1)
    return ndimage.binary_dilation(edge, iterations=width - 1) if width > 1 else edge


def overlay_png(layers, size, path):
    """layers: list of (mask_bool_at_size, rgb, alpha)"""
    w, h = size
    arr = np.zeros((h, w, 4), np.uint8)
    for m, rgb, a in layers:
        arr[m, :3] = rgb
        arr[m, 3] = int(a * 255)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr, "RGBA").save(path, optimize=True)


def resize_mask(m, size):
    return np.array(Image.fromarray(m.astype(np.uint8) * 255).resize(size, Image.NEAREST)) > 127


# ----------------------------------------------------------------------------------------------------- bridge
def bridge():
    sys.path.insert(0, str(FIG / "scripts"))
    import export_bridge_assets as eba
    import export_concept_variant as ecv

    meta = json.loads((FIG / "assets/c4_meta.json").read_text())
    # UNSB: the paper's liver baseline (Table III, 480k); the checkpoint used for Fig. 1's UNSB tile is not kept
    eba.RUN_UNSB = "Outputs/from 21.10.26/comparision_liver/unsb_liver_baseline_ver2/checkpoints/checkpoint_step_480000.pt"
    env = eba.Env()
    torch = env.torch
    s = env.dataset[meta["idx"]]
    seed = meta["seed"]
    out_sb, states, _, _, _ = env.run_sb(s, seed=seed, keep_path=True)
    # the published Fig. 1 tiles must be reproduced exactly
    for k in (1, 2, 3, 4):
        ref = np.array(Image.open(FIG / f"assets/c4_state{k}.png"))
        tmp = OUT / "_check.png"
        eba.gray_tile(env, tmp, states[k])
        assert np.array_equal(np.array(Image.open(tmp)), ref), f"state {k} differs from c4_state{k}.png"
        tmp.unlink()
    # UNSB path, same schedule and seed as Env.run_unsb / infer.sample_unsb
    model, _, _ = env.model("unsb")
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    x0 = env.unsb.to_unsb_domain(s["image"][None].to(env.device))
    times = env.unsb.unsb_time_schedule(5, x0.device, x0.dtype)
    x_t, x_next, ustates = x0, x0, []
    with torch.no_grad():
        for idx in range(5):
            if idx > 0:
                delta = times[idx] - times[idx - 1]
                denom = (times[-1] - times[idx - 1]).clamp_min(1e-8)
                inter = (delta / denom).view(1, 1, 1, 1)
                scale = (delta * (1.0 - delta / denom)).clamp_min(0.0).view(1, 1, 1, 1)
                x_t = (1.0 - inter) * x_t + inter * x_next + torch.sqrt(scale * 0.01) * torch.randn_like(x_t)
            ustates.append(x_t)
            x_next = model(x_t, torch.full((1,), idx, device=x0.device, dtype=torch.long))
    f = lambda t: env.unsb.from_unsb_domain(t.clamp(-1, 1)).clamp(0, 1)[0, 0].cpu().numpy()
    out_unsb = f(x_next)
    ref = env.run_unsb(s, seed=seed)
    assert np.abs(ref - out_unsb).max() < 1e-5, "UNSB path does not reproduce Env.run_unsb"
    sim = s["image"].squeeze().numpy()
    shown0 = ecv.ramp(sim)                                         # display ramp of the paper's simulated tile
    alpha = eba.sector_alpha(env)
    W, H = eba.OUT_W, eba.OUT_H

    def tile(img256):
        g = np.clip(eba.up(img256), 0, 1)
        rgb = (np.repeat(g[..., None], 3, 2) * 255 + .5).astype(np.uint8)
        rgb = (rgb * alpha[..., None]).astype(np.uint8)            # outside the sector: black
        return Image.fromarray(rgb, "RGB")

    frames = {"sb": [shown0] + [states[k] for k in (1, 2, 3, 4)] + [out_sb],
              "unsb": [shown0] + [f(ustates[k]) for k in (1, 2, 3, 4)] + [out_unsb]}
    for key, fr in frames.items():
        for k, img in enumerate(fr):
            webp(tile(img), OUT / f"bridge/{key}-{k}.webp")
    sh = env.sm.compute_shadow_masks(s["image"][None].to(env.device), s["labelmap"][None].to(env.device),
                                     config=env.shadow_cfg)
    vis = sh["visible"][0, 0].cpu().numpy()
    sec = sh["valid_sector"][0, 0].cpu().numpy()
    lab = s["labelmap"].squeeze().numpy()
    ves = s["visible_vessel_support"].squeeze().numpy()
    sec_hi = alpha > .5
    inner = ndimage.binary_erosion(sec_hi, iterations=8)
    liver = (eba.up(np.isin(lab, [4, 6]).astype(np.float32), nearest=True) > .5) & sec_hi
    vessel = (eba.up(ves, nearest=True) > .5) & sec_hi
    shadow = (eba.up((1 - vis) * sec) > .5) & sec_hi
    overlay_png([(contour(liver, 2) & inner, VIOLET_L, 1.0), (contour(vessel, 2), VIOLET_D, 1.0)], (W, H),
                OUT / "bridge/labels.png")
    overlay_png([(contour(shadow, 3) & inner, BLUE, .95)], (W, H), OUT / "bridge/shadow.png")
    stats = {}
    liver256 = np.isin(lab, [4, 6]) * sec
    neg = liver256 * vis * (1 - ves)
    m = lambda x, w: float((x * w).sum() / max(w.sum(), 1))
    for key, fr in frames.items():
        stats[key] = [round(m(x, neg) - m(x, ves), 4) for x in fr]
    return {"record": {k: meta[k] for k in ("idx", "split", "case", "base", "variant", "seed")},
            "unsb_checkpoint": eba.RUN_UNSB,
            "size": [W, H], "frames": 6, "vessel_contrast": stats}


# ---------------------------------------------------------------------------------------------------- compare
METHODS = [("12_sonobridge_{mhz}", "SonoBridge"), ("05_cyclegan", "CycleGAN"), ("06_cut", "CUT"), ("07_unsb", "UNSB"),
           ("08_syndiff", "SynDiff"), ("09_stegogan", "StegoGAN"), ("10_santa", "SANTA"), ("11_sasan", "SASAN")]
VIEWS = [("liver", "fig10_liver", "00039_clear_acoustic_window", "Liver · clear acoustic window", "3_4MHz"),
         ("liver", "fig10_liver", "00039_modeled_shadow", "Liver · modeled shadow", "3_4MHz"),
         ("liver", "fig10_liver", "00030_challenging_case", "Liver · challenging structure", "3_4MHz"),
         ("kidney", "fig11_kidney", "00098_clear_acoustic_window", "Kidney · clear acoustic window", "3_0MHz"),
         ("kidney", "fig11_kidney", "00030_modeled_shadow", "Kidney · modeled shadow", "3_0MHz")]
SIZE = {"liver": (480, 400), "kidney": (522, 393)}   # native acquisition aspect (w, h)
PAL = {"well": (242, 246, 250), "organ": (213, 219, 226), "tissue": (228, 232, 237), "violetL": VIOLET_L,
       "violetD": (91, 75, 183), "inkM": (60, 72, 85)}


def gray_img(path, size, gamma=1.0, fill=None):
    a = np.array(Image.open(path).convert("L"), np.float32) / 255
    if fill is not None:
        a = np.where(fill, 0, a)
    a = a ** gamma
    return Image.fromarray((a * 255 + .5).astype(np.uint8)).resize(size, Image.LANCZOS)


def compare():
    views = []
    for organ, folder, key, title, mhz in VIEWS:
        d = FIG / "assets" / folder / key
        size = SIZE[organ]
        out = OUT / "compare" / key
        lab = np.array(Image.open(d / "labelmap_ids.png"))
        ct = np.array(Image.open(d / "01_ct.png").convert("L"), np.float32) / 255
        sec = (np.array(Image.open(d / "sector.png")) > 127) if (d / "sector.png").exists() else \
            ndimage.binary_fill_holes(ndimage.binary_closing((ct > 0) | (lab > 0), iterations=2))
        fill = None
        if (d / "contact_fill.png").exists():
            sim_raw = np.array(Image.open(d / f"03_simus_{mhz}.png").convert("L"), np.float32) / 255
            fill = np.array(Image.open(d / "contact_fill.png")) > 127
            fill |= ndimage.binary_dilation(fill) & (sim_raw <= 22 / 255)
        if organ == "liver":
            fine = np.array(Image.open(d / "04_visible_vessel_support.png").convert("L")) > 127
            organ_m = np.isin(lab, [4, 6])
            fine = fine | (lab == 6)
        else:
            fine = np.array(Image.open(d / "04_medulla_support.png").convert("L")) > 127
            organ_m = lab == 2
            fine = fine & organ_m
        items = []
        for fn, name in METHODS:
            p = d / (fn.format(mhz=mhz) + ".png")
            webp(gray_img(p, size), out / f"{name.lower()}.webp")
            items.append(name)
        webp(gray_img(d / f"03_simus_{mhz}.png", size, gamma=.5, fill=fill), out / "simulated.webp")
        webp(Image.fromarray((np.where(sec, ct, 1.0) * 255 + .5).astype(np.uint8)).resize(size, Image.LANCZOS),
             out / "ct.webp")
        lt = np.empty(lab.shape + (3,), np.uint8)
        lt[:] = 255
        lt[sec] = PAL["well"]
        lt[np.isin(lab, [1, 2, 3, 5, 7, 10, 11, 12, 15]) & sec] = PAL["organ"]
        lt[np.isin(lab, [8, 9, 13]) & sec] = PAL["tissue"]
        lt[organ_m & sec] = PAL["violetL"]
        lt[fine & sec] = PAL["violetD"]
        lt[(lab == 14) & sec] = PAL["inkM"]
        webp(Image.fromarray(lt).resize(size, Image.NEAREST), out / "labels.webp", quality=95)
        if (d / "invivo.png").exists():
            webp(Image.open(d / "invivo.png").convert("L").resize(size, Image.LANCZOS), out / "reference.webp")
        org_hi, fine_hi, sec_hi = (resize_mask(m, size) for m in (organ_m & sec, fine & sec, sec))
        inner = ndimage.binary_erosion(sec_hi, iterations=4)
        overlay_png([(contour(org_hi, 2) & inner, VIOLET_L, 1.0), (contour(fine_hi, 2) & inner, VIOLET_D, 1.0)],
                    size, out / "labels-overlay.png")
        views.append({"key": key, "organ": organ, "title": title, "size": list(size), "methods": items,
                      "reference": (d / "invivo.png").exists()})
    return views


if __name__ == "__main__":
    parts = sys.argv[1:] or ["bridge", "compare"]
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if "bridge" in parts:
        manifest["bridge"] = bridge()
    if "compare" in parts:
        manifest["compare"] = compare()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(json.dumps({k: (v if k != "compare" else [x["key"] for x in v]) for k, v in manifest.items()}, indent=1))
