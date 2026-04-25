// Seeded PRNG + deterministic noise functions used by the bark tube
// extrusion pipeline and branch-wobble code.
//
// `random` is NOT exported — it is a mutable global in main.js that gets
// reseeded per generateTree() call. Only the pure, stateless helpers live here.

// Fast 32-bit seeded PRNG (Mulberry32). Returns a function() → [0, 1).
export function mulberry32(seed) {
  let t = seed >>> 0;
  if (t === 0) t = 1;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 32-bit hash from a master seed + any number of integer keys.
// Used to derive stable per-node / per-step RNGs so the number of `random()`
// calls inside a loop doesn't cascade-shift every downstream random draw.
export function _hashSeed(masterSeed, ...keys) {
  let h = (masterSeed | 0) >>> 0;
  for (let i = 0; i < keys.length; i++) {
    h = (h + (keys[i] | 0) + 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h || 1;
}
// Local RNG seeded from a context hash. Loop bodies use this instead of the
// global `random()` so their consumption can't shift other nodes' draws.
export function _localRng(masterSeed, ...keys) {
  return mulberry32(_hashSeed(masterSeed, ...keys));
}

// Deterministic 1D value noise (smoothed) in range [-1, 1]
export function hash1D(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
export function smoothNoise1D(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash1D(i) * (1 - u) + hash1D(i + 1) * u) * 2 - 1;
}

// 2D hash + value noise. Seeded sin trick — fine for surface displacement,
// faster than perlin for CPU tube baking. Returns [0, 1].
export function hash2D(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function valueNoise2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2D(xi,     yi);
  const b = hash2D(xi + 1, yi);
  const c = hash2D(xi,     yi + 1);
  const d = hash2D(xi + 1, yi + 1);
  const ab = a * (1 - u) + b * u;
  const cd = c * (1 - u) + d * u;
  return ab * (1 - v) + cd * v;            // [0,1]
}
// 3-octave FBM in [-1, 1].
export function fbm2D(x, y) {
  let f = 0, amp = 0.5, fx = x, fy = y;
  for (let o = 0; o < 3; o++) {
    f += (valueNoise2D(fx, fy) * 2 - 1) * amp;
    fx *= 2.03; fy *= 2.03; amp *= 0.5;
  }
  return f;
}
// Worley / cellular noise. Returns distance-to-nearest-feature-point in
// [0, ~1]. Used for knot-like bumps along the trunk.
export function worley2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  let md = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const h = hash2D(xi + i, yi + j);
      const h2 = hash2D(xi + i + 71.3, yi + j + 19.7);
      const px = i + h - xf;
      const py = j + h2 - yf;
      const d = px * px + py * py;
      if (d < md) md = d;
    }
  }
  return Math.sqrt(md);                     // ≈ [0,1.4]
}
// Cheap 3D FBM composed from three 2D slices. Not true 3D noise, but it
// removes cylindrical seams + Frenet-spiral when sampled with a 3D unit
// radial vector + axial position. In [-1, 1].
export function fbm3D(x, y, z) {
  return (fbm2D(x + z * 0.73, y - z * 0.19)
        + fbm2D(y + x * 0.41, z - x * 0.27)
        + fbm2D(z + y * 0.61, x - y * 0.53)) * (1 / 3);
}
// Composite 3D worley — 3 orthogonal 2D slices, min of distances. No seam.
export function worley3D(x, y, z) {
  const a = worley2D(x + z * 0.37, y);
  const b = worley2D(y + x * 0.19, z);
  const c = worley2D(z + y * 0.73, x);
  return Math.min(a, Math.min(b, c));
}
