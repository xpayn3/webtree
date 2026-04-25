# MTree vs webgpu-tree — Algorithm Comparison and Slider Plan

Read-only audit. Date: 2026-04-24.

## Sources analysed

- **Canonical Blender MTree (Maxime Herpin)** — `https://github.com/MaximeHerpin/modular_tree`
  C++ engine in `m_tree/source/tree_functions/`. Five active nodes today:
  Trunk, Branches, Pipe Radius (radius override), Tree Mesher; plus an
  experimental Growth (biological dynamic-vigor) node and an empty
  Leaves stub.
- **Unity port (Warwlock)** — `https://github.com/Warwlock/MTree` (the URL
  the task gave). It is a fork of an older MTree generation. Files in
  `Runtime/TreeFunctions/*.cs` + `Runtime/MTree.cs` + `Runtime/Node.cs`.
  Node set is slightly different (Trunk / Branch / Grow / Split / Roots /
  Leaf) — the Branch node itself is a thin wrapper that calls
  `Split` then `Grow` (`MTree.cs:347-348`).
- **Note on the maxhirsch/lucamoller forks the task suggested**: both
  repos are 404s today. Where the C++ engine and the Unity port disagree
  I cite both and label which I'm using.

The two MTree codebases are structurally almost identical (Trunk emits a
chain, Branch picks origins along parents, then a recursive grow loop
adds children one segment at a time and may split, gravity is a
post-pass). The Unity port has more leaf code (Blender's leaves are
scatter-on-mesh shader-side); the C++ engine has the cleaner branching
math.

---

## 1. MTree algorithm summary

### 1.1 Branching model

**Origins along the parent (where to place a new branch)** —
`BranchFunction.cpp:213-292` (canonical) /
`MTree.cs:247-301` (Unity port).

- Origins are placed at uniform arc-length intervals along the parent —
  `origins_dist = 1 / branches_density` — *not* by counting children. The
  total count emerges from `(end-start) * parentLen * density`. Compare
  our `L.children` integer slider.
- A clean-bole zone is `start * branchLength` and the tail end is
  `end * branchLength` — both as fractions of parent length
  (`BranchFunction.cpp:230-231`). Our analogue: `P.baseSize` (trunk
  only) + per-level `startPlacement / endPlacement`.
- Phyllotaxis: a single rotation by `phillotaxis = 137.5°` per origin
  (golden angle) plus ±1° jitter (`BranchFunction.cpp:243`). It is
  neither user-selectable spiral / opposite / decussate / whorled nor
  per-level. Just one knob with a sensible default.
- The `start_angle` and `length` and `start_radius` per-origin are
  **ramp properties** (Catmull-Rom curves) sampled at
  `factor = (current_length - absolute_start) / (absolute_end - absolute_start)`
  (`BranchFunction.cpp:263-269`). So the user draws the curve directly.
- After placement, each origin is grown one segment at a time by
  `grow_node_once` until it has run its `desired_length`
  (`BranchFunction.cpp:129-208`).

**Continuation vs split (mid-branch fork model)** — `BranchFunction.cpp:165-182`.

- Each step has a `split_proba / resolution` chance of forking. When it
  forks, ONE main child continues straight (axis = parent + jitter +
  up_attraction), and ONE side child is pushed out by `split_angle` from
  the parent axis. There is no "N forks" mode; only 0 or 1 split per
  step. (`BranchFunction.cpp:165-182`)
- Forks asymmetric in radius: side child = `node.radius * split_radius`
  with `split_radius` defaulting to 0.9. The continuation keeps full
  radius. The split gets a random `position_in_parent` within the segment
  it spawned in — i.e. the visible branch start is jittered along the
  segment, not snapped to its end.

**Growth (alternative biological branching model)** — `GrowthFunction.cpp:62-110`.

- Honda-style apical-control: every internode has a *vigor* assigned by
  recursive split between continuation child and side children; the
  continuation gets `t * light_flux / (t * light_flux + (1-t) * child_flux)`
  (`GrowthFunction.cpp:34-39`). With `apical_dominance` near 1 the
  continuation hogs all vigor, and laterals starve.
- Below `cut_threshold` a meristem is killed (commented out, currently
  inactive); above `split_threshold` a node forks at `philotaxis_angle`
  from the parent, advancing a per-node phyllotaxis counter
  (`GrowthFunction.cpp:67-105`).

**Conclusion on branching**: MTree's main pipeline is **density-driven,
curve-driven, and uses one fork per step at most**, with all per-position
shape coming from spline ramps the user drew. The optional Growth node
adds Honda-style apical control as an explicit post-process.

### 1.2 Direction model

Per growth step in `BranchFunction::grow_node_once` (`BranchFunction.cpp:34-41`):

```
random_dir = random_vec(flatness).normalized() + (0,0,1) * up_attraction
child_direction = parent.direction + random_dir * (randomness / resolution)
```

- `randomness` is a **ramp property** sampled at the branch's
  `current_length / desired_length` (`BranchFunction.cpp:144`). User can
  draw "wiggly base, straight tip" or vice versa.
- `flatness` ∈ [0, 1] flattens the random vector's z component before
  use (`GeometryUtilities.cpp:50-56`). Effect: forces branches to spread
  in the horizontal plane (cherry, acacia umbrella crown).
