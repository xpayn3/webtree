// bark-textures.js — procedural bark albedo + normal canvas textures.
//
// Extracted from main.js so the bark generator + its caches + noise pattern
// factories no longer occupy the middle of a 16k-line module. Pure data →
// HTMLCanvasElement; nothing here imports three.js, the scene, or any
// per-tree state. main.js drops in an `overrides` object (typically the
// live `P` parameter set) when calling `generateBarkTexture`.
//
// EXPORTS:
//   generateBarkTexture(style, seed, overrides?)  → { albedoCanvas, normalCanvas }
//   generateBarkThumbnail(style, size?)           → HTMLCanvasElement
//   generateNoiseThumbnail(patternName, size?)    → HTMLCanvasElement
//   BARK_STYLES                                    — recipe map (read by callers)

// --- Procedural bark texture generator ----------------------------------
// Generates a tilable albedo + normal canvas texture per bark style. Each
// style is a recipe of (vertical fissure / horizontal band / large-scale /
// micro-detail) parameters. Result is cached by `style:seed` so repeated
// species switches don't re-run the generator. Tilable: built from a
// periodic value-noise grid (true wrap) plus pure-sine fissure/band
// patterns (perfectly periodic by construction).
// LRU-capped — without this, every unique slider value combination created
// a new ~512KB { albedoCanvas, normalCanvas } entry and the cache grew
// unbounded (stress test saw +270 MB heap after 90s of slider drags).
// 24 entries ≈ 12 MB CPU + matching GPU upload, plenty for thrashing
// between the active style and a few recent variants without ballooning.
const _BARK_TEX_CACHE = new Map();
const _BARK_TEX_CACHE_MAX = 24;
function _lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  // Touch — move to end so recently-used entries survive eviction.
  map.delete(key);
  map.set(key, v);
  return v;
}
function _lruSet(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

// Recipes tuned for default 0.5 tiles/m repeat (2 m per tile) at 5-15 m
// camera distance. Each recipe targets a real-tree-bark archetype:
export const BARK_STYLES = {
  // White / English oak — deep gnarled vertical fissures separating
  // rough plates, with occasional perpendicular cross-cracks. Cool
  // brown-grey, busy micro surface.
  oak: {
    vertFreq: 3.5, vertSharp: 8, vertWobble: 0.10, vertDepth: 0.62,
    horizFreq: 4,  horizSharp: 8, horizAmp: 0.18,
    largeFreq: 1.0, largeAmp: 0.28,
    microFreq: 36, microAmp: 0.09,
    palette: [[24, 22, 20], [76, 66, 54], [138, 120, 98]],
    normalStrength: 5.2,
    grain: 8,
  },
  // Scots / red pine — wide plates separated by deep cracks. Real Scots pine
  // does have a coppery-bronze upper trunk but the lower trunk reads as a
  // muted greyish brown — palette pulled in that direction so it doesn't look
  // uniformly orange across the whole trunk.
  pine: {
    vertFreq: 2,   vertSharp: 3, vertWobble: 0.18, vertDepth: 0.42,
    horizFreq: 3,  horizSharp: 6, horizAmp: 0.36,
    largeFreq: 0.8, largeAmp: 0.34,
    microFreq: 16, microAmp: 0.04,
    palette: [[44, 36, 30], [108, 88, 70], [172, 144, 116]],
    normalStrength: 4.0,
    grain: 6,
  },
  // Paper birch — smooth white papery surface broken by sharp dark
  // horizontal lenticels (thin streaks). Large patches simulate the
  // peeling-paper colour shifts. Very low relief, high contrast.
  birch: {
    vertFreq: 0,   vertSharp: 0, vertWobble: 0, vertDepth: 0,
    horizFreq: 30, horizSharp: 18, horizAmp: 0.58,
    largeFreq: 1.8, largeAmp: 0.36,
    microFreq: 14, microAmp: 0.02,
    palette: [[18, 16, 14], [218, 212, 204], [248, 246, 240]],
    normalStrength: 1.2,
    grain: 4,
  },
  // Yoshino / blossoming cherry — silvery grey-brown trunk with horizontal
  // lenticel bands. Cool palette so it doesn't compete with the pink canopy;
  // sweet/black cherry's mahogany would read as more pink under bounce light.
  cherry: {
    vertFreq: 0,   vertSharp: 0, vertWobble: 0, vertDepth: 0,
    horizFreq: 22, horizSharp: 8, horizAmp: 0.30,
    largeFreq: 2,  largeAmp: 0.22,
    microFreq: 16, microAmp: 0.03,
    palette: [[48, 42, 38], [108, 100, 92], [170, 160, 148]],
    normalStrength: 1.6,
    grain: 4,
  },
  // Beech / olive — almost smooth, subtle weathered patches and a
  // muted grey-warm gradient. Nothing reads as a feature; everything
  // is gentle gradients.
  smooth: {
    vertFreq: 0,   vertSharp: 0, vertWobble: 0, vertDepth: 0,
    horizFreq: 0,  horizSharp: 0, horizAmp: 0,
    largeFreq: 1.5, largeAmp: 0.34,
    microFreq: 14, microAmp: 0.04,
    palette: [[100, 96, 90], [160, 156, 148], [205, 200, 192]],
    normalStrength: 0.8,
    grain: 5,
  },
  // Eucalyptus / paperbark — irregular peeling patches in multiple
  // shades, mild vertical hint, low relief. Big-amp large patches drive
  // the iconic mottled multi-colour look.
  eucalyptus: {
    vertFreq: 1.5, vertSharp: 2, vertWobble: 0.20, vertDepth: 0.18,
    horizFreq: 0,  horizSharp: 0, horizAmp: 0,
    largeFreq: 0.6, largeAmp: 0.55,
    microFreq: 22, microAmp: 0.05,
    palette: [[90, 70, 50], [165, 130, 95], [225, 195, 160]],
    normalStrength: 1.4,
    grain: 7,
  },
  // Palm — fibrous vertical strands that wrap around the trunk in a
  // diamond pattern; horizontal bands mark old leaf scars where fronds
  // once attached.
  palm: {
    vertFreq: 14, vertSharp: 4, vertWobble: 0.04, vertDepth: 0.18,
    horizFreq: 6, horizSharp: 4, horizAmp: 0.32,
    largeFreq: 0.8, largeAmp: 0.16,
    microFreq: 30, microAmp: 0.05,
    palette: [[60, 45, 30], [110, 88, 62], [165, 138, 98]],
    normalStrength: 2.4,
    grain: 5,
  },
  // Coast redwood / sequoia — long thin vertical fibrous strips, very
  // sharp deep grooves, warm cinnamon-red colour. Tall straight pattern.
  redwood: {
    vertFreq: 8,  vertSharp: 9, vertWobble: 0.03, vertDepth: 0.55,
    horizFreq: 0, horizSharp: 0, horizAmp: 0,
    largeFreq: 1.2, largeAmp: 0.22,
    microFreq: 24, microAmp: 0.05,
    palette: [[60, 28, 18], [128, 70, 40], [185, 118, 72]],
    normalStrength: 4.5,
    grain: 5,
  },
  // Plane / sycamore — iconic camouflage. Smooth surface broken by big
  // irregular patches of olive, cream, and grey-green where the outer
  // bark sloughs off. Almost no relief; the look is all colour.
  plane: {
    vertFreq: 0.6, vertSharp: 1.2, vertWobble: 0.30, vertDepth: 0.08,
    horizFreq: 0, horizSharp: 0, horizAmp: 0,
    largeFreq: 0.9, largeAmp: 0.62,
    microFreq: 18, microAmp: 0.04,
    palette: [[68, 64, 54], [125, 118, 102], [172, 162, 140]],
    normalStrength: 0.7,
    grain: 4,
  },
  // Mediterranean olive — heavily gnarled, twisted ropy texture, deep
  // irregular fissures. Cool grey-green palette. Old olives have an
  // almost driftwood look — busy micro detail without sharp ridges.
  olive: {
    vertFreq: 4,  vertSharp: 5, vertWobble: 0.28, vertDepth: 0.55,
    horizFreq: 1.5, horizSharp: 4, horizAmp: 0.20,
    largeFreq: 1.4, largeAmp: 0.42,
    microFreq: 28, microAmp: 0.08,
    palette: [[55, 55, 46], [105, 105, 88], [150, 150, 130]],
    normalStrength: 3.8,
    grain: 7,
  },
  // Maple (Acer) — finely fissured slate-grey-brown. Tighter and more
  // uniform than oak's deep plates; reads as ridged but not gnarled.
  // Real Acer rubrum has medium-dark grey-brown bark, not pewter.
  maple: {
    vertFreq: 5,  vertSharp: 6, vertWobble: 0.06, vertDepth: 0.42,
    horizFreq: 2,  horizSharp: 6, horizAmp: 0.10,
    largeFreq: 1.2, largeAmp: 0.20,
    microFreq: 32, microAmp: 0.06,
    palette: [[36, 32, 28], [80, 72, 64], [128, 116, 102]],
    normalStrength: 3.4,
    grain: 6,
  },
  // Beech / hornbeam — silken muted grey with very subtle horizontal
  // lenticel rings + faint mottling. Almost no relief, more texture than
  // 'smooth' so the trunk doesn't read as plastic.
  beech: {
    vertFreq: 0.4, vertSharp: 0.8, vertWobble: 0.20, vertDepth: 0.06,
    horizFreq: 14, horizSharp: 4, horizAmp: 0.12,
    largeFreq: 1.6, largeAmp: 0.18,
    microFreq: 22, microAmp: 0.04,
    palette: [[60, 58, 54], [118, 114, 108], [172, 168, 162]],
    normalStrength: 1.0,
    grain: 4,
  },
  // Cedar / cypress — long stringy peeling vertical strips. Original palette
  // leaned mahogany; toned down to a more neutral weathered brown so cedar +
  // cypress don't read as orange next to greener landscaping.
  cedar: {
    vertFreq: 9,  vertSharp: 5, vertWobble: 0.10, vertDepth: 0.32,
    horizFreq: 1, horizSharp: 2, horizAmp: 0.10,
    largeFreq: 1.0, largeAmp: 0.24,
    microFreq: 26, microAmp: 0.06,
    palette: [[60, 50, 42], [122, 102, 86], [180, 158, 134]],
    normalStrength: 2.6,
    grain: 6,
  },
};

// Periodic value-noise factory. Returns `(u, v) → [0, 1]`. Tiles exactly
// at u, v ∈ [0, 1) because the grid wraps modulo `period`.
function _makeTilableNoise(seed, period) {
  const grid = new Float32Array(period * period);
  let s = (seed | 0) >>> 0;
  for (let i = 0; i < grid.length; i++) {
    s = ((s * 1664525) + 1013904223) >>> 0;
    grid[i] = (s & 0xffffff) / 0xffffff;
  }
  return function (u, v) {
    let fu = (u - Math.floor(u)) * period;
    let fv = (v - Math.floor(v)) * period;
    const ix = Math.floor(fu) % period;
    const iy = Math.floor(fv) % period;
    const ix1 = (ix + 1) % period;
    const iy1 = (iy + 1) % period;
    const wx = fu - Math.floor(fu);
    const wy = fv - Math.floor(fv);
    const sx = wx * wx * (3 - 2 * wx);
    const sy = wy * wy * (3 - 2 * wy);
    const a = grid[iy * period + ix];
    const b = grid[iy * period + ix1];
    const c = grid[iy1 * period + ix];
    const d = grid[iy1 * period + ix1];
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}

// Tilable Perlin (gradient) noise. Random unit gradients per cell, quintic
// fade. Smoother + more organic flow than value noise.
function _makeTilablePerlin(seed, period) {
  const grads = new Float32Array(period * period * 2);
  let s = (seed | 0) >>> 0;
  for (let i = 0; i < period * period; i++) {
    s = ((s * 1664525) + 1013904223) >>> 0;
    const a = ((s & 0xffffff) / 0xffffff) * Math.PI * 2;
    grads[i * 2    ] = Math.cos(a);
    grads[i * 2 + 1] = Math.sin(a);
  }
  return function (u, v) {
    const fu = (u - Math.floor(u)) * period;
    const fv = (v - Math.floor(v)) * period;
    const ix = Math.floor(fu) % period;
    const iy = Math.floor(fv) % period;
    const ix1 = (ix + 1) % period;
    const iy1 = (iy + 1) % period;
    const wx = fu - Math.floor(fu);
    const wy = fv - Math.floor(fv);
    const fx = wx * wx * wx * (wx * (wx * 6 - 15) + 10);
    const fy = wy * wy * wy * (wy * (wy * 6 - 15) + 10);
    const g00 = (iy  * period + ix ) * 2;
    const g10 = (iy  * period + ix1) * 2;
    const g01 = (iy1 * period + ix ) * 2;
    const g11 = (iy1 * period + ix1) * 2;
    const d00 = grads[g00    ] * wx       + grads[g00 + 1] * wy;
    const d10 = grads[g10    ] * (wx - 1) + grads[g10 + 1] * wy;
    const d01 = grads[g01    ] * wx       + grads[g01 + 1] * (wy - 1);
    const d11 = grads[g11    ] * (wx - 1) + grads[g11 + 1] * (wy - 1);
    const x0 = d00 + (d10 - d00) * fx;
    const x1 = d01 + (d11 - d01) * fx;
    const n = x0 + (x1 - x0) * fy;
    return Math.max(0, Math.min(1, n * 0.7071 + 0.5));
  };
}

// Tilable Worley (cellular F1). One feature point per cell; sample cell +
// 8 wrapped neighbours, return distance to the nearest feature. Great for
// scaly / cracked / lenticel patterns.
function _makeTilableWorley(seed, period) {
  const pts = new Float32Array(period * period * 2);
  let s = (seed | 0) >>> 0;
  for (let i = 0; i < period * period; i++) {
    s = ((s * 1664525) + 1013904223) >>> 0;
    pts[i * 2    ] = (s & 0xffffff) / 0xffffff;
    s = ((s * 1664525) + 1013904223) >>> 0;
    pts[i * 2 + 1] = (s & 0xffffff) / 0xffffff;
  }
  return function (u, v) {
    const fu = (u - Math.floor(u)) * period;
    const fv = (v - Math.floor(v)) * period;
    const cx = Math.floor(fu);
    const cy = Math.floor(fv);
    let minD2 = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = ((cx + ox) % period + period) % period;
        const ny = ((cy + oy) % period + period) % period;
        const idx = (ny * period + nx) * 2;
        const px = (cx + ox) + pts[idx    ];
        const py = (cy + oy) + pts[idx + 1];
        const dx = fu - px;
        const dy = fv - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD2) minD2 = d2;
      }
    }
    return Math.min(1, Math.sqrt(minD2));
  };
}

