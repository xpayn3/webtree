# WebGPU Tree — Session Notes

Procedural tree generator in the browser. WebGPU + Three.js r184, no build step, vanilla JS.
Folder: `C:\Users\Luka\Downloads\webgpu-tree\`

---

## Run

```
python -m http.server 8090
```
Open `http://localhost:8090`. Needs Chrome/Edge (WebGPU).

---

## File structure

```
webgpu-tree/
  index.html        # layout, importmap pinned to three@0.184.0 (incl. three/tsl)
  main.js           # everything (~12,100 lines)
  style.css         # Apple-style dark UI (~4,300 lines)
  tree-worker.js    # off-main-thread tube geometry (~640 lines)
  sky.hdr           # HDRI for env map; optionally shown as background
  tex/
    leaf.png        # broadleaf maple — RGBA (albedo+alpha)
    leaf_b.png      # variant
    leaf_normal.jpg
    bark.jpg
    bark_normal.jpg
```

---

## Architecture (main.js top to bottom)

1. **Renderer / camera / controls** — `WebGPURenderer` mounted in `#canvas-wrap`. OrbitControls with MMB-pan (Blender-style).
2. **Click-and-drag branch grab** — RMB grabs the nearest skeleton node (screen-space pick), then drags it through a view-aligned plane. Halo cursor visualizes the pick.
3. **Studio environment** — `THEMES` (light/dark) with bg / grid / wire colors / light intensities. `applyTheme(name)` swaps live. PMREMGenerator from `RoomEnvironment` as instant fallback while `sky.hdr` loads.
4. **Post-processing** — TSL `RenderPipeline`. Bloom always on (`uBloomScale` controls intensity). Optional SSAO via MRT (color + normal pass), optional DOF. `updatePostPipeline()` rebuilds the output node when toggles change.
5. **Tree worker** — `tree-worker.js` builds tube geometries off-main-thread; main thread wraps returned typed arrays into `BufferGeometry`. Falls back to sync `tubeFromChain` on worker failure.
6. **3-point lighting** — key/fill/rim + ambient. `LIGHTING_PRESETS`: Studio / Golden Hour / Overcast / Moonlight / Noon / Dramatic / Sunset.
7. **Settings appliers** — exposure, tone mapping (`TONE_MAPPINGS`: None/Linear/Reinhard/Cineon/ACES Filmic/AgX/Neutral), pixel ratio, shadow on/off + quality (Low 1024 / Med 2048 / High 4096), bloom, fog, env intensity, axes helper. Heavy ones debounced 220ms.
8. **Cyclorama backdrop** — floor → quarter-circle sweep (`sweepRadius: 10`) → wall, single mesh, world-aligned UVs (1m/cell, `TILE_METERS = 40`).
9. **Soft contact shadow** — radial canvas-texture disc beneath the tree (in addition to real shadow maps from the key light).
10. **Textures + materials** — bark uses `MeshStandardNodeMaterial`; leaves + needles use `MeshPhysicalNodeMaterial` (Node variants so TSL wind displacement applies). Stems are a tiny shared cylinder.
11. **Wind (TSL)** — `uWindEnable`, `uWindStrength`, `uWindFreq`, `uWindScale`, `uWindDirX/Z`, `uWindGust`. `barkWindDisp` / `leafWindDisp` displace `positionLocal` via `time` + `instanceIndex`.
12. **Seeded RNG** — `mulberry32`. Re-seeded in `generateTree()` from `P.seed`.
13. **Schemas** — `PARAM_SCHEMA` (global, with per-group `treeType` filtering), `LEVEL_SCHEMA` (per-level), `WIND_SCHEMA`, `PHYSICS_SCHEMA`, `CONIFER_SCHEMA`, `BUSH_SCHEMA`. Per-param `live: true` updates without a full rebuild.
14. **Species presets** — `SPECIES`: Oak / Pine / Willow / Birch / Palm (+ more), broadleaf / conifer / bush types.
15. **Tree build** — `buildTree()`:
    - Trunk walk (separate from level walks), multi-trunk split by `trunkCount`/`trunkSplitSpread`
    - `walkInternode` per level — kink subdivisions, distortion (random/sine/perlin/twist), curvature (sCurve/backCurve/helical), tropism with susceptibility, torsion, twist, stochastic skip, signal decay
    - `spawnChildrenAlong` — phyllotaxis (spiral/opposite/whorled/decussate), apical dominance
    - Pruning envelope (ellipsoid)
    - Allometric radii (r_parent^e = Σ r_child^e)
    - Root flare + trunk thickness scale
