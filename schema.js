// Static parameter schemas, species presets, and tooltip descriptions.
// WIND_SCHEMA stays in main.js — its entries carry live uniform references (uni:).

// --- Schemas -------------------------------------------------------------
export const PARAM_SCHEMA = [
  { group: 'Trunk', params: [
    // Size + subdivision
    { key: 'trunkHeight', label: 'Height', min: 3, max: 30, step: 0.5, default: 11.0 },
    // Skeleton subdivision count for the trunk's reference curve. Higher =
    // smoother trunk silhouette + more vertices to drive bark displacement.
    { key: 'trunkSteps', label: 'Skeleton subdivisions', min: 5, max: 64, step: 1, default: 22 },
    // Tube mesh density. Ranges deliberately narrow:
    //   • Mesh sides 8-24 — below 8 trunks read as faceted polygons; above 24
    //     adds verts without visible improvement at our typical viewing
    //     distance. Twigs auto-halve (capped at 4 min) for efficiency.
    //   • Mesh smoothness 4-10 — below 4, Frenet frames flip on tight branch
    //     curves and chains kink visibly; above 10 just bloats vert count.
    // Both run on the tubes-only fast path (no skeleton rebuild). Bark UVs
    // are metric (world meters), so changing these doesn't stretch the bark
    // texture — only the silhouette gets coarser/finer.
    // Hidden — earlier attempts to expose these caused exploded geometry
    // (grow-only pool mismatch on tubesOnly path) and NaN positions on the
    // full-rebuild path. Reverted to hidden until both paths are properly
    // bulletproofed. Defaults (16 sides / 6 per step) cover the full range
    // of tree sizes safely. JSON imports of older saves still load.
    { key: 'barkRadialSegs',     label: 'Mesh sides',       min: 8, max: 24, step: 1, default: 16, hidden: true },
    { key: 'barkTubularDensity', label: 'Mesh smoothness',  min: 4, max: 10, step: 1, default: 6,  hidden: true },
    // Gnarliness — lateral noise applied to chain node positions during
    // skeleton build (SpeedTree calls this "wood noise", ezTree calls it
    // "gnarliness"). Branches inherit because they spawn off the wobbled
    // nodes. Per-level overrides available in each Level card.
    { key: 'branchWobble',       label: 'Gnarliness',       min: 0, max: 1.5, step: 0.02, default: 0    },
    { key: 'branchWobbleFreq',   label: 'Gnarl scale',      min: 0.3, max: 8, step: 0.1, default: 2.0 },
    // Hidden: legacy per-step trunk jitter, overlapped by Gnarliness now that
    // it covers the trunk too. Code path kept so old saves/presets still load.
    { key: 'trunkJitter', label: 'Jitter', min: 0, max: 0.5, step: 0.005, default: 0.025, hidden: true },
    // Splitting
    { key: 'trunkCount', label: 'Trunk count', min: 1, max: 5, step: 1, default: 1 },
    { key: 'trunkSplitSpread', label: 'Split spread', min: 0.1, max: 1.5, step: 0.05, default: 0.45 },
    // 0 = trunks fan from the ground (current legacy behavior).
    // >0 = trunks share a single base, then diverge at this fraction of trunk
    // height — produces a Y / V fork. Above ~0.7 you get tightly stacked
    // co-dominant leaders typical of cherry, beech, maple.
    { key: 'trunkSplitHeight', label: 'Split height', min: 0, max: 0.9, step: 0.02, default: 0 },
    { key: 'trunkTwist',       label: 'Twist',        min: -2,   max: 2,    step: 0.01, default: 0, hidden: true },
    // Pose — lean angle tilts the trunk base; lean direction is the heading
    // of that tilt. Bow bends the trunk along a subtle S-curve as it grows.
    { key: 'trunkLean',        label: 'Lean',         min: 0,    max: 1.2,  step: 0.01, default: 0 },
    { key: 'trunkLeanDir',     label: 'Lean dir',     min: 0,    max: 360,  step: 1,    default: 0 },
    { key: 'trunkBow',         label: 'Bow',          min: 0,    max: 2,    step: 0.02, default: 0 },
    // Long-wavelength lateral wander applied to the trunk's reference curve
    // only — this is the "ancient/winding" character. Independent of the
    // mid/high-freq trunk noise that drives Jitter, and 100% on the cheap
    // ref-curve path (64 evaluations total, zero new vertices).
    { key: 'trunkSinuous',     label: 'Sinuous',      min: 0,    max: 1.5,  step: 0.02, default: 0 },
    { key: 'trunkSinuousFreq', label: 'Sinuous freq', min: 0.3,  max: 4,    step: 0.1,  default: 1.0 },
    // Radius model (Weber-Penn parametric): trunk radius is a direct slider,
    // branches taper from baseRadius → tipRadius via taperExp, children scale
    // from parent-local radius via per-level radiusRatio.
    { key: 'baseRadius', label: 'Base radius',  min: 0.02, max: 1.2,  step: 0.01,  default: 0.35 },
    { key: 'tipRadius',  label: 'Tip radius',   min: 0.002, max: 0.15, step: 0.002, default: 0.028 },
    { key: 'taperExp',   label: 'Taper curve',  min: 0.5,  max: 4.0,  step: 0.05, default: 1.6 },
    // Post-multipliers on the parametric radii.
    { key: 'rootFlare', label: 'Root flare', min: 0, max: 4, step: 0.05, default: 1.0 },
    // Hidden — kept in state for back-compat with saved presets/JSON. trunkScale
    // and branchThickness overlap with baseRadius+rootFlare; alloExp is a no-op
    // under the Weber-Penn radius model.
    { key: 'trunkScale', label: 'Base thickening', min: 0.3, max: 3.5, step: 0.05, default: 1.0, hidden: true },
    { key: 'branchThickness', label: 'Overall thickness', min: 0.5, max: 3.0, step: 0.05, default: 1.0, hidden: true },
    { key: 'alloExp', label: 'Allometric exp. (legacy)', min: 1.3, max: 4.0, step: 0.05, default: 2.4, hidden: true },
    // Surface (moved from Bark — these change trunk geometry, not material).
    // tubesOnly: pure tube-extrusion params — the tubes-only fast path can
    // re-extrude bark without touching tree topology / skeleton / foliage.
    { key: 'barkDisplaceMode',   label: 'Displace mode', type: 'select',
      options: ['ridges', 'blobby', 'cellular', 'mixed'], default: 'ridges', tubesOnly: true },
    { key: 'barkDisplace',       label: 'Displace',     min: 0, max: 1.5, step: 0.02, default: 0.35, tubesOnly: true },
    { key: 'barkDisplaceFreq',   label: 'Displace freq', min: 0.5, max: 12, step: 0.1, default: 3.0, tubesOnly: true },
    { key: 'barkRidgeSharp',     label: 'Ridge sharpness', min: 0, max: 1, step: 0.02, default: 0.55, tubesOnly: true },
    { key: 'barkVerticalBias',   label: 'Vertical bias', min: 0, max: 1, step: 0.02, default: 0.8, tubesOnly: true },
    // --- Decorative bark effects, hidden by default (all default 0) ---
    // Each adds an extra per-vertex noise/cosine evaluation in tubeFromChain.
    // Most users never touch these — kept available for hero-shot tuning via
    // saved JSON / spotlight, but off the main UI to declutter the Trunk
    // card. Code paths intact.
    { key: 'barkKnots',          label: 'Knots',        min: 0, max: 1.5, step: 0.02, default: 0, tubesOnly: true, hidden: true },
    { key: 'barkKnotScale',      label: 'Knot scale',   min: 0.5, max: 6, step: 0.1, default: 2.0, tubesOnly: true, hidden: true },
    { key: 'barkDetail',         label: 'Micro detail', min: 0, max: 1,   step: 0.02, default: 0, tubesOnly: true, hidden: true },
    { key: 'barkDetailFreq',     label: 'Detail freq',  min: 4,  max: 40, step: 0.5, default: 12.0, tubesOnly: true, hidden: true },
    { key: 'buttressAmount', label: 'Buttress',       min: 0, max: 2,   step: 0.02, default: 0, tubesOnly: true, hidden: true },
    { key: 'buttressHeight', label: 'Buttress H',     min: 0.3, max: 5, step: 0.1,  default: 1.5, tubesOnly: true, hidden: true },
    { key: 'buttressLobes',  label: 'Buttress lobes', min: 2,   max: 10,step: 1,    default: 5, tubesOnly: true, hidden: true },
    // Reaction wood — asymmetric radial thickening on the compression side
    // of horizontal branches. Niche; default off.
    { key: 'reactionWood',   label: 'Reaction wood',  min: 0, max: 1,   step: 0.02, default: 0, tubesOnly: true, hidden: true },
  ]},
  { group: 'Bark', params: [
    { key: 'barkHue',            label: 'Hue',          min: 0, max: 1,   step: 0.01, default: 0.08, live: true },
    { key: 'barkTint',           label: 'Tint',         min: 0, max: 1,   step: 0.02, default: 0,    live: true },
    { key: 'barkRoughness',      label: 'Roughness',    min: 0.2, max: 1, step: 0.02, default: 0.95, live: true },
    { key: 'barkNormalStrength', label: 'Normal',       min: 0, max: 2.5, step: 0.05, default: 1.0,  live: true },
    // UVs are in world meters. These sliders are "tiles per meter" on each
    // axis. Lower = bigger bark tiles. Same density on any branch thickness.
    { key: 'barkTexScaleU',      label: 'Tiles/m along',  min: 0.2, max: 8,  step: 0.1, default: 1.5, live: true },
    { key: 'barkTexScaleV',      label: 'Tiles/m around', min: 0.2, max: 8,  step: 0.1, default: 1.5, live: true },
    // Moss / lichen world-up blend
    { key: 'mossAmount',         label: 'Moss amount',  min: 0, max: 1,   step: 0.02, default: 0,    live: true },
    { key: 'mossThreshold',      label: 'Moss coverage',min: 0.1, max: 0.9,step: 0.02,default: 0.4,  live: true },
    { key: 'mossHue',            label: 'Moss hue',     min: 0, max: 1,   step: 0.01, default: 0.3,  live: true },
    { key: 'mossLum',            label: 'Moss bright.', min: 0.05,max: 0.6,step: 0.02,default: 0.25, live: true },
  ]},
  { group: 'Leaves', treeType: 'broadleaf', params: [
    // Quantity & placement.
    { key: 'leavesPerTip',       label: 'Leaves/tip',   min: 0,   max: 200, step: 1,    default: 32 },
    { key: 'leavesStart',        label: 'Start height', min: 0,   max: 0.9, step: 0.02, default: 0 },
    { key: 'leafPhyllotaxis',    label: 'Arrangement',  type: 'select', options: ['spiral', 'opposite', 'alternate', 'random'], default: 'alternate' },
    // Size & shape.
    { key: 'leafSize',           label: 'Size',         min: 0.02, max: 0.5, step: 0.005, default: 0.15, rescale: true },
    { key: 'leafSizeVar',        label: 'Size variance',min: 0,   max: 1,   step: 0.05, default: 0.55 },
    // Leaf geometry detail. Industry-standard LOD: silhouette (full shape mesh,
    // ~200 tris/leaf) for hero shots; bent (curved strip, ~32 tris) for medium
    // distance; flat (textured quad, 2 tris) for performance + far LOD. The
    // alpha-cutout texture preserves the leaf silhouette in all three modes.
    // 200k leaves × 2 tris = 400k → easy 60fps; × 200 tris = 40M → ~24fps.
    { key: 'leafQuality',        label: 'Mesh detail',  type: 'select', options: ['flat', 'bent', 'silhouette'], default: 'bent' },
    // Pose.
    { key: 'leafSpread',         label: 'Spread',       min: 0,   max: 1.2, step: 0.05, default: 0.45 },
    { key: 'leafDroop',          label: 'Droop',        min: 0,   max: 1,   step: 0.05, default: 0 },
    { key: 'leafTilt',           label: 'Tilt',         min: 0,   max: 1,   step: 0.02, default: 0.25 },
    // Color & season.
    { key: 'season',             label: 'Season',       min: 0,   max: 1,   step: 0.02, default: 0.2 },
    { key: 'leafColorVar',       label: 'Color variance', min: 0, max: 0.3, step: 0.01, default: 0.08 },
    // --- Advanced placement (hidden by default — kept for presets / power users) ---
    { key: 'leafChainSteps',     label: 'Branch depth', min: 1,   max: 32,  step: 1,    default: 5,    hidden: true },
    { key: 'leafBranchFill',     label: 'Branch fill',  min: 0,   max: 3,   step: 0.05, default: 1,    hidden: true },
    { key: 'leafMaxRadius',      label: 'Max twig radius',min: 0.005,max: 0.3, step: 0.005,default: 0.08, hidden: true },
    { key: 'leafInset',          label: 'Plane inset',  min: -0.5,max: 0.5, step: 0.01, default: 0,    hidden: true },
    { key: 'fallenMax',          label: 'Fallen max',   min: 0,   max: 300, step: 5,    default: 120, live: true, hidden: true },
    { key: 'fallenFade',         label: 'Fade time',    min: 0.5, max: 10,  step: 0.1,  default: 3.0, live: true, hidden: true },
  ]},
  // Petioles — the stems that attach each leaf to the twig. Separated from
  // Leaves so the petiole geometry can be tuned without scrolling past leaf
  // material / colour controls (matches how SpeedTree and The Grove split
  // them in their UI).
  { group: 'Stems', treeType: 'broadleaf', params: [
    { key: 'leafStemLen',         label: 'Length',         min: 0,    max: 0.5, step: 0.01, default: 0.05 },
    { key: 'leafStemAngle',       label: 'Forward lean',   min: 0,    max: 1,   step: 0.02, default: 0.3 },
    { key: 'leafStemThick',       label: 'Thickness',      min: 0.3,  max: 3,   step: 0.05, default: 1.0 },
  ]},
  { group: 'Leaf Material', treeType: 'broadleaf', params: [
    // Essentials — the five PBR knobs that actually affect read-at-distance.
    { key: 'leafRoughness',       label: 'Roughness',     min: 0,    max: 1,   step: 0.02, default: 0.65, live: true },
    { key: 'leafTransmission',    label: 'Transmission',  min: 0,    max: 1,   step: 0.02, default: 0.45, live: true },
    { key: 'leafThickness',       label: 'Thickness',     min: 0,    max: 2,   step: 0.05, default: 0.35, live: true },
    { key: 'leafHueShift',        label: 'Hue shift',     min: -0.3, max: 0.3, step: 0.01, default: 0,    live: true },
    { key: 'leafBackMix',         label: 'Back mix',      min: 0,    max: 1,   step: 0.02, default: 0.35, live: true },
    // --- Advanced (hidden) — diminishing-return polish for hero shots ---
    { key: 'leafIOR',             label: 'IOR',           min: 1.0,  max: 2.0, step: 0.02, default: 1.35, live: true, hidden: true },
    { key: 'leafNormalStrength',  label: 'Normal',        min: 0,    max: 1.5, step: 0.05, default: 0.25, live: true, hidden: true },
    { key: 'leafBumpScale',       label: 'Vein bump',     min: 0,    max: 0.08,step: 0.002,default: 0.015,live: true, hidden: true },
    { key: 'leafClearcoat',       label: 'Waxy coat',     min: 0,    max: 1,   step: 0.02, default: 0,    live: true, hidden: true },
    { key: 'leafClearcoatRough',  label: 'Coat rough.',   min: 0,    max: 1,   step: 0.02, default: 0.3,  live: true, hidden: true },
    { key: 'leafSheen',           label: 'Sheen',         min: 0,    max: 1,   step: 0.02, default: 0,    live: true, hidden: true },
    { key: 'leafBackHue',         label: 'Back hue',      min: 0,    max: 1,   step: 0.01, default: 0.12, live: true, hidden: true },
    { key: 'leafBackLum',         label: 'Back bright.',  min: 0.2,  max: 1,   step: 0.02, default: 0.6,  live: true, hidden: true },
  ]},
  { group: 'Fruits / Flowers', treeType: 'broadleaf', params: [
    { key: 'fruitsEnable', label: 'Enable',    type: 'select', options: ['off', 'on'], default: 'off' },
    { key: 'fruitShape',   label: 'Shape',     type: 'select', options: ['sphere', 'teardrop', 'blossom'], default: 'sphere' },
    { key: 'fruitDensity', label: 'Density',   min: 0,    max: 1,    step: 0.02,  default: 0.3 },
    { key: 'fruitSize',    label: 'Size',      min: 0.01, max: 0.2,  step: 0.005, default: 0.04 },
    { key: 'fruitHang',    label: 'Hang len',  min: 0,    max: 0.3,  step: 0.005, default: 0.04 },
    { key: 'fruitHue',     label: 'Hue',       min: 0,    max: 1,    step: 0.01,  default: 0,    live: true },
    { key: 'fruitLum',     label: 'Brightness',min: 0.1,  max: 0.9,  step: 0.02,  default: 0.45, live: true },
    { key: 'fruitSat',     label: 'Saturation',min: 0,    max: 1,    step: 0.02,  default: 0.75, live: true },
  ]},
  { group: 'Vines', treeType: 'broadleaf', params: [
    { key: 'vinesEnable',     label: 'Enable',       type: 'select', options: ['off', 'on'], default: 'off' },
    { key: 'vineCount',       label: 'Count',        min: 1,    max: 8,    step: 1,     default: 2    },
    { key: 'vineCoverage',    label: 'Coverage',     min: 0.2,  max: 1,    step: 0.05,  default: 0.7  },
    { key: 'vineThickness',   label: 'Thickness',    min: 0.01, max: 0.12, step: 0.005, default: 0.035 },
    { key: 'vineCoils',       label: 'Coils / m',    min: 0.2,  max: 3,    step: 0.05,  default: 0.8  },
    { key: 'vineLeafSize',    label: 'Leaf size',    min: 0.1,  max: 1,    step: 0.02,  default: 0.35 },
    { key: 'vineLeafDensity', label: 'Leaf density', min: 0,    max: 40,   step: 1,     default: 12   },
    { key: 'vineHue',         label: 'Hue',          min: 0,    max: 1,    step: 0.01,  default: 0.08, live: true },
    { key: 'vineLum',         label: 'Brightness',   min: 0.05, max: 0.8,  step: 0.02,  default: 0.28, live: true },
  ]},
  { group: 'LOD', params: [
    { key: 'lodAutoSwitch', label: 'Auto-switch',  type: 'select', options: ['off', 'on'], default: 'off' },
    { key: 'lodDist1',      label: 'Distance LOD1',min: 5,  max: 200, step: 1,    default: 20 },
    { key: 'lodDist2',      label: 'Distance LOD2',min: 10, max: 400, step: 1,    default: 60 },
    { key: 'lodDist3',      label: 'Distance LOD3',min: 20, max: 800, step: 1,    default: 140 },
  ]},
  { group: 'Global', params: [
    { key: 'globalScale',  label: 'Global scale',  min: 0.3, max: 3.0, step: 0.05, default: 1.0 },
    // Legacy hard envelope on primary branch length. 'free' lets the per-level
    // length curves shape the silhouette directly (MTree-style emergent crown).
    // Named options stay for back-compat with species presets.
    { key: 'shape',        label: 'Crown silhouette', type: 'select',
      options: ['free', 'conical', 'spherical', 'hemispherical', 'cylindrical', 'tapered', 'flame', 'inverse', 'tend-flame'],
      default: 'free' },
    // Branching formula — post-processes child length/roll for biologically
    // distinct growth rules. Weber-Penn = current parametric; Honda applies
    // R1/R2 length ratios (1971); Fibonacci snaps roll to golden-angle
    // phyllotaxis (137.5°).
    { key: 'branchModel',  label: 'Branch formula', type: 'select',
      options: ['weber-penn', 'honda', 'fibonacci'], default: 'weber-penn' },
    { key: 'baseSize',     label: 'Clean bole',    min: 0,   max: 0.6, step: 0.02, default: 0    },
    { key: 'minLen',       label: 'Min length',    min: 0.1, max: 0.6, step: 0.02, default: 0.28 },
    { key: 'growthPhase',  label: 'Growth',        min: 0.1, max: 1,   step: 0.02, default: 1, hidden: true },
    // Gravity sag (MTree-style) — recursive weight + cumulative rotation pass
    // applied once at build time. Heavy joints sag and the entire downstream
    // subtree rotates with them. Wind PBD layers on top of the sagged pose.
    { key: 'gravityStrength', label: 'Gravity sag',   min: 0, max: 3, step: 0.02, default: 0    },
    { key: 'gravityStiffness',label: 'Sag stiffness', min: 0, max: 2, step: 0.02, default: 0.5  },
    { key: 'rotation',     label: 'Rotation',      min: 0,   max: 360, step: 1,    default: 0,    live: true },
    { key: 'sunAzimuth',   label: 'Sun azimuth',   min: 0,   max: 360, step: 1,    default: 0    },
    { key: 'sunElevation', label: 'Sun elevation', min: 0,   max: 90,  step: 1,    default: 90   },
  ]},
  { group: 'Pruning', params: [
    { key: 'pruneMode',    label: 'Shape',    type: 'select', options: ['off', 'ellipsoid'], default: 'off' },
    { key: 'pruneRadius',  label: 'Radius',   min: 2, max: 40, step: 0.5, default: 9 },
    { key: 'pruneHeight',  label: 'Height',   min: 2, max: 40, step: 0.5, default: 7 },
    { key: 'pruneCenterY', label: 'Center Y', min: 0, max: 40, step: 0.5, default: 10 },
  ]},
  { group: 'Stubs (dead wood)', params: [
    { key: 'stubsEnable', label: 'Enable',    type: 'select', options: ['off', 'on'], default: 'off' },
    { key: 'stubsChance', label: 'Chance',    min: 0,    max: 1,   step: 0.02, default: 0.3 },
    { key: 'stubsLength', label: 'Length',    min: 0.1,  max: 1.5, step: 0.05, default: 0.5 },
    { key: 'stubsTaper',  label: 'Taper',     min: 0,    max: 1,   step: 0.05, default: 0.55 },
    { key: 'stubsHue',    label: 'Hue',       min: 0,    max: 1,   step: 0.01, default: 0.08, live: true },
    { key: 'stubsLum',    label: 'Brightness',min: 0.05, max: 0.6, step: 0.02, default: 0.18, live: true },
  ]},
  { group: 'Canopy dieback', params: [
    { key: 'dieback',        label: 'Strength',    min: 0, max: 1,   step: 0.02, default: 0,    live: false },
    { key: 'diebackOuter',   label: 'Outer shell', min: 0.3, max: 1, step: 0.02, default: 0.55 },
  ]},
];

