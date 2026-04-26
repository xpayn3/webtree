# Sidebar Audit

Audit date: 2026-04-25. Read-only. Scope: every visible (non-`hidden`) entry in
`PARAM_SCHEMA`, `LEVEL_SCHEMA`, `CONIFER_SCHEMA`, `BUSH_SCHEMA`, `PHYSICS_SCHEMA`
plus the inline `WIND_SCHEMA` in `main.js`.

Methodology: enumerate every visible key, grep for `P.<key>` / `L.<key>` /
`Lvl.<key>` reads in `main.js` and `tree-worker.js`, then walk each consumer to
confirm the read is reachable. 152 top-level visible params + 29 visible level
params + 11 physics + 6 wind = 198 sliders / selects audited.

Headline: there are NO truly dead sliders that render but write to nothing.
Every UI control resolves to at least one consumer read. The real problems
are softer — duplicate keys, schema-vs-implementation contradictions, slider
step/round mismatches, schema-out-of-bounds species presets, and a couple of
mode-gated controls that are inert in the user's currently-selected mode.

---

## 🔴 Dead sliders (no read sites)

None of the visible sliders are wholly dead at the consumer level. The
suspicious-looking zero-grep hits (`P.barkLargePattern`, `P.barkMicroPattern`)
turned out to be read via the bark-recipe layer at `main.js:2700-2701` (`Ps =
P` rebind, then `Ps.barkLargePattern ?? recipe.largePattern`). All 152 top-level
keys have at least one reachable consumer.

Closest things to a "dead UI knob" — both belong on the cleanup list anyway:

- The `Compound leaves` group call at `main.js:8557` is a silent no-op because
  no `'Compound leaves'` group exists in `PARAM_SCHEMA`. This is already
  flagged in `PRODUCTION_AUDIT.md` H1; mentioned here only because tooltips for
  `leafletCount` / `leafletSpread` (`schema.js:1140-1141` in the older file —
  in current `schema.js` they're absent) hint at sliders that never render.
- The two `leafStem*` tooltip-only entries (`leafStemColor`, `leafStemTaper`)
  flagged at PRODUCTION_AUDIT M2 / M3 are still tooltip-only; no slider, but
  the tooltip text is reachable from any keyword search and looks like a
  promise the UI doesn't keep.

---

## 🟠 Effectively dead (read but in unreachable / mode-gated code path)

Five visible sliders only do something when a sibling control is in a
specific mode. They are not bugs — they're mode-conditional — but they will
read as "dead" to any user who hasn't flipped the gating control.

- `hondaR1`, `hondaR2` (Global card). Read at `main.js:4623-4625` and
  `tree-worker.js:596-597`, but inside `if (_branchModel === 'honda')`. Default
  `branchModel` is `'weber-penn'`, so the two Honda sliders are inert until the
  user changes the Branch formula select. Worth a small "(Honda only)" hint on
  the labels, or grey-them-out when the formula select is anything else.

- `trunkSplitSpread`, `trunkSplitHeight` (Trunk card). Read at
  `main.js:4693-4697` / `tree-worker.js:632-634`, but `useDelayedSplit` only
  fires when `trunkCount > 1 && trunkSplitHeight > 0`, and `trunkSplitSpread`
  is only consulted when `trunkCount > 1`. Default `trunkCount = 1`, so these
  two sliders do nothing on a default tree. Same UX fix: grey out when
  `trunkCount === 1`.

- `density` (per-level). Read at `main.js:4459-4460` /
  `tree-worker.js:464-465`, but only consulted when `L.placementMode ===
  'density'`. With the default `placementMode === 'count'`, the `density`
  slider is inert. The two are mutually exclusive — the `children` slider
  becomes inert under `'density'` mode and `density` becomes live. Either
  collapse them into a unified row that swaps in based on the mode select, or
  visibly grey the inert one.

- `lodDist1` / `lodDist2` / `lodDist3` (LOD card). Read at
  `main.js:8251-8253`, but only fires inside `if (P.lodAutoSwitch === 'on' &&
  treeMesh && _lodPreviewMeshes.size > 0)` (`main.js:14760`). Until the user
  bakes at least one LOD slot AND flips `lodAutoSwitch` to `'on'`, all three
  distance sliders are no-ops. Default state ships with empty `_lodPreviewMeshes`.

- `apicalContinue` (per-level). Read at `main.js:4617` (`apicalLenBoost = 1 +
  apicalContinue * 0.6`) but `isApicalChild` is only `true` when the per-level
  `apicalDominance` calculation has elected an apical child for the current
  parent step. With `apicalDominance === 0` (the default for most species
  presets) very little apical work happens, so a user changing
  `apicalContinue` on its own and seeing nothing happen is correct but
  surprising. Treat as 🟣 (label vs effect) — see below.

---

## 🟡 Fighting / clobbered

- `leafSheen` is declared TWICE in `PARAM_SCHEMA` (`schema.js:192` visible
  default `0.4`, then `schema.js:206` hidden default `0`). The init loop at
  `main.js:4054` (`for (const g of PARAM_SCHEMA) for (const p of g.params)
  P[p.key] = p.default`) walks the schema in order, so the second
  (hidden) declaration **overwrites** the first: `P.leafSheen = 0` on every
  startup. The visible "Wax sheen" slider on a fresh tree therefore reads
  `0`, not the schema-declared `0.4`. Effect on the rendering pipeline:
  the leaf material's sheen contribution is zero by default until the user
  actively drags the slider. The slider is otherwise functional — drag it
  and it works — but the schema's stated default is a lie. Fix: delete the
  hidden duplicate at line 206, or rename the hidden one (it was probably
  meant to be a separate "advanced" sheen knob alongside the wax sheen).

- `barkStyle` preset switches load fresh values into every `barkVert*`,
  `barkHoriz*`, `barkLarge*`, `barkMicro*`, `barkGrain`, `barkBumpStrength`
  slider via `_loadBarkPreset(style)` at `main.js:3942`. This is intentional
  on style change (the comment confirms: "After that, layer-slider edits
  stand on their own"), and is correctly gated by `style !==
  _activeBarkStyle` so it doesn't fire every frame. Not a fight — but it
  IS a one-shot clobber, and worth knowing about: any custom bark-layer
  edits made before the user picks a different style are silently
  destroyed by the preset reload.

- Cherry / Baobab / ScotsPine species presets pass `pruneMode: 'off'`
  while at the same time setting `pruneRadius`, `pruneHeight`, `pruneCenterY`
  on the species. None fight — pruning code at `main.js:8207-8213` honours
  `pruneMode === 'off'`. But the dead numbers in the species body are
  confusing during preset-edit work. Pure cosmetic.

No other genuine clobbering pairs were found. The bark Saturation /
Brightness fix (recently moved to in-shader uniforms `_barkSatU`/`_barkBrightU`
at `main.js:3976-3977`) is holding — saturation now actually saturates
(`mix(luminance, tex.xyz, _barkSatU)` at line 3112) instead of silently
no-op'ing on a white CPU multiplier. The `applyBarkMaterial()` post-style
sync is also correct: `barkMat.color.copy(_mossTint).multiplyScalar(brightness)`
keeps the fallback path consistent without competing against the shader path.

---

## 🔵 Range / step / default issues

- `barkVertFreq` (`schema.js:107`). Slider step `0.25`, range `0..20`, but
  `generateBarkTexture()` rounds the value to an integer at
  `main.js:2711` (`p.vertFreq = Math.max(0, Math.round(p.vertFreq))`).
  Anything between e.g. `4.0` and `4.49` is identical at the texture level.
  The step is purely cosmetic. Either bump step to `1` (matches the
  consumer) or keep step `0.25` and remove the round (a quick test for
  texture seam visibility at non-integer freqs is needed first — the seam
  comment at lines 2704-2710 is the reason for the round). Same applies in
  miniature to:
  - `barkLargeFreq` step `0.1` rounded to int (`main.js:2713`).
  - `barkHorizFreq` is already step `1` (no waste).
  - `barkMicroFreq` is already step `1` (no waste).

- `wobbleFreq` (per-level, `schema.js:322`). Slider min `0`, but the
  override-resolution at `main.js:5072` and `tree-worker.js:935` uses
  `(Lvl.wobbleFreq ?? 0) > 0 ? Lvl.wobbleFreq : globalFreq` — so
  `wobbleFreq === 0` means "inherit global", indistinguishable from "the
  user set it to 0 to disable freq". `wobble` itself uses the same sentinel
  but its consumer doesn't break at 0 because amplitude 0 visibly disables
  wobble anyway. Fix: bump `wobbleFreq` min to `0.1` (matches global
  `branchWobbleFreq` min `0.3`) so the override slot is always positive
  when the user touches it. Already noted in PRODUCTION_AUDIT M8.

- `mossLum` (`schema.js:146`). Range `0.05..0.6`, step `0.02`. (0.6 - 0.05) /
  0.02 = 27.5 — last reachable value is `0.59`, the declared `0.6` max is
  unreachable. Fix: change min to `0.06` or max to `0.61` so the range / step
  is integral. Cosmetic. (Already in PRODUCTION_AUDIT L1.)

- `vineLum` (`schema.js:229`). Same: range `0.05..0.8`, step `0.02`. (0.75 /
  0.02) = 37.5 — `0.79` is the max reachable.

- `stubsLum` (`schema.js:281`). Same: range `0.05..0.6`, step `0.02`.

- `cBranchStart` (`schema.js:1254` / line 1254 in trimmed schema). Range
  `0..0.95`, step `0.02`. 0.95/0.02 = 47.5 — reachable max is `0.94`.

- `cBranchLen` (`schema.js:1257`). Range `0.15..1.8`, step `0.02`.
  1.65/0.02 = 82.5 — reachable max is `1.79`.

- `cTwigLen` (`schema.js:1263`). Range `0.3..0.95`, step `0.02`. 0.65/0.02 =
  32.5 — reachable max `0.94`.

- `bUpright` (`schema.js:1297`). Range `-1..1`, step `0.02`. 2/0.02 = 100,
  exactly integral — fine. Listed only for completeness.

- `barkVertSharp` step `0.5` over `0.5..12` — works. `barkHorizSharp` step
  `0.5` over `0.5..20` — works.

- `pruneCenterY` default `10`, range `0..40`. If the user picks a tall
  species (Redwood `trunkHeight: 24`) the default `10` puts the prune
  ellipsoid down where the trunk is, not the crown. The species presets
  explicitly override `pruneCenterY` per species, so this only bites
  when the user toggles `pruneMode` to `'ellipsoid'` on a Custom tree.
  Not a schema bug — minor UX wart.

- `barkBrightness` default `1.0` against range `0.3..2.0`. Centred at
  `(2.0 - 0.3)/2 + 0.3 = 1.15`, default is offset slightly to the left.
  Brightness swatch gradient (`main.js:8520-8525`) is centred at `0.5`
  normalised position, which corresponds to `1.15` in this slider's
  units — so the swatch shows the slider as slightly off-centre on a
  default tree. Cosmetic.

- `leafTransmission` default `0.6` (high). Combined with `leafThickness`
  default `0.18`, certain species presets effectively burn the leaves
  out at full transmission. Out of audit scope (this is a tuning issue,
  not a schema bug) but worth a sanity check by Luka.

---

## 🟣 Label-vs-effect mismatches

- `diebackOuter` (Canopy dieback). Slider label: "Outer shell". Tooltip:
  "Threshold for the outer shell that survives — higher = thicker live
  canopy". Implementation at `main.js:5932`:

  ```
  interior = max(0, 1 - rxz / max(0.01, outerFrac)) * (1 - max(0, ry - 0.6) * 2.5);
  if (interior > 0 && Math.random() < interior * strength) { /* kill leaf */ }
  ```

  As `outerFrac` grows, `1 - rxz/outerFrac` grows for any leaf with
  `rxz > 0`, so MORE leaves are eligible for the kill probability. So
  higher `diebackOuter` = MORE leaves dropped, the OPPOSITE of the
  tooltip's "thicker live canopy". Either invert the formula (treat
  `outerFrac` as the radial threshold below which leaves are SAFE), or
  rewrite the tooltip + label to match reality (e.g. "Inner kill zone
  fraction — higher = larger cull region"). This one will trip up every
  user who reads the tooltip first.

- `mossThreshold` (Bark / Moss). Slider label: "Moss coverage". Tooltip:
  "Coverage threshold (lower = more moss)". Implementation at
  `main.js:3115`: `mask = smoothstep(threshold-0.25, threshold,
  upFactor) * mossAmount` — higher threshold means fewer pixels exceed
  it, so LESS moss. Tooltip text is correct ("lower = more moss") but
  the slider label "Moss coverage" leads the user to assume "drag right
  for more coverage", which is wrong. Either rename the slider to
  "Moss threshold" (so the label aligns with the tooltip and the
  implementation), or invert the underlying expression so dragging right
  increases coverage. Tooltip alone is not enough — most users don't read
  it, and this is a pure UX confusion.

- `apicalContinue` (per-level, "Central leader"). Tooltip says "Force
  the last child to inherit parent direction with a length boost (central
  leader)". Implementation at `main.js:4617` only multiplies length by `1
  + apicalContinue * 0.6` IF `isApicalChild` is true (line 4617), which
  in turn is only true when the parent's apical-dominance roll selected
  an apical continuation. With `apicalDominance === 0` (default for many
  presets) you can drag `apicalContinue` to 1.0 and see nothing change
  on the tree. The slider is honest about its effect mathematically —
  but the label "Central leader" suggests a strong primary trunk
  continuation, which only fires when `apicalDominance > 0`. Worth
  either a "(needs apical dominance > 0)" hint, or tying the two
  together so `apicalContinue > 0` implies a minimum apical dominance.

- `leafSheen` shadow-default. Label "Wax sheen", schema default `0.4`,
  but runtime default is `0` because the hidden duplicate at line 206
  rewrites it. Already covered under 🟡; mentioned again because the
  label "Wax sheen" with default-looking-mid-position-but-actually-zero
  is exactly the kind of thing a user would call "label vs effect
  mismatch" before they look at the schema.

- `bSpread` (Bush card, "Spread (m)"). Tooltip says "Canopy diameter".
  Implementation at `main.js:6910` derives `pruneRadius = (P.bSpread *
  0.5) / compactDiv` — i.e. the prune **radius** is half of `bSpread`,
  which is consistent with diameter. Correct, but slightly buried —
  worth knowing the slider IS in diameter and not radius.

- `barkRotation` (Bark / Mapping, "Grain angle"). Slider unit is
  degrees, range `-90..90`. Implementation at `main.js:3989` converts to
  radians and applies via `barkAlbedo.rotation = rot`. Correct but the
  display unit shows just a number — a `°` suffix in the slider would
  make the unit clear at a glance. Cosmetic.

---

## 🟤 Species presets out-of-bounds

These species values get silently clamped by the schema sanitizer
(`sanitizeNum` walk at `main.js:7657-7658`) when the user loads the
preset. The user sees a clamped value, not the intent.

- **Cherry** sets `baseSize: 0.7` (`schema.js:476`). PARAM_SCHEMA range
  is `0..0.6` (`schema.js:257`). Clamped to `0.6`. Visible effect: the
  cherry's mushroom-dome silhouette starts slightly lower than the
  preset author intended. If the intended maxis really `0.7`, raise the
  slider max accordingly.

- **Baobab** sets `baseSize: 0.65` (`schema.js:629`). Same clamp to `0.6`.
  Probably needs the slider max raised to `0.8` so the famously bare
  baobab bole renders as designed.

- **Beech** sets `barkHue: -0.05` (`schema.js:816`). Slider range
  `0..1` (`schema.js:131`) — clamped to `0`. Beech almost certainly
  wanted a slight cool/blue cast, which would need the slider min lowered
  to e.g. `-0.2` to allow negative hue offsets. Currently the negative
  is silently dropped.

- **Beech** / **PlaneTree** / **Eucalyptus** all set `barkLum`
  (`schema.js:816`, `843`, `950`). The runtime renamed the parameter to
  `barkBrightness` long ago — `P.barkLum` is never read anywhere in
  `main.js` or `tree-worker.js`. The three preset values are
  (currently) doing nothing. Either rename the preset key to
  `barkBrightness`, or add a back-compat alias at preset-load time.

- **Olive**, **Sassafras**, **Acacia** (?), **JapaneseMaple** all set
  per-level `torsion: 0.x` (`schema.js:614`, `776`, `937`). `L.torsion`
  is never read in either file (verified — zero hits). Tooltip exists
  (`schema.js:1424`), no slider exists, no consumer exists. The presets
  are leaving an artifact from a planned-but-never-shipped torsion
  feature. Either implement torsion as a per-level effect (the tooltip
  describes "Rotates noise perturbation around the growth axis"), or
  delete the preset values and the tooltip.

- **Cherry** levels[0] sets `phototropism: 0.04` (`schema.js:489`).
  `L.phototropism` IS read at `main.js:4262` (`tropP =
  normalizeTropism(L.phototropism, 'photo')`). This is fine — the value
  is in-range — but worth flagging that `phototropism` doesn't appear
  in the visible LEVEL_SCHEMA: it's only editable through the
  `TropismPanel` widget at `main.js:9829-9842`. Not a sidebar slider,
  but if a user clones a Cherry preset and tries to find phototropism
  in the slider list they won't see it under the standard rows.

- **Olive** levels[0..1] sets `phyllotaxis: 'opposite'` —
  `LEVEL_SCHEMA.phyllotaxis` options are `['spiral', 'opposite',
  'whorled', 'decussate']`, so `'opposite'` is valid. Listed only to
  confirm I checked; no issue.

- All conifer presets stay within the conifer schema ranges. All bush
  presets stay within bush ranges. Spot-checked all `cTwigCount`,
  `cBranchCount`, `cConeCount`, `bThickness`, `bUpright`, `bGnarl`
  presets — all in range.

---

## 🟢 Recommendations

Ordered by ROI (signal-per-effort), highest first.

1. **Delete the duplicate `leafSheen` declaration** (`schema.js:206`).
   - File: `schema.js:206` (delete the hidden duplicate).
   - Effort: small. Risk: low.
   - Why: removes a contradiction where the schema's stated default `0.4`
     for "Wax sheen" is silently clobbered to `0` at startup. One-line
     fix; the visible slider at line 192 is the canonical entry.

2. **Fix the `diebackOuter` semantic inversion** (label / tooltip / formula).
   - File: `main.js:5932` (formula) OR `schema.js:285,1551` (label / tooltip).
   - Effort: small. Risk: low (dieback is opt-in; default `dieback === 0`
     means most users never trigger this code path).
   - Why: the tooltip and label currently lie about what the slider does.
     Pick one of two fixes: (a) invert the formula so `outerFrac` is the
     SAFE-zone radial fraction (matches tooltip), or (b) rewrite the
     label to "Inner kill radius" and update the tooltip. (a) is the more
     intuitive UX — users reading "Outer shell" expect higher = preserve
     more.

3. **Bump `wobbleFreq` slider min from 0 to 0.1** (`schema.js:322`).
   - File: `schema.js:322`. Effort: small. Risk: low.
   - Why: aligns the slider's reachable range with the
     `(Lvl.wobbleFreq ?? 0) > 0 ? override : inherit` gating contract
     (`main.js:5072`, `tree-worker.js:935`). Currently dragging the
     slider to exactly `0` is indistinguishable from "I don't want to
     override," so the override sentinel and the user's "disable freq"
     gesture collide. Already noted in PRODUCTION_AUDIT M8.

4. **Clamp species presets `Cherry.baseSize` and `Baobab.baseSize` OR raise the
   `baseSize` slider max** (`schema.js:257`, `476`, `629`).
   - File: choose one. Effort: small. Risk: low.
   - Why: both species are silently clipped from `0.7`/`0.65` to `0.6`
     today. Raising the slider max to `0.8` is the safer fix because
     it preserves preset intent without requiring per-species rebalancing.
     Cap the slider's min too if numerical stability needs it.

5. **Fix `Beech.barkHue: -0.05` / consider widening the `barkHue` slider
   range to allow negative hue offsets**, OR tighten Beech's preset to
   a positive hue.
   - File: `schema.js:816` (Beech) and/or `schema.js:131` (slider min).
   - Effort: small. Risk: low.
   - Why: `barkHue` is semantically a hue WHEEL position [0..1] so a
     negative value is unusual — Beech probably wanted a tint
     adjustment, which is `barkTint` not `barkHue`. Easiest fix: drop
     the `-0.05` from Beech.

6. **Rename the moss "coverage" slider to "Moss threshold"** OR invert
   the smoothstep so high = more moss.
   - File: `schema.js:144,1487`. Effort: small. Risk: low.
   - Why: the label currently fights the implementation, the tooltip
     warns the user about it, but most users won't read the tooltip.
     Either way, label and behaviour need to align.

7. **Mode-gate the `hondaR1`/`hondaR2`/`density`/`children`/`trunkSplit*`
   sliders visually** (e.g. `disabled` attribute or a CSS dim) when
   their parent select is not in the right mode.
   - Files: `main.js` createSliderRow + per-card render code (Trunk,
     Global, per-level row). Effort: medium. Risk: low.
   - Why: five (or more) sliders today look live and ready when in fact
     they do nothing in the default state. A simple `aria-disabled` +
     `pointer-events: none` + 50% opacity covers it. Bonus: do the
     same for `lodDist1/2/3` until at least one LOD slot is baked.

8. **Strip `barkLum` from species presets and the unused `torsion`
   per-level value** OR implement them.
   - Files: `schema.js:816,843,950` (`barkLum`), `schema.js:614,776,937`
     (`torsion`). Effort: small (delete) / medium (implement).
     Risk: low (delete) / medium (implement — torsion is non-trivial in
     the perlin-based jitter pass).
   - Why: zero-consumer keys in saved presets are landmines for the
     next round of preset tuning ("why doesn't this preset look right?").

9. **Snap the bark-frequency slider steps to integers** (`barkVertFreq`
   step `1`, `barkLargeFreq` step `1`).
   - File: `schema.js:107,118`. Effort: small. Risk: low.
   - Why: the consumer rounds to int (`main.js:2711-2714`); the fine
     step gives the user the false impression they have 0.25-cycles-per-
     metre control. The texture-cache keys at `main.js:2717-2722` would
     also become slightly more cache-friendly.

10. **Tweak step / max values to make integral ranges**: `mossLum`,
    `vineLum`, `stubsLum`, `cBranchStart`, `cBranchLen`, `cTwigLen`.
    - File: `schema.js`. Effort: small. Risk: low.
    - Why: every one of these has an unreachable max because (max - min)
      isn't a multiple of step. Already in PRODUCTION_AUDIT L1.

11. **Add a "(Honda only)" / "(needs apical dominance)" hint to the
    relevant slider labels.**
    - Files: `schema.js` labels for `hondaR1/R2`, `apicalContinue`.
      Effort: small. Risk: low.
    - Why: cheaper than building a full mode-gating system; tells the
      user instantly why their slider drag had no visible effect.

12. **Add a `°` suffix to `barkRotation`** (and to `trunkLeanDir`,
    `sunAzimuth`, `sunElevation`, `rotation`).
    - File: `main.js` createSliderRow value formatter. Effort: small.
      Risk: low.
    - Why: pure polish — these sliders are unitless in the readout
      today, but their values are degrees. A unit suffix makes the
      sidebar self-explanatory.

13. **Convert the `apicalContinue` slider into a stacked panel with
    `apicalDominance`** so they can't drift independently.
    - File: `main.js` per-level render. Effort: medium. Risk: medium.
    - Why: the two are conceptually one knob (apical = the central-leader
      mechanic). Splitting them today encourages the
      "set-apicalContinue-to-1-and-see-nothing" frustration.

---

## Accounting

- 🔴 Dead: 0
- 🟠 Effectively dead (mode-gated): 5 keys (hondaR1, hondaR2, trunkSplitSpread,
  trunkSplitHeight, density) plus the LOD trio
- 🟡 Fighting / clobbered: 1 confirmed (leafSheen duplicate). Bark style
  one-shot reload not counted as "fighting".
- 🔵 Range / step / default: 11 items
- 🟣 Label-vs-effect: 5 items (diebackOuter, mossThreshold,
  apicalContinue, leafSheen-default, bSpread-naming)
- 🟤 Species presets out-of-bounds: 6 keys across 6 species (Cherry,
  Baobab, Beech, PlaneTree, Eucalyptus, plus the Olive/Sassafras/JapaneseMaple
  torsion family)

Total problem count by category: see "Accounting". Top-3 highest-ROI fixes
are #1, #2, #3 in the Recommendations list.