- `up_attraction` is **constant** along the branch — pulls toward +Z.
  This is the only tropism; there is no separate phototropism vs
  gravitropism. There is no falloff array, no by-level scaling, no
  attractor system.

**Branch-base direction at the origin** — `BranchFunction.cpp:267`:

```
child_direction = lerp(parent.direction, tangent, start_angle / 90)
```

A spherical-linear approximation. `start_angle` is itself a ramp so the
user can author "shallow at base, perpendicular at tip" or any profile.

**Floor avoidance** — `BranchFunction.cpp:25-32`: if a node is heading
down and would hit z=0 within one parent-length, force-terminate the
branch ("avoid_floor"); if just heading down, scale z back proportionally.
That's a hard prune, not a clamp like ours.

**Gravity post-pass** (NOT a per-step force; runs once per batch) —
`BranchFunction.cpp:81-112` and again per-iteration in
`GrowthFunction.cpp:133-152`.

- Tracks `cumulated_weight` recursively (`update_weight_rec`).
- For each node computes a torque from horizontality × √weight, applies
  it as an angular displacement toward (-Z) about the tangent, modulated
  by `exp(-deviation_from_rest_pose * stiffness / resolution)` so an
  already-bent branch resists more (a real wood spring response).
- `apply_gravity_rec` walks the chain and *accumulates rotations* down the
  tree — the entire subtree below a heavy joint sags as one piece, just
  like the real thing. This is what gives MTree's broadleaf canopies
  that gentle, weight-aware swag we don't have.

### 1.3 Length / radius model

**Length:**

- `length` is a **ramp property** keyed to "factor" — for the trunk
  it's a constant; for a Branch node it's keyed by the placement
  position on the parent (`BranchFunction.cpp:270`). So branches near
  the parent base can be long, near the tip short — drawn directly as
  a curve.
- The growth loop quantises the length into `1/resolution` segments
  (`BranchFunction.cpp:142`). `resolution` is per-node, not global.

**Radius — three independent stages:**

1. **At growth time**: each node's radius decays linearly from
   `origin_radius` to `origin_radius * end_radius` along the branch
   (`BranchFunction.cpp:141`). `end_radius` is a single dial (default
   .05) — so this is roughly the "tip ratio of base" model.
2. **Pipe radius post-pass** (optional, `PipeRadiusFunction.cpp:5-20`):
   `node.radius = (sum_children radius^power)^(1/power) + constant_growth * length / 100`
   — Weber-Penn ratio-power = our `alloExp`. `constant_growth` adds a
   slow linear thickening for woody secondary growth (no analogue in our
   project).
3. **Splits get** `node.radius * split_radius` at fork time.

**No `radiusRatio` dial per level**, no per-level `taper` shape, no
`rootFlare`, no `trunkScale`. A single thickness profile drawn as a curve
plus the pipe-power dial.

### 1.4 Crown shape

**There is no envelope**. MTree does NOT clip branches against an
ellipsoid or a named silhouette ('conical' / 'spherical' / 'flame' / etc).
Crown shape emerges from:

- The `length` ramp: a tall conifer is just `length` near 1 at the base,
  near 1 at mid, near 0 at tip — drawn explicitly. A spherical hardwood
  has length 0.4→1.0→0.4 along the trunk.
- The `start_angle` ramp: shallow at base + perpendicular at tip
  produces a flame; the inverse produces a fountain.
- The `up_attraction` constant pulls everything toward vertical to a
  controllable degree.
- Floor avoidance trims branches diving too low.

That's the entire crown-shape system. It works because the user-drawn
curves are doing the silhouette authoring. **This is the single biggest
algorithmic delta with our project.** We have a hard envelope dropdown
that scales branch length post-hoc; MTree has user-drawn curves that
shape branch length / angle / radius from origin.

### 1.5 Resampling / smoothing

- **Tube smoothing**: Manifold mesher walks each node and emits a circle
  of `radial_n_points` quads, then runs a Laplacian smoothing pass for
  `smooth_iterations` (default 4) iterations
  (`smoothing.cpp:36-77`, `tree_mesher_node.py:15`). Vertex weighted
  toward neighborhood barycenter by `factor * radius / node_length`
  (`ManifoldMesher.cpp:27-30`) — wider parts smooth more, short
  segments smooth less. Branch junctions get an explicit fan
  (`add_child_circle` / `add_child_base_geometry`,
  `ManifoldMesher.cpp:242-256`) so the joint is one continuous mesh, not
  two intersecting tubes.
- The skeleton itself is NOT resampled — it's straight polylines, and
  smoothing happens at mesh-vertex time only.

### 1.6 Twigs / leaves

- The Blender addon's `LeavesFunction.cpp` is empty; leaf placement is
  done downstream by the Geometry-Nodes scatter graph that ships with
  the addon (`resources/geo_node/`). Density driven by branch radius +
  surface UV.
- The Unity port (`LeafFunction.cs:74-108`) places leaves on candidate
  branches whose radius < `maxRadius` (default 0.25) by sampling
  per-arc-length to reach `number` total. Each leaf gets a random
  per-axis weight in `[minWeight, maxWeight]` interpreted as droop
  along Y. There are six prefab leaf meshes (cross / diamond cross /
  diamond / long / plane) plus a procedural variant (`uLoops` middle
  segments, `lengthCurve` ramp, `gravityStrength`). No phyllotaxis at
  all — placement is uniform random along the parent.

### 1.7 Roots / trunk flare