export const LEVEL_SCHEMA = [
  { key: 'children',        label: 'Branch count',     min: 1,   max: 120,  step: 1,     default: 3    },
  { key: 'lenRatio',        label: 'Length',           min: 0.1, max: 3,    step: 0.02,  default: 0.7  },
  // Weber-Penn branch-radius ratio — child base = parent's local radius × this.
  { key: 'radiusRatio',     label: 'Radius ratio',     min: 0.1, max: 1.0,  step: 0.02,  default: 0.6  },
  // Weber-Penn branch taper — reshapes radius along each branch's length.
  //   < 1 spindle/cylindrical (mid stays thick), 1 linear (default),
  //   1–2 cone (narrows faster toward tip), > 2 periodic oscillation.
  { key: 'taper',           label: 'Taper',            min: 0,   max: 3,    step: 0.05,  default: 1    },
  { key: 'angle',           label: 'Branch angle',     min: 0,   max: 3.14, step: 0.02,  default: 0.55 },
  { key: 'angleVar',        label: 'Angle variation',  min: 0,   max: 3.14, step: 0.02,  default: 0.3  },
  { key: 'rollVar',         label: 'Roll variation',   min: 0,   max: 6.28, step: 0.02,  default: 0.55 },
  // Base phase offset applied on top of the arrangement pattern. Rotates
  // the whole phyllotaxis around the parent axis before rollVar jitter.
  { key: 'rollStart',       label: 'Roll start',       min: 0,   max: 6.28, step: 0.02,  default: 0    },
  { key: 'phyllotaxis',     label: 'Arrangement',      type: 'select', options: ['spiral', 'opposite', 'whorled', 'decussate'], default: 'spiral' },
  { key: 'startPlacement',  label: 'Start position',   min: 0,   max: 1,    step: 0.02,  default: 0    },
  { key: 'endPlacement',    label: 'End position',     min: 0,   max: 1,    step: 0.02,  default: 1    },
  { key: 'apicalDominance', label: 'Apical dominance', min: 0,   max: 1,    step: 0.02,  default: 0    },
  { key: 'apicalContinue',  label: 'Central leader',   min: 0,   max: 1,    step: 0.02,  default: 0    },
  { key: 'kinkSteps',       label: 'Segments',         min: 2,   max: 40,   step: 1,     default: 8    },
  { key: 'distortion',      label: 'Wiggle amount',    min: 0,   max: 4,    step: 0.01,  default: 0.2  },
  { key: 'distortionFreq',  label: 'Wiggle frequency', min: 0.1, max: 40,   step: 0.1,   default: 3    },
  // Per-level gnarliness overrides. 0 = inherit the global Gnarliness (Trunk
  // card); >0 = override the global with this absolute value at this level.
  // Lets you straighten the trunk and gnarl the twigs (or the inverse).
  { key: 'wobble',          label: 'Gnarliness',       min: 0,    max: 1.5, step: 0.02, default: 0    },
  { key: 'wobbleFreq',      label: 'Gnarl scale',      min: 0,    max: 8,   step: 0.1,  default: 0    },
  { key: 'curveMode',       label: 'Curve type',       type: 'select', options: ['none', 'sCurve', 'backCurve', 'helical'], default: 'none' },
  { key: 'curveAmount',     label: 'Curve strength',   min: 0,   max: 10,   step: 0.02,  default: 0    },
  { key: 'curveBack',       label: 'Curve reversal',   min: -10, max: 10,   step: 0.02,  default: 0    },
  { key: 'segSplits',       label: 'Fork rate',        min: 0,   max: 6,    step: 0.05,  default: 0    },
  { key: 'splitAngle',      label: 'Fork angle',       min: 0,   max: 3.14, step: 0.02,  default: 0.25 },
  { key: 'angleDecline',    label: 'Angle taper',      min: -2,  max: 2,    step: 0.02,  default: 0    },
  { key: 'gravitropism',    label: 'Gravity',          min: 0,   max: 3,    step: 0.01,  default: 0    },
  { key: 'susceptibility',  label: 'Bend strength',    min: -10, max: 10,   step: 0.05,  default: 1    },
  { key: 'stochastic',      label: 'Branch drop',      min: 0,   max: 1,    step: 0.02,  default: 0    },
];

