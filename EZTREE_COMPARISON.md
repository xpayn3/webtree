# EZ-Tree vs WebGPU Tree — Architecture Comparison

Research date: 2026-04-24
Repo analysed: https://github.com/dgreenheck/ez-tree (cloned to `C:/Users/Luka/Downloads/_eztree_research`, package version `1.1.0`, MIT license)
- The `ez-tree-builder` and `three-procedural-tree` repos do not exist (only `ez-tree`).

---

## 1. What ezTree is

- **Repo**: `@dgreenheck/ez-tree` v1.1.0 — a single-author, actively-maintained Three.js procedural tree generator.
- **License**: MIT (`LICENSE:1`) — code can be freely copied into the user's project.
- **Status**: Published on npm, has a hosted demo at https://eztree.dev, used as the companion project for Daniel's "Three.js Roadmap" course.
- **Dependencies**: `three >= 0.167` is the only peer dependency. Zero runtime deps (`package.json:55-58`).
- **Scope**: Single class `Tree extends THREE.Group` (`src/lib/tree.js:10`). Generates one tree per instance, two output meshes (branchesMesh + leavesMesh) plus an optional Trellis. ~840 lines of generation code total.
- **Code size**: 1353 LOC across the entire library (`src/lib/*.js` total), vs ~18k LOC in our `main.js + tree-worker.js`.

---

## 2. ezTree architecture by pipeline stage

### 2.1 Branching algorithm — recursive BFS, **not** Catmull-Rom curves

- `Tree.generate()` seeds a `branchQueue` with a single root `Branch` (the trunk) at `tree.js:88-98`, then BFS-pops branches and calls `generateBranch(branch)` until empty (`tree.js:100-103`).
- `generateBranch` walks the branch one *section* at a time (`tree.js:130-233`). Each section is a ring of vertices placed at `sectionOrigin`, then `sectionOrigin` advances by `sectionLength` along the current Y axis, *rotated by the section's accumulated Euler orientation* (`tree.js:188-190`). There is no spline at all — the branch skeleton **is** the polyline of section origins, and the orientation Euler is the integrator's state.
- Random gnarliness perturbs the orientation between sections, scaled by `1 / sqrt(sectionRadius)` so thin twigs gnarl harder than the trunk (`tree.js:194-199`). This is a clever, dimensionally-correct biological cue.
- Growth force is implemented as a **rotation toward** the force direction, with strength `force.strength / sectionRadius` — thin branches bend more than thick ones (`tree.js:209-218`). Quaternion math via `setFromUnitVectors` + `rotateTowards` (no euler-angle gimbal hazards here).
- Twist is a per-level Y-axis rotation applied between sections (`tree.js:204-207`).
- **Trellis force** (`tree.js:220-230`, `744-832`) is a unique feature — branches can be attracted toward an axis-aligned grid, which is how Daniel makes his vine-like presets. Distance falloff with exponent.
- Child branches: `generateChildBranches(count, level, sections)` (`tree.js:283-360`) interpolates between two adjacent parent sections to find the spawn point, slerps the orientation, then applies a per-level `angle` (degrees) and a radial offset spread evenly with `radialOffset + i / count` to distribute children around the parent (`tree.js:327`). Spawn points are deterministic relative to `start[level]` plus `rng.random()`.

**Honda model?** Closer to the spirit (recursive level-indexed branching with per-level params) but without Honda's exact ratio constants. Pure parametric, single-level recursion (no terminal-branch elongation chain like ours).

### 2.2 Trunk + branch geometry — **the relevant comparison**

Tube extrusion is hand-rolled, not `THREE.TubeGeometry`. Each section emits one ring of vertices, indexed across sections to form quads:

- **Per-level subdivision is user-facing** (`options.js:76-89`):
  - `sections[level]` — number of longitudinal sections per branch (defaults: trunk 12, L1 10, L2 8, L3 6).
  - `segments[level]` — number of radial segments per ring (defaults: trunk 8, L1 6, L2 4, L3 3).