- Canonical Blender: not in this MTree version (the older
  modular-tree-3 had a Roots node; the current C++ rewrite hasn't
  re-added it).
- Unity port has a **Roots** function (`RootsFunction.cs` referenced via
  `MTree.cs:113-185`): emits angled ground-bound branches off the trunk
  base, spaced by `rootsPerMeter`, attracted to a virtual ground plane
  via `MoveToGroundModifier` (`MTree.cs:190-200`). It's a real physical
  buttress system, not a radius-bell post-pass like ours.
- Trunk node has `originAttraction` (Unity, `TrunkFunction.cs:17`) and
  `up_attraction` (Blender, `TrunkFunction.hpp:16`) which pull the
  trunk toward its starting axis and toward +Z respectively — the
  combination of the two is what draws a slightly leaning tree back to
  near-vertical without a hard clamp.

### 1.8 Complete user-facing parameter list

| Node | Param | Default | Range | Code use |
|------|-------|---------|-------|----------|
| **Trunk** | seed | random | int | `TrunkFunction.cpp:7` |
|  | length | 14 | >0 | total trunk length, `TrunkFunction.cpp:13` |
|  | start_radius | 0.3 | >0.0001 | `TrunkFunction.cpp:11` (base radius) |
|  | end_radius | 0.05 | >0.0001 | `TrunkFunction.cpp:20` (top radius) |
|  | shape | 0.7 | >0 | radius profile exponent, `TrunkFunction.cpp:19` |
|  | up_attraction | 0.6 | float | bias toward +Z each step, `TrunkFunction.cpp:22` |
|  | resolution | 3 | >0 | segments per metre, `TrunkFunction.cpp:9` |
|  | randomness | 1 | float | jitter per step, `TrunkFunction.cpp:21` |
| **Branches** | seed | random | int | `BranchFunction.cpp:296` |
|  | start | 0.1 | 0..1 | clean-bole fraction, `BranchFunction.cpp:230` |
|  | end | 0.95 | 0..1 | branching tail fraction, `BranchFunction.cpp:231` |
|  | length | ramp(9) | ramp | branch length along parent, `BranchFunction.cpp:270` |
|  | branches_density | 2 | >0 | origins per metre, `BranchFunction.cpp:219` |
|  | start_angle | ramp(45) | ramp 0..180 | spawn angle, `BranchFunction.cpp:267` |
|  | randomness | ramp(0.5) | ramp | per-step jitter, `BranchFunction.cpp:144` |
|  | break_chance | 0.02 | >0 | random branch death, `BranchFunction.cpp:131` |
|  | resolution | 3 | >0 | segments per m, `BranchFunction.cpp:142` |
|  | start_radius | ramp(0.4) | ramp | radius at branch base relative to parent, `BranchFunction.cpp:269` |
|  | flatness | 0.2 | 0..1 | horizontal bias, `BranchFunction.cpp:36-46` |
|  | up_attraction | 0.25 | float | gravitropism, `BranchFunction.cpp:36` |
|  | gravity_strength | 10 | float | post-pass weight sag, `BranchFunction.cpp:97` |
|  | stiffness | 0.1 | float | resistance to gravity, `BranchFunction.cpp:98` |
|  | split_proba | 0.5 | 0..1 | per-step fork chance, `BranchFunction.cpp:165` |
|  | phillotaxis | 137.5 | 0..360 | golden-angle origin spacing, `BranchFunction.cpp:243` |
|  | split_radius | 0.8 | >0 | side-fork radius factor, `BranchFunction.cpp:169` |
|  | split_angle | 35 | 0..180 | side-fork angle, `BranchFunction.cpp:50` |
| **Pipe Radius** | end_radius | 0.005 | >0 | tip radius, `PipeRadiusFunction.cpp:9` |
|  | constant_growth | 0.2 | ≥0 | woody secondary thickening, `PipeRadiusFunction.cpp:19` |
|  | power | 2.5 | ≥0.1 | Weber-Penn ratio-power exponent, `PipeRadiusFunction.cpp:17-19` |
| **Tree Mesher** | radial_resolution | 32 | ≥3 | circle vertices, `tree_mesher_node.py:14` |
|  | smoothness | 4 | ≥0 | Laplacian iterations, `tree_mesher_node.py:15` |

That's it — **about 27 user-facing knobs total** across the whole
pipeline (excluding mesher detail). Compare ours: ~110 sliders just in
PARAM_SCHEMA + LEVEL_SCHEMA × levels.

The big things this list does NOT have, that we DO have:
- Per-level structure (MTree has one Branch node configurable per
  call, but the user typically chains 2-3 of them — analogous to our
  L1/L2/L3 — each with its own param block).
- Crown-shape envelope (no equivalent — see 1.4).
- Phyllotaxis selector (one global angle).
- Per-level `taper` profile, `rootFlare`, `trunkScale`,
  `branchThickness`, `alloExp` — all collapsed into the single
  `start_radius` ramp + Pipe Radius `power`.
- Distortion type / freq, curveBack, curveMode, twist, torsion,
  attractors, susceptibility, signalDecay, apicalContinue,
  apicalInverted, etc. — most replaced by the `randomness` ramp +
  gravity post-pass.

---

## 2. Our algorithm summary

### 2.1 Branching model

`spawnChildrenAlong` in `main.js:5205-5392` (parallel:
`tree-worker.js:469-651`). Per-level call.