export function makeDefaultLevel() {
  const L = {};
  for (const p of LEVEL_SCHEMA) L[p.key] = p.default;
  // Density along parent — matches measured branching density after the
  // clean-bole zone (which P.baseSize handles separately). Gentler than
  // a 0.5/0.55 end-falloff so we don't double-count baseSize culling.
  L.densityPoints = [0.75, 0.95, 1.0, 0.95, 0.7];
  // Length along parent — apical dominance: tip laterals 0.75× of mid
  // laterals (within the 0.7–0.85 range measured in real hardwoods).
  // Previous 0.55 tip was too aggressive + compounded with apicalDominance.
  L.lengthPoints = [0.9, 1.0, 1.0, 0.9, 0.75];
  // 5-point fork-probability curve (0..2) sampled along the branch's OWN
  // growth progress (0 = base, 1 = tip). Multiplies per-step segSplits rate
  // so forks can cluster early, late, or stay even.
  L.splitPoints = [1, 1, 1, 1, 1];
  // MTree-style ramps: per-position multiplier on direction jitter (sampled
  // along each branch's own growth t) and additive on spawn angle (sampled
  // at branch placement on parent). Defaults are neutral.
  L.randomnessPoints = [1, 1, 1, 1, 1];
  L.startAnglePoints = [0, 0, 0, 0, 0];
  return L;
}

// Catmull-Rom sample of a flat density array in [0, 1]. Matches SplineEditor.sample.
export function sampleDensityArr(arr, t) {
  if (!Array.isArray(arr) || arr.length === 0) return 1;
  const n = arr.length;
  if (n === 1) return arr[0];
  const f = Math.max(0, Math.min(1, t)) * (n - 1);
  const i1 = Math.floor(f);
  const i2 = Math.min(n - 1, i1 + 1);
  const i0 = Math.max(0, i1 - 1);
  const i3 = Math.min(n - 1, i2 + 1);
  const u = f - i1;
  const p0 = arr[i0], p1 = arr[i1], p2 = arr[i2], p3 = arr[i3];
  const a = 2 * p1, b = p2 - p0, c = 2 * p0 - 5 * p1 + 4 * p2 - p3, d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * u + c * u * u + d * u * u * u);
}


// Physical simulation parameters — multipliers on the PBD sim (stepSim).
export const PHYSICS_SCHEMA = [
  { key: 'stiffness',       label: 'Stiffness',    min: 0.1, max: 3.0, step: 0.05, default: 1.0 },
  { key: 'damping',         label: 'Damping',      min: 0.1, max: 3.0, step: 0.05, default: 1.0 },
  { key: 'windResponse',    label: 'Wind Resp.',   min: 0,   max: 3.0, step: 0.05, default: 1.0 },
  { key: 'massiveness',     label: 'Mass',         min: 0.3, max: 3.0, step: 0.05, default: 1.0 },
  // Grab-and-pull interaction
  { key: 'grabPickRadius',  label: 'Pick radius',  min: 10,  max: 150, step: 5,    default: 60  },
  { key: 'grabSensitivity', label: 'Sensitivity',  min: 0.2, max: 3.0, step: 0.05, default: 1.0 },
  { key: 'grabMaxPull',     label: 'Max pull',     min: 1,   max: 40,  step: 0.5,  default: 12  },
  { key: 'grabSpread',      label: 'Bend spread',  min: 0,   max: 1.0, step: 0.02, default: 0.72 },
  // Ice/snow load — thin branches bend downward under accumulated mass.
  { key: 'snowLoad',        label: 'Snow load',    min: 0,   max: 1,   step: 0.02, default: 0   },
];

// --- Species presets -----------------------------------------------------
function withLevel(overrides) {
  return { ...makeDefaultLevel(), ...overrides };
}