- The ring is generated in branch-local space and rotated by the integrator's `sectionOrientation` Euler (`tree.js:153-160`) — there is **no Frenet frame computation, no parallel transport**. The frame is whatever the integrator has at that section. No flips because the orientation is built up additively rather than re-derived per-step from a tangent.
- Normals are computed *analytically* per ring vertex from the same cos/sin and the section orientation (`tree.js:158-160`) — no `computeVertexNormals` pass, no smoothing artifacts.
- UVs run `j / segmentCount` around (with a duplicate first vertex at j=N for seam continuity, `tree.js:177-179`) and a **0/1 alternating ladder vertically** (`tree.js:162-165`: `(i % 2 === 0) ? 0 : 1`). This is the noteworthy hack — the V coordinate doesn't accumulate down the branch length, it just zig-zags 0,1,0,1. Bark-texture stretching is then a function of `bark.textureScale.y` (`textures.js:42`: `texture.repeat.y = 1 / scale.y`) and is the user's problem to set.
- Radial taper: per-level `taper[level]` linearly shrinks `sectionRadius` along the branch (`tree.js:140-141`). The final section of the final level clamps to `radius = 0.001` to close the tip (`tree.js:134-138`).
- Branch ends are **not capped** — the cylinder is open both ends. Children either continue from a section (so the parent end is hidden inside) or the branch is at terminal level and gets a leaf instead.

**No flicker / no Frenet flips because**:
1. There is no Frenet frame. The frame is the integrator's running orientation.
2. Subdivisions don't change the *shape* of the branch — they change how finely the same Euler-integrated path is sampled. More sections = same path, more rings.
3. The integrator's RNG calls are inside the section loop (`tree.js:198-199`) — increasing `sections[level]` *does* shift downstream RNG draws and change the tree, so the user sees a different tree but never a *broken* tree.

### 2.3 Leaves — billboarded quads, single mesh

- `generateLeaves(sections)` (`tree.js:371-427`) is called only when `branch.level === levels` (the terminal level). It places `leaves.count` leaves per terminal branch, distributed along the branch via the same section interpolation used for child branches.
- Each leaf is a **flat 4-vertex / 2-tri quad** (`tree.js:434-502`). Width and length both come from `leaves.size * (1 ± rng(sizeVariance))` (`tree.js:437-444`).
- `Billboard.Double` (`leaves.billboard`) emits a *second* perpendicular quad rotated 90° around Y, for crossed-billboard volume (`tree.js:499-501`). Total: 4 verts / 2 tris (single) or 8 verts / 4 tris (double).
- All leaves go into **one merged BufferGeometry** (`tree.js:571-585`) — not InstancedMesh. So 100k leaves = 800k verts, one draw call, no instancing overhead.
- Texture is a single PNG with alpha (`assets/leaves/oak_color.png` etc.) keyed off `leaves.type` (`textures.js:99-104`).
- **No LOD scheme**. No silhouette mesh. No fade-distance trick.

### 2.4 Materials — `MeshPhongMaterial`, not Standard

- Branches: `MeshPhongMaterial` with optional ao/color/normal/roughness map set per bark-type (`tree.js:547-558`).
- Leaves: `MeshPhongMaterial` with `side: DoubleSide`, `alphaTest: 0.5`, `dithering: true` (`tree.js:587-594`).
- **Wind animation** is injected via `mat.onBeforeCompile` (`tree.js:597-728`) — a self-contained simplex3 noise function is prepended to the leaf vertex shader and `gl_Position` is computed from `transformed + uv.y * uWindStrength * sum-of-three-sines(uTime, simplex3(pos))`. Branch trunk does not sway. Wind is one-way (leaves only).
- No physics-based or PBR metalness setup. No subsurface scattering. No baked AO from the tree itself — only the bark AO map.

### 2.5 UI — flat slider list, ~50 user-facing knobs

- Built imperatively in `src/app/ui.js` (1089 lines including SVG icon strings).
- Two top-level tabs: **Tree** (parameters) and **Export** (`ui.js:425-447`). The Tree tab contains seven collapsible sections: Presets, Bark, Branches, Leaves, Trellis, Camera, Environment, Info.
- Branches section nests subsections per parameter family (Angle, Children, Gnarliness, Force, Length, Radius, Sections, Segments, Start, Taper, Twist) — each subsection has 3-4 sliders, one per branch level (`ui.js:570-707`).
- I count roughly **~50 user-facing controls** (sliders + selects + toggles + color pickers).
- **Sections / Segments sliders are exposed** with hard ranges (`ui.js:651-671`):
  - `sections`: min 1, max 20, step 1
  - `segments`: min 3, max 16, step 1
- That's it for mesh-detail validation — they trust the geometry path and the ranges. No hidden "advanced" mode.

### 2.6 Performance — single-threaded, single-pass

- **No worker offload**. Generation runs on the main thread and is synchronous. ezTree relies on its small, branch-loops-only algorithm being fast enough.
- **No GPU compute / TSL / WebGPU**. Standard `WebGLRenderer` (`src/app/main.js:5` imports `OrbitControls`, no WebGPU).
- **No LOD** (no Meshopt, no draw-distance swap, no impostor fallback).
- **No claimed perf number**. The standard demo presets generate ~50k-200k verts and the trellis preset spawns thousands of branches — but Daniel doesn't ship benchmark or 200k-leaf claims. The README doesn't mention perf at all.
- Effective approach: *make the algorithm so cheap a worker isn't needed*. The whole tree is a couple of nested for-loops over `sections × segments` per branch, with O(branches) total work, no curve evaluation, no per-vertex Frenet recompute.