16. **Chains + tubes** — `buildChains()` collapses each fork-to-fork run into one chain; `tubeFromChain()` (or worker) builds a tapered TubeGeometry with circular profile multiplier from `ProfileEditor` and per-chain length lerp from the radius spline. Per-vertex `nodeA/nodeB/nodeW` skeleton mapping is computed for the sim. Final pass: `mergeGeometries` → one bark draw call.
17. **PBD skeleton sim** — `stepSim(dt, t)`. Each node = particle with mass ∝ r²; constraints are (1) rigid edge length, (2) elastic bend toward parent rest target with rotation propagation (`rotMix = 0.65`), plus a rest-pose anchor that engages when not grabbing. Iteration count adapts (22 during grab, 10 with wind on, 6 idle).
18. **Bark deform** — `updateBark()` interpolates each bark vertex between its two skeleton nodes' world offsets (cantilever-correct). Static-edge epsilon skips immobile vertices.
19. **Leaves** — broadleaf: `InstancedMesh` (2 variants A/B) + tiny stem cylinders, scattered along chain tips. Quaternion composition: `Ry(yaw) * Rx(-π/2)` for the droop rest pose. Cluster size/spread, tilt, color variance.
20. **Needles (conifer)** — narrow plane `InstancedMesh` with procedural canvas texture (`makeNeedleTexture`); cones hang from tips via shared `coneInst`.
21. **Falling leaves** — separate InstancedMesh pool (`MAX_FALLING = 400`, ring-buffer recycled). Free-fall physics → slerp toward rest quaternion on touchdown, fade out.
22. **Undo / Redo** — `undoStack`/`redoStack` (`MAX_HISTORY = 50`). Snapshots `P` + the three spline editors as JSON. Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y).
23. **UI** —
    - Sidebar: schema-driven, collapsible groups, resizable. Horizontal drag-scrubbers (absolute positioning, click-to-jump, 6px intent threshold, `touch-action: pan-y`). Continuous float step internally; display rounds to schema step. Right-click on a scrubber opens a context menu (reset / copy / paste).
    - `SplineEditor` (Catmull-Rom): Radius Curve, Length Curve.
    - `ProfileEditor` (circular closed Catmull-Rom): Trunk Profile.
    - Levels dynamically rendered via `renderLevels()` (add/remove). Apple-style section labels.
    - Live preview while scrubbing: `beginScrub`/`endScrub` halt shadow-map updates and halve tube longitudinal+radial detail. Final-quality rebuild fires on drag end.
    - Saved presets in `localStorage` (`webgpu-tree:presets`) with PNG thumbnails.
24. **Toolbar** (left strip in canvas-wrap): theme / wireframe / spline view / leaves toggle / physics toggle / upload PNG / export JSON / screenshot / OBJ-or-glTF mesh export / regenerate.
25. **Camera presets** — `#cam-presets` floating column: top / left / home / right / back / front (animated reframe).
26. **Spotlight command palette** — Ctrl+K opens `#spotlight`; fuzzy search across commands, sliders, species. Enter focuses a slider or runs the command.
27. **Other UI** — toast notifications, shortcut pill flash, tooltip system with shortcut chips, scale ruler overlay (person silhouette + meters), pause state, tree info panel (height in m), stats panel.

---

## Features implemented

