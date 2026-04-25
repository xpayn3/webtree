# Production Audit — main.js + tree-worker.js

Scope: `C:/Users/Luka/Downloads/webgpu-tree/main.js` (14 614 lines) and
`C:/Users/Luka/Downloads/webgpu-tree/tree-worker.js` (1 670 lines), plus
`schema.js` (1 221 lines) where consumer-side checks required it.

Audit date: 2026-04-24. Read-only.

---

## 1. Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 1     |
| Medium   | 8     |
| Low      | 5     |

No outright crashes or hangs found. The recent gravity-sag, branch-wobble,
kinkSteps-invariance, section-rail and sticky-stack work all hold up: main.js
↔ tree-worker.js parity is byte-for-byte on the gravity / wobble passes; the
`stepInv = 8 / max(1, kinkSteps)` factor is applied consistently to all
per-step distortion / curve / tropism / attractor terms in both kernels;
worker `buildTube` clamps match main `tubeFromChain` (8–24 radial, 4–10
tubular); the chainRoot.pos snap is in place via the bridge node mechanism;
sticky `--sb-sticky-h` math correctly uses `Math.max(tabs, top)`; sticky
summaries pin to `var(--sb-sticky-h, 86px)` and the parent details uses
`clip-path: inset(0 round var(--r-lg))` not `overflow: hidden`. The
significant items below are mostly dead code accumulated through the
post-Session-13 refactors.

---

## 2. Critical

None found.

---

## 3. High (correctness)

### H1. `buildParamGroup('Compound leaves', ...)` is a silent no-op
- **File:** `main.js:8557`, plus `schema.js` (the group is *not* declared).
- **Description:** `buildParamGroup` looks up `PARAM_SCHEMA.find((g) => g.group === groupName)` and returns immediately when no group matches (`main.js:8153–8154`). The PARAM_SCHEMA groups are: Trunk, Bark, Leaves, Stems, Leaf Material, Fruits / Flowers, Vines, LOD, Global, Pruning, Stubs (dead wood), Canopy dieback (`schema.js:6/91/106/139/146/163/173/184/190/216/222/230`). There is **no `'Compound leaves'` group**, so the call at line 8557 silently renders nothing. Memory `project_webgpu_tree.md` (Session 13 cont.) claims this group was added with `leafletCount` + `leafletSpread`; the keys exist in `PARAM_DESCRIPTIONS` (`schema.js:1140-1141`) but never made it into the PARAM_SCHEMA array. Result: the documented Compound-leaves UI does not exist; `leafletCount` / `leafletSpread` are unreachable from the sidebar. (Compound-leaf rendering itself is also unreachable — no code in main.js or tree-worker.js reads either key.)
- **Action:** Either remove the dead call at `main.js:8557` and the two tooltip entries, or actually add the group to PARAM_SCHEMA and wire `leafletCount` / `leafletSpread` consumers in `_foliagePhase`. Memory's "compound-leaf expand" reference at `~7250` does not exist in the current source.
- **Effort:** S (delete) / M (implement).

---

## 4. Medium (quality)

### M1. `leafDataB` and `leafInstB` exist but are never populated
- **Files:** `main.js:5020, 2389, 632, 647, 738, 5634, 5700, 5779, 6382-6388, 6459, 6717, 6718, 7703, 7712, 8207, 8213, 9221, 9238, 9324, 11138, 11148, 11349, 11451, 12683-12685, 12810`.
- **Description:** `const leafDataB = []` is declared at `main.js:5020` and `let leafInstB = null` at `main.js:2389`. Searching for any write to `leafDataB.push` / `leafDataB[i] =` returns zero hits (verified). The only write site to `list` in `_foliagePhase` is `const list = leafDataA;` at `main.js:6299`. `leafInstB` is only ever assigned `null` (line 6717) — there is no `leafInstB = new InstancedMesh(...)` anywhere. Consequence: every double-loop `for (const data of [leafDataA, leafDataB])` and `[[leafInstA, leafDataA], [leafInstB, leafDataB]]` runs a pointless empty-array iteration; `bakeInstancesMerged(leafInstB, leafDataB, ...)` at line 11138 is dead; the snapshot/restore plumbing for `leafB` (lines 632, 647, 9221, 9324) and visibility toggles (7703, 11349) are no-ops. This is the largest concentration of dead branches in main.js.
- **Action:** Either delete the leaf-B variant end-to-end, or actually populate it (e.g. for the second leaf-shape in compound foliage). Pure deletion saves ~25 reachable lines + ~10 dead conditionals.
- **Effort:** M.