// Tilable ridged multifractal — Perlin folded through `1 - |2n - 1|` so
// zero crossings become sharp peaks. Carved-fissure look.
function _makeTilableRidged(seed, period) {
  const p = _makeTilablePerlin(seed, period);
  return function (u, v) {
    return 1 - Math.abs(p(u, v) * 2 - 1);
  };
}

// Tilable domain warp — two perlins offset the sample point of a third.
// The output flows like molten rock; impossible to fake with a single
// noise pass. Strength stays low so it still tiles cleanly.
function _makeTilableWarp(seed, period) {
  const base  = _makeTilablePerlin(seed,      period);
  const warpX = _makeTilablePerlin(seed + 31, period);
  const warpY = _makeTilablePerlin(seed + 53, period);
  const STRENGTH = 0.4;
  return function (u, v) {
    const dx = (warpX(u, v) - 0.5) * STRENGTH;
    const dy = (warpY(u, v) - 0.5) * STRENGTH;
    return base(u + dx, v + dy);
  };
}

// Pattern registry — name → factory(seed, period). Schema layers pick a
// pattern by name; the generator dispatches via this map. Add a new
// pattern = one entry here + a schema option, nothing else.
const NOISE_PATTERNS = {
  value:  _makeTilableNoise,
  perlin: _makeTilablePerlin,
  worley: _makeTilableWorley,
  ridged: _makeTilableRidged,
  warp:   _makeTilableWarp,
};