### Tree generation
- L-system-inspired recursive parametric grower, broadleaf / conifer / bush types
- Per-level: children, lenRatio, angle + variance, rollVar, phyllotaxis, startPlacement/endPlacement, apicalDominance, kinkSteps, distortion + type + freq, curvature mode + amount, phototropism, gravitropism, susceptibility, torsion, twist, stochastic skip, signalDecay
- Trunk: height, subdivisions, jitter, count, split spread, twist
- Radius: tipRadius, trunkScale, alloExp, rootFlare
- Bark: hue, tint, roughness, normal strength, UV scale (U/V independently)
- Global: minLen, growthPhase (animated baby→full), rotation
- Pruning: off / ellipsoid with radius + height + center Y
- Splines: Radius Curve, Length Curve, Trunk Profile (circular cross-section)
- Multi-trunk (1–5) with split spread

### Leaves (broadleaf)
- Structural: leavesPerTip, leafChainSteps, leavesStart, leafSize + variance, leafSpread, leafDroop, season (0=spring → 1=winter bare), fallenMax, fallenFade
- Material (live): roughness, transmission, thickness, IOR, normal strength, hue shift, clearcoat + roughness, sheen
- Detail: color variance, tilt, stem length, cluster size + spread
- Upload custom PNG (sidebar + toolbar) — replaces both variants, alphaTest preserved

### Conifer
- Whorl-based crown with branch count, angle, start, taper, droop, length
- Twigs per branch with own length + angle
- Procedural needle texture; needle length, width, density, chain, facing (droopy ↔ radiating), droop
- Hanging cones with count, size, hang distance

### Bush
- Height, spread, primary stems, branchiness, twig length, compactness
- Bush-specific leaf size, density, spread, droop

### Wind (TSL vertex displacement)
- Strength, frequency, scale, direction, gust
- Bark + leaf displacement nodes; toggle via `uWindEnable`

### Physics (PBD skeleton sim)
- Stiffness, damping, wind response, mass
- Branch grab (RMB drag): pick radius, sensitivity, max pull, bend spread (ancestors soften, descendants stiffen)
- Adaptive solver iteration count (idle/wind/grab)
- Rest-pose anchor scaled by `bendStiff²` so thick branches snap back hard, tips return via bending alone

### Scene
- Cyclorama L-shape with smooth quarter-circle sweep
- Unity-style 1m grid texture, theme-aware
- HDRI environment + optional sky background
- 3-point lighting with 7 presets (Studio, Golden Hour, Overcast, Moonlight, Noon, Dramatic, Sunset)
- Real cast shadows + soft radial contact shadow
- Tone mapping: None/Linear/Reinhard/Cineon/ACES Filmic/AgX/Neutral
- Bloom (always-on at variable intensity), optional SSAO, optional DOF
- Pixel ratio, shadow quality, fog, env intensity, axes helper

### UX
- Floating left toolbar
- Sidebar with Apple-style section labels, resize handle, collapsible groups
- Dark + light themes, live swap
- Shaded + wireframe overlay (wire-on-solid à la Blender / Cinema 4D)
- Spline-only debug view (`tb-spline`)
- Spotlight command palette (Ctrl+K)
- Camera presets (top/left/right/front/back/home, animated)
- Pause toggle (right-click canvas menu)
- Undo / Redo (Ctrl+Z / Ctrl+Shift+Z, 50-deep)
- Toast notifications + shortcut pill + tooltip chips
- Live preview mode while dragging sliders (halved detail, no shadow updates)
- Saved preset library (localStorage with thumbnails)
- Preset JSON export to clipboard
- Screenshot PNG export
- Mesh export: OBJ / STL / GLTF
- LOD preview via `SimplifyModifier`
- Tree info (height in m), stats panel, scale ruler overlay

### Controls
- LMB orbit, MMB pan, RMB drag-to-grab-branch (or context menu on click), wheel zoom (DCC convention)
- Ctrl+K command palette, Ctrl+Z / Ctrl+Shift+Z undo/redo

---

## What's left

