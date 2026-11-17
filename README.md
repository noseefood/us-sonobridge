# SonoBridge project page

A static project page with linked ultrasound and robotic acquisition views.
The existing paper title, authors and affiliations are preserved. Paper and
code links remain marked as coming soon. The project website is hosted at
[noseefood.github.io/us-sonobridge](https://noseefood.github.io/us-sonobridge/).

## Local preview

```bash
python3 tools/serve.py
```

Open **http://127.0.0.1:8780/#interactive**. The server binds only to the local
machine. No inference server or frontend build is needed to view the site.

## GitHub Pages

The site uses `https://noseefood.github.io/us-sonobridge/`. All runtime assets use relative
URLs, so both a repository subpath and a custom-domain root are supported.
The checked-in `.nojekyll` file disables Jekyll processing.

To publish the current repository:

1. Commit and push `index.html`, `.nojekyll`, and the complete `static/`
   directory, including the precomputed images, both anatomy assets and their
   `.glb.gz` files. The generated assets must be regular Git files, not LFS
   pointer files.
2. In **Settings → Pages**, choose **Deploy from a branch**, then **master**
   and **/(root)**. If the publishing branch is renamed, select that branch.

No Python server, Node build, Isaac Sim installation, model checkpoint or GPU
is needed on GitHub Pages. `tools/serve.py` is only a local preview server.
The browser decodes the explicitly requested `.glb.gz` geometry; ordinary JS,
CSS and JSON files also work without the preview server's gzip headers.
`refs/` and `node_modules/` stay excluded from Git.

The current static assets total approximately **258 MB** (largest file:
**2.16 MB**), below GitHub Pages' **1 GB** published-site limit. This is the
whole dataset: the browser loads images and the second organ only as needed.
See [GitHub's publishing-source guide](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
and [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

Local compatibility verification uses a plain static server mounted at
`/us-sonobridge/`, with no custom response headers. It covers initial Liver
loading, Kidney selection, robot and anatomy assets, CT/label comparisons,
guidance, and the appearance and pose controls.

## Interactive acquisitions

| | Liver | Kidney |
|---|---|---|
| Case | 00039 | **00098** |
| Frequency / depth | 3.4 MHz / 180 mm | 3.0 MHz / 160 mm |
| Scan positions | 17, −16 to +16 mm | 17, −12 to +12 mm |
| Axial rotations | 13, −18 to +18° | 13, −12 to +12° |
| Native checkpoint | liver 480k | kidney debug 240k |
| Acquisition | Supine | Posterior, prone |

Each organ has 221 contact-validated poses and 25 native pipeline outputs per
pose: five shadow offsets (−40, −20, 0, +20, +40%) and five fine-structure
strengths (0, .25, .5, .75, 1). Initial settings use a selected reference pose,
default shadow and strength 1. Kidney starts at record 014 to show both shadow
and medulla variation. In views without an adjustable native shadow region,
the shadow slider is inactive until the probe moves to a suitable view.
The native kidney demo's existing
`local_outward_tissue_transport_v2` output refinement is included.

The page opens on **Liver**. The illustrative patient is supine for liver and
prone (back facing up, face down) for kidney, matching each native acquisition.

Controls include organ selection, scan position, probe rotation, shadow area,
fine-structure strength, optional guidance, Label map / CT comparisons,
auto scan, reset, orbit, zoom and an expanded viewer. The robot stays visible.
The default camera fits the full mechanical arm, probe and anatomy closely,
with separate liver and kidney viewing directions. The bed is cropped to a
local support surface and uses a quieter color in this view. **Full setup**
frames the bed and support; **Focus scan** returns to the acquisition view.
Switching organs or resetting the camera also restores the close scan view. The transparent patient outline is a generic spatial aid,
aligned to each CT abdomen, not a patient reconstruction. Bed width, mattress
height and robot pedestal placement follow the native demo; bed length is
extended to accommodate the illustrative whole-body outline.

Ultrasound is precomputed, with a short crossfade between sampled records.
The scene uses the original FR3 CAD, probe assembly and native URDF kinematics.
The browser does not run simulation or neural inference. Both image display
and 3D fan use each acquisition's actual sector geometry and physical aspect
ratio, rather than a square ultrasound display.

## Loading

The default output loads independently of the 3D scene. CT, labels and guidance
load only when selected. Nearby states prefetch one at a time after the scene
is ready; new interactions cancel obsolete requests. The shared decoded image
cache is limited to 64 small images (16 MiB), with 16 guidance overlays (4 MiB).

The two organs share one robot asset. Geometry uses Meshopt packing and explicit
gzip assets, decoded with `DecompressionStream` (uncompressed fallback included):

- Shared robot: **443 KB** transferred.
- Liver anatomy: **1.95 MB** transferred.
- Kidney anatomy: **717 KB** transferred, only on the first kidney selection.

Cached geometry is reused when switching back. Text assets have precompressed
sidecars served by `tools/serve.py`; a production host can provide equivalent
HTTP compression. Three.js, meshoptimizer and Inter are local, with their
licenses included. There are no external runtime dependencies or analytics.

Two cold-load measurements at 8 Mbps shared throughput and 80 ms request
latency gave 0.53–0.54 s to usable image controls, 1.97–2.01 s to the robot,
and 4.04–4.08 s to the complete scene. The previous version took 4.95 s for
the complete scene under the same conditions. These are local development
measurements, not hosting guarantees; records are in
`refs/demo-build/loading_benchmark_v4.json`.

## Provenance and regeneration

Source data and native pipelines are read from:

```
/home/xuesong-li/Research_IFL/CT-MRI2US/SonoGym
```

All native data, models, simulation meshes and SonoGym scripts remain read-only.
Derived preparation files and QA reports are in the git-ignored
`refs/demo-build/` directory. The robot CAD comes from the existing v09 Blender
scene. CT surfaces use closed crop boundaries and display smoothing; these
approximations do not change the data used for image synthesis.

Scripts in `tools/demo/` reference the existing local environments:
`common_us` for inference and `env_isaaclab` for native ray-based simulation.
Use the installed Blender binary for GLB export.

Liver regeneration follows `select_candidates.py`, `prepare_grid.py`,
`simulate.py grid`, `export_images.py`, `align_robot.py`, `prepare_surfaces.py`,
`polish_surfaces.py`, `export_scene.py -- --polished`, then `split_images.py`.
The selected liver view is candidate 11 of case 00039.

Kidney regeneration:

1. `prepare_kidney_98.py`: build a website-local posterior patient cache from
   case 00098 CT, labels and the existing MONAI medulla prediction (class 2).
2. `kidney_assets.py select`, `kidney_simulate.py selection`, and
   `kidney_assets.py preview`: inspect candidate views. Candidate 6 is selected.
3. `kidney_assets.py grid 6`: sample contact-validated views and solve a
   continuous reachable robot posture branch.
4. `kidney_simulate.py grid`, then `kidney_assets.py export`: generate all native
   appearance settings and verify lossless image export.
5. `kidney_surfaces.py`, then Blender `--python export_kidney_scene.py`:
   create the aligned kidney anatomy asset.

Finally, run `npm ci --prefix tools/demo` if needed, then
`npm run build --prefix tools/demo` to package shared geometry and runtime.
This is asset preparation; the static site runs without a build server.

## Validation

```bash
node tools/demo/validate.mjs
```

Checks all 442 poses, contact fractions, calibrated browser FK, smooth adjacent
joint configurations, robot links, anatomy nodes, image presence, each organ's
physical image aspect, and byte-identical gzip decompression. Image export
also verifies lossless pixels against the native pipeline output.

The browser review covers both organs, parameter endpoints and combinations,
guidance, CT/label comparisons, fast organ switching, reset, auto scan,
patient outline, camera framing, expanded view and mobile layout.