- Children placed by **integer count**: `count = L.children`,
  evenly distributed in `[startPlacement, endPlacement]`. Each child
  gets a 24% spacing jitter (`main.js:5249-5251`).
- `densityPoints` 5-knot Catmull-Rom curve culls children probabilistically
  per `frac` (`main.js:5255-5258`).
- Phyllotaxis selector — `'spiral'` (golden angle), `'opposite'`,
  `'decussate'`, `'whorled'`, plus `'fibonacci'` mode (P.branchModel)
  that snaps to strict 137.5° (`main.js:5320-5341`).
- `apicalDominance` shortens the apical (or basal, if `apicalInverted`)
  side of the branch and angles the tip child toward parent axis
  (`main.js:5305-5312`). `apicalContinue` further forces the last child
  to inherit parent direction with a length boost — explicit central
  leader (`main.js:5347-5369`).
- Honda branch model (`P.branchModel === 'honda'`) post-multiplies
  `lenRatio` by 0.94 (apical) / 0.86 (first lateral) / 0.70 (other
  laterals) (`main.js:5373-5376`).
- Mid-branch forks via `walkInternode`'s `segSplits` knob: for each
  step a fractional Bernoulli decides forks, each fork is a chainRoot
  bridge spawned at the segment with `splitAngle` and length `(stepsLeft / kinkSteps) * 0.9` of remaining (`main.js:5159-5200`).
- Trunk vs branches: trunk is built outside walkInternode in a
  reference-curve sampler at fixed REF_TRUNK_STEPS=64 with the user's
  `trunkSteps` resolved as a sampled polyline of that curve
  (`main.js:5479-5547`). Branches use walkInternode.

### 2.2 Direction model

Per step in `walkInternode` (`main.js:4976-5203`):

- 4 distortion modes (`random` / `sine` / `perlin` / `twist`), with `amp` and `freq`
  per level. Random mode RMS-corrected for `kinkSteps` invariance
  (`main.js:5012-5041`).
- `torsion` rotates the noise vector around the growth axis
  (`main.js:5043-5051`).
- 4 curve modes (`none`/`sCurve`/`backCurve`/`helical`) plus Weber-Penn
  asymmetric `curveBack` reversal (`main.js:5057-5078`).
- Tropism: separate phototropism and gravitropism, each with strength,
  per-axis direction vector, optional `byLevel` scaling, optional
  `falloff` 5-pt Catmull-Rom curve along the branch (`main.js:5083-5096`).
- `susceptibility` per-level scales both tropisms (`main.js:5085, 5092`).
- Attractors — N world-space points pull the heading
  (`main.js:5098-5112`).
- `twist` rotates the heading around world Y per step
  (`main.js:5114-5122`).
- Floor clamp at `FLOOR_Y = 0.03` (`main.js:5137-5144`) — branch
  flattens horizontally on contact, doesn't terminate.

No gravity post-pass; everything is per-step constant tropism.

### 2.3 Length / radius model

**Length:**

- `parentLen` × `L.lenRatio` (per-level scalar) × apical adjustments ×
  shape envelope × `lengthPoints` curve sample × Honda multiplier
  (`main.js:5377`).
- Trunk-children get the additional `shapeLenRatio(crownShape, frac)`
  multiplier (`main.js:5364`).
- `growthPhase` only scales the deepest level (`main.js:5422-5425`).
- L0 branch length is `9.0 * P.globalScale` — **decoupled from
  trunkHeight** (`main.js:5562`), unlike MTree where parent length
  drives child length by ramp.

**Radius — five-stage pipeline (from session 11 cont. memory):**

1. Pipe-model walk: `tipR` baseline; trunk tapers `baseR → tipR` along
   `branchT` with exponent `taperExp`; each branch base = parent.radius
   × `L.radiusRatio` (`main.js:5605-5628`).
2. Global `branchThickness` multiplier — uniform on every node
   (`main.js:5633-5636`). Currently HIDDEN from UI.
3. Per-level `L.taper` reshape (cylinder/cone/periodic)
   (`main.js:5643-5662`). UI hidden.
4. `rootFlare` ease-out cubic bell over first 3.8 m
   (`main.js:5664-5678`).
5. `trunkScale` height-graded multiplier (base-heavy)
   (`main.js:5680-5688`). UI hidden.

Then at tube time:
- `taperSpline` — user-drawn radius curve (trunk only)
  (`main.js:5847-5852`).
- `profileEditor` — radial cross-section profile
  (`main.js:5816-5818`).
- `buttressAmount` / `buttressLobes` / `buttressHeight` — trunk-base
  lobe bulges.
- `reactionWood` — asymmetric thickening on undersides of horizontal
  branches.
- Hard cap: branch base ≤ 0.8 × parent's local radius
  (`main.js:5883-5889`).

### 2.4 Crown shape

`shapeLenRatio(shape, ratio)` at `main.js:5397-5414`. Named silhouettes
(`conical`/`spherical`/`hemispherical`/`cylindrical`/`tapered`/`flame`/`inverse`/`tend-flame`)
post-multiply primary branch length. Only applied to children of the
trunk (`main.js:5216`). Not user-authored — picked from a dropdown.

Plus an explicit ellipsoid hard prune via `pruneMode === 'ellipsoid'`
(`main.js:5567-5594`) parameterised by `pruneRadius`/`pruneHeight`/`pruneCenterY`.

