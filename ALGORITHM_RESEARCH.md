# Tree Generation Research Report

## TL;DR

- The project's gravity sag implementation is architecturally correct (recursive weight + cumulative subtree rotation) but several species presets either don't use it (`Willow: gravityStrength` is unset, defaulting to 0) or stack it against per-step `gravitropism` so the two fight each other.
- **Crown shape** is the largest visual gap: the `shape` enum is a hard length envelope, while MTree, The Grove, and space colonization all produce crown shape as an emergent property of per-position curves. `randomnessPoints` and `startAnglePoints` already exist in `makeDefaultLevel()` but no `LEVEL_SCHEMA` entries render them in the UI — significant shape-control surface is hiding under the floor.
- Several species combine **conflicting parameters**: Oak L1 `angle: 1.25` (71° from vertical) + `curveAmount: 0.45` + `pruneMode: 'ellipsoid'` at `pruneRadius: 7.0 / pruneHeight: 5.0` causes hard mid-arc clipping. Maple's decussate cage gets near-spherical clipped silhouette from its ellipsoid envelope.
- The biggest **missing feature class** vs peers is density-driven branch placement (MTree: origins per metre, not integer count) — fixes the visible "ring of children" artifact at low `L.children`.
- Platform layer (WebGPU/TSL, PBD, worker pool, LOD, MeshPhysicalNodeMaterial subsurface leaves, contact shadow disc, SSAO/DOF) **exceeds every open-source peer**. The gap is in parametric defaults and a handful of missing post-build shape operators, not the rendering engine.

---

## Section 1: What this project gets RIGHT

**Weber-Penn core** is faithfully implemented: `lenRatio`, `radiusRatio`, `taper`, `angle`/`angleVar`, `segSplits`/`splitAngle`, `curveMode`/`curveAmount`/`curveBack`, `startPlacement`/`endPlacement`, `baseSize`, `densityPoints`, `lengthPoints`. The phyllotaxis enum (spiral, opposite, whorled, decussate per-level + spiral/opposite/alternate/random for leaves) exceeds the original spec and Sapling.

**Gravity sag** (`gravityStrength`, `gravityStiffness`) — schema comment confirms it's "MTree-style — recursive weight + cumulative rotation pass applied once at build time. Heavy joints sag and the entire downstream subtree rotates with them." This is the correct architecture. Oak uses `gravityStrength: 0.55`, Maple `0.25`.

**Ramp system** (`densityPoints`, `lengthPoints`, `splitPoints`, `randomnessPoints`, `startAnglePoints`) — full Catmull-Rom 5-point curves on each level. This is exactly what MTree's ramps provide. The infrastructure is in `makeDefaultLevel()` (schema.js:278–299).

**Rendering architecture** is best-in-class for browser trees: WebGPU/TSL, MeshPhysicalNodeMaterial with subsurface scattering on leaves, PBD skeleton sim, worker pool, LOD with auto-switch, real shadow maps + contact shadow disc, SSAO/DOF. No JS competitor comes close.

**Species coverage** — 26 broadleaf, 13 conifer, 9 bush — with botanically grounded phyllotaxis and leaf shape choices. Unmatched in open-source JS.

**Branch formula enum** — `branchModel: 'weber-penn' | 'honda' | 'fibonacci'` (schema.js:205) acknowledges that one parametric backbone doesn't cover all topologies.

---

## Section 2: What this project gets WRONG or has set up suboptimally

### 2.1 Oak L1: angle 1.25 + curveAmount 0.45 + ellipsoid prune — three-way conflict

Verified at schema.js:355–358:
```
gravityStrength: 0.55, gravityStiffness: 0.55,
pruneMode: 'ellipsoid', pruneRadius: 7.0, pruneHeight: 5.0, pruneCenterY: 7.0,
levels: [
  withLevel({ children: 12, ..., angle: 1.25, ..., curveMode: 'sCurve', curveAmount: 0.45, ...
```

71° from vertical + an sCurve magnitude of 0.45 means each L1 branch arcs further outward then curves back — exactly the trajectory most likely to exit a 5m-tall ellipsoid centered at Y=7 (which spans Y=2 to Y=12). With 12 L1 branches placed in spiral phyllotaxis after the `baseSize: 0.28` clean bole, branches in the upper third start with their base near Y=8 and curve through Y=11–13 — well above the prune cap. The hard envelope clips them, producing a flat-topped sphere instead of the "broad and billowy with a slightly flattened top" the preset comment promises. Removing `pruneMode: 'ellipsoid'` from Oak and letting `densityPoints: [0.85, 1.0, 1.0, 0.95, 0.8]` + `lengthPoints: [0.9, 1.0, 1.0, 1.0, 0.85]` shape the silhouette would eliminate the artifact entirely.

### 2.2 Maple: ellipsoid prune on a decussate cage