export const SPECIES = {
  Oak: {
    // Mature spreading Oak (Quercus alba / robur / lobata): wider than tall.
    // Stout trunk forks low into heavy horizontal scaffolds, gnarled and
    // twisting. Crown is broad and billowy with a slightly flattened top —
    // not a flame, not a perfect ball. Alternate phyllotaxis (spiral).
    // Heavy gravity sag because oak limbs are massive and horizontal.
    type: 'broadleaf',
    trunkHeight: 8, trunkScale: 1.15, tipRadius: 0.006, alloExp: 2.4, rootFlare: 0.55,
    trunkJitter: 0.07,
    globalScale: 1.0,
    shape: 'free', baseSize: 0.28,
    leafShape: 'Oak',
    leafSize: 0.15, leafSpread: 0.45, leafStemLen: 0.06, leafStemAngle: 0.35, leafTilt: 0.15,
    leavesPerTip: 28, leafChainSteps: 9, leavesStart: 0.05, season: 0.45,
    leafClusterSize: 3, leafClusterSpread: 0.6, leafMaxRadius: 0.18,
    leafPhyllotaxis: 'alternate',
    gravityStrength: 0.55, gravityStiffness: 0.55,
    pruneMode: 'ellipsoid', pruneRadius: 7.0, pruneHeight: 5.0, pruneCenterY: 7.0,
    levels: [
      withLevel({ children: 12, lenRatio: 0.68, angle: 1.25, angleVar: 0.28, rollVar: 0.95, startPlacement: 0.3, endPlacement: 1, apicalDominance: 0.05, angleDecline: 0.25, distortion: 0.32, distortionType: 'perlin', distortionFreq: 2.0, curveMode: 'sCurve', curveAmount: 0.45, curveBack: -0.35, segSplits: 0.3, splitAngle: 0.4, susceptibility: 1.3, gravitropism: 0.015, densityPoints: [0.85, 1.0, 1.0, 0.95, 0.8], lengthPoints: [0.9, 1.0, 1.0, 1.0, 0.85], randomnessPoints: [0.5, 0.8, 1.1, 1.4, 1.7] }),
      withLevel({ children: 10, lenRatio: 0.68, angle: 0.85, angleVar: 0.25, rollVar: 0.9, startPlacement: 0.2, endPlacement: 1, apicalDominance: 0.08, distortion: 0.28, distortionType: 'perlin', distortionFreq: 2.6, curveMode: 'sCurve', curveAmount: 0.4, curveBack: -0.35, segSplits: 0.22, splitAngle: 0.35, gravitropism: 0.03, susceptibility: 1.5, densityPoints: [0.85, 1.0, 1.0, 0.95, 0.8], lengthPoints: [0.9, 1.0, 1.0, 1.0, 0.85], randomnessPoints: [0.6, 0.9, 1.2, 1.5, 1.8] }),
      withLevel({ children: 8, lenRatio: 0.62, angle: 0.7, angleVar: 0.2, rollVar: 0.9, startPlacement: 0.22, endPlacement: 1, distortion: 0.26, distortionType: 'perlin', distortionFreq: 3.0, stochastic: 0.18, curveMode: 'backCurve', curveAmount: 0.32, segSplits: 0.15, splitAngle: 0.32, gravitropism: 0.04, densityPoints: [0.85, 1.0, 1.0, 0.95, 0.85], lengthPoints: [0.92, 1.0, 1.0, 1.0, 0.9], randomnessPoints: [0.7, 1.0, 1.3, 1.6, 1.9] }),
      // L4 = the twig layer: short, dense, drooping, heavily wiggled.
      withLevel({ children: 6, lenRatio: 0.42, angle: 0.6, angleVar: 0.25, rollVar: 0.95, startPlacement: 0.25, endPlacement: 1, distortion: 0.3, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.3, curveMode: 'backCurve', curveAmount: 0.35, gravitropism: 0.18, densityPoints: [0.85, 1.0, 1.0, 0.95, 0.85], lengthPoints: [0.95, 1.0, 1.0, 1.0, 0.92], randomnessPoints: [0.9, 1.2, 1.5, 1.8, 2.1] }),
    ],
  },
  Maple: {
    // Sugar/Red Maple: dense, round, bushy crown — the iconic "lollipop"
    // silhouette. Trunk forks low into multiple co-dominant leaders, each
    // ramifying densely toward a packed outer shell. Opposite/decussate
    // phyllotaxis (Acer genus). 4 orders, heavy ramification, gravity sag
    // for the slight tip droop real maples carry under leaf weight.
    type: 'broadleaf',
    trunkHeight: 9, trunkScale: 1.0, tipRadius: 0.005, alloExp: 2.3, rootFlare: 0.45,
    trunkJitter: 0.06,
    globalScale: 1.0,
    shape: 'free', baseSize: 0.3,
    leafShape: 'Maple',
    leafSize: 0.12, leafSpread: 0.4, leafStemLen: 0.05, leafStemAngle: 0.4, leafTilt: 0.12,
    leavesPerTip: 26, leafChainSteps: 9, leavesStart: 0.05, season: 0.78,
    leafClusterSize: 3, leafClusterSpread: 0.6, leafMaxRadius: 0.14,
    leafPhyllotaxis: 'opposite',
    gravityStrength: 0.25, gravityStiffness: 1.0,
    pruneMode: 'ellipsoid', pruneRadius: 5.5, pruneHeight: 5.0, pruneCenterY: 7.5,
    levels: [
      withLevel({ children: 14, lenRatio: 0.62, angle: 1.0, angleVar: 0.15, rollVar: 0.55, phyllotaxis: 'decussate', startPlacement: 0.3, endPlacement: 1, apicalDominance: 0.05, angleDecline: 0.2, distortion: 0.22, distortionType: 'perlin', distortionFreq: 2.2, curveMode: 'sCurve', curveAmount: 0.25, curveBack: -0.15, segSplits: 0.3, splitAngle: 0.35, susceptibility: 1.2, gravitropism: 0.01, densityPoints: [0.85, 1.0, 1.0, 0.95, 0.85], lengthPoints: [0.85, 1.0, 1.0, 1.0, 0.85], randomnessPoints: [0.4, 0.7, 1.0, 1.2, 1.4] }),
      withLevel({ children: 11, lenRatio: 0.65, angle: 0.8, angleVar: 0.18, rollVar: 0.5, phyllotaxis: 'decussate', startPlacement: 0.15, endPlacement: 1, apicalDominance: 0.06, distortion: 0.22, distortionType: 'perlin', distortionFreq: 2.6, curveMode: 'sCurve', curveAmount: 0.22, curveBack: -0.15, segSplits: 0.22, splitAngle: 0.32, gravitropism: 0.015, susceptibility: 1.3, densityPoints: [0.85, 1.0, 1.0, 0.95, 0.85], lengthPoints: [0.9, 1.0, 1.0, 1.0, 0.9], randomnessPoints: [0.5, 0.8, 1.1, 1.3, 1.5] }),
      withLevel({ children: 8, lenRatio: 0.6, angle: 0.65, angleVar: 0.15, rollVar: 0.7, startPlacement: 0.18, endPlacement: 1, distortion: 0.24, distortionType: 'perlin', distortionFreq: 3.0, stochastic: 0.15, curveMode: 'backCurve', curveAmount: 0.2, segSplits: 0.15, splitAngle: 0.3, gravitropism: 0.025, densityPoints: [0.85, 1.0, 1.0, 0.95, 0.85], lengthPoints: [0.92, 1.0, 1.0, 1.0, 0.92], randomnessPoints: [0.6, 0.9, 1.2, 1.4, 1.6] }),
      // L4 = twig layer: short, droopy, wiggly.
      withLevel({ children: 6, lenRatio: 0.4, angle: 0.55, angleVar: 0.2, rollVar: 0.85, startPlacement: 0.2, endPlacement: 1, distortion: 0.28, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.28, curveMode: 'backCurve', curveAmount: 0.3, gravitropism: 0.16, densityPoints: [0.85, 1.0, 1.0, 0.95, 0.85], lengthPoints: [0.95, 1.0, 1.0, 1.0, 0.95], randomnessPoints: [0.85, 1.15, 1.45, 1.7, 2.0] }),
    ],
  },
  Cherry: {
    // Prunus: wide spreading crown on a short trunk, alternate phyllotaxis.
    // Flowers bloom before leaves — season 0.05 keeps that "pink cloud" read.
    // 4 orders (was 5). Trunk bumped 6 → 7 so the crown clears the floor.
    type: 'broadleaf',
    trunkHeight: 7, trunkScale: 1.25, tipRadius: 0.005, alloExp: 2.35, rootFlare: 0.35,
    trunkJitter: 0.06,
    globalScale: 0.9,
    shape: 'free', baseSize: 0.2,
    leafShape: 'Oval',
    leafSize: 0.1, leafSpread: 0.35, leafStemLen: 0.05, leafStemAngle: 0.35, leafTilt: 0.15,
    leavesPerTip: 18, leafChainSteps: 6, leavesStart: 0, season: 0.05,
    leafClusterSize: 4, leafClusterSpread: 0.65,
    leafPhyllotaxis: 'alternate',
    pruneMode: 'off',
    levels: [
      withLevel({ children: 7, lenRatio: 0.7, angle: 1.1, angleVar: 0.25, rollVar: 0.8, startPlacement: 0.25, endPlacement: 1, apicalDominance: 0.12, angleDecline: -0.15, distortion: 0.26, distortionType: 'perlin', distortionFreq: 2.4, curveMode: 'sCurve', curveAmount: 0.45, curveBack: -0.25, segSplits: 0.2, splitAngle: 0.3, susceptibility: 1.6, gravitropism: 0.02, densityPoints: [0.5, 0.9, 1, 1, 0.85] }),
      withLevel({ children: 6, lenRatio: 0.72, angle: 0.85, angleVar: 0.22, startPlacement: 0.2, endPlacement: 1, apicalDominance: 0.08, distortion: 0.24, distortionType: 'perlin', distortionFreq: 2.8, curveMode: 'sCurve', curveAmount: 0.35, curveBack: -0.3, segSplits: 0.1, splitAngle: 0.3, gravitropism: 0.025, susceptibility: 1.5, densityPoints: [0.5, 0.9, 1, 0.95, 0.7] }),
      withLevel({ children: 5, lenRatio: 0.62, angle: 0.65, startPlacement: 0.25, endPlacement: 1, distortion: 0.22, stochastic: 0.22, curveMode: 'backCurve', curveAmount: 0.3, gravitropism: 0.04, densityPoints: [0.5, 0.85, 1, 1, 0.75] }),
      // L4 twigs: drooping, wiggly.
      withLevel({ children: 4, lenRatio: 0.42, angle: 0.5, startPlacement: 0.3, endPlacement: 1, distortion: 0.26, distortionType: 'perlin', distortionFreq: 3.4, stochastic: 0.3, curveMode: 'backCurve', curveAmount: 0.3, gravitropism: 0.16, densityPoints: [0.5, 0.85, 1, 1, 0.8] }),
    ],
  },
  Willow: {
    // Weeping Willow (Weber-Penn 1995, Table 2). Salix has alternate
    // phyllotaxis but we keep the leaves slightly scattered so the drooping
    // whips don't read like a rigid helix. trunkHeight lifted 7 → 8 so the
    // weeping whips don't scrape the floor.
    type: 'broadleaf',
    trunkHeight: 8, trunkScale: 1.5, tipRadius: 0.005, alloExp: 2.25, rootFlare: 0.55,
    trunkBow: 0.45, trunkLean: 0.05, trunkLeanDir: 220, trunkJitter: 0.07,
    globalScale: 1.1,
    shape: 'cylindrical', baseSize: 0.08,
    leafShape: 'Willow',
    leafSize: 0.2, leafDroop: 0.95, leafFacing: 0.3, leafStemLen: 0.04, leafStemAngle: 0.25, leafSpread: 0.4,
    leavesPerTip: 20, leafChainSteps: 12, leavesStart: 0.1,
    leafMaxRadius: 0.05, leafPhyllotaxis: 'alternate',
    leafClusterSize: 3, leafClusterSpread: 0.3,
    pruneMode: 'off', season: 0.35,
    levels: [
      // Weber-Penn L1: Curve 0, CurveBack 20, SegSplits 0.1
      withLevel({ children: 6, lenRatio: 0.55, angle: 0.85, angleVar: 0.18, rollVar: 0.7, startPlacement: 0.35, endPlacement: 1, phototropism: 0.04, gravitropism: 0.015, susceptibility: 1.2, curveMode: 'sCurve', curveAmount: 0.4, curveBack: 0.2, segSplits: 0.1, splitAngle: 0.05, distortion: 0.1, densityPoints: [0.4, 0.8, 1, 1, 0.9], lengthPoints: [0.7, 0.95, 1.05, 1.0, 0.8] }),
      withLevel({ children: 5, lenRatio: 0.8, angle: 0.55, rollVar: 0.7, startPlacement: 0.2, endPlacement: 1, gravitropism: 0.05, susceptibility: 2.0, curveMode: 'backCurve', curveAmount: 0.75, curveBack: 0.8, segSplits: 0.2, splitAngle: 0.5, distortion: 0.08, densityPoints: [0.4, 0.85, 1, 0.95, 0.7], lengthPoints: [0.8, 1.0, 1.05, 1.0, 0.85] }),
      // Iconic weeping whips — uniformly long at all parent positions
      // (base-heavy taper would kill the drape effect).
      withLevel({ children: 4, lenRatio: 0.95, angle: 0.28, startPlacement: 0.25, endPlacement: 1, gravitropism: 0.14, susceptibility: 3.2, curveMode: 'backCurve', curveAmount: 1.15, stochastic: 0.1, densityPoints: [0.5, 0.85, 1, 0.95, 0.7], lengthPoints: [0.95, 1.0, 1.05, 1.05, 0.95] }),
      withLevel({ children: 3, lenRatio: 0.85, angle: 0.22, startPlacement: 0.3, endPlacement: 1, gravitropism: 0.18, susceptibility: 3.5, curveMode: 'backCurve', curveAmount: 1.2, stochastic: 0.14, densityPoints: [0.5, 0.9, 1, 1, 0.8], lengthPoints: [0.95, 1.0, 1.05, 1.05, 0.95] }),
    ],
  },
  Birch: {
    // Betula: slender pale trunk, narrow ovate crown with drooping whip
    // tips. Alternate phyllotaxis. Keeps 4 orders because the fine drooping
    // whips are part of the silhouette.
    type: 'broadleaf',
    trunkHeight: 10, trunkScale: 1.1, tipRadius: 0.005, alloExp: 2.45, rootFlare: 0.25,
    trunkJitter: 0.05,
    globalScale: 0.7,
    shape: 'tend-flame', baseSize: 0.18,
    barkHue: 0.12, barkTint: 0.68,
    leafShape: 'Birch',
    leafSize: 0.07, leafSpread: 0.3, leafStemLen: 0.04, leafStemAngle: 0.3, leafTilt: 0.2,
    leavesPerTip: 14, leafChainSteps: 6, leavesStart: 0.1, season: 0.25,
    leafClusterSize: 3, leafClusterSpread: 0.55,
    leafPhyllotaxis: 'alternate',
    pruneMode: 'off',
    levels: [
      // Birch: slender trunk, scaffold arcs up, drooping whippy tips.
      // Flame shape + angleDecline negative keeps the narrow tall silhouette.
      withLevel({ children: 8, lenRatio: 0.6, angle: 0.95, angleVar: 0.25, rollVar: 0.85, startPlacement: 0.22, endPlacement: 1, apicalDominance: 0.15, angleDecline: -0.25, distortion: 0.26, distortionType: 'perlin', distortionFreq: 2.5, curveMode: 'sCurve', curveAmount: 0.35, curveBack: -0.2, segSplits: 0.15, splitAngle: 0.3, stochastic: 0.15, gravitropism: 0.02, susceptibility: 1.5, densityPoints: [0.4, 0.8, 1, 1, 0.9] }),
      withLevel({ children: 6, lenRatio: 0.78, angle: 0.7, startPlacement: 0.18, endPlacement: 1, apicalDominance: 0.08, gravitropism: 0.06, susceptibility: 1.8, curveMode: 'backCurve', curveAmount: 0.55, curveBack: 0.4, segSplits: 0.1, splitAngle: 0.35, distortion: 0.22, densityPoints: [0.45, 0.85, 1, 0.95, 0.7] }),
      withLevel({ children: 5, lenRatio: 0.72, angle: 0.5, startPlacement: 0.25, endPlacement: 1, gravitropism: 0.1, distortion: 0.2, distortionType: 'perlin', distortionFreq: 3.0, stochastic: 0.24, curveMode: 'backCurve', curveAmount: 0.45, densityPoints: [0.5, 0.85, 1, 1, 0.75] }),
      // L4 twigs: heavy droop, wiggly — birch weeping whip-tip character.
      withLevel({ children: 4, lenRatio: 0.55, angle: 0.4, startPlacement: 0.3, endPlacement: 1, distortion: 0.28, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.32, gravitropism: 0.2, curveMode: 'backCurve', curveAmount: 0.4, densityPoints: [0.55, 0.9, 1, 1, 0.8] }),
    ],
  },
  Acacia: {
    // African flat-top (Vachellia): clean tall trunk with a thin horizontal
    // umbrella crown. Alternate phyllotaxis on bipinnate compound leaves.
    // trunkHeight 6 → 7 so the canopy sits clearly above the ground.
    type: 'broadleaf',
    trunkHeight: 7, trunkScale: 1.3, tipRadius: 0.006, alloExp: 2.3, rootFlare: 0.4,
    trunkJitter: 0.05,
    globalScale: 0.9,
    shape: 'free', baseSize: 0.45,
    leafShape: 'Lanceolate',
    leafSize: 0.08, leafSpread: 0.3, leafStemLen: 0.03, leafStemAngle: 0.5, leafTilt: 0.18,
    leavesPerTip: 22, leafChainSteps: 6, leavesStart: 0.3, season: 0.5,
    leafClusterSize: 5, leafClusterSpread: 0.7,
    leafPhyllotaxis: 'alternate',
    pruneMode: 'off',
    levels: [
      // Acacia: horizontal umbrella (African Flat-Top / Vachellia). The
      // flat crown is formed by branches that spawn in a narrow zone near
      // the trunk top, all reaching roughly the same horizontal outward
      // distance. Dome lengthPoints keeps the middle-spawning branches
      // longest, stubbier at the extremes → concave umbrella rim.
      withLevel({ children: 8, lenRatio: 0.78, angle: 1.25, angleVar: 0.2, rollVar: 0.75, startPlacement: 0.4, endPlacement: 1, apicalDominance: 0.06, angleDecline: 0.35, distortion: 0.22, distortionType: 'perlin', distortionFreq: 2.2, curveMode: 'sCurve', curveAmount: 0.55, curveBack: -0.4, segSplits: 0.3, splitAngle: 0.45, phototropism: 0.08, susceptibility: 1.3, gravitropism: -0.02, densityPoints: [0.3, 0.7, 1, 1, 0.9], lengthPoints: [0.55, 0.85, 1.05, 1.05, 0.85] }),
      withLevel({ children: 7, lenRatio: 0.88, angle: 1.05, angleVar: 0.22, startPlacement: 0.2, endPlacement: 1, phototropism: 0.1, susceptibility: 1.7, distortion: 0.2, distortionType: 'perlin', distortionFreq: 2.6, curveMode: 'sCurve', curveAmount: 0.45, curveBack: -0.5, segSplits: 0.2, splitAngle: 0.4, apicalDominance: 0.08, gravitropism: -0.02, densityPoints: [0.4, 0.85, 1, 0.95, 0.7], lengthPoints: [0.7, 0.95, 1.05, 1.0, 0.85] }),
      withLevel({ children: 5, lenRatio: 0.75, angle: 0.75, startPlacement: 0.25, endPlacement: 1, distortion: 0.18, distortionType: 'perlin', distortionFreq: 3.0, stochastic: 0.22, phototropism: 0.06, gravitropism: -0.015, densityPoints: [0.5, 0.85, 1, 1, 0.8] }),
      // L4 twigs: mild droop (Acacia is horizontal not weeping), more wiggle.
      withLevel({ children: 4, lenRatio: 0.45, angle: 0.55, startPlacement: 0.3, endPlacement: 1, distortion: 0.24, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.32, gravitropism: 0.08, densityPoints: [0.55, 0.9, 1, 1, 0.85] }),
    ],
  },
  Olive: {
    // Olea europaea: gnarly short sympodial (no central leader) with
    // OPPOSITE phyllotaxis — branches and leaves in pairs. Short fat trunk,
    // wide irregular crown. trunkHeight 4.5 → 5 + baseSize 0.1 → 0.15 so
    // low branches clear the ground more reliably.
    type: 'broadleaf',
    trunkHeight: 5, trunkScale: 1.8, tipRadius: 0.007, alloExp: 2.1, rootFlare: 0.55,
    trunkJitter: 0.1,
    globalScale: 0.75,
    shape: 'spherical', baseSize: 0.15,
    leafShape: 'Lanceolate',
    leafSize: 0.09, leafFacing: 0.2, leafSpread: 0.28, leafStemLen: 0.03, leafStemAngle: 0.35, leafTilt: 0.1,
    leavesPerTip: 14, leafChainSteps: 6, leavesStart: 0.1, season: 0.28,
    leafClusterSize: 4, leafClusterSpread: 0.6,
    leafPhyllotaxis: 'opposite',
    pruneMode: 'off',
    levels: [
      // Olive: gnarly twisted branches (Leeuwenberg-like — sympodial, no
      // single leader). High torsion + twist + strong curveBack creates
      // the wavy zigzag character. Reverse taper keeps long branches at
      // the tip of the parent so the crown spreads wide + flat-topped, and
      // very high stochastic makes spacing irregular — matching real
      // ancient olives which have dense-then-sparse foliage clumps.
      // L1 uses opposite phyllotaxis so branches come in pairs (Oleaceae).
      withLevel({ children: 8, lenRatio: 0.72, angle: 1.15, angleVar: 0.42, rollVar: 0.5, phyllotaxis: 'opposite', startPlacement: 0.2, endPlacement: 1, apicalDominance: 0.02, angleDecline: 0.15, distortion: 0.4, distortionType: 'perlin', distortionFreq: 3, curveMode: 'sCurve', curveAmount: 0.55, curveBack: 0.5, segSplits: 0.4, splitAngle: 0.55, torsion: 0.5, twist: 0.3, stochastic: 0.18, susceptibility: 1.3, gravitropism: -0.015, densityPoints: [0.4, 0.75, 1, 1, 0.95], lengthPoints: [0.7, 0.9, 1.0, 1.0, 0.95] }),
      withLevel({ children: 6, lenRatio: 0.65, angle: 0.9, phyllotaxis: 'opposite', startPlacement: 0.2, endPlacement: 1, distortion: 0.3, stochastic: 0.35, torsion: 0.4, curveMode: 'backCurve', curveAmount: 0.45, curveBack: 0.55, segSplits: 0.25, splitAngle: 0.45, gravitropism: -0.015, densityPoints: [0.5, 0.9, 1, 0.95, 0.7] }),
      withLevel({ children: 5, lenRatio: 0.6, angle: 0.65, startPlacement: 0.25, endPlacement: 1, distortion: 0.25, stochastic: 0.4, curveBack: 0.35, densityPoints: [0.55, 0.9, 1, 1, 0.75] }),
      // L4 twigs: drooping, distorted.
      withLevel({ children: 4, lenRatio: 0.4, angle: 0.5, startPlacement: 0.3, endPlacement: 1, distortion: 0.3, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.45, gravitropism: 0.12, densityPoints: [0.6, 0.9, 1, 1, 0.8] }),
    ],
  },
  Baobab: {
    // Adansonia: massive swollen trunk with short radial branches only at
    // the very top. Alternate phyllotaxis on palmate compound leaves.
    // baseSize 0.6 keeps the famously clean trunk.
    type: 'broadleaf',
    trunkHeight: 6, trunkScale: 3.4, tipRadius: 0.012, alloExp: 2.25, rootFlare: 1.0,
    trunkLean: 0.04, trunkLeanDir: 15, trunkJitter: 0.07,
    globalScale: 0.9,
    shape: 'free', baseSize: 0.65,
    leafShape: 'Fan',
    leafSize: 0.1, leafSpread: 0.3, leafStemLen: 0.04, leafStemAngle: 0.3, leafTilt: 0.1,
    leavesPerTip: 12, leafChainSteps: 5, leavesStart: 0.5, season: 0.5,
    leafClusterSize: 5, leafClusterSpread: 0.65,
    leafPhyllotaxis: 'alternate',
    pruneMode: 'off',
    levels: [
      // Baobab: massive horizontal scaffold at the top of the trunk.
      // baseSize 0.6 = cleanest bole of any species (fat trunk, branches
      // only at top). angleDecline POSITIVE → even flatter branches at tip.
      withLevel({ children: 9, lenRatio: 0.85, angle: 1.3, angleVar: 0.22, rollVar: 0.7, startPlacement: 0.75, endPlacement: 1, apicalDominance: 0.04, angleDecline: 0.3, distortion: 0.28, distortionType: 'perlin', distortionFreq: 2, curveMode: 'sCurve', curveAmount: 0.4, curveBack: -0.5, segSplits: 0.3, splitAngle: 0.5, susceptibility: 1.0, densityPoints: [0.3, 0.7, 1, 1, 0.9], lengthPoints: [1.0, 1.0, 1.0, 1.0, 1.0] }),
      withLevel({ children: 6, lenRatio: 0.6, angle: 0.85, startPlacement: 0.2, endPlacement: 1, distortion: 0.3, distortionType: 'perlin', distortionFreq: 2.6, stochastic: 0.3, curveMode: 'sCurve', curveAmount: 0.3, curveBack: 0.4, segSplits: 0.15, splitAngle: 0.35, gravitropism: -0.02, densityPoints: [0.5, 0.9, 1, 0.95, 0.7] }),
      withLevel({ children: 5, lenRatio: 0.52, angle: 0.6, startPlacement: 0.25, endPlacement: 1, distortion: 0.25, distortionType: 'perlin', distortionFreq: 3.0, stochastic: 0.35, densityPoints: [0.55, 0.9, 1, 1, 0.8] }),
      // L4 twigs: stubby, droopy, wiggly.
      withLevel({ children: 4, lenRatio: 0.4, angle: 0.48, startPlacement: 0.3, endPlacement: 1, distortion: 0.28, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.45, gravitropism: 0.12, densityPoints: [0.6, 0.9, 1, 1, 0.85] }),
    ],
  },
  Palm: {
    // Single-order architecture: fronds emerge directly from the trunk apex
    // in a spiral. No secondary branching in real palms. trunkHeight lifted
    // so the frond crown is clearly above human eye-level.
    type: 'broadleaf',
    trunkHeight: 11, trunkScale: 0.8, tipRadius: 0.1, alloExp: 2.6, rootFlare: 0.4,
    trunkLean: 0.12, trunkLeanDir: 35, trunkBow: 0.3,
    globalScale: 0.85,
    leafShape: 'Lanceolate',
    leafSize: 0.45, leafDroop: 0.7, leafFacing: 0.2, leafStemLen: 0.15, leafStemAngle: 0.15,
    leavesPerTip: 16, leafChainSteps: 6, leavesStart: 0.85, season: 0.2,
    leafClusterSize: 3, leafClusterSpread: 0.5,
    leafPhyllotaxis: 'spiral',
    pruneMode: 'off',
    levels: [
      // Palm: tufted radial whorl at the very top — no true branching in
      // real palms. Every frond must be full length (default base-heavy
      // taper would squash the crown into a tiny tuft because all fronds
      // spawn in the narrow 96-100% zone).
      withLevel({ children: 14, lenRatio: 0.55, angle: 0.95, angleVar: 0.08, phyllotaxis: 'spiral', startPlacement: 0.96, endPlacement: 1, gravitropism: 0.07, susceptibility: 2.8, curveMode: 'backCurve', curveAmount: 0.95, distortion: 0.04, rollStart: 0.3, lengthPoints: [1, 1, 1, 1, 1], densityPoints: [1, 1, 1, 1, 1] }),
    ],
  },
  // --- Weber-Penn library species (SIGGRAPH 1995 parameter sets) ---------
  // Values translated from the original paper's per-species tables. DownAngle
  // in degrees → our `angle` in radians. nBranches collapsed where our system
  // uses a coarser recursion depth. Tuned for visual parity with our renderer.
  Aspen: {
    // Quaking Aspen (Weber-Penn 1995, Table 4). Populus tremuloides —
    // alternate phyllotaxis, narrow columnar crown, flat leafstalks that
    // flutter in wind.
    type: 'broadleaf',
    trunkHeight: 9, trunkScale: 0.85, tipRadius: 0.005, alloExp: 2.4, rootFlare: 0.25,
    trunkJitter: 0.05,
    globalScale: 0.75,
    shape: 'cylindrical', baseSize: 0.4,
    leafShape: 'Heart',
    leafSize: 0.07, leafSpread: 0.3, leafStemLen: 0.05, leafStemAngle: 0.4, leafTilt: 0.25,
    leavesPerTip: 18, leafChainSteps: 6, leavesStart: 0.3, season: 0.55,
    leafClusterSize: 3, leafClusterSpread: 0.45, leafMaxRadius: 0.06,
    leafPhyllotaxis: 'alternate',
    pruneMode: 'ellipsoid', pruneRadius: 4.5, pruneHeight: 7, pruneCenterY: 11,
    levels: [
      withLevel({ children: 8, lenRatio: 0.48, angle: 1.05, angleVar: 0.35, rollVar: 0.85, startPlacement: 0.4, endPlacement: 1, apicalDominance: 0.2, distortion: 0.26, distortionType: 'perlin', distortionFreq: 3, curveMode: 'backCurve', curveAmount: 0.2, segSplits: 0.5, splitAngle: 0.3, susceptibility: 1.2, densityPoints: [0.3, 0.75, 1, 1, 0.9] }),
      withLevel({ children: 6, lenRatio: 0.58, angle: 0.78, angleVar: 0.3, startPlacement: 0.2, endPlacement: 1, apicalDominance: 0.15, distortion: 0.24, distortionType: 'perlin', distortionFreq: 3.2, stochastic: 0.22, curveMode: 'backCurve', curveAmount: 0.7, gravitropism: 0.015, densityPoints: [0.45, 0.85, 1, 0.95, 0.7] }),
      withLevel({ children: 4, lenRatio: 0.5, angle: 0.55, startPlacement: 0.25, endPlacement: 1, distortion: 0.22, distortionType: 'perlin', distortionFreq: 3.4, stochastic: 0.28, curveMode: 'backCurve', curveAmount: 0.7, gravitropism: 0.025, densityPoints: [0.5, 0.85, 1, 1, 0.8] }),
      // L4 twigs: drooping, wiggly — Aspen's flutter character.
      withLevel({ children: 3, lenRatio: 0.36, angle: 0.45, startPlacement: 0.3, endPlacement: 1, distortion: 0.26, distortionType: 'perlin', distortionFreq: 3.8, stochastic: 0.36, gravitropism: 0.14, densityPoints: [0.55, 0.9, 1, 1, 0.85] }),
    ],
  },
  Tupelo: {
    // Black Tupelo (Weber-Penn 1995, Table 1) — pointed pyramidal crown,
    // strong central trunk visible through lower branches, vivid autumn color.
    // tend-flame silhouette = flame/teardrop: widest in lower third, pointed top.
    // Nyssa sylvatica — alternate phyllotaxis, oval leaves.
    type: 'broadleaf',
    trunkHeight: 12, trunkScale: 1.05, tipRadius: 0.006, alloExp: 2.45, rootFlare: 0.5,
    trunkJitter: 0.06,
    globalScale: 0.85,
    shape: 'conical', baseSize: 0.25,
    leafShape: 'Oval',
    leafSize: 0.15, leafSpread: 0.4, leafStemLen: 0.05, leafStemAngle: 0.35, leafTilt: 0.15,
    leavesPerTip: 22, leafChainSteps: 6, leavesStart: 0.1, season: 0.88,
    leafClusterSize: 4, leafClusterSpread: 0.65, leafMaxRadius: 0.1,
    leafPhyllotaxis: 'alternate',
    pruneMode: 'off',
    levels: [
      // L1: short laterals kept close to the central trunk + high apical
      // dominance so the pointed top reads. angleDecline negative = angle
      // decreases going up the trunk (shorter more vertical branches at top).
      withLevel({ children: 11, lenRatio: 0.42, angle: 0.95, angleVar: 0.25, rollVar: 0.85, startPlacement: 0.15, endPlacement: 1, apicalDominance: 0.35, angleDecline: -0.3, distortion: 0.26, distortionType: 'perlin', distortionFreq: 2.4, curveMode: 'sCurve', curveAmount: 0.2, segSplits: 0.1, splitAngle: 0.2, susceptibility: 1.3, gravitropism: 0.005, densityPoints: [0.35, 0.8, 1, 1, 0.9] }),
      withLevel({ children: 7, lenRatio: 0.62, angle: 0.6, angleVar: 0.25, startPlacement: 0.2, endPlacement: 1, apicalDominance: 0.2, distortion: 0.24, distortionType: 'perlin', distortionFreq: 2.8, stochastic: 0.18, curveMode: 'sCurve', curveAmount: 0.22, gravitropism: 0.02, densityPoints: [0.45, 0.85, 1, 0.95, 0.7] }),
      withLevel({ children: 5, lenRatio: 0.6, angle: 0.5, startPlacement: 0.25, endPlacement: 1, distortion: 0.22, distortionType: 'perlin', distortionFreq: 3.2, stochastic: 0.22, curveMode: 'backCurve', curveAmount: 0.22, gravitropism: 0.03, densityPoints: [0.5, 0.85, 1, 1, 0.8] }),
      // L4 twigs.
      withLevel({ children: 4, lenRatio: 0.4, angle: 0.42, startPlacement: 0.3, endPlacement: 1, distortion: 0.26, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.32, gravitropism: 0.15, densityPoints: [0.55, 0.9, 1, 1, 0.85] }),
    ],
  },
  Sassafras: {
    // Sassafras albidum — alternate phyllotaxis, polymorphic leaves
    // (oval + mitten + 3-lobed on the same tree). Irregular zigzag
    // branching, forky silhouette.
    type: 'broadleaf',
    trunkHeight: 8, trunkScale: 1.15, tipRadius: 0.006, alloExp: 2.3, rootFlare: 0.35,
    trunkJitter: 0.08,
    globalScale: 1.0,
    shape: 'spherical', baseSize: 0.18,
    leafShape: 'Fan',
    leafSize: 0.15, leafSpread: 0.4, leafStemLen: 0.06, leafStemAngle: 0.4, leafTilt: 0.2,
    leavesPerTip: 12, leafChainSteps: 6, leavesStart: 0.15, season: 0.82,
    leafClusterSize: 3, leafClusterSpread: 0.5, leafMaxRadius: 0.08,
    leafPhyllotaxis: 'alternate',
    pruneMode: 'off',
    levels: [
      // Sassafras: irregular, twisted, lots of forking at every level.
      withLevel({ children: 6, lenRatio: 0.7, angle: 1.15, angleVar: 0.4, rollVar: 0.9, startPlacement: 0.28, endPlacement: 1, apicalDominance: 0.12, angleDecline: -0.15, distortion: 0.28, distortionType: 'perlin', distortionFreq: 2, curveMode: 'sCurve', curveAmount: 0.5, curveBack: -0.35, segSplits: 0.5, splitAngle: 0.45, torsion: 0.3, susceptibility: 1.5, gravitropism: 0.01, densityPoints: [0.4, 0.85, 1, 1, 0.85] }),
      withLevel({ children: 6, lenRatio: 0.75, angle: 0.82, angleVar: 0.32, startPlacement: 0.2, endPlacement: 1, distortion: 0.24, stochastic: 0.22, curveMode: 'backCurve', curveAmount: 0.4, curveBack: 0.3, segSplits: 0.35, splitAngle: 0.4, gravitropism: 0.03, densityPoints: [0.5, 0.9, 1, 0.95, 0.7] }),
      withLevel({ children: 5, lenRatio: 0.7, angle: 0.62, startPlacement: 0.25, endPlacement: 1, distortion: 0.2, stochastic: 0.28, curveMode: 'backCurve', curveAmount: 0.3, gravitropism: 0.04, densityPoints: [0.55, 0.9, 1, 1, 0.8] }),
      // L4 twigs: drooping, gnarled.
      withLevel({ children: 4, lenRatio: 0.42, angle: 0.5, startPlacement: 0.3, endPlacement: 1, distortion: 0.28, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.4, gravitropism: 0.16, densityPoints: [0.6, 0.9, 1, 1, 0.85] }),
    ],
  },
  Lime: {
    // Tilia: dense spherical crown, heart-shaped leaves. Distichous
    // (2-ranked alternate) phyllotaxis — approximated as alternate.
    // baseSize bumped so the low scaffold clears the ground.
    type: 'broadleaf',
    trunkHeight: 9, trunkScale: 1.3, tipRadius: 0.006, alloExp: 2.35, rootFlare: 0.45,
    trunkJitter: 0.06,
    globalScale: 0.95,
    shape: 'spherical', baseSize: 0.2,
    leafShape: 'Heart',
    leafSize: 0.14, leafSpread: 0.4, leafStemLen: 0.05, leafStemAngle: 0.35, leafTilt: 0.15,
    leavesPerTip: 14, leafChainSteps: 6, leavesStart: 0.1, season: 0.5,
    leafClusterSize: 4, leafClusterSpread: 0.65, leafMaxRadius: 0.12,
    leafPhyllotaxis: 'alternate',
    pruneMode: 'off',
    levels: [
      // Lime (Tilia): big dense round canopy, large heart-shaped leaves,
      // regular branching with a modest spherical envelope.
      withLevel({ children: 7, lenRatio: 0.55, angle: 0.95, angleVar: 0.25, rollVar: 0.85, startPlacement: 0.3, endPlacement: 1, apicalDominance: 0.2, angleDecline: -0.2, distortion: 0.26, distortionType: 'perlin', distortionFreq: 2.4, curveMode: 'sCurve', curveAmount: 0.35, curveBack: -0.25, segSplits: 0.2, splitAngle: 0.3, susceptibility: 1.5, gravitropism: 0.005, densityPoints: [0.4, 0.85, 1, 1, 0.9] }),
      withLevel({ children: 7, lenRatio: 0.75, angle: 0.78, angleVar: 0.25, startPlacement: 0.2, endPlacement: 1, apicalDominance: 0.1, distortion: 0.24, distortionType: 'perlin', distortionFreq: 2.8, stochastic: 0.18, curveMode: 'sCurve', curveAmount: 0.3, curveBack: -0.3, segSplits: 0.1, splitAngle: 0.3, gravitropism: 0.02, densityPoints: [0.45, 0.9, 1, 0.95, 0.7] }),
      withLevel({ children: 5, lenRatio: 0.7, angle: 0.62, startPlacement: 0.25, endPlacement: 1, distortion: 0.22, distortionType: 'perlin', distortionFreq: 3.2, stochastic: 0.24, curveMode: 'backCurve', curveAmount: 0.25, gravitropism: 0.03, densityPoints: [0.5, 0.85, 1, 1, 0.8] }),
      // L4 twigs.
      withLevel({ children: 4, lenRatio: 0.4, angle: 0.5, startPlacement: 0.3, endPlacement: 1, distortion: 0.26, distortionType: 'perlin', distortionFreq: 3.6, stochastic: 0.32, gravitropism: 0.15, densityPoints: [0.55, 0.9, 1, 1, 0.85] }),
    ],
  },
  Pine: {
    type: 'conifer',
    trunkHeight: 14, trunkScale: 1.25, tipRadius: 0.022, alloExp: 2.6, rootFlare: 0.5,
    shape: 'conical', baseSize: 0.15,
    leafSize: 0.18, leafFacing: 0.65, leavesPerTip: 26, leafChainSteps: 5, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 8.5, pruneHeight: 12, pruneCenterY: 12,
    // Conifer-specific structure — applyConiferConfigToP reads these.
    cBranchCount: 55, cBranchAngle: 1.1, cBranchStart: 0.25, cCrownTaper: 0.65,
    cBranchDroop: 0.02, cBranchLen: 0.52,
    cTwigCount: 9, cTwigLen: 0.7, cTwigAngle: 0.9,
    cNeedleLength: 0.55, cNeedleWidth: 0.18, cNeedleDensity: 26, cNeedleChain: 5,
    cNeedleFacing: 0.6, cNeedleDroop: 0.05,
    cConeCount: 12, cConeSize: 0.22, cConeHang: 0.7,
  },
  Spruce: {
    type: 'conifer',
    trunkHeight: 16, trunkScale: 1.15, tipRadius: 0.02, alloExp: 2.7, rootFlare: 0.4,
    shape: 'conical', baseSize: 0.08,
    leafSize: 0.1, leafFacing: 0.8, leavesPerTip: 30, leafChainSteps: 5, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 5, pruneHeight: 14, pruneCenterY: 14.5,
    cBranchCount: 60, cBranchAngle: 1.2, cBranchStart: 0.18, cCrownTaper: 0.85,
    cBranchDroop: 0.04, cBranchLen: 0.36,
    cTwigCount: 9, cTwigLen: 0.5, cTwigAngle: 1.0,
    cNeedleLength: 0.26, cNeedleWidth: 0.13, cNeedleDensity: 30, cNeedleChain: 5,
    cNeedleFacing: 0.8, cNeedleDroop: 0,
    cConeCount: 10, cConeSize: 0.18, cConeHang: 0.8,
  },
  Cedar: {
    type: 'conifer',
    trunkHeight: 16, trunkScale: 1.35, tipRadius: 0.03, alloExp: 2.4, rootFlare: 0.7,
    shape: 'conical', baseSize: 0.2,
    leafSize: 0.14, leafFacing: 0.45, leavesPerTip: 22, leafChainSteps: 4, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 8.5, pruneHeight: 9.5, pruneCenterY: 11.5,
    cBranchCount: 32, cBranchAngle: 0.95, cBranchStart: 0.35, cCrownTaper: 0.5,
    cBranchDroop: 0.05, cBranchLen: 0.58,
    cTwigCount: 7, cTwigLen: 0.55, cTwigAngle: 0.85,
    cNeedleLength: 0.35, cNeedleWidth: 0.13, cNeedleDensity: 22, cNeedleChain: 4,
    cNeedleFacing: 0.45, cNeedleDroop: 0.1,
    cConeCount: 6, cConeSize: 0.3, cConeHang: 0.2,
  },
  Cypress: {
    type: 'conifer',
    trunkHeight: 14, trunkScale: 0.95, tipRadius: 0.022, alloExp: 2.8, rootFlare: 0.35,
    shape: 'cylindrical', baseSize: 0.05,
    leafSize: 0.08, leafFacing: 0.65, leavesPerTip: 28, leafChainSteps: 4, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 3.2, pruneHeight: 14, pruneCenterY: 11,
    cBranchCount: 75, cBranchAngle: 0.65, cBranchStart: 0.1, cCrownTaper: 0.92,
    cBranchDroop: 0.005, cBranchLen: 0.2,
    cTwigCount: 8, cTwigLen: 0.45, cTwigAngle: 0.7,
    cNeedleLength: 0.2, cNeedleWidth: 0.1, cNeedleDensity: 28, cNeedleChain: 4,
    cNeedleFacing: 0.65, cNeedleDroop: 0,
    cConeCount: 5, cConeSize: 0.12, cConeHang: 0.1,
  },
  // --- Weber-Penn conifers ------------------------------------------------
  Fir: {
    type: 'conifer',
    trunkHeight: 18, trunkScale: 1.2, tipRadius: 0.02, alloExp: 2.8, rootFlare: 0.5,
    shape: 'conical', baseSize: 0.08,
    leafSize: 0.12, leafFacing: 0.78, leavesPerTip: 28, leafChainSteps: 5, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 5.2, pruneHeight: 15, pruneCenterY: 15,
    cBranchCount: 70, cBranchAngle: 1.3, cBranchStart: 0.12, cCrownTaper: 0.88,
    cBranchDroop: 0.01, cBranchLen: 0.3,
    cTwigCount: 8, cTwigLen: 0.55, cTwigAngle: 0.95,
    cNeedleLength: 0.28, cNeedleWidth: 0.11, cNeedleDensity: 28, cNeedleChain: 5,
    cNeedleFacing: 0.78, cNeedleDroop: 0,
    cConeCount: 9, cConeSize: 0.17, cConeHang: 0.75,
  },
  Larch: {
    type: 'conifer',
    trunkHeight: 15, trunkScale: 1.1, tipRadius: 0.022, alloExp: 2.55, rootFlare: 0.45,
    shape: 'conical', baseSize: 0.15,
    leafSize: 0.1, leafFacing: 0.4, leavesPerTip: 24, leafChainSteps: 4, season: 0.35,
    pruneMode: 'ellipsoid', pruneRadius: 6.5, pruneHeight: 12, pruneCenterY: 13,
    cBranchCount: 40, cBranchAngle: 1.0, cBranchStart: 0.22, cCrownTaper: 0.6,
    cBranchDroop: 0.04, cBranchLen: 0.48,
    cTwigCount: 7, cTwigLen: 0.55, cTwigAngle: 0.85,
    cNeedleLength: 0.3, cNeedleWidth: 0.08, cNeedleDensity: 24, cNeedleChain: 4,
    cNeedleFacing: 0.4, cNeedleDroop: 0.08,
    cConeCount: 8, cConeSize: 0.15, cConeHang: 0.4,
  },
  // --- Community-library conifers (Arbaro / tree-gen presets) -------------
  ScotsPine: {
    // Scots Pine: tall bare trunk with the whole crown at the top — the
    // classic "umbrella pine" silhouette.
    type: 'conifer',
    trunkHeight: 15, trunkScale: 1.15, tipRadius: 0.022, alloExp: 2.6, rootFlare: 0.5,
    shape: 'inverse', baseSize: 0.55,
    leafSize: 0.2, leafFacing: 0.5, leavesPerTip: 30, leafChainSteps: 5, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 8, pruneHeight: 6, pruneCenterY: 17,
    cBranchCount: 22, cBranchAngle: 1.35, cBranchStart: 0.55, cCrownTaper: 0.2,
    cBranchDroop: 0.01, cBranchLen: 0.55,
    cTwigCount: 8, cTwigLen: 0.65, cTwigAngle: 1.05,
    cNeedleLength: 0.65, cNeedleWidth: 0.14, cNeedleDensity: 30, cNeedleChain: 5,
    cNeedleFacing: 0.55, cNeedleDroop: 0.02,
    cConeCount: 10, cConeSize: 0.2, cConeHang: 0.6,
  },
  Hemlock: {
    // Eastern Hemlock: graceful drooping conifer with soft silhouette —
    // tips of every branch droop noticeably.
    type: 'conifer',
    trunkHeight: 16, trunkScale: 1.05, tipRadius: 0.02, alloExp: 2.65, rootFlare: 0.35,
    shape: 'conical', baseSize: 0.1,
    leafSize: 0.1, leafFacing: 0.55, leavesPerTip: 28, leafChainSteps: 5, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 6, pruneHeight: 14, pruneCenterY: 14,
    cBranchCount: 55, cBranchAngle: 1.25, cBranchStart: 0.15, cCrownTaper: 0.7,
    cBranchDroop: 0.08, cBranchLen: 0.4,
    cTwigCount: 8, cTwigLen: 0.55, cTwigAngle: 0.9,
    cNeedleLength: 0.24, cNeedleWidth: 0.09, cNeedleDensity: 28, cNeedleChain: 5,
    cNeedleFacing: 0.55, cNeedleDroop: 0.25,
    cConeCount: 7, cConeSize: 0.1, cConeHang: 0.9,
  },
  Juniper: {
    // Juniper: short shrub-like conifer — dense rounded crown, tiny needles.
    type: 'conifer',
    trunkHeight: 4, trunkScale: 0.8, tipRadius: 0.02, alloExp: 2.3, rootFlare: 0.4,
    globalScale: 0.55,
    shape: 'spherical', baseSize: 0.05,
    leafSize: 0.07, leafFacing: 0.7, leavesPerTip: 24, leafChainSteps: 4, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 2.8, pruneHeight: 3, pruneCenterY: 2.5,
    cBranchCount: 40, cBranchAngle: 0.85, cBranchStart: 0.08, cCrownTaper: 0.3,
    cBranchDroop: 0, cBranchLen: 0.5,
    cTwigCount: 7, cTwigLen: 0.4, cTwigAngle: 0.8,
    cNeedleLength: 0.16, cNeedleWidth: 0.08, cNeedleDensity: 24, cNeedleChain: 4,
    cNeedleFacing: 0.7, cNeedleDroop: 0,
    cConeCount: 4, cConeSize: 0.08, cConeHang: 0.1,
  },
  Redwood: {
    // Coast Redwood / Sequoia: massive columnar tower. Thick trunk,
    // narrow crown, clean lower bole.
    type: 'conifer',
    trunkHeight: 24, trunkScale: 1.9, tipRadius: 0.028, alloExp: 2.9, rootFlare: 0.75,
    globalScale: 1.1,
    shape: 'cylindrical', baseSize: 0.3,
    leafSize: 0.08, leafFacing: 0.65, leavesPerTip: 26, leafChainSteps: 4, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 4.5, pruneHeight: 18, pruneCenterY: 22,
    cBranchCount: 55, cBranchAngle: 1.1, cBranchStart: 0.3, cCrownTaper: 0.75,
    cBranchDroop: 0.02, cBranchLen: 0.32,
    cTwigCount: 7, cTwigLen: 0.5, cTwigAngle: 0.9,
    cNeedleLength: 0.2, cNeedleWidth: 0.09, cNeedleDensity: 26, cNeedleChain: 4,
    cNeedleFacing: 0.65, cNeedleDroop: 0.03,
    cConeCount: 6, cConeSize: 0.08, cConeHang: 0.3,
  },
  Araucaria: {
    // Monkey Puzzle tree: distinctive tiered horizontal branches with
    // short stubby twigs and dense spiky needles.
    type: 'conifer',
    trunkHeight: 16, trunkScale: 1.1, tipRadius: 0.03, alloExp: 2.4, rootFlare: 0.4,
    shape: 'conical', baseSize: 0.25,
    leafSize: 0.13, leafFacing: 0.9, leavesPerTip: 40, leafChainSteps: 6, season: 0.2,
    pruneMode: 'ellipsoid', pruneRadius: 7, pruneHeight: 12, pruneCenterY: 13,
    cBranchCount: 20, cBranchAngle: 1.35, cBranchStart: 0.28, cCrownTaper: 0.6,
    cBranchDroop: -0.01, cBranchLen: 0.55,
    cTwigCount: 4, cTwigLen: 0.3, cTwigAngle: 1.0,
    cNeedleLength: 0.3, cNeedleWidth: 0.14, cNeedleDensity: 40, cNeedleChain: 6,
    cNeedleFacing: 0.9, cNeedleDroop: 0,
    cConeCount: 4, cConeSize: 0.25, cConeHang: 0.2,
  },
  // Bush presets — life-size landscape shrubs. Bush-prefixed keys drive
  // applyBushConfigToP (trunk/levels/pruning are derived). Tree-level keys
  // (leafShape, leafPhyllotaxis, gravityStrength, etc.) survive through
  // applyBushConfigToP and shape per-species character.
  // Real-world dims sourced from RHS / nursery references — heights/spreads
  // in meters, leaf sizes in meters.
  Boxwood: {
    // Buxus sempervirens — dense rounded dome of small dark green leaves.
    // Life-size mature shrub: 0.8–1.2m H × 1.0m W. Leaves are tiny in real
    // life (~2cm) but oversized here so they read as foliage at scene scale.
    type: 'bush',
    bHeight: 1.0, bSpread: 1.0, bStems: 16, bBranchiness: 9, bTwigLen: 0.4, bCompact: 1.25,
    bUpright: 0.15, bGnarl: 0.05, bThickness: 1.1,
    bLeafSize: 0.10, bLeafDensity: 22, bLeafSpread: 0.18, bLeafDroop: 0.05,
    leafShape: 'Oval',
    leafPhyllotaxis: 'opposite',
    leafClusterSize: 2, leafClusterSpread: 0.3,
    season: 0,
    leafHueShift: -0.04,
    gravityStrength: 0.05, gravityStiffness: 1.0,
  },
  Lavender: {
    // Lavandula angustifolia — many thin upright stems, narrow gray-green
    // leaves. Life-size: 0.4–0.7m H × 0.6–0.8m W.
    type: 'bush',
    bHeight: 0.55, bSpread: 0.7, bStems: 22, bBranchiness: 2, bTwigLen: 0.85, bCompact: 0.55,
    bUpright: 0.95, bGnarl: 0.05, bThickness: 0.9,
    bLeafSize: 0.10, bLeafDensity: 6, bLeafSpread: 0.35, bLeafDroop: 0.0,
    leafShape: 'Lanceolate',
    leafPhyllotaxis: 'opposite',
    leafClusterSize: 1, leafClusterSpread: 0.0,
    season: 0.2,
    leafHueShift: 0.06,
    gravityStrength: 0.02, gravityStiffness: 1.4,
  },
  Hydrangea: {
    // Hydrangea macrophylla — open globe of large heart-shaped leaves.
    // Life-size: 1.2–1.6m H × 1.5–1.8m W, real leaves 8–14cm.
    type: 'bush',
    bHeight: 1.4, bSpread: 1.7, bStems: 6, bBranchiness: 4, bTwigLen: 0.65, bCompact: 0.7,
    bUpright: -0.5, bGnarl: 0.15, bThickness: 1.2,
    bLeafSize: 0.28, bLeafDensity: 5, bLeafSpread: 0.45, bLeafDroop: 0.5,
    leafShape: 'Heart',
    leafPhyllotaxis: 'opposite',
    leafClusterSize: 2, leafClusterSpread: 0.4,
    season: 0.45,
    leafHueShift: 0.0,
    gravityStrength: 0.55, gravityStiffness: 0.6,
  },
  Rosemary: {
    // Rosmarinus officinalis — woody upright sub-shrub, fine narrow leaves.
    // Life-size: 0.8–1.2m H × 0.8m W.
    type: 'bush',
    bHeight: 0.9, bSpread: 0.9, bStems: 12, bBranchiness: 5, bTwigLen: 0.65, bCompact: 0.55,
    bUpright: 0.65, bGnarl: 0.45, bThickness: 1.0,
    bLeafSize: 0.09, bLeafDensity: 18, bLeafSpread: 0.25, bLeafDroop: 0.0,
    leafShape: 'Lanceolate',
    leafPhyllotaxis: 'opposite',
    leafClusterSize: 3, leafClusterSpread: 0.2,
    season: 0.3,
    leafHueShift: 0.04,
    gravityStrength: 0.08, gravityStiffness: 1.2,
  },
  Holly: {
    // Ilex aquifolium (shrub form) — stiff dark spiny ovate leaves on
    // upright woody stems. Life-size: 1.5–2.5m H × 1.2–1.6m W.
    type: 'bush',
    bHeight: 1.8, bSpread: 1.3, bStems: 6, bBranchiness: 6, bTwigLen: 0.5, bCompact: 1.0,
    bUpright: 0.55, bGnarl: 0.2, bThickness: 1.4,
    bLeafSize: 0.16, bLeafDensity: 12, bLeafSpread: 0.25, bLeafDroop: 0.05,
    leafShape: 'Oak',
    leafPhyllotaxis: 'alternate',
    leafClusterSize: 2, leafClusterSpread: 0.4,
    season: 0,
    leafHueShift: -0.03,
    gravityStrength: 0.12, gravityStiffness: 1.0,
  },
};
export const BROADLEAF_KEYS = ['Custom', ...Object.keys(SPECIES).filter((k) => SPECIES[k].type === 'broadleaf')];
export const CONIFER_KEYS = ['Custom', ...Object.keys(SPECIES).filter((k) => SPECIES[k].type === 'conifer')];
export const BUSH_KEYS = ['Custom', ...Object.keys(SPECIES).filter((k) => SPECIES[k].type === 'bush')];