// Returns `{ albedoCanvas, normalCanvas }` — raw HTMLCanvasElements only.
// The caller swaps these into the long-lived singleton CanvasTexture
// objects (barkAlbedo / barkNormal) via `.image = canvas; needsUpdate=true`
// so the shader's TSL binding (built once at compile time) stays valid
// forever. This kills four bugs at once:
//   1. "Stuck ribbons" — colorNode no longer points at a stale texture
//      after a style swap.
//   2. GPU texture leak — only one CanvasTexture per role ever lives.
//   3. Cache bloat — cache stores cheap HTMLCanvasElements instead of
//      THREE.CanvasTexture instances.
//   4. barkRotation snapping — rotation is set on the persistent texture
//      so it doesn't get wiped by a later swap.
export function generateBarkTexture(style = 'oak', seed = 1, overrides = {}) {
  // Merge: start with the style preset's full recipe, then override any
  // field with the matching `bark*` slider value from `overrides` (typically
  // the live `P` parameter object — extra fields on it are ignored, missing
  // ones fall through to recipe defaults). The boot sequence calls this
  // before P is initialized; passing `{}` (or omitting `overrides`) is the
  // safe path for that case.
  const recipe = BARK_STYLES[style] || BARK_STYLES.oak;
  const Ps = overrides || {};
  const p = {
    vertFreq:    Ps.barkVertFreq     ?? recipe.vertFreq,
    vertSharp:   Ps.barkVertSharp    ?? recipe.vertSharp,
    vertWobble:  Ps.barkVertWobble   ?? recipe.vertWobble,
    vertDepth:   Ps.barkVertDepth    ?? recipe.vertDepth,
    horizFreq:   Ps.barkHorizFreq    ?? recipe.horizFreq,
    horizSharp:  Ps.barkHorizSharp   ?? recipe.horizSharp,
    horizAmp:    Ps.barkHorizAmp     ?? recipe.horizAmp,
    largeFreq:   Ps.barkLargeFreq    ?? recipe.largeFreq,
    largeAmp:    Ps.barkLargeAmp     ?? recipe.largeAmp,
    microFreq:   Ps.barkMicroFreq    ?? recipe.microFreq,
    microAmp:    Ps.barkMicroAmp     ?? recipe.microAmp,
    normalStrength: Ps.barkBumpStrength ?? recipe.normalStrength,
    grain:       Ps.barkGrain        ?? recipe.grain,
    largePattern: Ps.barkLargePattern ?? recipe.largePattern ?? 'value',
    microPattern: Ps.barkMicroPattern ?? recipe.microPattern ?? 'value',
    palette:     recipe.palette,    // colour stops still come from preset
  };
  // Snap all frequencies to integers so the texture tiles seamlessly:
  // - sin(2π·f·u) only wraps at u=0↔u=1 when f is integer
  // - noise(u·f, …) wraps at u=0↔u=1 only when f is integer (the noise
  //   itself wraps mod period at integer input steps).
  // Sliders keep their fine step for UX feel; the generator rounds.
  // Without this, fractional freqs (e.g. largeFreq=1.5) produce visible
  // seams where the noise/sin phase doesn't match across u=0↔u=1.
  p.vertFreq  = Math.max(0, Math.round(p.vertFreq));
  p.horizFreq = Math.max(0, Math.round(p.horizFreq));
  p.largeFreq = Math.max(0, Math.round(p.largeFreq));
  p.microFreq = Math.max(0, Math.round(p.microFreq));
  // Cache key includes every layer field so per-slider tweaks each get
  // their own cached canvas. Palette is implicit in `style`.
  const key = style + ':' + seed + ':' +
    p.vertFreq + ',' + p.vertSharp + ',' + p.vertWobble + ',' + p.vertDepth + ':' +
    p.horizFreq + ',' + p.horizSharp + ',' + p.horizAmp + ':' +
    p.largeFreq + ',' + p.largeAmp + ',' + p.largePattern + ':' +
    p.microFreq + ',' + p.microAmp + ',' + p.microPattern + ':' +
    p.normalStrength + ',' + p.grain;
  const cached = _lruGet(_BARK_TEX_CACHE, key);
  if (cached) return cached;

  // 256² regen runs in 15-25 ms instead of 50-100 ms at 512² — fast
  // enough that the main thread doesn't visibly stall during slider
  // drags. Bark detail at typical viewing distance is dominated by the
  // normal map's lighting response, not the texel grid; the size drop is
  // hard to spot. Bump back to 512 if hero shots demand it.
  const N = 256;

  try {
    // Tilable noise — pre-built grids at multiple scales. Patches and
    // micro layers dispatch via NOISE_PATTERNS so the user's per-layer
    // pattern choice (value / perlin / worley / ridged / warp) selects a
    // different noise function. Wobble and grain stay on plain value
    // noise — they're support layers, not the visual identity.
    const largeFn = NOISE_PATTERNS[p.largePattern] || NOISE_PATTERNS.value;
    const microFn = NOISE_PATTERNS[p.microPattern] || NOISE_PATTERNS.value;
    const noiseLarge = largeFn(seed, 8);
    const noiseMid   = _makeTilableNoise(seed + 7, 16);
    const noiseFine  = microFn(seed + 13, 64);
    const noiseGrain = _makeTilableNoise(seed + 23, 128);

    // Build the height field once — used for both albedo (palette lookup)
    // and normal map (central differences).
    const height = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      const v = y / N;
      for (let x = 0; x < N; x++) {
        const u = x / N;
        let h = 0.5;

        // Round U-axis frequencies to integers so the bark texture wraps
        // seamlessly around the trunk circumference. Sine/value-noise
        // sampling in u only tiles cleanly at integer multiples of the
        // unit interval. (horizFreq runs along v / trunk height — its
        // wrap is hidden inside geometry, no integer needed.)
        const _vF = Math.max(0, Math.round(p.vertFreq));
        const _lF = Math.max(0, Math.round(p.largeFreq));
        const _mF = Math.max(0, Math.round(p.microFreq));

        // Vertical fissures — sin wave with noise wobble. Pure sin in u
        // tiles automatically; noise wobble uses tilable noise.
        if (_vF > 0 && p.vertDepth > 0) {
          const wobble = (noiseMid(u * 4, v * 8) - 0.5) * p.vertWobble;
          const fissure = Math.sin((u + wobble) * Math.PI * 2 * _vF);
          const sharp = Math.pow(Math.max(0, 1 - Math.abs(fissure)), p.vertSharp);
          h -= sharp * p.vertDepth;
        }

        // Horizontal bands — lenticels (birch/cherry, sharp) or plates
        // (pine, broad). Same sin-with-wobble pattern in v.
        if (p.horizFreq > 0 && p.horizAmp > 0) {
          const wobble = (noiseMid(u * 6, v * 4) - 0.5) * 0.04;
          const band = Math.sin((v + wobble) * Math.PI * 2 * p.horizFreq);
          const sharp = Math.pow(Math.max(0, 1 - Math.abs(band)), p.horizSharp);
          h += (sharp - 0.5) * p.horizAmp;
        }

        // Large-scale variation — patchy regions across the trunk.
        if (p.largeAmp > 0 && _lF > 0) {
          h += (noiseLarge(u * _lF, v * _lF) - 0.5) * p.largeAmp;
        }

        // Micro detail — final fine bump pattern.
        if (p.microAmp > 0 && _mF > 0) {
          h += (noiseFine(u * _mF, v * _mF) - 0.5) * p.microAmp;
        }

        height[y * N + x] = Math.max(0, Math.min(1, h));
      }
    }

    // Albedo — three-stop palette interpolated by height.
    const aCanvas = document.createElement('canvas');
    aCanvas.width = N; aCanvas.height = N;
    const aCtx = aCanvas.getContext('2d');
    const aImg = aCtx.createImageData(N, N);
    const aData = aImg.data;
    const pal = p.palette;
    const grainAmp = p.grain || 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const h = height[i];
        let r, g, b;
        if (h < 0.5) {
          const t = h * 2;
          r = pal[0][0] * (1 - t) + pal[1][0] * t;
          g = pal[0][1] * (1 - t) + pal[1][1] * t;
          b = pal[0][2] * (1 - t) + pal[1][2] * t;
        } else {
          const t = (h - 0.5) * 2;
          r = pal[1][0] * (1 - t) + pal[2][0] * t;
          g = pal[1][1] * (1 - t) + pal[2][1] * t;
          b = pal[1][2] * (1 - t) + pal[2][2] * t;
        }
        if (grainAmp > 0) {
          const grain = (noiseGrain(x / N, y / N) - 0.5) * grainAmp * 2;
          r += grain; g += grain; b += grain;
        }
        const o = i * 4;
        aData[o    ] = r < 0 ? 0 : r > 255 ? 255 : r;
        aData[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        aData[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        aData[o + 3] = 255;
      }
    }
    aCtx.putImageData(aImg, 0, 0);

    // Normal map — central differences on the height field, wrap-aware
    // so the seam tiles correctly. Standard tangent-space encoding
    // (XYZ → 0..255 via *0.5+0.5).
    const nCanvas = document.createElement('canvas');
    nCanvas.width = N; nCanvas.height = N;
    const nCtx = nCanvas.getContext('2d');
    const nImg = nCtx.createImageData(N, N);
    const nData = nImg.data;
    const ns = p.normalStrength || 2;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const xL = (x - 1 + N) % N;
        const xR = (x + 1) % N;
        const yU = (y - 1 + N) % N;
        const yD = (y + 1) % N;
        const dx = (height[y * N + xR] - height[y * N + xL]) * ns;
        const dy = (height[yD * N + x] - height[yU * N + x]) * ns;
        const m = Math.sqrt(dx * dx + dy * dy + 1) || 1;
        const nx = -dx / m, ny = -dy / m, nz = 1 / m;
        const o = (y * N + x) * 4;
        nData[o    ] = (nx * 0.5 + 0.5) * 255;
        nData[o + 1] = (ny * 0.5 + 0.5) * 255;
        nData[o + 2] = (nz * 0.5 + 0.5) * 255;
        nData[o + 3] = 255;
      }
    }
    nCtx.putImageData(nImg, 0, 0);

    const result = { albedoCanvas: aCanvas, normalCanvas: nCanvas };
    _lruSet(_BARK_TEX_CACHE, key, result, _BARK_TEX_CACHE_MAX);
    return result;
  } catch (err) {
    // Bulletproof fallback — render-time consumer (applyBarkStyle) sees
    // null canvases and keeps the previous textures rather than mapping
    // unfilled black.
    console.warn('[bark-gen] failed for style', style, '— keeping previous', err);
    return null;
  }
}