Verified at schema.js:381–384: `gravityStrength: 0.25, gravityStiffness: 1.0, pruneMode: 'ellipsoid', pruneRadius: 5.5, pruneHeight: 5.0, pruneCenterY: 7.5,` with `children: 14` L1 + `phyllotaxis: 'decussate'` + `children: 11` L2 + `phyllotaxis: 'decussate'`. Decussate produces paired branches in 4 directions, building a dense cage. The `5.5 × 5.0` ellipsoid cuts this cage at a near-perfect sphere outline visible from any angle — the opposite of the irregular "lollipop" the preset comment describes. Real maples don't need a hard envelope because the dense ramification naturally fills space. Drop `pruneMode: 'ellipsoid'` from Maple, tighten `endPlacement` slightly.

### 2.3 Willow: missing gravityStrength, all weight on per-step gravitropism

Verified at schema.js:414–438: Willow has NO `gravityStrength` key in the species block (only `pruneMode: 'off', season: 0.35` after the leaf params). It defaults to 0. Per-step `gravitropism` is doing all the drooping work: L2 `0.05`, L3 `0.14`, L4 `0.18` with `susceptibility: 3.5`. Per-step gravitropism applies a small incremental deflection every segment — produces uniform curvature. Real willows have a horizontal scaffold then a sharp joint-level droop where accumulated weight wins. Setting `gravityStrength: 1.2, gravityStiffness: 0.3` on Willow and halving L3/L4 `gravitropism` would produce the correct two-part weeping motion.

### 2.4 apicalDominance + apicalContinue stacking unmonitored

`LEVEL_SCHEMA` exposes both `apicalDominance` (length scaling on side children) and `apicalContinue` (force last child to inherit parent direction). Both can be set > 0 per level. When `apicalContinue > 0`, the forced-direction child still gets `apicalDominance` length scaling — two contradictory operations on the same child. Sapling uses one apical control concept; MTree uses only `apical_dominance`. This codebase should route the chosen continuation child around the `apicalDominance` length math.

### 2.5 distortion + curveMode + torsion + twist + wobble: five overlapping perturbations

Per LEVEL_SCHEMA: `distortion` (with `distortionFreq` and `distortionType` mode), `curveMode` (sCurve/backCurve/helical), `torsion`, plus `wobble`/`wobbleFreq`. Oak L1 has `distortion: 0.32 + curveMode: 'sCurve' + curveAmount: 0.45` simultaneously. They compound multiplicatively and the user has no signal which is contributing what. MTree covers the same visual range with one `randomness` ramp. Recommendation: surface `randomnessPoints` (already in `makeDefaultLevel`) as the primary noise control and demote `distortion` to a scalar multiplier on the ramp, hidden by default.

### 2.6 randomnessPoints and startAnglePoints exist but are not in the UI

Confirmed at schema.js:296–297:
```
L.randomnessPoints = [1, 1, 1, 1, 1];
L.startAnglePoints = [0, 0, 0, 0, 0];
```
Neither key has an entry in `LEVEL_SCHEMA` (lines 239–276), so no slider/curve is rendered. Oak/Maple/etc. set non-default `randomnessPoints` in their level arrays (e.g. Oak L4: `[0.9, 1.2, 1.5, 1.8, 2.1]`) — the user can only edit them via JSON import or species preset mutation. This is a large shape-control surface hiding below the UI.

### 2.7 Hidden radius parameters that overlap with Weber-Penn radius model

schema.js:65–70 admits this: `trunkScale`, `branchThickness`, `alloExp` are hidden because "trunkScale and branchThickness overlap with baseRadius+rootFlare; alloExp is a no-op under the Weber-Penn radius model". But species presets still write them (Oak: `trunkScale: 1.15, alloExp: 2.4`). They're inert — a code-archaeology trap for any contributor reading the presets. Either delete from presets or document that they're back-compat only.

### 2.8 Crown silhouette default vs species-set 'free'

`PARAM_SCHEMA` Global shape default is `'free'` (good — emergent crown). But species like Birch override to `shape: 'tend-flame'` (schema.js:448), Willow to `shape: 'cylindrical'` (schema.js:423). These hard envelopes fight against the per-level ramps the same species also configure. If a user manually set Willow's L3 `lengthPoints` to push tip branches longer, the `cylindrical` envelope still clips them.

### 2.9 L1 base length decoupled from trunkHeight

`L.lenRatio` is the multiplier; the BASE length the multiplier acts on for L1 should be derived from `P.trunkHeight` × `L1.lenRatio`. If it's hardcoded as a constant times `globalScale` (as MTREE_COMPARISON.md and the previous research analyst indicated based on `main.js`), tall trunks have proportionally stubby L1 branches and short trunks have disproportionately long ones. MTree keys length to parent length directly.

### 2.10 Conifer cBranch* overwriting P.levels on every regen

`applyConiferConfigToP` (per project context) re-derives `P.levels[0]` and `P.levels[1]` from `cBranch*` scalars on every call. Manual edits to L1/L2 via the LEVEL_SCHEMA panel are silently discarded the next time the conifer regenerates. The LEVEL_SCHEMA panel for conifers is effectively display-only. Either document prominently or do a merge instead of replace.

---

## Section 3: What this project is MISSING

### Critical

