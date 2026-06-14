# Foundation-Model-Assisted Flood Mask Correction App

A single-page, zero-dependency browser tool for correcting AI-generated flood/change detection masks. Annotators load a foundation-model (FM) approximate mask and fix its errors — adding missed flood regions and removing wrongly predicted ones — then export the corrected binary mask.

All processing happens locally in the browser. No backend, no build step, no npm required.


---

## How to Run

```bash
# In the project directory:
python -m http.server

# Then open:
http://localhost:8000
```

VS Code users can also use the **Live Server** extension.

---


## Mask Convention

| Value | Meaning |
|-------|---------|
| **White / 255** | Flood or Change detected |
| **Black / 0** | No flood / No change / Background |

This convention is used everywhere: internal canvas, brush painting, exported masks.

---

## Required Inputs

| File | Description |
|------|-------------|
| **ON/FLOOD image** | Image captured during or after the flood event (base image for annotation) |
| **BEFORE image** | Image captured before the flood (used for visual comparison overlay) |
| **FM Approximate Mask** | Binary or grayscale mask from foundation model — thresholded at 128 and used as starting point |

Optional:
- **Existing Final Mask** — load a previously saved corrected mask to continue editing.

---

## Annotation Workflow

1. **Load ON/FLOOD image** — this is the main base image displayed on canvas.
2. **Load BEFORE image** — shown as optional opacity overlay for before/after comparison.
3. **Load FM Approx. Mask** — the AI prediction, thresholded to binary and used as the starting final mask.
4. A **red overlay** shows the current flood mask. An **orange overlay** shows the FM reference.
5. **Add Flood (A)** — paint areas the AI missed (paints white = flood pixels).
6. **Remove Flood (R)** — erase wrongly predicted areas (paints black = no-flood pixels).
7. Enable **Correction Diff** overlay to review what changed (green = added, blue = removed, yellow = unchanged).
8. Fill in **Sample Info** (Pair ID, annotator, quality status, notes).
9. **Export** the final corrected mask.

---

## Output Files

| File | Description |
|------|-------------|
| `{pair_id}_final_mask.png` | Binary PNG: white=flood, black=no-flood |
| `{pair_id}_correction_diff.png` | RGB visualization of corrections |
| `{pair_id}_preview.png` | Visual preview with overlays |
| `{pair_id}_metadata.json` | Full annotation metadata and pixel statistics |

### Correction Diff Color Encoding

| Color | Meaning |
|-------|---------|
| Green | Human added flood (AI missed it) |
| Blue | Human removed flood (AI was wrong) |
| Yellow | Unchanged flood (AI was correct, human kept it) |
| Black | No flood in either mask |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `A` | Add Flood tool |
| `R` | Remove Flood tool |
| `P` | Pan tool |
| `Z` | Undo |
| `Y` | Redo |
| `[` / `]` | Decrease / increase brush size by 2px |
| `=` or `+` | Zoom in |
| `-` | Zoom out |
| `0` | Fit image to screen |
| `F` | Toggle final mask overlay |
| `M` | Toggle FM reference overlay |
| `D` | Toggle correction diff overlay |
| `Space` (hold) | Temporary pan |
| `H` or `?` | Open help dialog |
| `Esc` | Close modals |
| Scroll wheel | Zoom centered on cursor |
| Middle click + drag | Pan |

---

## UI Features

- **Status bar** — shows sample ID, load status, current tool, brush size, and zoom level.
- **Collapsible sidebar sections** — click any section header to expand/collapse.
- **Drag-and-drop** — drop up to 3 image files; app auto-detects roles from filenames.
- **Auto-detected Pair ID** — extracted from numeric patterns in filenames (e.g. `0001`).
- **Autosave** — corrections are automatically saved to `localStorage` after each edit. On reload with the same Pair ID, you are prompted to restore.
- **Quality stats** — pixel counts for FM prediction, final mask, added, and removed pixels.
- **Warnings** — alerts for empty masks, >80% flood coverage, identical FM/final masks, missing Pair ID.
- **Dimension mismatch handling** — if mask and image sizes differ, offers nearest-neighbor resizing.

---

## Recommended Dataset Folder Structure

```
flood_dataset/
├── images/
│   ├── before/          # BEFORE images
│   └── on/              # ON/FLOOD images
├── masks/
│   ├── fm_initial/      # FM approximate masks (inputs)
│   ├── final/           # Final corrected masks (outputs)
│   └── correction_diff/ # Correction diff visualizations
├── metadata/            # JSON metadata files
└── previews/            # Preview images
```

---

## Metadata JSON Schema

```json
{
  "pair_id": "flood_0001",
  "before_image": "before_flood_0001.png",
  "on_image": "on_flood_0001.png",
  "foundation_mask": "fm_mask_flood_0001.png",
  "final_mask": "flood_0001_final_mask.png",
  "correction_diff": "flood_0001_correction_diff.png",
  "preview": "flood_0001_preview.png",
  "mask_convention": "255=flood_or_change, 0=no_flood_or_no_change",
  "annotator": "ann_01",
  "quality_status": "accepted",
  "created_at": "2026-06-10T12:00:00.000Z",
  "image_width": 512,
  "image_height": 512,
  "fm_changed_pixel_count": 12450,
  "final_changed_pixel_count": 13200,
  "added_pixel_count": 1100,
  "removed_pixel_count": 350,
  "unchanged_changed_pixel_count": 12100,
  "correction_pct": 0.56,
  "changed_area_pct": 5.03,
  "notes": "Manual review complete. Removed false positive near river bend."
}
```


---

## Technical Notes

- All mask canvases use `willReadFrequently: true` for efficient pixel access.
- Binary masks are enforced (thresholded to 0/255) after every brush stroke.
- Mask resizing uses nearest-neighbor interpolation (`imageSmoothingEnabled = false`) to preserve binary values.
- Undo/redo history is limited to 20 steps to control memory usage.
- Pointer events (`pointerdown/move/up`) support mouse, touch, and pen tablets.
- Display uses adjustable render scale (1×–3×) for sharp pixel display on HiDPI screens.

---

## Privacy

All processing is done locally in the browser. No data is sent to any server.