// Slim albedo-only renderer for the style picker thumbnails. Uses the
// preset recipe defaults (no P slider overrides) so each thumbnail always
// shows the canonical look of that preset, regardless of the user's
// current edits. Caches the raw pixel buffer (Uint8ClampedArray) instead
// of the canvas, then stamps onto a fresh canvas per call — same fix as
// generateNoiseThumbnail (DOM appendChild moves nodes, so a cached canvas
// reused by two pickers ends up parented to whichever ran last, leaving
// the other empty / black).
const _BARK_THUMB_CACHE = new Map();
export function generateBarkThumbnail(style, size = 48) {
  const key = style + ':' + size;
  const cachedPixels = _BARK_THUMB_CACHE.get(key);
  if (cachedPixels) {
    const cv2 = document.createElement('canvas');
    cv2.width = size; cv2.height = size;
    cv2.getContext('2d').putImageData(new ImageData(cachedPixels, size, size), 0, 0);
    return cv2;
  }
  const recipeRaw = BARK_STYLES[style] || BARK_STYLES.oak;
  // Snap freqs to integers so the thumb tiles cleanly — same logic as
  // generateBarkTexture (see comment there for why fractional freqs seam).
  const recipe = {
    ...recipeRaw,
    vertFreq:  Math.max(0, Math.round(recipeRaw.vertFreq)),
    horizFreq: Math.max(0, Math.round(recipeRaw.horizFreq)),
    largeFreq: Math.max(0, Math.round(recipeRaw.largeFreq)),
    microFreq: Math.max(0, Math.round(recipeRaw.microFreq)),
  };
  const N = size;
  const seed = 1;
  const noiseLarge = _makeTilableNoise(seed, 8);
  const noiseMid   = _makeTilableNoise(seed + 7, 16);
  const noiseFine  = _makeTilableNoise(seed + 13, 64);
  const noiseGrain = _makeTilableNoise(seed + 23, 128);
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N);
  const data = img.data;
  const pal = recipe.palette;
  const grainAmp = recipe.grain || 0;
  // Round U-axis frequencies to integers so the texture tiles seamlessly
  // around the trunk circumference (u=0 must equal u=1). Sine waves and
  // tilable-noise lookups only wrap cleanly at integer multiples of u.
  // horizFreq stays continuous because it samples v (trunk height), where
  // the wrap is hidden inside trunk geometry, not at a visible seam.
  const vFreq    = Math.max(0, Math.round(recipe.vertFreq));
  const lFreq    = Math.max(0, Math.round(recipe.largeFreq));
  const mFreq    = Math.max(0, Math.round(recipe.microFreq));
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N;
      let h = 0.5;
      if (vFreq > 0 && recipe.vertDepth > 0) {
        const wobble = (noiseMid(u * 4, v * 8) - 0.5) * recipe.vertWobble;
        const fissure = Math.sin((u + wobble) * Math.PI * 2 * vFreq);
        h -= Math.pow(Math.max(0, 1 - Math.abs(fissure)), recipe.vertSharp) * recipe.vertDepth;
      }
      if (recipe.horizFreq > 0 && recipe.horizAmp > 0) {
        const wobble = (noiseMid(u * 6, v * 4) - 0.5) * 0.04;
        const band = Math.sin((v + wobble) * Math.PI * 2 * recipe.horizFreq);
        h += (Math.pow(Math.max(0, 1 - Math.abs(band)), recipe.horizSharp) - 0.5) * recipe.horizAmp;
      }
      if (recipe.largeAmp > 0 && lFreq > 0) h += (noiseLarge(u * lFreq, v * lFreq) - 0.5) * recipe.largeAmp;
      if (recipe.microAmp > 0 && mFreq > 0) h += (noiseFine(u * mFreq, v * mFreq) - 0.5) * recipe.microAmp;
      h = Math.max(0, Math.min(1, h));
      let r, g, b;
      if (h < 0.5) {
        const t = h * 2;
        r = pal[0][0] * (1 - t) + pal[1][0] * t;
        g = pal[0][1] * (1 - t) + pal[1][1] * t;
        b = pal[0][2] * (1 - t) + pal[1][2] * t;
      } else {
        const t = (h - 0.5) * 2;
        r = pal[1][0] * (1 - t) + pal[2][0] * t;
        g = pal[1][1] * (1 - t) + pal[2][1] * t;
        b = pal[1][2] * (1 - t) + pal[2][2] * t;
      }
      if (grainAmp > 0) {
        const gr = (noiseGrain(x / N, y / N) - 0.5) * grainAmp * 2;
        r += gr; g += gr; b += gr;
      }
      const o = (y * N + x) * 4;
      data[o    ] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Cache the raw pixel buffer (not the canvas) so future calls stamp
  // onto a fresh canvas, avoiding DOM-parent contention.
  _BARK_THUMB_CACHE.set(key, new Uint8ClampedArray(data));
  return cv;
}