**Density-driven branch placement** (MTree: `branches_density` origins per metre, not integer `L.children`). With integer count, changing branch spacing on a longer branch requires manually retuning `L.children`. With density, the count emerges from `parentLen × density`, and branches stay botanically consistent regardless of parent length. The visible "ring of children" artifact at `children: 4` or fewer is entirely a consequence of integer placement. Impact: every broadleaf species with fewer than 6 L1 children reads as geometric. Effort: medium (new `placementMode` enum on each level, derive count inside `spawnChildrenAlong` in main.js + tree-worker.js).

**Per-position length ramp** (`lenAtPositionPoints`). Currently `lengthPoints` modulates density of children along the parent — it's a probability weight, not a direct length multiplier keyed to spawn position. MTree's `length` ramp means "branches near the base are long, branches near the tip are short" — drawn directly. Adding a `lenAtPositionPoints: [1,1,1,1,1]` 5-pt curve sampled at `frac` in `spawnChildrenAlong` and multiplying `childLen` by it would replicate MTree's feature exactly. Impact: directly enables emergent conical/spherical/umbrella crown shapes without a hard envelope. The current `shape` enum could be deprecated.

**Compound leaf geometry** (`leafletCount`/`leafletSpread`). Per project context (PRODUCTION_AUDIT H1), the keys exist in `PARAM_DESCRIPTIONS` but the schema group `'Compound leaves'` is never added to `PARAM_SCHEMA`, making `buildParamGroup('Compound leaves')` a silent no-op. Ash, Walnut, Rowan, Horse Chestnut all require compound leaves. `leafDataB`/`leafInstB` are dead code (PRODUCTION_AUDIT M1) likely intended for compound rendering. Impact: 3–4 missing culturally important species; significant visual quality gap vs SpeedTree.

**Manifold joint meshing** (MTree: `add_child_circle` + Laplacian smoothing). Branch junctions here are handled by a chainRoot bridge node and a flare-collar radius bump. At medium camera distances the ring seam is visible at junctions with thick parents. MTree's approach merges child and parent circles into a single fan with Laplacian smoothing iterations. Effort: large (rethink `tubeFromChain` junction handling).

### Nice to Have

**Expose `randomnessPoints` and `startAnglePoints` in LEVEL_SCHEMA**. Both keys already exist in `makeDefaultLevel` and are read by the walker. Add two `LEVEL_SCHEMA` entries (e.g. type `'curve5'`) and add curve rendering in the level cards. Effort: small. Impact: surfaces "wiggly base, straight tip" and "shallow at base, perpendicular at tip" — the two most-requested per-level shape controls — without touching algorithm code.

**Density-keyed radius ramp** (`radiusAtPositionPoints`). MTree's `start_radius` ramp lets the user say "branches near the base are thin (young), mid-parent branches are thick (mature), tip branches are thin (new growth)". Currently `radiusRatio` is a fixed scalar. Effort: small (add 5-pt curve, sample at spawn, multiply child base radius).

**Space colonization hybrid for canopy fill**. Generate attraction points inside the desired crown volume, then use them as directional bias on the existing `P.attractors` system (already wired in state). NOT a full SCA implementation — using the attractor pull to steer branches toward unfilled space. Result: organically filled canopy with no overlapping branch clusters, without changing the parametric skeleton. Highest-payoff visual improvement that doesn't require a new algorithm. Effort: medium.

**Laplacian-smoothed bark at junctions**. Not mesh-manifold, just a 2-iteration weight-toward-neighborhood pass on vertices within a radius of a chainRoot bridge node. Inexpensive — once at build time on a small vertex subset. Eliminates the most visible mesh seam artifact on close-up renders.

**Vertex phase channel for wind sync** (SpeedTree pattern). All vertices on one branch share a phase offset so the branch oscillates coherently. Currently TSL wind uses `positionLocal` as proxy for phase, so adjacent vertices on the same branch oscillate independently — visible at low wind frequency as surface shimmer rather than branch sway. During `buildTubes`, write `seedT` or `branchPhase` to a custom vertex attribute, read in TSL wind nodes.

### Esoteric

**Self-organizing / light competition growth** (Palubicki 2009, The Grove). Multi-year growth simulation where buds compete for shadow-weighted light. Produces emergent apical dominance, natural crown asymmetry under occlusion, realistic branch death. Requires 3D shadow volume per bud per year. Uniquely organic interior structure. Not suitable for real-time parametric tool; relevant if "grow-by-age" simulation becomes a feature (NOTES.md pending).

**Stochastic L-system rules for inter-node variation**. Replacing per-step Perlin noise with a stochastic context-free grammar gives "bursty" variation — the irregular inter-node spacing of real hardwoods — without the frequency-artifact of repeating noise. Effort: large.

**Pirk et al. 2017 shape-space metric for preset interpolation**. Defines distance metric between trees, enables morphing path between two parameter sets. Useful for "blend Oak toward Willow" UI affordance.

---

## Section 4: Algorithms — deep dive

### 4.1 Weber-Penn (1995)