### 2.7 License — MIT, copy freely

- `LICENSE:1` confirms MIT. The user can lift any of this code wholesale.

---

## 3. Side-by-side comparison

| Stage | ezTree (file:line) | webgpu-tree (file:line) |
|---|---|---|
| **Skeleton model** | Euler-integrated polyline; orientation accumulates per section (`tree.js:130-232`). No spline. | Catmull-Rom curve fit through skeleton nodes, walked with `walkInternode` integrator (`main.js:4588`+) producing a node graph + spline; spawn points use a `refCurve` for subdivision-invariance (`main.js:4855-4870`). |
| **Tube extrusion** | Hand-rolled ring extrusion in `generateBranch` — orientation is the integrator state (`tree.js:147-186`). No Frenet. | `buildTube` in worker (`tree-worker.js:1102+`) — parallel-transport frames, mirrors three.js `computeFrenetFrames` recipe (`tree-worker.js:1041-1098`). Catmull-Rom curve sampled at `tubularPerStep × (chain-1)` points. |
| **Radial subdivision** | Per-level slider `segments[level]` 3-16 (`options.js:84-89`, `ui.js:662-670`). | Single global slider `barkRadialSegs` 4-32 (`main.js:3284`), auto-halved for thin twigs (`tree-worker.js:1130`). Currently **hidden** post-revert. |
| **Longitudinal subdivision** | Per-level slider `sections[level]` 1-20 (`options.js:76-81`, `ui.js:651-659`). | Two-stage: trunk skeleton `trunkSteps` 5-64 (`main.js:3276`) + tube density `barkTubularDensity` 2-12 per skeleton step (`main.js:3285`). Currently `barkTubularDensity` is **hidden**. |
| **Frame stability** | Cannot flip — no Frenet computation; orientation is integrator state. | Frenet flip risk on tight curves; uses three.js parallel-transport recipe (`tree-worker.js:1041-1098`) to avoid the worst, but still curve-derived. |
| **Branching** | BFS queue, one `generateBranch`, per-level `angle`/`children`/`start`/`gnarliness`/`twist`/`force` (`tree.js:100-103`, `283-360`). | `walkInternode` per level with kink subdivisions, distortion (random/sine/perlin/twist), curvature (S-curve/back-curve/helical), tropism with susceptibility, torsion, twist, stochastic skip, signal decay (per `NOTES.md:54`). |
| **Leaves geometry** | Flat quad (4v/2t single, 8v/4t double-cross) merged into one BufferGeometry (`tree.js:434-502, 571-585`). | Custom `leafGeo` built from procedural shape (`main.js:2377+`, `2431-2501`) with a `leafShape` selector (Oak / Maple / Oval / Willow / Birch / Lanceolate / Fan / Heart) — silhouette-traced quad/strip rendered via `THREE.InstancedMesh` (`main.js:7404`). |
| **Leaf rendering** | Single merged mesh, one draw call, no instancing. | `THREE.InstancedMesh` per material slot, with optional per-instance jitter color attribute (`main.js:7404-7415`). |
| **Materials** | `MeshPhongMaterial` + bark texture pack + leaf alpha PNG (`tree.js:547-563, 587-594`). | Custom WebGPU/TSL pipelines (`main.js:85` `WebGPURenderer`), MeshStandard/Phys variants, moss world-up blend, normal-strength slider, ao/dof post-fx (`main.js:13`). |
| **Wind** | Leaf-only sway via `onBeforeCompile` injecting simplex3 noise into vertex shader (`tree.js:597-728`). | TSL-based wind (referenced by `P.wind.enabled` etc. throughout `main.js`), separate worker wind. |
| **UI** | ~50 controls in flat collapsibles (`ui.js`, ~1089 LOC). Sections+Segments per level exposed as plain sliders. | 211 `{ key: ... }` schema entries across 17 schema groups (`main.js:3270+`); ~110 visible by default, 37 hidden (back-compat / advanced). |
| **Workers** | None. Synchronous on main thread. | Pool of `_prewarmedWorkers` (`main.js:61-62`), `tree-worker.js` builds tree+chains then extrudes tubes off the main thread. |
| **GPU compute / WebGPU** | None — `WebGLRenderer`. | `THREE.WebGPURenderer` with TSL, dof/ao node post-fx, MeshoptSimplifier for LOD (`main.js:85, 26`). |
| **LOD** | None. | LOD slot system with ratio/tris/sloppy modes, simplifier-driven preview meshes (`main.js:203-218, 13340+`). |
| **Trellis** | Built-in axis-aligned grid attractor with cylinder geometry (`tree.js:744-832`, `trellis.js`). | None. |
| **Tree types** | Hard split between `Deciduous` and `Evergreen` enum (`enums.js:20-23`); evergreen has child-branches that shorten with `1 - childBranchStart` (`tree.js:344-346`) and no terminal branch. | Conifer has its own schema (`main.js:4118+` Crown/Twigs/Needles/Cones). Bush also has its own schema (`main.js:4148+`). Three independent generation paths. |
| **Persistence** | JSON copy/load via `TreeOptions.copy` (`options.js:185-197`). 13 packaged JSON presets (`presets/*.json`). | Save/load to JSON, plus brush/sculpt undo stack, GLB export, prewarmed worker pool. |
| **Lines of code** | 1353 LOC `src/lib/`, 1089 LOC UI. | 16442 LOC `main.js` + 1546 LOC `tree-worker.js` = 17988. |
| **License** | MIT — copy freely. | (private, presumably) |