// Greyscale thumbnail of a single noise pattern at native frequency. Used
// by the per-layer pattern picker so the user can see what each pattern
// looks like at a glance. We cache the raw pixel buffer (Uint8ClampedArray)
// instead of the canvas itself — DOM appendChild moves nodes rather than
// copying them, so a cached canvas reused by two pickers (e.g. 'value'
// appears in both Patches and Micro) ends up parented to whichever row
// was built last, leaving the other empty / black.
const _NOISE_THUMB_CACHE = new Map();
export function generateNoiseThumbnail(patternName, size = 48) {
  const key = patternName + ':' + size;
  let pixels = _NOISE_THUMB_CACHE.get(key);
  if (!pixels) {
    const factory = NOISE_PATTERNS[patternName] || NOISE_PATTERNS.value;
    // Period = 6 reads as "patches" at 48² — chunky enough that ridged /
    // worley / warp show their character clearly. Same period across
    // patterns so visual differences are pattern-driven, not scale-driven.
    const noise = factory(7, 6);
    pixels = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        // Worley returns distance — invert so feature points read bright
        // (more visually interesting than dark spots on grey).
        let n = noise(u, v);
        if (patternName === 'worley') n = 1 - n;
        const c = Math.max(0, Math.min(255, n * 255));
        const o = (y * size + x) * 4;
        pixels[o    ] = c;
        pixels[o + 1] = c;
        pixels[o + 2] = c;
        pixels[o + 3] = 255;
      }
    }
    _NOISE_THUMB_CACHE.set(key, pixels);
  }
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  // ImageData expects a Uint8ClampedArray of the exact length — wrap the
  // cached buffer so we don't pay a copy on every reuse.
  ctx.putImageData(new ImageData(pixels, size, size), 0, 0);
  return cv;
}