### 2.5 Resampling / smoothing

- `walkInternode` does NOT resample — it emits one node per
  `kinkSteps`-divided segment.
- `tubeFromChain` (`main.js:5772-5891`) wraps the chain in a
  `CatmullRomCurve3` (centripetal, tension 0.5) and emits a TubeGeometry
  with `tubular = clamp(12, 384, (pts-1) * 6)` longitudinal segments
  and `radial = 8|16` radial. Drag-time gets quartered.
- No Laplacian smoothing pass at the mesh stage. Junction handling is
  a chainRoot bridge node + a flare-collar radius bump
  (`main.js:5793-5798`) — *not* a manifold weld like MTree.

### 2.6 Twigs / leaves

`_foliagePhase` (referenced from session memory; large function around
main.js:7100-7300). Leaf placement:

- Per-tip count `leavesPerTip` (default 32) on tips that pass
  `leafChainSteps` depth and `leafBranchFill` density gates.
- `leafPhyllotaxis` selector (`'spiral'`/`'opposite'`/`'alternate'`/`'random'`)
  used at the leaf level (separate from per-level branch phyllotaxis).
- `leafSpread`, `leafDroop`, `leafTilt`, `leafStemAngle`, `leafStemLen`,
  `leafSize`+`leafSizeVar`+`leafColorVar` author the per-leaf pose.
- Compound leaves (`leafletCount`>1) expand each placed leaf into N
  leaflets along a petiole.
- Twig system separate (`twigCount`/`twigLen*`/`twigDroop`) places
  short stems with optional leaves at tips.

### 2.7 Roots / trunk flare

- Visual root flare = per-node radius bell over first 3.8 m
  (`main.js:5664-5678`). Exponent 1, eased.
- Buttress lobes at tube-extrusion time
  (`main.js:5853-5858`).
- We do NOT have actual root branches — purely a shader/geometry bell.

### 2.8 PARAM_SCHEMA + LEVEL_SCHEMA quick map

I'll pull the full live list from `main.js:3482-3717` into the diff
table below rather than repeat it here.

---

## 3. Side-by-side diff — what causes the visual gap

| Stage | MTree | webgpu-tree | Source of visual gap |
|-------|-------|-------------|-----------------------|
| Branch placement | Density-driven; arc-length spacing × phillotaxis 137.5° | Integer count evenly distributed | Density-driven looks more natural at any branch length; integer spacing produces visible "rings" of children when count is low. **Medium.** |
| Per-position branch params | Catmull-Rom **ramps** for length, radius, randomness, start_angle | Constant per-level scalar + densityPoints/lengthPoints/splitPoints curves | We HAVE the curves but they only modulate density/length/split, not radius/randomness/angle. **Medium-high.** |
| Direction tropism | Single `up_attraction` constant + `flatness` flatten Z + `randomness` ramp | Phototropism + gravitropism vector + susceptibility + falloff + attractors + curveMode + curveBack + twist + torsion | Ours is more powerful but stacks and fights itself. MTree's single-source pull rarely produces the "branches all curl back" weirdness ours can. **Low-medium.** |
| Gravity (weight sag) | Recursive weight accumulation + cumulative rotation pass + stiffness fatigue | None | This is THE big one. MTree branches sag at heavy joints and the entire downstream subtree rotates with them. Our branches stay in their parametric pose forever. **HIGH.** |
| Floor handling | Hard kill via `avoid_floor`; pre-emptive at low-z heading | Y-clamp at 0.03 with horizontal flatten | Ours produces "branches running along floor" artifacts. MTree just refuses to grow them. **Medium.** |
| Branch length | Drawn ramp keyed to placement on parent | `lenRatio` × `lengthPoints` × shape envelope × Honda × apical | Ours can author similar but defaults are coupled. Crown silhouette emerges from our `shape` dropdown rather than a curve. **Medium.** |
| Crown shape | None (envelope emerges from length+angle ramps) | Named-silhouette dropdown + ellipsoid prune | Hard-clipped envelopes look plastic; emergent envelopes look organic. **HIGH.** |
| Radius profile | `start_radius` ramp + `(sum r^p)^(1/p)` pipe-radius post-pass + linear length-decay | 5-stage pipeline (alloExp + radiusRatio + branchThickness + per-level taper + rootFlare + trunkScale) + spline + profile + buttress + react | Ours is over-engineered. Five global multipliers stacked produces a thick blob unless every dial is in tune. **Medium.** |
| Resolution | Per-node `resolution` segments-per-metre | Per-level `kinkSteps` total-segments | Ours produces sparser segments on long branches. Slightly less smooth. **Low.** |
| Mesh joint | `add_child_circle` welds + Laplacian smoothing | chainRoot bridge + flare collar | MTree joints are visibly seamless; ours show the discontinuity at thin parents. **Medium.** |
| Phyllotaxis | One global 137.5° + ±1° jitter | Per-level enum + `rollStart` + `rollVar` + `branchModel` global | Ours is more flexible but presets pick wrong values often. MTree's golden default just works. **Low.** |
| Twigs / leaves | Geometry-Nodes scatter (Blender) / radius-thresholded uniform sampler (Unity) | Tip-walk with leavesPerTip + chain-depth + branch-fill | Comparable feature-wise once species are tuned; not a shape gap. **None.** |
| Roots / trunk flare | Real Roots branches + up_attraction constant balancing trunk lean | Radius bell + buttress lobes | Visual fidelity at the base is roughly comparable; ours faster. **None.** |
| Resampling | None at skeleton; Laplacian smoothing at mesh | None at skeleton; Catmull-Rom + radial profile at mesh | Comparable. **None.** |