The original SIGGRAPH paper defines ~80 parameters with an "n" prefix per recursion level. Trunk and branch geometry are tapered cylinders (`nTaper` 0–3: cylindrical, linear, concave, periodic) placed along Euler-integrated curves. Per-step curvature accumulates via `nCurve` (total arc) and `nCurveBack` (second-half reversal), with `nCurveV` for variation.

**What this project implements correctly**: `lenRatio` (nLength), `radiusRatio` (nBranchRatio), `taper` (nTaper, types 0–2 only), `angle`/`angleVar` (nDownAngle/nDownAngleV), `segSplits`/`splitAngle` (nSegSplits/nSplitAngle), `curveAmount`/`curveBack` (nCurve/nCurveBack), `startPlacement`/`endPlacement`/`baseSize`, phyllotaxis variants (nRotate/nRotateV).

**What's missing from the original spec**:

1. **Taper type 3 (periodic/bamboo)** — `LEVEL_SCHEMA.taper` goes to 3.0 but the periodic oscillation path isn't implemented. Schema comment confirms: "> 2 periodic oscillation" — this code path is documented as intent but empty. Adding `r = r_base * (1 - (taper-2) * sin(π*t))` in the radius pass produces node-like swelling.

2. **nFlare with nLobes/nLobeDepth** — Weber-Penn's lobed flare is a clean radial cosine multiplier `R * (1 + nLobeDepth * cos(nLobes * θ))`. The project has `rootFlare` (ease-out cubic bell) plus separate `buttressAmount`/`buttressLobes`/`buttressHeight` (hidden, displacement-based, additive). Replacing the buttress displacement with the algebraic multiplier would be smoother and match Weber-Penn closely.

3. **nLeafShape as parametric blade** — Weber-Penn defines geometric shapes (oval, 0=triangle, 1=3-lobe oak, 2=3-lobe maple, 3=5-lobe maple, 4=compound). This project uses 8 leaf names but they're texture-based, not procedural blades. Distinction matters for export resolution-independence.

4. **Compound leaves with nLeafDistrib** — leaflets along a petiole with density profile. Dead in this project.

5. **nBranches as a float** — Weber-Penn allows `nBranches = 2.5` (probabilistically rounded each step). Project uses strict integer `L.children`. Fractional branching produces subtle irregularity across regenerations.

6. **nBaseSplits with angular distribution** — Weber-Penn distributes co-dominant leaders at angular intervals around the trunk axis. Project covers this with `trunkCount`/`trunkSplitHeight`/`trunkSplitSpread` but uses radial fan rather than the spec's distribution formula.

**Good/bad assessment**: Weber-Penn excels at deterministic, controllable, real-time parametric trees. Weak at organically irregular broadleaf canopies (integer-count children is biologically wrong). Terrible at environmental response (no light concept). Modern good-looking parametric trees augment Weber-Penn with MTree-style weight sag + density placement, or abandon it for space colonization.

**Integration with this project**: largely already done. Extensions beyond the spec (ramps, wobble, PBD, conifer path) are well-motivated.

### 4.2 Space Colonization (Runions, Lane, Prusinkiewicz 2007)

**How it works**: Seed N attraction points randomly inside a crown volume. At each growth step each point finds its nearest skeleton node within "radius of influence" ri. Nodes with associated points compute normalized average direction toward their points and grow a new node at distance `d` in that direction. Points within "kill distance" dk (dk < ri) are deleted. Repeat until consumed.

Three parameters control topology: ri determines how many points each node "sees" (large ri → bushy interconnected; small ri → sparse directional); dk determines how closely the skeleton must approach (small dk forces visiting every point); d/ri ratio controls branching events per point.

**Why broadleaf canopies look more organic**: The algorithm breaks the bilateral and radial symmetry inherent in Weber-Penn's even-spacing. Two branches growing toward the same cluster compete — one consumes the points first, leaving the other to bend toward different clusters. Asymmetry is emergent from geometry, not parameterized.

**What it's bad at**: conifers (need explicit apical dominance), determinism (same params + different point seed = very different tree), performance (O(N×M) per step; needs spatial index), explicit crown shape control (hard for tight fastigiate without careful constraint).

**Hybrid with this project**: The `P.attractors` attractor system is already wired. Seed crown volume with ~200–500 points matching the desired shape (cone for spruce, hemisphere for oak, umbrella for acacia). Push to `P.attractors` with medium strength (0.4) and kill radius ~0.8m. Parametric `walkInternode` continues handling curvature/taper/phyllotaxis/gravity — the cloud just biases heading toward open space. No new algorithm, no architectural change. Effort: small (a `seedCrownAttractors(P, shape, count)` function called before `buildTree`).

### 4.3 Self-Organizing Trees (Palubicki et al. 2009)

**How it works**: Each bud receives light Q from a shadow propagation model: `Q = max(C - s + a, 0)` where s is accumulated shadow from upper buds (cone propagating down with `s = a/b^q` per bud at depth q). Vigor V distributes Borchert-Honda style: `λ` (apical control parameter) governs continuation vs lateral split. λ near 0.5 is symmetrically monopodial; near 1.0 is excurrent conifers; near 0.0 is sympodial hardwoods. Buds above split threshold produce two new buds; below kill threshold die. Year by year.