### Pending
1. **Force/attractor nodes** — the `P.attractors` array exists but needs the 3D-gizmo UI to place + move them in world space.
2. **Grow-by-age** — dead-twig layer, apical decay. Major refactor on top of `growthPhase`.
3. **Density maps on trunk** — paint where Level 1 children attach. Needs an extra spline or paintable UI.
4. **Branch decorations** — moss / lichen / fruit as InstancedMesh along branch paths.

---

## Patterns / gotchas to remember

- **Schema-first new controls.** Don't hand-write DOM for a new slider. Add a schema entry and the sidebar, scrubber, undo, and command-palette pick it up automatically.
- **Live vs rebuild params.** A schema entry with `live: true` runs an `onAfter` callback (material tweak, uniform write) without regenerating the tree. Anything affecting topology must omit `live` and go through `debouncedGenerate()`.
- **Foliage-only rebuild.** Leaf / needle / cone params route through `rebuildLeavesOnly()` which reuses the cached tree nodes (`_cachedTreeNodes`, `_cachedTips`) — saves ~70ms vs full regen.
- **Scrub mode degrades quality intentionally.** `tubeFromChain` reads `isScrubbing` and halves both `tubular` and `radial` segments; `endScrub` triggers a final full-quality rebuild. Don't "fix" the lower detail mid-drag.
- **Worker fallback.** `buildTubesViaWorker` resolves to `null` if the worker isn't ready; the caller must fall back to sync `tubeFromChain`. Don't assume the worker is always live.
- **Euler order for leaves.** Plane leaf's flat-on-ground rest uses `Ry(yaw) * Rx(-π/2)` composed via `Quaternion.multiply`, NOT `new Euler(-π/2, yaw, 0, 'XYZ')` — the latter applies Y to a still-vertical plane.
- **Scrubber UX.** Cursor-X maps to value 1:1 (no fixed PX_PER_STEP). 6px intent threshold before committing drag so vertical sidebar scroll works. `touch-action: pan-y`, not `none`. `preventDefault` only when actually dragging.
- **PBD bend during grab.** Ancestors of the grabbed node (`grabChainMask`) get *softer* (bend spread) so the chain curves smoothly; everything else gets *stiffer* (×1.8) so descendants follow rigidly like a fishing rod tip. Iterations bumped to 22.
- **Rest-pose anchor only when not grabbing.** Otherwise the anchor fights the cursor.
- **Theme swap touches three things:** cyclorama grid texture (regenerated from colors and disposed), tree wire material color, key + ambient light intensities. `applySkyBackground` overrides `scene.background` if HDRI is on.
- **Texture disposal.** `floorMaterial.map.dispose()` before reassigning, but only if it's not one of the original `leafMapA/B` references (for leaf upload/reset).
- **`renderer.setSize` uses `canvasWrap.clientWidth/Height`**, not `window`. Resize handler mirrors this.
- **`refreshCoreMaterials()`** explicitly lists the materials needing `.needsUpdate = true` after tone-map / shadow toggles. Cheaper than `scene.traverse`.
- **Undo snapshots** include `P` (sans `wind` array nuances), all three spline editors' points; `restoreStateJSON` calls `syncUI()`, `renderLevels()`, `applyLeafMaterial()`, `applyBarkMaterial()`, `generateTree()`. Set `isRestoring = true` to prevent the restore from creating a new history entry.

---

## User preferences

- Terse updates, no verbose narration
- Dark mode default; Apple-style UI aesthetic
- WebGPU-only, no WebGL fallback
- DCC controls: LMB orbit, MMB pan, RMB drag-grab, wheel zoom
- Leaves must lie flat on ground, no visible snapping
- Scrubbers follow cursor 1:1, never inverted, drag-right increases
- New controls go through schemas, not hand-written DOM
- Commit/push without asking when intent is clear; don't auto-deploy

---

## To continue next session

1. Read this file (and verify against `main.js` — assume drift).
2. `cd /c/Users/Luka/Downloads/webgpu-tree && python -m http.server 8090`.
3. Pick from "What's left". Attractor gizmo UI is the most natural next step — the data path already exists.