The two stages MTree clearly wins on: **gravity sag** and **emergent
crown shape from drawn ramps**. Those two are the bulk of the "MTree
trees look better" feeling.

---

## 4. Slider rationalisation plan

### 4.1 ADD — sliders to expose (mapped to MTree feature we lack)

1. **Gravity sag pass** (single dial: `gravityStrength`, plus
   `stiffness`). MTree: `BranchFunction.cpp:81-112` (gravity iter) +
   `BranchFunction.cpp:114-126` (cumulated_weight). Implement as
   post-pass over `nodes` in `buildTree` after radius assignment but
   before `buildChains`. Walk children leaves-first to compute
   `cumulated_weight = length + sum(child_weight)`, then root-down
   accumulating `Quaternion.setFromAxisAngle(tangent_to_minus_y, displacement)`
   across each node and rotating the entire descendant subtree's
   directions and positions. Apply once per build (not per frame; we
   already have wind PBD for runtime). Insert after main.js:5688.

2. **Per-level `randomness` ramp** (replace `distortion` + `distortionFreq`
   for the dominant case). MTree: `BranchFunction.cpp:144`. We already
   have `densityPoints`/`lengthPoints`/`splitPoints` 5-knot ramps; add
   `randomnessPoints` keyed to `tNorm` inside `walkInternode`
   (`main.js:5012-5041`). Multiply the existing `amp` by
   `sampleDensityArr(L.randomnessPoints, tNorm)`.

3. **Per-level `startAnglePoints` ramp** for spawn angle. MTree:
   `BranchFunction.cpp:267`. Sample at `frac` inside
   `spawnChildrenAlong` (`main.js:5318`) and add to the existing
   `angle + apicalAngleBoost + declineBias`.

4. **Per-level `radiusPoints` ramp** for branch base radius along the
   parent. MTree: `BranchFunction.cpp:269` (`start_radius` ramp). Sample
   at `frac` inside the radius pass at `main.js:5610-5628` for
   chainRoot nodes, multiplying `n.chainBaseR`.

5. **Density-as-spacing slider** (`branches_density`) per level. MTree:
   `BranchFunction.cpp:219`. Add a `placement` enum: `'count'` (current
   behaviour) | `'density'`. When density: count derived as
   `density * parentLen * (endPlacement - startPlacement)`. The user
   picks density-per-metre, branches don't visually thin out as the
   parent extends.

6. **Pipe-radius `constant_growth`** for woody thickening. MTree:
   `PipeRadiusFunction.cpp:19`. Add to the radius pass at
   `main.js:5605-5628`: after computing each node's pipe-power radius,
   add `constant_growth * accumulated_branch_length / 100`. Gives
   matures more solid trunks without inflating tips.

### 4.2 REMOVE or HIDE — sliders that fight each other

| Slider | Why | Override path |
|--------|-----|---------------|
| `trunkScale` (already hidden) — keep hidden | Stacks with `rootFlare` + `baseRadius` for base thickening | session 11 cont. doc: 7-dial radius pipeline |
| `branchThickness` (already hidden) — keep hidden, retire on next save format | Pure global multiplier; users always reach for `baseRadius`/`tipRadius` first | `main.js:5633-5636` |
| `alloExp` (already hidden) — fully retire | Unused under current pipe-model; `radiusRatio` per-level supersedes it | `main.js:5510` (`hidden: true`) |
| `growthPhase` | Only affects deepest level; users mistake it for a global "size" knob | `main.js:5424-5425` — partial-level scale |
| `taper` per-level (already hidden in UI, kept in JSON) — retire from JSON too | session 11 cont. notes the `taperSpline` + `trunkScale` + `alloExp` already over-cover this | `main.js:5643-5662` |
| `signalDecay` AND `apicalDominance` together | Both multiplicatively shorten siblings. Per session 10 backlog. | `main.js:5311` (apical) + `main.js:5360` (signal) |
| `pruneMode = 'ellipsoid'` for non-bush species | Hard envelope visibly clips MTree-like emergent crowns | `main.js:5567-5594`. Recommend dropdown becomes `off | density-prune` (cull by densityPoints) instead of geometric. |
| `apicalContinue` AND `apicalDominance` together | Apical-continue overrides the other; users see both and tweak both | `main.js:5343-5369`; doc says apical-continue bypasses signal/length scaling |
| `curveAmount` AND `distortion` AND `torsion` AND `twist` | 4 different per-step direction perturbations; MTree's single `randomness` ramp covers the same ground | `main.js:5011-5051` (distortion+torsion) + 5057-5078 (curve) + 5114-5122 (twist) |
| `phototropism` AND `gravitropism` direction vectors | MTree gets by on a single `up_attraction` constant plus `flatness`. Two competing direction vectors per level is overkill. | `main.js:5083-5096` |
| `attractors` panel | Fights crown shape; users rarely use. Move to "advanced" collapsible. | `main.js:5098-5112` |
| `barkDisplaceMode = 'cellular'` | Looks like alien skin — no MTree analogue, doesn't read as bark | `main.js:5826-5827` |
| `leafBumpScale`, `leafClearcoat`, `leafSheen` | Leaf material has 14 sliders; ~5 are diminishing-return polish | `main.js:3568-3582` |
| Conifer `cBranchCount`/etc. AND L1.children (level-driven) | `applyConiferConfigToP` rewrites `P.levels` from scratch every regen, throwing away L1.children edits | `main.js:7326-7365` |
| Bush `bStems` etc. AND `pruneMode` UI | `applyBushConfigToP` overrides `pruneMode` to `'ellipsoid'` unless user explicitly set `'off'`; same pattern with the levels array | `main.js:7369-7435` |