// --- Conifer parameter schema (only used when treeType === 'conifer') ----
export const CONIFER_SCHEMA = [
  { group: 'Crown', params: [
    { key: 'cBranchCount',  label: 'Branches',      min: 8,    max: 200,  step: 1,    default: 55 },
    { key: 'cBranchAngle',  label: 'Branch angle',  min: 0.2,  max: 2.2,  step: 0.02, default: 1.05 },
    { key: 'cBranchStart',  label: 'Crown start',   min: 0.0,  max: 0.95, step: 0.02, default: 0.2 },
    { key: 'cCrownTaper',   label: 'Crown taper',   min: 0,    max: 1,    step: 0.02, default: 0.75 },
    { key: 'cBranchDroop',  label: 'Branch droop',  min: 0,    max: 0.3,  step: 0.002,default: 0.025 },
    { key: 'cBranchLen',    label: 'Branch length', min: 0.15, max: 1.8,  step: 0.02, default: 0.42 },
    { key: 'cBranchRadiusRatio', label: 'Branch attach', min: 0.05, max: 0.8, step: 0.01, default: 0.32 },
    { key: 'cBranchTaper',  label: 'Branch taper',  min: 0.2,  max: 3,    step: 0.05, default: 1.5 },
  ]},
  { group: 'Twigs', params: [
    { key: 'cTwigCount',    label: 'Twigs/branch',  min: 2,    max: 10,   step: 1,    default: 6 },
    { key: 'cTwigLen',      label: 'Twig length',   min: 0.3,  max: 0.95, step: 0.02, default: 0.6 },
    { key: 'cTwigAngle',    label: 'Twig angle',    min: 0.3,  max: 1.3,  step: 0.05, default: 0.95 },
    { key: 'cTwigRadiusRatio', label: 'Twig attach', min: 0.05, max: 0.8, step: 0.01, default: 0.28 },
    { key: 'cTwigTaper',    label: 'Twig taper',    min: 0.2,  max: 3,    step: 0.05, default: 1.4 },
  ]},
  { group: 'Needles', params: [
    { key: 'cNeedleLength', label: 'Length',        min: 0.1,  max: 0.8,  step: 0.01, default: 0.35 },
    { key: 'cNeedleWidth',  label: 'Width',         min: 0.05, max: 0.5,  step: 0.01, default: 0.18, live: true },
    { key: 'cNeedleDensity',label: 'Density',       min: 3,    max: 60,   step: 1,    default: 8 },
    { key: 'cNeedleChain',  label: 'Chain depth',   min: 1,    max: 5,    step: 1,    default: 3 },
    { key: 'cNeedleFacing', label: 'Face outward',  min: 0,    max: 1,    step: 0.05, default: 0.55 },
    { key: 'cNeedleDroop',  label: 'Droop',         min: 0,    max: 1,    step: 0.05, default: 0 },
  ]},
  { group: 'Cones', params: [
    { key: 'cConeCount',    label: 'Count',         min: 0,    max: 150,  step: 1,    default: 10 },
    { key: 'cConeSize',     label: 'Size',          min: 0.08, max: 0.5,  step: 0.01, default: 0.2 },
    { key: 'cConeHang',     label: 'Hang',          min: 0,    max: 1,    step: 0.05, default: 0.5 },
  ]},
];