### M2. `leafStemColor` slider is dead
- **File:** `schema.js:143` (declares `live: true`); never read.
- **Description:** Searching `leafStemColor` across the project yields hits only in `schema.js:143`, `schema.js:1138`. No `P.leafStemColor` access in main.js or tree-worker.js. Slider renders, has a "live: true" tag (so it triggers material refreshes), but no material reads it.
- **Action:** Delete the entry from PARAM_SCHEMA and PARAM_DESCRIPTIONS, or wire it into `applyLeafMaterial()` / stem material if the petiole hue was intended to differ from leaf hue.
- **Effort:** S.

### M3. `leafStemTaper` slider is dead
- **File:** `schema.js:144` (`hidden: true`); never read.
- **Description:** Same situation as M2 — only declared and described. No `P.leafStemTaper` consumer. Schema comment at `schema.js:144` says "code path kept" but no code path actually exists.
- **Action:** Delete entry + tooltip, or wire into stem geometry tapering inside `buildStemBaseMatrices`.
- **Effort:** S.

### M4. `simP` style memory: `leafletCount` / `leafletSpread` documentation orphaned
- **File:** `schema.js:1140-1141` (PARAM_DESCRIPTIONS only).
- **Description:** Both keys appear in `PARAM_DESCRIPTIONS` but not in PARAM_SCHEMA (verified) and not in any consumer. Tooltips for keys that have no slider can never be shown.
- **Action:** Delete from PARAM_DESCRIPTIONS until / unless the H1 group is properly wired.
- **Effort:** S.

### M5. Orphaned twig-system tooltips (`twigsEnable`, `twigCount`, `twigLenMin`, `twigLenMax`, `twigAngle`, `twigDroop`, `twigThickness`, `twigTaper`, `twigLeaves`, `twigHue`, `twigLum`)
- **File:** `schema.js:1173-1183` (PARAM_DESCRIPTIONS only).
- **Description:** All eleven `twig*` keys (excluding the `cTwig*` conifer family, which IS wired) are tooltip-only. Search confirms zero hits in PARAM_SCHEMA, zero hits in `main.js`/`tree-worker.js` for `P.twigsEnable`, `P.twigCount`, … No UI renders them; no growth code reads them. They are the descriptions for a now-deleted twig sub-system referenced in the EZTREE_COMPARISON.md doc.
- **Action:** Delete the 11 entries from PARAM_DESCRIPTIONS.
- **Effort:** S.

### M6. `_chainsRef` no longer required by `_tubesOnlyRebuild` after Session 11 — but dead branch still exists
- **File:** `main.js:6539-6545` (the "main-thread fallback" inside `_tubesOnlyRebuild`).
- **Description:** Eligibility check at line 6639 already requires `_cachedChainsSer || (_chainsRef && _chainsRef.length > 0)`. When the worker pool is healthy and `_cachedChainsSer` is set, the worker path at lines 6535-6537 runs and returns. The fallback at lines 6539-6545 (`tubes = _chainsRef.map(tubeFromChain).filter(Boolean)`) only fires if the worker path returned `null` for the entire tube batch (timeout / pool error). That code path is reachable but rarely exercised. `_chainsRef` itself is also still consumed by `buildSplineMesh` (`main.js:7739, 7741, 7745`) so we can't drop the variable. **Note:** when this fallback IS taken, it doesn't rebuild bark UVs / barkNodeA/B/W metric to match the main full-build path's pool-fill — verify that the main mesh remains visually consistent after a worker failure. (Quick read suggests it does, since `tubeFromChain` returns the same shape as the worker output post-Session-11.) Treat as low-confidence; no need to fix unless an in-the-wild glitch shows up.
- **Action:** Add a console warning when this branch is taken so prod incidents surface; leave the code.
- **Effort:** S.

### M7. `_buildGen` stale-check missing in `_tubesOnlyRebuild` after the main-thread fallback
- **File:** `main.js:6539-6599`.
- **Description:** The worker path at line 6537 (`if (myGen !== _buildGen) return false; // stale`) correctly guards against a newer build superseding this one. When the worker path fails and execution falls through to the synchronous main-thread fallback at line 6544 (`tubes = _chainsRef.map(tubeFromChain)`) plus the pool-fill loop (6549-6583) plus the geometry swap at line 6595 (`treeMesh.geometry = treeGeo`), there is **no second stale-check**. So if a `tubesOnly` rebuild kicks off, takes the sync fallback (single-threaded, can be slow on big trees), and during that work a brand-new full rebuild ALSO starts on the worker path, the sync tubesOnly rebuild will commit a stale geometry on top of the newer full build. Worst case: visual flicker and wasted GPU bandwidth; not a crash. Probability is low because tubesOnly drags rarely race with full rebuilds.
- **Action:** Add `if (myGen !== _buildGen) return false;` immediately before line 6595's `treeMesh.geometry = treeGeo` swap.
- **Effort:** S.