**Light competition**: Shadow cone from upper buds suppresses lower — tree self-thins its interior without explicit "clean bole" parameter. The Grove looks better than parametric trees because it simulates this self-pruning.

**Good at**: uniquely organic interior, emergent crown asymmetry under occlusion, natural year-by-year aging.

**Bad at**: runtime (must simulate N years; each year requires shadow pass), repeatability (param tweaks cause large structural shifts), explicit user control.

**Integration**: matches the "grow-by-age" feature in NOTES.md pending. `P.growthPhase` exists but only scales deepest level length. Real BH simulation would start from seed, run `growthPhase × 20` years with simplified shadow (just bud count above), cache the grown skeleton. PBD wind layers on top. Effort: large — separate growth path. Not a slider tweak.

### 4.4 L-systems (Lindenmayer 1968 / Prusinkiewicz "ABoP" 1990)

**How they work**: Formal string rewriting. Symbols are turtle commands (F = forward, +/- = turn, [/] = stack push/pop). Rule like `F → F[+F]F[-F]F` iteratively expands. Stochastic L-systems add probability weights; parametric L-systems attach numbers to symbols.

**Relevance**: Pure L-systems require string rewriting (expensive for large trees, exactly self-similar without stochastic). Modern parametric generators like Weber-Penn ARE essentially discretized L-system approximations — the per-level parameter arrays substitute for rules. ABoP free PDF available from algorithmicbotany.org. Chapter 2 covers Honda model. Chapter 6 covers stochastic L-systems for branching irregularity.

**What's useful here**: Stochastic parametric L-systems can produce "branching bursts" — sequences of rapid subdivision then quiet stretches — without the frequency-artifact of repeating Perlin noise. Project's `segSplits`/`stochastic` approximates this but lacks memory (each step independent). A simple Markov chain — "if last step split, halve probability of next split" — would produce more natural burst spacing. Effort: small.

### 4.5 Honda Model (1971)

Honda's "Description of the form of trees" (J. Theoretical Biology 31:331). Deterministic bifurcating tree: each parent splits into exactly two daughters. Daughter lengths `r1 × parent_length` and `r2 × parent_length` (r1 ≥ r2). Branching plane fixed per junction. Three params: r1, r2, planar branching angle θ.

**What's still useful**: r1/r2 ratio directly encodes apical dominance without separate parameter — r1 near 1.0 is strong excurrent, r1 = r2 is co-dominant. The project's `branchModel: 'honda'` exists in schema.js:205 but applies fixed multipliers (per previous research: 0.94 apical / 0.86 first lateral / 0.70 other). Reasonable defaults but hardcoded. Exposing `hondaR1` and `hondaR2` as sliders and replacing the constants would make the mode genuinely useful for bifurcating species.

**Bad at**: cannot produce whorled, cannot represent conifers, deterministic bifurcation produces visually obvious patterns at low levels. Mostly historical interest; everything Weber-Penn does better.

### 4.6 Recent (2015+)

- **TreeSketch** (Longay, Runions, Boudon, Prusinkiewicz 2012, SBIM): combines space colonization with sketch-based seeding. The brush → point cloud pipeline is a direct analogue for the "crown seeder" hybrid in 4.2.
- **Interactive synthesis of self-organizing trees on GPU** (2014): GPU port of Palubicki 2009 with parallel reduction shadow pass; ~100× speedup. Project already has a WebGPU compute path — a simplified BH shadow pass could be a compute shader.
- **Shape Space of 3D Botanical Tree Models** (Pirk et al. 2017, SIGGRAPH): defines metric over tree structures; given two trees, interpolates a morphing path. Useful for preset blending UI.
- **Neural tree generators** (2021+, various): GAN/diffusion-based synthesis of tree structures from latent space. Not relevant for procedural control; mentioned for completeness.

---

## Section 5: Open-Source Projects — comparison

### Sapling Tree Gen (Blender built-in, Python, Weber-Penn)

**Algorithm**: Andrew Hale's full Weber-Penn implementation. NURBS curves skinned by mesh. Implements taper types 0–3 including periodic; `nFlare` algebraic multiplier; lobed flare cross-section; parabolic + flat + cylinder + ellipsoid pruning envelopes. Leaves as instanced objects.

**Good**: most parameter-complete; pruning envelope flexible; taper type 3 (bamboo-node swelling).

**Bad**: no gravity sag; no emergent crown shape; Blender-only; output is curves, not renderable mesh.

**What to steal**: taper type 3 implementation (add to `taper > 2` branch in radius pass); `nLobes`/`nLobeDepth` algebraic flare formula (replace `buttressAmount` displacement with `R * (1 + depth * cos(lobes * θ))`).

### Arbaro (Java, Weber-Penn)

**Algorithm**: Most parameter-complete Weber-Penn ever (all 80). POV-Ray output. Predates Sapling.

**Good**: complete parameter set; full per-species parameter tables from the original paper appendix (Black Tupelo, Weeping Willow, Quaking Aspen, Black Oak).

**Bad**: Swing UI; POV-Ray only; abandoned 2004; no gravity sag; no real-time.