// --- Bush parameter schema (only used when treeType === 'bush') ----------
// All dimensions are in METERS — bushes are life-size: 0.4m lavender sprig
// up to 3m holly. min/max ranges below cover the realistic range for common
// landscape shrubs.
export const BUSH_SCHEMA = [
  { group: 'Bush Shape', params: [
    { key: 'bHeight',       label: 'Height (m)',     min: 0.3, max: 3.5,  step: 0.05, default: 1.0 },
    { key: 'bSpread',       label: 'Spread (m)',     min: 0.4, max: 4.0,  step: 0.05, default: 1.2 },
    { key: 'bStems',        label: 'Primary stems',  min: 3,   max: 24,   step: 1,    default: 10 },
    { key: 'bBranchiness',  label: 'Branchiness',    min: 1,   max: 12,   step: 1,    default: 6 },
    { key: 'bTwigLen',      label: 'Twig length',    min: 0.2, max: 1.0,  step: 0.02, default: 0.55 },
    { key: 'bCompact',      label: 'Compactness',    min: 0.2, max: 1.4,  step: 0.02, default: 0.9 },
    // -1 → arching/drooping (hydrangea), 0 → neutral, +1 → strongly upright
    // (lavender wand). Drives gravitropism + initial branching angle on L0.
    { key: 'bUpright',      label: 'Uprightness',    min: -1,  max: 1,    step: 0.02, default: 0.0 },
    // Adds curve + wiggle to primary stems for woody/gnarled species
    // (rosemary, holly). 0 = clean, 1 = heavily kinked.
    { key: 'bGnarl',        label: 'Gnarl',          min: 0,   max: 1,    step: 0.02, default: 0.2 },
    // Stem/branch thickness multiplier. 1 = auto-derived life-size radii
    // (very fine on small bushes); 2-3 reads chunky and shows up better
    // when the camera reframes to fit the bush.
    { key: 'bThickness',    label: 'Thickness',      min: 0.5, max: 4.0,  step: 0.05, default: 1.0 },
  ]},
  { group: 'Bush Foliage', params: [
    // Leaf size — same arbitrary scene units as global leafSize so the
    // visual size matches what the broadleaf species use. Real bush leaves
    // are 1-3cm but at scene scale that's invisible, so values default to
    // the broadleaf range (0.08-0.25).
    { key: 'bLeafSize',     label: 'Leaf size',      min: 0.02, max: 0.5,  step: 0.005, default: 0.15 },
    { key: 'bLeafDensity',  label: 'Density',        min: 1,    max: 40,   step: 1,     default: 12 },
    { key: 'bLeafSpread',   label: 'Leaf spread',    min: 0,    max: 1.0,  step: 0.02,  default: 0.3 },
    { key: 'bLeafDroop',    label: 'Droop',          min: 0,    max: 1,    step: 0.05,  default: 0.1 },
  ]},
];