---

## 4. What we could steal — ranked by payoff

### Tier 1 — directly addresses the slider-revert issue

1. **Drop the Frenet frame entirely; use integrator-state orientation for tubes.** `tree.js:130-232` is the recipe. The integrator already carries the section orientation. Generate the ring in the local frame with `cos(a)` along X, `sin(a)` along Z, multiply by radius, then `applyEuler(sectionOrientation)` and `add(sectionOrigin)` (`tree.js:153-156`). No tangents, no parallel transport, no flip — the frame can't flip because nothing recomputes it from the geometry. **This is the actual reason ezTree's `sections` slider is rock-solid** while ours stutters: their frame is causally upstream of the geometry, ours is downstream.
   - Migration cost: medium. We'd carry an Euler/quat alongside each chain node (we already track tangent/dir on bridge nodes — see `main.js:4870`).
   - Risk: torsion/twist control would change. We'd need to handle the curve-fit wobble we currently get for free from Frenet.

2. **Per-level radial+longitudinal subdivision** (`options.js:76-89`) instead of one global slider. Trunk wants 12-16 sides, twigs want 3-6. We currently auto-halve thin twigs (`tree-worker.js:1130`) but it's a binary jump; a per-level array avoids hard cutoffs and lets the user tune memory budget.

3. **Per-section UV ladder** (`tree.js:162-165`: `(i % 2 === 0) ? 0 : 1`). Hilariously simple — V is just 0/1/0/1 per ring. Combined with `texture.repeat.y = 1/scale.y` (`textures.js:42`), bark texture density is decoupled from branch length and from longitudinal subdivision. Our current world-meter UV (`barkTexScaleU / barkTexScaleV` in `main.js:3342-3343`) is "right" but more complex; ezTree's ladder is what makes their `sections` slider not stretch the texture.

### Tier 2 — algorithmic clarity wins

4. **Quaternion-based growth force** (`tree.js:209-218`). `setFromUnitVectors` + `rotateTowards(qForce, strength/radius)` is *much* cleaner than computing tropism susceptibility in Euler-land. The `1/radius` weighting mirrors biology (thin shoots bend faster) and gives stable behaviour without a separate susceptibility slider.

5. **`gnarliness * 1/sqrt(radius)` random walk** (`tree.js:194-199`). One-line implementation of "thin branches gnarl harder than the trunk." We approximate this with multiple curvature sliders per level; one well-scaled slider replaces three.

6. **Trellis force** (`tree.js:220-230, 744-832`). Whether or not we ship vine support, the *idea* of attractor-based growth is generalisable — for example, branches could be repelled from a sphere centred on the trunk to fix the canopy-self-intersection issue.

### Tier 3 — polish + perf ideas

7. **Crossed billboards for leaves** (`tree.js:499-501`). Two perpendicular quads per leaf gives volume from any angle for *zero* extra material complexity. We use silhouette-traced shapes and `InstancedMesh` — for the budget-LOD slot, two quads per leaf-cluster might beat our current path.

8. **Wind via `onBeforeCompile` simplex3 sum-of-three-sines** (`tree.js:710-726`):
   ```
   windSway = uv.y * uWindStrength * (
     0.5 * sin(uTime * uWindFrequency + windOffset) +
     0.3 * sin(2.0 * uTime * uWindFrequency + 1.3 * windOffset) +
     0.2 * sin(5.0 * uTime * uWindFrequency + 1.5 * windOffset)
   )
   ```
   The fractal sum of three sines is a textbook trick that produces convincing leaf flutter for free. Our wind is nicer but heavier.