**What to steal**: Arbaro's XML preset files. The project's Tupelo/Aspen/Willow presets were likely derived from these. Worth diffing against current presets to find lost parameter values.

### MTree / Modular Tree (Maxime Herpin, Blender, C++)

Already documented in `MTREE_COMPARISON.md`. Key takeaways:
- Density-driven placement (origins/metre, not integer count) — biggest algorithmic gap.
- `randomness` ramp and `start_angle` ramp keyed to position along parent — emergent crown shape.
- Recursive weight + gravity post-pass — authentic joint-level droop.
- Pipe-radius `constant_growth` for secondary thickening.
- 27 total parameters vs this project's ~110 — simplicity by design.

**What to steal** (priority): density-as-spacing placement; per-position length ramp; verify gravity sag rotates entire subtree at each sagged joint.

### dgreenheck/ez-tree (JavaScript/Three.js)

Already documented in `EZTREE_COMPARISON.md`. Remaining steal: the `trellis force` is an axis-aligned grid attractor — structurally identical to `P.attractors` with multiple world-space points in a grid. Could replicate without algorithm addition.

### proctree.js (supereggbert, JavaScript)

**Algorithm**: Not Weber-Penn. Custom recursive with `clumpMax`/`clumpMin` for radial spread, `branchFactor` for sub-branching, `dropAmount`/`growAmount` for gravity/phototropism, `twistRate` for helix, `taperRate` for radius falloff. Two outputs: tree mesh and twig mesh.

**Good**: ~200 LOC; integrated via donmccurdy/glTF-Procedural-Trees export pipeline; quick acceptable results.

**Bad**: no parametric species character; no biology basis; constant drop/grow; no leaves (just twig geometry).

**What to steal**: nothing algorithmically. The glTF export wrapper is interesting but already covered.

### The Grove (Blender, paid, biologically-inspired)

**Algorithm**: Close relative of Palubicki 2009. Tracks shade, weight, growth power, health per branch as vertex layers. `Fatigue` parameter controls whether bends are permanent (real wood sets) or spring back. Light threshold for side-branch development. Year-by-year simulation. v2.3 (March 2026) focuses workflow.

**Good**: most organically convincing broadleaf trees of any tool; shade-driven self-pruning interior; natural weight-bend interaction.

**Bad**: paid; Blender-only; no real-time preview; output is static mesh.

**What to steal conceptually**: the `Fatigue` parameter. Project's PBD currently springs back to rest pose. A fatigue multiplier on the rest anchor (0 = full springback, 1 = rest drifts toward current deformation) would make grab-and-bend feel like shaping clay. One slider on `PHYSICS_SCHEMA`.

### SpeedTree (commercial, industry standard)

Feature list relevant to this project's gaps:
- **Vertex color channels**: AO per-vertex, wind phase per-clump, subsurface gradient, branch semantic. Project bakes none. Wind phase channel = quick win for synchronized branch sway.
- **Wind LOD**: SpeedTree grades wind by camera distance — close = full PBD + TSL; medium = TSL only; far = billboard no wind. Project's LOD could extend to wind response.
- **Hand-editing of individual branches**: per-branch length/angle/curve overrides as manual edits on top of parametric. Project's RMB grab is the closest analogue but it's dynamic-physics drag, not persistent.
- **Per-branch color variation**: SpeedTree bakes a color variation UV for per-branch age/health tinting. Project has `leafColorVar` for leaves, nothing for branches.

---

## Section 6: Concrete recommendations ranked by ROI

### Rec 1: Expose `randomnessPoints` and `startAnglePoints` in the Level card UI
**Why**: Both keys exist in `makeDefaultLevel()` and are read by the walker. Currently unreachable from UI. They control "wiggly base, straight tip" and "shallow at base, perpendicular at tip" — the two highest-impact per-level shape controls.
**Effort**: Small. Two entries in `LEVEL_SCHEMA` (e.g. `{ key: 'randomnessPoints', type: 'curve5', label: 'Wiggle ramp' }`) and curve rendering in `renderLevels()`. `sampleDensityArr` already handles them.
**Risk**: Low.
**Files**: `schema.js` (LEVEL_SCHEMA), `main.js` (renderLevels UI).

### Rec 2: Remove `pruneMode: 'ellipsoid'` from Oak, Maple defaults
**Why**: Oak L1 `angle: 1.25 + curveAmount: 0.45 + pruneRadius: 7.0 / pruneHeight: 5.0` produces visible mid-arc clipping. Maple's decussate cage at `pruneRadius: 5.5 / pruneHeight: 5.0` looks like a clipped sphere. Real oaks/maples don't need a hard envelope — the ramps shape the silhouette.
**Effort**: Small. Schema change; tighten `endPlacement` slightly to compensate.
**Risk**: Low. Existing JSON presets unaffected.
**Files**: `schema.js` (Oak, Maple, plus audit Aspen/Tupelo/Lime/etc — there are 12+ ellipsoid presets in lines 681–825).