### 4.3 RENAME / REGROUP

- **Trunk group name confusion**: `baseRadius` / `tipRadius` /
  `taperExp` / `rootFlare` / `branchThickness` / `trunkScale` /
  `alloExp` are spread across the Trunk group. Rename group → "Trunk &
  thickness", drop the hidden three. Move bark `barkDisplace*` group
  under the renamed group so all geometry-affecting params for the
  trunk live together.
- `shape` (dropdown) → "Crown silhouette" + add a hint:
  "Hard envelope. Set to 'free' and use length curves for natural
  shapes." — guides user toward MTree-style authoring.
- `kinkSteps` per-level → "Segments per branch" (current label is
  fine; just keep). Note the existing tooltip; add to the help that
  this is total, not per-metre.
- `distortion` (per-level) → "Wiggle"; `distortionFreq` →
  "Wiggle frequency"; `distortionType` → "Wiggle pattern". Today's
  "Waviness" / "Noise frequency" are technical-sounding and decoupled
  in label terminology.
- `apicalDominance` → "Apical dominance"; `apicalContinue` → "Central leader";
  `signalDecay` → "Sibling decay" (already current). Group into a single
  "Apical control" subgroup at the top of LEVEL_SCHEMA so the user
  understands these all do related things.
- `curveMode` + `curveAmount` + `curveBack` group as "Branch curve"
  subgroup; today they're alphabetical interleaved with distortion.
- `phototropism` + `gravitropism` + `susceptibility` group as
  "Tropism" subgroup.
- Move `branchModel` (Global group) next to per-level `phyllotaxis` —
  they're related and currently 200 lines apart in UI.

---

## 5. Top 3 highest-shape-payoff changes

1. **Implement gravity sag pass.** MTree's recursive
   weight-accumulate-then-rotate over the skeleton (`BranchFunction.cpp:81-112`) is
   the single biggest missing visual element. Implement after
   `buildTree` final radius pass at `main.js:5688` with a single
   `P.gravityStrength` and `P.stiffness` slider. Wind PBD already gives
   us per-frame deflection; this is a one-time at build time pose pass.
   It will entirely transform our broadleaf canopies — heavy laterals
   will droop at the joint and pull the entire downstream subtree with
   them, instead of standing rigid in their parametric pose. Estimate:
   one session, ~150 LOC, mirror in tree-worker.js.

2. **Make `crown shape` an emergent property of length curves**, not a
   hard envelope. Today: `shapeLenRatio` post-multiplies primary
   branch length by a named silhouette (`main.js:5397-5414`). Replace
   with: `'free'` keeps current `lengthPoints` curve; `'conical'` /
   `'spherical'` etc. are *presets that load specific lengthPoints +
   startPlacement + endPlacement curves* on the L1 level — then the
   user can edit the curve. MTree's gives `length(parent_factor)` ramps
   the user can draw; we already have a 5-pt ramp per level. Hide the
   raw `shape` dropdown except as a preset loader. Estimate: half a
   session, ~50 LOC + curve presets.

3. **Add per-level `randomness` and `startAngle` 5-pt ramps.**
   Currently `distortion` is constant per level. MTree's
   `randomness.execute(factor_in_branch)` (`BranchFunction.cpp:144`)
   gives "wiggly base, straight tip" silhouettes our branches can't
   produce. Same for the spawn-angle ramp at
   `BranchFunction.cpp:267`. Both are tiny additions — a multiplier
   sample inside `walkInternode` and `spawnChildrenAlong`. Mirror in
   tree-worker.js. Estimate: one session, ~60 LOC.

(If a 4th: bake **density-driven branch placement** as an alternative
to count-driven. Adds `density` as a per-level scalar, derives count
from parent length × density. Single new UI mode toggle.)

---

## 6. Risks / caveats

- **Gravity sag will change every preset's silhouette.** MTree-tuned
  presets need every preset's `gravityStrength` set to ~0.5–2 (where
  MTree default is 10 / `BranchFunction.hpp:25`). Without per-species
  tuning the canopies will sag too much on Pine and not enough on
  Willow. Plan: start with global `P.gravityStrength = 1.5`, verify
  Oak/Maple/Cherry, then per-species tune.
- **Sag pass + wind PBD interaction.** PBD reads `restPos` from the
  node (`main.js:~6477`, updateBark). If the sag pass shifts node
  positions, PBD restPose must be captured AFTER sag, or the wind
  motion will look like the tree is springing back to its un-sagged
  pre-sag pose every frame. Capture rest after sag in
  `_allocSkeletonSoA` (Session 11).
- **Worker parity.** Every change to `walkInternode` / `spawnChildrenAlong` /
  `growAtLevel` MUST be mirrored in `tree-worker.js:227-832`. Session
  10 / 11 closed previous drift; future drift is the critical
  correctness risk. The gravity pass is a post-pass over `nodes` array
  — it can run main-thread only after the worker returns SoA, since
  it operates on the full skeleton. Recommended: post-pass on main
  thread, NOT in the worker.