9. **JSON preset format** (`presets/oak_large.json`). Their per-level dictionary `{ "0": 12, "1": 10, ... }` is readable and copy-pastable. Our flat key namespace works but their structure mirrors the algorithm's level-indexed control.

### Tier 4 — explicit non-steals

- **Don't** drop our worker. ezTree's main-thread sync generation works because the algorithm is small. We have wind+sculpt+brush+LOD+sim — we need the worker.
- **Don't** drop Frenet *and* TSL together. If we keep the WebGPU shader stack, we still need stable tube frames. The Tier 1 swap to integrator-state orientation should be done *with* the shader pipeline kept intact.
- **Don't** drop our LOD pipeline. ezTree has none; we ship a real one.

---

## 5. Direct answer: how does ezTree handle the mesh-subdivision trade-off?

**Short version: they expose the sliders, with sensible per-level defaults, and their algorithm structurally cannot break under subdivision changes.** No clamps, no validation, no auto-derivation. The user can crank `segments[trunk]` from 8 to 16 and get a smoother trunk, full stop.

The reason it's stable — and the reason ours wasn't — comes down to **where the section frame lives in the data flow**:

| | Frame source | Effect of changing subdivisions |
|---|---|---|
| ezTree | Integrator's running `sectionOrientation` Euler. The frame *causes* the ring positions. | More sections = same orientation walked finer = same skeleton, smoother mesh. The frame can't flip because nothing recomputes it. |
| webgpu-tree | Frenet frames (parallel-transport) computed *from* a Catmull-Rom curve fit through the skeleton points. The geometry causes the frame. | More tubular samples = different curve sampling = different tangents = potentially different parallel-transport rotation accumulated over the chain = visible wobble or seam shift. RNG draws inside the integrator may also reshuffle (`main.js:7243-7292` flags this). |

Specifically, ezTree's stability rests on three structural choices we don't share:

1. **No spline.** Skeleton *is* the polyline of section origins (`tree.js:188-190`). Our `Catmull-Rom` evaluation introduces a curve that has its own tangent field, which can flip on tight curls.
2. **No Frenet.** Ring orientation is the integrator state, not derived from tangent/binormal. Removing Frenet from the dependency chain removes the only thing that can flip.
3. **UV ladder is index-based, not arc-length-based** (`tree.js:162-165`). Doubling `sections` doesn't change UV V (still 0,1,0,1) — only the texture-repeat factor matters. Our world-meter UV (`main.js:3342-3343`) is more "correct" but introduces a length term that *does* shift slightly when subdivisions change because polyline-length ≠ curve-length.

ezTree's subdivision-stability is **emergent from algorithm choice, not from extra validation**. We can either:

- **(a) Match their structure** — drop the spline, use integrator-state orientation for tubes, accept the loss of curve-smooth bark-flow but gain rock-solid sliders. Tier 1 #1 above.
- **(b) Keep our structure, fix the seams** — pin the Frenet seed frame to the parent branch's frame at the spawn point so subdivisions don't reshuffle. We almost do this already with the bridge node + `refCurve` (`main.js:4974`, `4855-4870`); the bug is that the *radial* seam isn't pinned, only the spawn position is.
- **(c) Hide the sliders, use sensible per-level defaults** — what we just did. Works; concedes the feature.

**Recommendation**: start with (b) — it's the smallest delta and solves the immediate flicker without rewriting the tube extruder. If that proves brittle on heavy presets, fall back to a hybrid where short branches use ezTree-style integrator orientation and long trunks keep Frenet-on-curve for smooth bark flow.

---

## Footnotes

- Number of presets in ezTree: 13 (`assets/presets/*.json`) — Ash/Aspen/Oak/Pine in S/M/L sizes plus 3 bushes and a trellis.
- ezTree's `Tree` is a `THREE.Group` containing two pre-allocated `Mesh` objects whose geometry is *swapped* on regenerate (`tree.js:560-565, 731-738`) — keeps GC churn low. We do similar via the worker handoff.
- `branch.js` is 28 lines — just a value object holding origin, orientation, length, radius, level, sectionCount, segmentCount.
- The trunk of an evergreen tree skips the terminal-branch chain entirely (`tree.js:142-145`) and tapers `1 - i/sectionCount` regardless of `taper[level]` — that's how Daniel gets pine's classic single-shaft profile without exposing a "needles only / single shaft" toggle.