### Rec 3: Fix Willow — add gravityStrength, halve per-step gravitropism
**Why**: Verified at schema.js:414–438 — Willow has NO `gravityStrength` (defaults to 0). All weeping is from per-step `gravitropism` (L3: 0.14, L4: 0.18, susceptibility 3.5). Produces uniform curvature instead of horizontal-then-droop joint behavior.
**Effort**: Small. Add `gravityStrength: 1.2, gravityStiffness: 0.3`; halve L3/L4 `gravitropism`.
**Risk**: Low.
**Files**: `schema.js` (Willow).

### Rec 4: Add lenAtPositionPoints — length ramp keyed to spawn position
**Why**: Enables emergent crown silhouettes without `shape` envelope. A conical crown is `lenAtPositionPoints = [1, 1, 0.7, 0.4, 0.1]` on L1. Currently `lengthPoints` is a density probability weight, not a length multiplier.
**Effort**: Small. Add to `makeDefaultLevel()` as `[1,1,1,1,1]`. Sample at `frac` in `spawnChildrenAlong`. Mirror in `tree-worker.js`. Add curve to LEVEL_SCHEMA.
**Risk**: Low. Neutral default preserves behavior.
**Files**: `schema.js`, `main.js`, `tree-worker.js`.

### Rec 5: Density-driven branch placement mode
**Why**: Fixes "ring of children" artifact at low counts. Matches MTree biology. Makes count respect parent length changes automatically.
**Effort**: Medium. Add `placementMode: 'count' | 'density'` enum. In density mode, derive count as `round(L.density × parentLen × (endPlacement - startPlacement))` inside `spawnChildrenAlong`. Mirror in worker. `signalDecay` should use `frac` not child index.
**Risk**: Medium (changes child count for existing presets unless default is `'count'`).
**Files**: `schema.js`, `main.js`, `tree-worker.js`.

### Rec 6: Crown attractor seeder (space colonization light)
**Why**: Seeds `P.attractors` from a point cloud matching crown shape before building. Branches naturally fill open space. No new algorithm — reuses existing attractor system.
**Effort**: Medium. Implement `seedCrownAttractors(P, shape, count, killRadius)`. Add toggle to Global schema. Remove consumed points (kill-radius check in walker attractor loop).
**Risk**: Medium (interactions with manually placed user attractors need separation).
**Files**: `main.js` (new function, walker attractor loop, Global schema).

### Rec 7: Implement taper type 3 (periodic/bamboo)
**Why**: `LEVEL_SCHEMA.taper` schema comment at line 246 says "> 2 periodic oscillation" but the path isn't implemented. Users setting `taper: 2.5` get the cone path, not oscillating internodes.
**Effort**: Small. In radius pass, add `taper > 2` branch: `r = r_base * (1 - (taper-2) * sin(π * t))`. Mirror in worker.
**Risk**: Low.
**Files**: `main.js` (radius pass), `tree-worker.js`.

### Rec 8: apicalDominance / apicalContinue mutual exclusion
**Why**: When `apicalContinue > 0`, the forced-direction child still gets `apicalDominance` length scaling — contradictory. `apicalContinue` should bypass apical length math for that child.
**Effort**: Small. One conditional in `spawnChildrenAlong` around the apical-dominance length multiplier.
**Risk**: Low. No species presets currently set both > 0.
**Files**: `main.js`, `tree-worker.js`.

### Rec 9: Honda r1/r2 as sliders
**Why**: `branchModel: 'honda'` uses hardcoded multipliers. Exposing `hondaR1`/`hondaR2` (defaults 0.94/0.86) makes the mode genuinely useful for bifurcating species.
**Effort**: Small.
**Risk**: Low.
**Files**: `schema.js` (Global group), `main.js` (Honda post-multiply block).

### Rec 10: L1 base length tied to trunkHeight
**Why**: If hardcoded as `9.0 * P.globalScale`, a 24m Redwood and 8m Oak get same base L1 length. Should be `P.trunkHeight * L1.lenRatio`.
**Effort**: Small. One-line change.
**Risk**: Medium. Changes proportions for every existing species; presets may need `lenRatio` retuning.
**Files**: `main.js`.

### Rec 11: Vertex phase channel for wind sync
**Why**: TSL wind currently uses `positionLocal` as phase proxy → adjacent vertices on same branch oscillate independently → low-frequency surface shimmer instead of branch sway. Bake per-chain phase to vertex attribute.
**Effort**: Medium. Write `seedT`/`branchPhase` in `buildTubes`. Read in `barkWindDisp`/`leafWindDisp` TSL nodes.
**Risk**: Low.
**Files**: `tree-worker.js` (buildTube attribute), `main.js` (TSL wind nodes).

### Rec 12: Add Compound leaves group OR delete the dead reference
**Why**: PRODUCTION_AUDIT H1: `buildParamGroup('Compound leaves')` is a no-op. PRODUCTION_AUDIT M1: `leafDataB`/`leafInstB` dead. Either implement (enables Ash, Walnut, Rowan, Horse Chestnut species) or delete.
**Effort**: Small (delete). Medium (implement).
**Risk**: Low (delete).
**Files**: `main.js`, `schema.js`.