// Per-param one-line descriptions. Shown as a tooltip when hovering the slider
// label. Only keys listed here get tooltips.
export const PARAM_DESCRIPTIONS = {
  // Trunk
  trunkHeight:      'Overall tree height in meters',
  trunkSteps:       'Trunk skeleton control points — this is the shape-detail knob. Higher = the trunk curve has more real bends to follow (Sinuous/Bow/Jitter all act on these). 22 = clean, 36-44 = winding/ancient.',
  barkRadialSegs:   'Radial sides of each tube. 8 = octagonal, 16 = smooth (default). Thin twigs auto-halve. Tubes-only fast path.',
  barkTubularDensity: 'Polygon strips between skeleton points — purely a polish knob, no new shape. Push too high and you reveal high-freq bark-displacement noise as visible bumps. Default 6 is the sweet spot; only raise if you see facets between control points.',
  branchWobble:     'Skeleton-level lateral perturbation that gives branches an aged, knotted character (SpeedTree calls this wood noise; ezTree calls it gnarliness). Auto-scaled by branch depth so trunks stay relatively straight and twigs flex. Per-level overrides in each Level card.',
  branchWobbleFreq: 'Spatial scale of the gnarl pattern. Higher = tighter, more frequent bends along each branch.',
  wobble:           'Per-level gnarliness. 0 = inherit global Gnarliness (Trunk card). >0 = override with this absolute value at this level.',
  wobbleFreq:       'Per-level gnarl scale. 0 = inherit global. >0 = override.',
  trunkJitter:      'Lateral noise per trunk segment — higher = more wander',
  trunkCount:       'Number of independent trunks sprouting from the base',
  trunkSplitSpread: 'How far multi-trunks lean outward before straightening',
  trunkSplitHeight: 'Fraction of trunk height where multi-trunks diverge. 0 = fan from the ground. 0.5+ = shared lower bole then a Y-fork above.',
  trunkTwist:       'Corkscrew the trunk around Y as it grows',
  // Surface (mesh displacement on trunk + branches)
  barkDisplace:       'Overall mesh-displacement strength (radial push)',
  barkDisplaceFreq:   'Spatial frequency of the main bark pattern',
  barkDisplaceMode:   'Noise flavor — ridges (vertical grain) / blobby (gnarled) / cellular (plated) / mixed',
  barkRidgeSharp:     'Turns smooth noise into sharp, ridged cracks',
  barkVerticalBias:   '0 = organic 3D bulges, 1 = purely vertical trunk grain',
  barkKnots:          'Sparse knot bumps (Worley) — adds stubby protrusions',
  barkKnotScale:      'Knot size — lower = fewer, bigger knots',
  barkDetail:         'High-freq micro-displacement on top of the main pattern',
  barkDetailFreq:     'Scale of the micro-displacement',
  // Bark
  barkHue:          'Hue for bark tint (0–1 around color wheel)',
  barkTint:         'Blend strength of hue into bark color',
  barkTexScaleU:    'Bark tiles per meter ALONG the trunk — lower = bigger tiles',
  barkTexScaleV:    'Bark tiles per meter AROUND the trunk — lower = bigger tiles',
  barkRoughness:    'PBR roughness of bark surface',
  barkNormalStrength:'Strength of bark normal map',
  // Radius
  tipRadius:        'Thickness of the smallest twigs',
  baseRadius:       'Trunk radius at ground — primary thickness dial',
  taperExp:         'Taper curve — higher = sharper cone toward tip',
  trunkScale:       'Height-graded thickness multiplier — thickens base more than crown',
  branchThickness:  'Global branch thickness multiplier — single dial for overall tree weight',
  alloExp:          'Legacy pipe-model exponent — no longer drives radius (kept for JSON import)',
  rootFlare:        'Extra thickness near the ground for a rooted look',
  // Leaves
  leavesPerTip:     'Leaves placed per branch tip',
  leafChainSteps:   'How many nodes back from the tip also get leaves',
  leavesStart:      'Y-height below which no leaves grow (0–1 of tree height)',
  leafSize:         'Base scale for a single leaf',
  leafSizeVar:      'Random size variation around leafSize',
  leafSpread:       'Random scatter of leaf positions around the tip',
  leafDroop:        'Slerp leaves toward horizontal (hanging)',
  season:           '0 = spring, 1 = winter/bare (tint + density falloff)',
  fallenMax:        'Max number of leaves lying on the ground',
  fallenFade:       'Seconds an overflowing fallen leaf takes to fade out',
  // Leaf Material
  leafRoughness:    'PBR roughness of leaf surface',
  leafTransmission: 'Translucency — light through the leaf',
  leafThickness:    'Apparent leaf thickness for subsurface scattering',
  leafIOR:          'Index of refraction for leaf material',
  leafNormalStrength:'Strength of leaf normal map',
  leafHueShift:     'Hue-shift applied on top of seasonal tint',
  // Global
  globalScale:      'Overall branch/canopy size multiplier. Trunk height is independent.',
  branchModel:      'Growth formula. Weber-Penn = parametric default. Honda applies R1/R2 straight/side-branch length ratios (1971). Fibonacci snaps every roll to the golden angle (137.5°) for perfect phyllotaxis.',
  minLen:           'Recursion stops when branch length falls below this',
  growthPhase:      'Animated growth factor — 0.1 baby tree, 1 full size',
  rotation:         'Whole-tree rotation around Y (degrees)',
  // Pruning
  pruneRadius:      'Horizontal radius of the pruning envelope',
  pruneHeight:      'Vertical radius of the pruning envelope',
  pruneCenterY:     'World Y-center of the pruning envelope',
  // Level
  children:         'Number of child branches per parent at this level',
  lenRatio:         'Child length as a fraction of parent',
  angle:            'Base branching angle off parent axis (radians)',
  angleVar:         'Random variation added to the branch angle',
  rollVar:          'Random roll around the parent axis per child',
  rollStart:        'Base phase that rotates the whole arrangement around the parent axis',
  startPlacement:   'Start of the range along parent where children attach (0–1)',
  endPlacement:     'End of the placement range',
  apicalDominance:  'Base children shorter, tip children stronger',
  kinkSteps:        'Subdivisions per branch — more = smoother curves',
  distortion:       'Lateral noise amount per step',
  distortionFreq:   'Frequency of the distortion noise',
  curveAmount:      'Strength of the curvature profile',
  phototropism:     'Upward bias — branches curve toward light',
  gravitropism:     'Downward bias — branches droop',
  susceptibility:   'How strongly tropism + bending apply',
  torsion:          'Rotates noise perturbation around the growth axis',
  twist:            'Spiral the heading itself around Y each step',
  stochastic:       'Probability of skipping a child spawn — adds asymmetry',
  // Wind
  strength:         'Wind amplitude',
  frequency:        'Wind oscillation rate',
  direction:        'Wind azimuth in radians',
  gust:             'How much slow gusts modulate the base wind',
  // Physics
  stiffness:        'How firmly branches snap back to rest',
  damping:          'How quickly oscillations decay',
  windResponse:     'Sensitivity of branch sim to the wind uniforms',
  massiveness:      'Mass scaling — higher = branches move less',
  grabPickRadius:   'Screen-pixel radius for snapping RMB to the nearest branch',
  grabSensitivity:  'Multiplier from cursor delta to pull distance',
  grabMaxPull:      'World-space clamp on how far a branch can be pulled',
  grabSpread:       'How much of the branch chain softens during a grab',
  // Bush
  bHeight:          'Overall bush height in meters (life-size)',
  bSpread:          'Canopy diameter in meters',
  bStems:           'Primary stems from the base',
  bBranchiness:     'Child branches per stem',
  bTwigLen:         'Twig length as a fraction of branch',
  bCompact:         'Tightness of the pruning envelope (higher = denser)',
  bUpright:         '−1 = arching/drooping habit, 0 = neutral, +1 = strongly upright (e.g. lavender)',
  bGnarl:           'Wood character on primary stems — kink, curve and wiggle. 0 = clean, 1 = gnarled',
  bLeafSize:        'Leaf size in meters (life-size — boxwood ~2cm, hydrangea ~12cm)',
  bLeafDensity:     'Leaves per tip',
  bLeafSpread:      'Scatter of leaves around tips',
  bLeafDroop:       'Leaf droop toward horizontal',
  // Conifer
  cBranchCount:     'Number of whorl branches along the trunk',
  cBranchAngle:     'Branch angle off trunk (radians)',
  cBranchStart:     'Height fraction where the crown begins',
  cCrownTaper:      'How quickly the crown tapers to a point (apical dominance)',
  cBranchDroop:     'Downward curl of branches',
  cBranchLen:       'Branch length as fraction of trunk height',
  cTwigCount:       'Child twigs per primary branch',
  cTwigLen:         'Twig length fraction',
  cTwigAngle:       'Twig angle off branch',
  cNeedleLength:    'Needle length',
  cNeedleWidth:     'Needle width',
  cNeedleDensity:   'Needles per tip',
  cNeedleChain:     'How far back from the tip needles grow',
  cNeedleFacing:    'Needles fan outward (0 = droopy, 1 = radiating)',
  cNeedleDroop:     'Droop applied to needles',
  cConeCount:       'Number of hanging cones',
  cConeSize:        'Cone size',
  cConeHang:        'How far cones hang from the tip',
  // Trunk pose
  trunkLean:        'Tilt the trunk base — bigger = more lean',
  trunkLeanDir:     'Heading of the lean (degrees around Y)',
  trunkBow:         'S-curve along the trunk as it rises',
  trunkSinuous:     'Slow lateral meander along the trunk — gives an ancient, winding character without inflating high-frequency jitter. Free (ref-curve path).',
  trunkSinuousFreq: 'Wavelengths of meander over the trunk height. ~1 = single bend, ~2-3 = serpentine.',
  // Surface (continued)
  buttressAmount:   'Lobed bulge at the trunk base — buttress roots',
  buttressHeight:   'How far up the trunk the buttress fades out (m)',
  buttressLobes:    'Number of buttress lobes around the base',
  reactionWood:     'Asymmetric thickening on the underside of horizontal branches',
  // Bark (continued)
  mossAmount:       'How much moss/lichen blends onto the bark',
  mossThreshold:    'Coverage threshold (lower = more moss)',
  mossHue:          'Moss color hue',
  mossLum:          'Moss brightness',
  // Leaves (continued)
  leafBranchFill:   'Per-step density along the leaf-bearing chain',
  leafTilt:         'Random tilt added to each leaf orientation',
  leafColorVar:     'Per-leaf hue/saturation/brightness jitter',
  leafPhyllotaxis:  'Arrangement pattern of leaves on a twig (spiral / opposite / alternate / random)',
  leafQuality:      'Leaf mesh detail. flat = 2 tris (fastest, far LOD). bent = 32 tris (default). silhouette = full shape mesh, ~200 tris (close-ups, slow on dense canopies).',
  leafMaxRadius:    'Skip leaves on twigs thicker than this (keeps them off main branches)',
  leafInset:        'Shift the leaf along its blade Y axis — for textures whose visible body is offset',
  // Stems (petioles)
  leafStemLen:      'Petiole length — distance from twig surface to leaf base',
  leafStemAngle:    'Forward lean of the petiole toward the twig tip (0 = perpendicular)',
  leafStemThick:    'Petiole thickness multiplier',
  // Leaf material (continued)
  leafBumpScale:    'Vein bump intensity (procedural leaf modes only)',
  leafClearcoat:    'Waxy coat for glossy leaves (laurel, holly)',
  leafClearcoatRough: 'Roughness of the waxy coat',
  leafSheen:        'Velvety sheen at grazing angles',
  leafBackHue:      'Underside hue',
  leafBackLum:      'Underside brightness',
  leafBackMix:      'How much of the back colour mixes into the front',
  // Global
  shape:            'Crown silhouette envelope. free lets per-level length curves shape the crown directly (MTree-style emergent). Named options apply a hard length multiplier — kept for legacy presets.',
  baseSize:         'Clean-bole fraction — the bottom portion of the trunk that gets no branches',
  sunAzimuth:       'Sun heading (degrees) — drives phototropism direction',
  sunElevation:     'Sun elevation above horizon (degrees)',
  // Gravity sag
  gravityStrength: 'MTree-style weight sag at build time. Heavy branches droop and the entire downstream subtree rotates with them. 0 = off (rigid parametric pose).',
  gravityStiffness: 'Resistance to sag — thicker branches stiffen further. Higher = less droop overall.',
  // Pruning
  pruneMode:        'Crown clip envelope. off = no clip. ellipsoid = hard cull outside the ellipsoid (used by bushes).',
  // LOD
  lodAutoSwitch:    'Auto-switch to a simpler tree when far from the camera',
  lodDist1:         'Distance (m) to switch to LOD1',
  lodDist2:         'Distance (m) to switch to LOD2',
  lodDist3:         'Distance (m) to switch to LOD3',
  // Stubs
  stubsEnable:      'Sprout dead-wood stubs at pruned parent nodes',
  stubsChance:      'Per-stub-site spawn probability',
  stubsLength:      'Stub length (m)',
  stubsTaper:       'How sharply the stub tapers to a point',
  stubsHue:         'Stub hue',
  stubsLum:         'Stub brightness',
  // Vines
  vinesEnable:      'Wrap spiral vines around branches',
  vineCount:        'Number of vines',
  vineCoverage:     'Fraction of host chain covered',
  vineThickness:    'Vine radius (m)',
  vineCoils:        'Coils per metre',
  vineLeafSize:     'Vine leaf size',
  vineLeafDensity:  'Vine leaves per metre',
  vineHue:          'Vine hue',
  vineLum:          'Vine brightness',
  // Fruits / flowers
  fruitsEnable:     'Add fruits or flowers at twig endpoints',
  fruitShape:       'Fruit geometry (sphere / teardrop / blossom)',
  fruitDensity:     'Fraction of tips bearing fruit',
  fruitSize:        'Fruit size (m)',
  fruitHang:        'How far the fruit hangs from the tip (m)',
  fruitHue:         'Fruit hue',
  fruitLum:         'Fruit brightness',
  fruitSat:         'Fruit saturation',
  // Canopy dieback
  dieback:          'Strength of the dead-twig culling on the inside of the canopy',
  diebackOuter:     'Threshold for the outer shell that survives — higher = thicker live canopy',
  // Per-level (additions)
  radiusRatio:      'Branch base radius as a fraction of the parent local radius',
  phyllotaxis:      'Branch arrangement pattern — spiral, opposite, decussate, whorled',
  apicalContinue:   'Force the last child to inherit parent direction with a length boost (central leader)',
  signalDecay:      'Sibling decay — later children get progressively shorter',
  angleDecline:     'Angle taper along the parent — positive = tip children angle out more, negative = tip more vertical',
  curveMode:        'Parametric curve shape — none, sCurve, backCurve, helical',
  curveBack:        'Weber-Penn asymmetric curve — first half curves one way, second reverses',
  segSplits:        'Mid-branch fork rate (per branch, fractional probability)',
  splitAngle:       'Angle of the side fork off the parent (radians)',
  distortionType:   'Wiggle pattern — random, sine, perlin, twist',
  // Wind (additions)
  turbulence:       'High-frequency noise added on top of the base wind',
  swirl:            'Sideways swirl that rotates the wind heading over time',
  // Physics (additions)
  pinPower:         'How strongly leaves pin to the branch (used by foliage sim)',
};