- **`applyConiferConfigToP` / `applyBushConfigToP` overrides.** Adding
  new per-level ramps to LEVEL_SCHEMA means these helpers (`main.js:7326`,
  `7369`) must be updated to populate the new fields, or conifer/bush
  trees will silently lose the new shape control. List them now:
  `cBranch* → P.levels[0]` (8 fields), `cTwig* → P.levels[1]` (5
  fields), `bStems / bBranchiness / bTwigLen → P.levels[0..2]` (3
  fields). The new ramps need defaults populated in both helpers.
- **`taperSpline` / `profileEditor` are tube-time, not skeleton-time.**
  Anything modifying skeleton radii (sag-induced reaction-wood feedback,
  for example) won't show up under the user's `taperSpline`. Today
  the relationship is "tube radius = skeleton radius × profileMul ×
  taperRow". Fine for now; flag if implementing reaction-wood feedback.
- **5-pt Catmull-Rom ramps require UI surface area.** If we add 3-5
  more curves per level, the per-level UI grows from one column to two
  (already crowded). Recommend an "Advanced curves" expander per level
  that hides them by default.
- **Hiding `shape` dropdown** breaks Oak/Aspen/Tupelo/Baobab/ScotsPine
  presets that currently rely on `tend-flame` / `inverse`. These
  presets must be migrated to drawn-curve equivalents *before* hiding
  the dropdown. Until migrated, leave the dropdown but rename to
  "Crown silhouette (legacy)".
- **Pruning ellipsoid removal** is risky for Bush presets — they use
  it as their canopy shape control. Leave bush special-cased; remove
  for broadleaf/conifer only.
- **Density-driven placement** changes child indices (no longer
  uniform), which breaks `signalDecay` (which assumes monotonically
  increasing sibling index = position). Decouple by switching
  signalDecay's input from `c` to `frac`.

---

## 7. References (file:line)

### MTree (canonical Blender C++)
- Trunk grow loop — `m_tree/source/tree_functions/TrunkFunction.cpp:5-34`
- Branch origins along parent — `m_tree/source/tree_functions/BranchFunction.cpp:213-292`
- Branch grow-once + split — `m_tree/source/tree_functions/BranchFunction.cpp:129-208`
- Floor avoidance — `m_tree/source/tree_functions/BranchFunction.cpp:25-32`
- Direction model — `m_tree/source/tree_functions/BranchFunction.cpp:34-53`
- Gravity weight + sag — `m_tree/source/tree_functions/BranchFunction.cpp:81-126`
- Pipe-radius post-pass — `m_tree/source/tree_functions/PipeRadiusFunction.cpp:5-30`
- Honda apical-control vigor split — `m_tree/source/tree_functions/GrowthFunction.cpp:20-47`
- Manifold mesher branch joint — `m_tree/source/meshers/manifold_mesher/ManifoldMesher.cpp:138-256`
- Laplacian smoothing — `m_tree/source/meshers/manifold_mesher/smoothing.cpp:36-77`
- Trunk param defaults — `m_tree/source/tree_functions/TrunkFunction.hpp:9-17`
- Branch param defaults — `m_tree/source/tree_functions/BranchFunction.hpp:14-32`
- Pipe-radius defaults — `m_tree/source/tree_functions/PipeRadiusFunction.hpp:19-21`
- Trunk node UI — `python_classes/nodes/tree_function_nodes/trunk_node.py:13-25`
- Branch node UI — `python_classes/nodes/tree_function_nodes/branch_node.py:12-33`
- Mesher node UI — `python_classes/nodes/tree_function_nodes/tree_mesher_node.py:14-15`

### MTree (Unity port — older variant)
- Branch grow at node — `Runtime/Node.cs:34-124`
- AddBranches = Split + Grow — `Runtime/MTree.cs:343-348`
- Roots ground attractor — `Runtime/MTree.cs:113-200`
- Leaf placement — `Runtime/TreeFunctions/LeafFunction.cs:74-108`

### webgpu-tree
- PARAM_SCHEMA — `main.js:3482-3678`
- LEVEL_SCHEMA — `main.js:3680-3717`
- Default level + 5-pt ramps — `main.js:3719-3735`
- buildTree entry — `main.js:4965`
- walkInternode (main) — `main.js:4976-5203`
- spawnChildrenAlong (main) — `main.js:5205-5392`
- shapeLenRatio crown envelopes — `main.js:5397-5414`
- growAtLevel + level recursion — `main.js:5416-5435`
- Trunk reference curve — `main.js:5479-5547`
- Pruning ellipsoid — `main.js:5567-5594`
- Radius 5-stage pipeline — `main.js:5605-5688`
- buildChains — `main.js:5693-5726`
- tubeFromChain — `main.js:5772-5891`
- applyConiferConfigToP — `main.js:7326-7365`
- applyBushConfigToP — `main.js:7369-7435`
- walkInternode (worker) — `tree-worker.js:246-466`
- spawnChildrenAlong (worker) — `tree-worker.js:469-651`
- _w_shapeLenRatio (worker) — `tree-worker.js:446-466`
- buildTreeWorker — `tree-worker.js:227-851`
- buildChainsWorker — `tree-worker.js:853-?`