### Rec 13: Remove inert hidden radius params from species presets
**Why**: schema.js:65–70 documents that `trunkScale`, `branchThickness`, `alloExp` are no-ops under Weber-Penn radius. Yet Oak: `trunkScale: 1.15, alloExp: 2.4`. Misleading for any contributor reading presets.
**Effort**: Small. Strip from species blocks; keep schema entries hidden for back-compat JSON load.
**Risk**: Low.
**Files**: `schema.js`.

### Rec 14: Document conifer LEVEL_SCHEMA panel as display-only
**Why**: `applyConiferConfigToP` clobbers manual L1/L2 edits on regen. Either document prominently or merge instead of replace.
**Effort**: Small (doc) or small (Object.assign instead of replace).
**Risk**: Low.
**Files**: `main.js` (`applyConiferConfigToP`).

### Rec 15: Fatigue multiplier on PBD rest anchor
**Why**: Project's PBD springs back to rest pose. Fatigue 0..1 makes rest drift toward current deformation, so RMB grab-and-bend feels permanent.
**Effort**: Small. One slider on PHYSICS_SCHEMA, one mix in stepSim's anchor update.
**Risk**: Low.
**Files**: `schema.js` (PHYSICS_SCHEMA), `main.js` (stepSim).

---

## Section 7: Reading list / sources

### Papers (author + year + title — search queries provided where URLs not verified)

- Weber, J. and Penn, J. (1995). "Creation and Rendering of Realistic Trees." SIGGRAPH 1995. PDF accessible via Duke CS course pages (search: "Weber Penn 1995 creation rendering realistic trees p119-weber.pdf").
- Runions, A., Lane, B., Prusinkiewicz, P. (2007). "Modeling Trees with a Space Colonization Algorithm." Eurographics Workshop on Natural Phenomena. algorithmicbotany.org/papers/colonization.egwnp2007.html
- Palubicki, W., Horel, K., Longay, S., Runions, A., Lane, B., Měch, R., Prusinkiewicz, P. (2009). "Self-organizing tree models for image synthesis." ACM SIGGRAPH 2009 (TOG 28:3). algorithmicbotany.org/papers/selforg.sig2009.html
- Prusinkiewicz, P. and Lindenmayer, A. (1990). "The Algorithmic Beauty of Plants." Springer. Full text free at algorithmicbotany.org/papers/#abop — Chapter 2 (Honda), Chapter 6 (stochastic L-systems).
- Honda, H. (1971). "Description of the form of trees by the parameters of the tree-like body." Journal of Theoretical Biology 31:331–338. (Search: "Honda 1971 description form trees parameters JTB").
- Longay, S., Runions, A., Boudon, F., Prusinkiewicz, P. (2012). "TreeSketch: Interactive Procedural Modeling of Trees on a Tablet." SBIM 2012. algorithmicbotany.org/papers/TreeSketch.SBM2012.html
- Pirk, S. et al. (2017). "Shape Space of 3D Botanical Tree Models." ACM SIGGRAPH 2017. (Search: "Pirk 2017 shape space botanical tree models").
- Borchert, R. and Honda, H. (1984). "Control of development in the bifurcating branch system of Tabebuia rosea: a computer simulation." Botanical Gazette 145:184–195.

### Open-source projects (verified GitHub strings)

- `dgreenheck/ez-tree` — Three.js Weber-Penn-inspired (MIT, npm `@dgreenheck/ez-tree`). Full analysis in `EZTREE_COMPARISON.md`.
- `MaximeHerpin/modular_tree` — Blender MTree C++ engine. Full analysis in `MTREE_COMPARISON.md`.
- `abpy/improved-sapling-tree-generator` — Enhanced Blender Sapling.
- `supereggbert/proctree.js` — Compact ~20-param tree library.
- `donmccurdy/glTF-Procedural-Trees` — proctree.js + glTF 2.0 export.
- `openalea/weberpenn` — Python Weber-Penn implementation, full param set.
- `dsforza96/tree-gen` — Space colonization in JavaScript (search: github.com/dsforza96/tree-gen).

### Commercial — feature references

- SpeedTree Modeler documentation: vertex colors, wind LOD overview (search: "SpeedTree vertex colors documentation").
- The Grove 3D devblog: thegrove3d.com/releases/ — release notes for v5 through v2.3 document algorithm internals.
- Xfrog feature list (search: "xfrog feature comparison").
- TreeIt by Frecle (search: "TreeIt Frecle procedural tree").

### Verified URLs consulted during research

- https://algorithmicbotany.org/papers/colonization.egwnp2007.html
- https://algorithmicbotany.org/papers/selforg.sig2009.html
- https://history.siggraph.org/learning/creation-and-rendering-of-realistic-trees-by-weber-and-penn/
- https://dl.acm.org/doi/10.1145/218380.218427
- https://dl.acm.org/doi/10.1145/1531326.1531364
- https://github.com/dgreenheck/ez-tree
- https://github.com/MaximeHerpin/modular_tree
- https://github.com/abpy/improved-sapling-tree-generator
- https://github.com/supereggbert/proctree.js
- https://www.thegrove3d.com/