### M8. `wobbleFreq` per-level slider has min:0 — collides with the inherit sentinel
- **File:** `schema.js:259`.
- **Description:** `wobble` per-level uses `0 = inherit, > 0 = override` (gating logic at `main.js:4146-4147` and `tree-worker.js:915-916`). For `wobbleFreq` the same sentinel is used (`(Lvl.wobbleFreq ?? 0) > 0 ? Lvl.wobbleFreq : globalFreq`), but the slider min is 0 and step is 0.1 — so the user can dial wobbleFreq down to exactly 0 ("inherit") just by dragging left, which feels indistinguishable from "no override". Compare to global `branchWobbleFreq` which has min: 0.3 (a positive floor, can't be 0). Either change wobbleFreq's min to 0.1 (force a positive override when set) or rename "0" UX to a labelled "Inherit" mode in the slider row. Functionally the gating works, this is a UX-correctness gap not a crash.
- **Action:** Bump `wobbleFreq` schema min to `0.1` to match the override gating contract.
- **Effort:** S.

---

## 5. Low (cosmetic)

### L1. Schema range / step misalignments (cannot reach max via the slider)
- **File:** `schema.js`. Specifically: `mossLum` (`schema.js:104`, range 0.55, step 0.02), `vineLum` (`schema.js:182`, range 0.75, step 0.02), `stubsLum` (`schema.js:228`, range 0.55, step 0.02), `cBranchStart` (`schema.js:913`, range 0.95, step 0.02), `cBranchLen` (`schema.js:916`, range 1.65, step 0.02), `cTwigLen` (`schema.js:920`, range 0.65, step 0.02).
- **Description:** Step does not divide cleanly into `(max - min)`. With browser-native `<input type=range>` + step snapping, the user can't actually land on the declared `max` — last reachable value is one step short. Functionally negligible (defaults are mid-range).
- **Action:** Tweak `min` or `max` so range / step is integral.
- **Effort:** S.

### L2. Stale comment in `_writeLeafSlot` — pool size
- **File:** `main.js:6101-6105`.
- **Description:** Comment says "loop (updateLeafInstances / updateStemInstances / buildStemBaseMatrices)". Accurate but minor: the pool acquire is correct (Session 11 work), the comment is dated to before that refactor. Cosmetic only.
- **Action:** Skip / update at next visit.
- **Effort:** S.

### L3. Memory `project_webgpu_tree.md` Session 11 references `leafletN > 1` compound expand at `main.js:~7250` — no such code exists
- **File:** Memory only.
- **Description:** Session-11-cont. notes mention "Compound-leaf expand (`leafletN > 1`, line ~7250) NOT pooled". Searching confirms zero references to `leafletN` anywhere in main.js or tree-worker.js. Either the expand was deleted in a later session and memory wasn't updated, or it was never landed.
- **Action:** Update the project memory line so future sessions don't trust it.
- **Effort:** S.

### L4. Spotlight comment at `main.js:~16373` mentions "Leaf Detail" — group no longer exists
- **File:** `main.js` Spotlight section. (Memory note `project_webgpu_tree.md` Session 13 cont. flags this as known-stale.)
- **Description:** "Leaf Detail" was removed in Session 13's leaf-UX restructure but the comment still references it. Cosmetic.
- **Action:** Update on next docs pass.
- **Effort:** S.

### L5. Five separate `window.addEventListener('keydown', ...)` registrations in main.js (lines 979, 1104, 7317, 11624, 12222, 13660, 14601)
- **File:** `main.js` — 7 distinct hot listeners (modal close handlers + global hotkeys).
- **Description:** Already flagged in Session 8 memory as a known low-priority leak. Each modal registers once at module init, never unregisters. Not a leak in the GC sense (listeners live for the page session) but each modal close runs all 7 handlers in sequence on every keydown. Performance impact negligible at typical typing rates (~1 µs / event); listed for completeness.
- **Action:** Consolidate into a single delegated handler if you ever do a hotkey pass.
- **Effort:** M.

---

## 6. Verified intact (no issues)

The following recent changes were re-verified and are correct:

- **kinkSteps invariance** — `stepInv = 8 / Math.max(1, L.kinkSteps)` factor applied in both `main.js:3384-3455` and `tree-worker.js:288-342` to amp, curve (sCurve / backCurve / helical), tropism (P + G), and attractor pull. Byte-for-byte parity.
- **chainRoot.pos snap in `spawnChildrenAlong`** — bridge node at `main.js:3734` is constructed at `sp.pos` which is `_spNode.pos.clone()` (line 3631), i.e. the parent's actual chain node position. TNode constructor clones the Vector3 (`main.js:3290`).
- **Wobble Pass 2 chainRoot inheritance** — `main.js:4178-4191` and `tree-worker.js:947-955` are byte-identical and correctly read the parent's *post-wobble* `n.parent.pos` plus the saved `oX[pi]` snapshot to compute the offset.
- **`_applyGravitySag` ↔ `_applyGravitySagW` parity** — both at ~70 lines, identical math (Hamilton-product cumulative quaternion, sagW = length × radius², 0.5-rad cap, stiffness damping). `main.js:4201-4275` ↔ `tree-worker.js:958-1021`. Worker uses `P._scrubSkipSag` flag (set from main at `main.js:1525`) to skip during scrubs; main uses the `isScrubbing` local — both paths converge.
- **`_applyBranchWobble` ↔ `_applyBranchWobbleW` parity** — same. `main.js:4119-4192` ↔ `tree-worker.js:893-956`. Per-level override `Lvl.wobble > 0 ? Lvl.wobble : globalAmt` mirrored exactly.
- **Tube clamps** — `Math.max(8, Math.min(24, P.barkRadialSegs))` and `Math.max(4, Math.min(10, P.barkTubularDensity))` at `main.js:4389/4394` and the corresponding `tree-worker.js:1247/1249`. Twig auto-halve (`r0 > 0.3 ? baseRad : Math.max(4, baseRad >> 1)`) matches.
- **Worker payload state.P fields** at `main.js:1509-1531` includes everything `tree-worker.js` reads from P (verified: `P.shape`, `P.baseSize`, `P.gravityStrength`, `P.gravityStiffness`, `P.branchWobble`, `P.branchWobbleFreq`, `P._scrubSkipSag`, `P.goldenRoll`, `P.branchModel`, `P.sunAzimuth`, `P.sunElevation`, `P.pruneMode/Radius/Height/CenterY`, `P.trunkSinuous*`, `P.trunkSplitHeight`, `P.alloExp`, `P.branchThickness`, etc.).
- **Section rail rebuild** at `main.js:13187-13255` — iterates `:scope > .section-label`, reads text via `:scope > span:not(.sec-icon)`, builds icon via `iconSvg(el.dataset.icon, 16)`. Uses RAF debounce.
- **Sticky stack tracker** at `main.js:13985-14007` — `Math.max(tabs, top)` of `.sb-tabs` + `.tree-type-sticky` offsetHeight, sets `--sb-sticky-h` on `#sidebar-body`. Has both ResizeObserver (over the static sticky children which exist at init time before this runs — verified at `main.js:7929-7933`) and a MutationObserver (subtree:true) for downstream changes.
- **Card sticky CSS** at `style.css:2079-2092` — `position: sticky; top: var(--sb-sticky-h, 86px); z-index: 4`. Parent `details` block at `style.css:1765-1786` uses `clip-path: inset(0 round var(--r-lg))` not `overflow: hidden`. Correct.
- **Per-level wobble override resolver** — `Lvl && (Lvl.wobble ?? 0) > 0 ? Lvl.wobble : globalAmt` at `main.js:4146` and `tree-worker.js:915` — identical.
- **Stem decoupling end-to-end** — `_writeLeafSlot` accepts six new args (`anchorOffX/Y/Z`, `stemVecX/Y/Z`) at `main.js:6101-6124`; `_foliagePhase` passes them at `main.js:6371-6374`; `buildStemBaseMatrices` reads `L.anchorOffX/Y/Z + rX[a]` for base and `L.stemVecX/Y/Z` for direction at `main.js:5714-5722`.
- **Worker watchdog cleanup** — `_settlePending` and `_failWorkerPending` (`main.js:1352-1369`) clear timers on settlement; both buildTube and build-tree-and-chains paths register watchdog timers (lines 1441, 1537). `_workerPending` map is cleaned on every settle.
- **Orphan queues drained on every commit** — `_drainOrphanList(_orphanBark); _drainOrphanList(_orphanFoliage);` at `main.js:7026`. Foliage-only path drains only `_orphanFoliage` at `main.js:6729` (intentional: bark stays visible until the in-flight full rebuild commits).
- **Pool growth (bark, leaf slots) is grow-only and bounded** — `_ensureBarkPools` at `main.js:5136-5160` only grows; latches `_barkIndexIs32` once promoted. `_leafSlotPoolA/B` cursors reset to 0 each `_foliagePhase` call (Session 11 cont.), so no leak.

---

End of audit.
