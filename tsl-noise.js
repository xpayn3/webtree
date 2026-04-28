// tsl-noise.js — TSL ports of the JS noise functions in noise.js.
//
// Why this exists: any future GPU compute work (tube extrusion, animated
// growth, shader-side procedural detail) needs the SAME noise the CPU side
// has been using, so visual character is preserved. These TSL functions are
// algorithmic copies of noise.js — same `sin`-based hash, same value noise,
// same 3-octave fbm, same composite Worley.
//
// Precision note: TSL runs on the GPU in f32, JS noise runs in f64. The hash
// function `sin(n * 127.1) * 43758.5453` returns a number in the millions and
// then takes the fractional part. Tiny f32 rounding shifts the fractional
// part, so per-vertex noise values won't match the CPU bit-exact. The visible
// pattern (frequency, amplitude, ridge density) IS preserved — same algorithm.
// If a sub-millimeter shift in bark texture matters, swap the sin-hash for an
// integer-hash variant (no sin, just bit-shuffle); the API stays the same.
//
// Nothing in the live app imports this file yet — it's foundation for the
// GPU compute path. Wire it in when that lands.

import { Fn, sin, floor, fract, vec2, vec3, float, mul, add, sub, abs, min, max } from 'three/tsl';

// 1D hash — TSL port of noise.js hash1D. Returns scalar in [0, 1).
//
//   JS: const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s);
//
// fract(s) is equivalent to s - floor(s) in TSL but maps to a single hardware
// op on most GPUs. Keep the magic constants identical so the noise pattern
// shape (peak/valley locations) matches the CPU output to within f32 drift.
export const hash1D = Fn(([n]) => {
  return fract(sin(n.mul(127.1)).mul(43758.5453));
});

// Smoothed 1D value noise in [-1, 1]. TSL port of noise.js smoothNoise1D.
//
//   JS: const i = Math.floor(x); const f = x - i;
//       const u = f * f * (3 - 2 * f);
//       return (hash1D(i) * (1 - u) + hash1D(i + 1) * u) * 2 - 1;
export const smoothNoise1D = Fn(([x]) => {
  const i = floor(x);
  const f = x.sub(i);
  // Smoothstep weight: 3f² - 2f³.
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash1D(i);
  const b = hash1D(i.add(1));
  // Lerp + remap [0,1] → [-1,1].
  return a.mul(float(1).sub(u)).add(b.mul(u)).mul(2).sub(1);
});

// 2D hash — TSL port of noise.js hash2D. Returns scalar in [0, 1).
//
//   JS: const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
//       return s - Math.floor(s);
export const hash2D = Fn(([x, y]) => {
  return fract(sin(x.mul(127.1).add(y.mul(311.7))).mul(43758.5453));
});

// 2D value noise in [0, 1]. TSL port of noise.js valueNoise2D — bilinear
// interpolation between the four hash corners with the cubic smoothstep
// weight 3t² - 2t³ on each axis.
export const valueNoise2D = Fn(([x, y]) => {
  const xi = floor(x);
  const yi = floor(y);
  const xf = x.sub(xi);
  const yf = y.sub(yi);
  const u = xf.mul(xf).mul(float(3).sub(xf.mul(2)));
  const v = yf.mul(yf).mul(float(3).sub(yf.mul(2)));
  const a = hash2D(xi,           yi);
  const b = hash2D(xi.add(1),    yi);
  const c = hash2D(xi,           yi.add(1));
  const d = hash2D(xi.add(1),    yi.add(1));
  const ab = a.mul(float(1).sub(u)).add(b.mul(u));
  const cd = c.mul(float(1).sub(u)).add(d.mul(u));
  return ab.mul(float(1).sub(v)).add(cd.mul(v));
});

// 3-octave 2D FBM in [-1, 1]. TSL port of noise.js fbm2D.
//
// JS uses a `for` loop with mutating `f += ...; fx *= 2.03;`. TSL functions
// are pure node graphs (no mutable state), so the three octaves are unrolled
// here. Numerically identical to running the JS loop with the same inputs.
export const fbm2D = Fn(([x, y]) => {
  // Octave 0 — amplitude 0.5, frequency 1.
  const n0 = valueNoise2D(x, y).mul(2).sub(1).mul(0.5);
  // Octave 1 — amplitude 0.25, frequency 2.03.
  const n1 = valueNoise2D(x.mul(2.03), y.mul(2.03)).mul(2).sub(1).mul(0.25);
  // Octave 2 — amplitude 0.125, frequency 2.03 * 2.03.
  const n2 = valueNoise2D(x.mul(2.03 * 2.03), y.mul(2.03 * 2.03)).mul(2).sub(1).mul(0.125);
  return n0.add(n1).add(n2);
});

// 2D Worley / cellular distance noise. TSL port of noise.js worley2D.
//
// Walks the 3×3 neighborhood of the integer grid cell containing (x, y),
// hashes each cell's feature point, and tracks the minimum squared distance.
// Returns sqrt of that distance — same as the JS version, output ≈ [0, 1.4].
//
// Unrolled because TSL Fn bodies can't mutate state across iterations.
export const worley2D = Fn(([x, y]) => {
  const xi = floor(x);
  const yi = floor(y);
  const xf = x.sub(xi);
  const yf = y.sub(yi);
  // Track running minimum across the 9 neighbor cells. TSL has no `let`
  // mutation inside Fn, so we chain `min()` calls — works because the
  // operation is associative.
  let md = float(8);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi.add(i);
      const cy = yi.add(j);
      const h  = hash2D(cx,         cy);
      const h2 = hash2D(cx.add(71.3), cy.add(19.7));
      const px = float(i).add(h).sub(xf);
      const py = float(j).add(h2).sub(yf);
      const d = px.mul(px).add(py.mul(py));
      md = min(md, d);
    }
  }
  // sqrt: TSL exposes it via Math.sqrt-style node, but for cleanliness we use
  // the standard `pow(d, 0.5)` equivalent via the d.sqrt() method node.
  return md.sqrt();
});

// Cheap 3D FBM composed from three 2D slices. TSL port of noise.js fbm3D.
// Removes the cylindrical seam + Frenet-spiral artifacts when sampled with a
// 3D unit radial vector + axial position. Output in [-1, 1].
//
//   JS: return (fbm2D(x + z * 0.73, y - z * 0.19)
//             + fbm2D(y + x * 0.41, z - x * 0.27)
//             + fbm2D(z + y * 0.61, x - y * 0.53)) * (1 / 3);
export const fbm3D = Fn(([x, y, z]) => {
  const a = fbm2D(x.add(z.mul(0.73)), y.sub(z.mul(0.19)));
  const b = fbm2D(y.add(x.mul(0.41)), z.sub(x.mul(0.27)));
  const c = fbm2D(z.add(y.mul(0.61)), x.sub(y.mul(0.53)));
  return a.add(b).add(c).mul(1 / 3);
});

// Composite 3D Worley — three orthogonal 2D slices, min of distances. No
// seam. TSL port of noise.js worley3D.
//
//   JS: const a = worley2D(x + z * 0.37, y);
//       const b = worley2D(y + x * 0.19, z);
//       const c = worley2D(z + y * 0.73, x);
//       return Math.min(a, Math.min(b, c));
export const worley3D = Fn(([x, y, z]) => {
  const a = worley2D(x.add(z.mul(0.37)), y);
  const b = worley2D(y.add(x.mul(0.19)), z);
  const c = worley2D(z.add(y.mul(0.73)), x);
  return min(a, min(b, c));
});
