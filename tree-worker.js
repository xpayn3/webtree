// Tree worker — runs the heavy parts of tree generation off the main thread.
//
// Two message types:
//   • 'build-tubes'             — extrude tube geometries from pre-built chains.
//                                 One worker handles a subset; main thread fans
//                                 a single generate across the pool.
//   • 'build-tree-and-chains'   — full procedural build: walkInternode, pruning,
//                                 allometric radii, chain segmentation. Returns
//                                 SoA typed arrays (posX/Y/Z, parentIdx, radius,
//                                 prunedFlags) + chain index lists + chain node
//                                 data ready for a subsequent 'build-tubes' pass.
//
// NOTE: buildTree / buildChains / tubeFromChain are duplicated from main.js.
// Keep them in sync when you change one; the growth math must match exactly so
// the worker and sync fallback paths produce identical trees at the same seed.
//
// Three.js is imported from the same CDN the main app uses. Workers don't
// inherit importmaps, so the URL is absolute.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js';

// --- Spline samplers (Catmull-Rom, matching main.js editors) -------------
class SplineSampler {
  constructor(points) { this.points = (points && points.length) ? Array.from(points) : null; }
  sample(t) {
    const pts = this.points;
    if (!pts) return 1;
    const n = pts.length;
    if (n === 1) return pts[0];
    const f = Math.max(0, Math.min(1, t)) * (n - 1);
    const i1 = Math.floor(f);
    const i2 = Math.min(n - 1, i1 + 1);
    const i0 = Math.max(0, i1 - 1);
    const i3 = Math.min(n - 1, i2 + 1);
    const u = f - i1;
    const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2], p3 = pts[i3];
    const a = 2 * p1;
    const b = p2 - p0;
    const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const d = -p0 + 3 * p1 - 3 * p2 + p3;
    return 0.5 * (a + b * u + c * u * u + d * u * u * u);
  }
}
class ProfileSampler {
  constructor(points) { this.points = (points && points.length) ? Array.from(points) : null; }
  sample(angle) {
    const pts = this.points;
    if (!pts) return 1;
    const n = pts.length;
    const norm = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const f = (norm / (Math.PI * 2)) * n;
    const i1 = Math.floor(f) % n;
    const i2 = (i1 + 1) % n;
    const i0 = (i1 - 1 + n) % n;
    const i3 = (i2 + 1) % n;
    const u = f - Math.floor(f);
    const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2], p3 = pts[i3];
    const a = 2 * p1;
    const b = p2 - p0;
    const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const d = -p0 + 3 * p1 - 3 * p2 + p3;
    return 0.5 * (a + b * u + c * u * u + d * u * u * u);
  }
}

// --- Tropism shape (matches main.js normalizeTropism) -------------------
const _W_TROPISM_DEFAULTS = {
  gravity: { dirX: 0,  dirY: -1, dirZ: 0 },
  photo:   { dirX: 0,  dirY:  1, dirZ: 0 },
};
function _normalizeTropism(v, kind) {
  const def = _W_TROPISM_DEFAULTS[kind];
  if (typeof v === 'number') {
    return {
      enabled: v !== 0,
      dirX: def.dirX, dirY: def.dirY, dirZ: def.dirZ,
      strength: v,
      falloff: null,
      byLevel: false,
      _useSun: kind === 'photo',
    };
  }
  if (v && typeof v === 'object') {
    return {
      enabled: v.enabled !== false,
      dirX: (v.dirX ?? def.dirX),
      dirY: (v.dirY ?? def.dirY),
      dirZ: (v.dirZ ?? def.dirZ),
      strength: v.strength ?? 0,
      falloff: Array.isArray(v.falloff) ? v.falloff : null,
      byLevel: !!v.byLevel,
      _useSun: false,
    };
  }
  return { enabled: false, dirX: 0, dirY: 0, dirZ: 0, strength: 0, falloff: null, byLevel: false, _useSun: false };
}
function _sampleFalloffArr(arr, t) {
  if (!arr || arr.length < 2) return 1;
  const n = arr.length;
  const f = Math.max(0, Math.min(1, t)) * (n - 1);
  const i1 = Math.floor(f);
  const i2 = Math.min(n - 1, i1 + 1);
  const i0 = Math.max(0, i1 - 1);
  const i3 = Math.min(n - 1, i2 + 1);
  const u = f - i1;
  const p0 = arr[i0], p1 = arr[i1], p2 = arr[i2], p3 = arr[i3];
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * u + c * u * u + d * u * u * u);
}

// --- Smooth 1D value noise (matches main.js smoothNoise1D) ---------------
function _hash1D(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function _smoothNoise1D(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (_hash1D(i) * (1 - u) + _hash1D(i + 1) * u) * 2 - 1;
}

// 2D hash/value/fbm + Worley (mirror of main.js). Used for bark mesh
// displacement modes: ridges / blobby / cellular / mixed.
function _hash2D(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function _valueNoise2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = _hash2D(xi,     yi);
  const b = _hash2D(xi + 1, yi);
  const c = _hash2D(xi,     yi + 1);
  const d = _hash2D(xi + 1, yi + 1);
  const ab = a * (1 - u) + b * u;
  const cd = c * (1 - u) + d * u;
  return ab * (1 - v) + cd * v;
}
function _fbm2D(x, y) {
  let f = 0, amp = 0.5, fx = x, fy = y;
  for (let o = 0; o < 3; o++) {
    f += (_valueNoise2D(fx, fy) * 2 - 1) * amp;
    fx *= 2.03; fy *= 2.03; amp *= 0.5;
  }
  return f;
}
function _worley2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  let md = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const h = _hash2D(xi + i, yi + j);
      const h2 = _hash2D(xi + i + 71.3, yi + j + 19.7);
      const px = i + h - xf;
      const py = j + h2 - yf;
      const d = px * px + py * py;
      if (d < md) md = d;
    }
  }
  return Math.sqrt(md);
}
function _fbm3D(x, y, z) {
  return (_fbm2D(x + z * 0.73, y - z * 0.19)
        + _fbm2D(y + x * 0.41, z - x * 0.27)
        + _fbm2D(z + y * 0.61, x - y * 0.53)) * (1 / 3);
}
function _worley3D(x, y, z) {
  const a = _worley2D(x + z * 0.37, y);
  const b = _worley2D(y + x * 0.19, z);
  const c = _worley2D(z + y * 0.73, x);
  return Math.min(a, Math.min(b, c));
}

// --- Tree-build logic (mirrors main.js buildTree + buildChains) ----------
// See the duplication note at the top of this file.

function _mulberry32(seed) {
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
function _w_hashSeed(masterSeed, ...keys) {
  let h = (masterSeed | 0) >>> 0;
  for (let i = 0; i < keys.length; i++) {
    h = (h + (keys[i] | 0) + 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h || 1;
}
function _w_localRng(masterSeed, ...keys) {
  return _mulberry32(_w_hashSeed(masterSeed, ...keys));
}

class _TNode {
  constructor(pos, parent = null) {
    this.pos = pos.clone();
    this.parent = parent;
    this.children = [];
    this.radius = 0;
    this.pruned = false;
    this.idx = -1;
  }
}

// Scratch vectors — worker's buildTree is non-reentrant within a single call.
const _w_scUp       = new THREE.Vector3();
const _w_scRight    = new THREE.Vector3();
const _w_scLocUp    = new THREE.Vector3();
const _w_scAzimuth  = new THREE.Vector3();
const _w_scChildDir = new THREE.Vector3();

function buildTreeWorker(state) {
  const P = state.P;
  const attractors = (state.attractors && state.attractors.length) ? state.attractors : null;
  const lengthSampler = (state.lengthPoints && state.lengthPoints.length) ? new SplineSampler(state.lengthPoints) : null;
  const random = _mulberry32(state.seed >>> 0);

  // Sun direction for phototropism. Elevation 90° ⇒ (0,1,0), matches the
  // legacy pure-up bias when the user leaves the new sliders at defaults.
  const _sunEl = ((P.sunElevation ?? 90) * Math.PI) / 180;
  const _sunAz = ((P.sunAzimuth   ?? 0)  * Math.PI) / 180;
  const _sunC = Math.cos(_sunEl);
  const sunDirX = _sunC * Math.sin(_sunAz);
  const sunDirY = Math.sin(_sunEl);
  const sunDirZ = _sunC * Math.cos(_sunAz);

  const nodes = [];
  const root = new _TNode(new THREE.Vector3(0, 0, 0));
  nodes.push(root);

  function walkInternode(startNode, startPos, dir, length, L, levelIdx = 0) {
    const segLen = length / L.kinkSteps;
    let cur = startNode;
    const pos = startPos.clone();
    const d = dir.clone();
    const stepData = [];
    const tropG = _normalizeTropism(L.gravitropism, 'gravity');
    const tropP = _normalizeTropism(L.phototropism, 'photo');
    const levelMul = levelIdx + 1;
    const freq = L.distortionFreq ?? 3;
    const type = L.distortionType ?? 'random';
    const amp = L.distortion ?? 0;
    const susc = L.susceptibility ?? 1;
    const curveMode = L.curveMode ?? 'none';
    const curveAmt = L.curveAmount ?? 0;
    // ez-tree's 1/√radius gnarliness rule, indexed by level depth (radius isn't
    // computed yet here). Mirror of main.js walkInternode.
    const lastLevel = (P.levels.length - 1);
    const thinScale = levelIdx >= lastLevel ? 2.0
                    : levelIdx === lastLevel - 1 ? 1.4
                    : 1.0;
    // Position-keyed branch RNG — keys are all spatial, so this RNG is
    // decoupled from the global random() stream and stable across rebuilds.
    const _qpos = (v) => Math.round(v * 1000) | 0;
    const bRng = _w_localRng(
      P.seed | 0,
      _qpos(startPos.x), _qpos(startPos.y), _qpos(startPos.z),
      _qpos(dir.x), _qpos(dir.y), _qpos(dir.z),
      levelIdx,
      Math.round(length * 1000),
    );
    // Derived from bRng so it no longer consumes the global stream.
    const branchSeed = bRng() * 137.5;
    const curveAngle = branchSeed;
    const randPts = L.randomnessPoints;
    for (let s = 0; s < L.kinkSteps; s++) {
      const tNorm = s / L.kinkSteps;
      let dx = 0, dz = 0;
      const rampMul = randPts ? _sampleFalloffArr(randPts, tNorm) : 1;
      // kinkSteps invariance (mirror of main.js): scale per-step amplitude
      // by (8/kinkSteps) so the total curve stays constant when the user
      // changes Segments. Default kinkSteps=8 → factor 1.
      const stepInv = 8 / Math.max(1, L.kinkSteps);
      const ampE = amp * rampMul * thinScale * stepInv;
      // Distortion noise — always perlin (mirror of main.js). Torsion removed.
      if (ampE > 0) {
        dx = _smoothNoise1D(tNorm * freq + branchSeed) * ampE;
        dz = _smoothNoise1D(tNorm * freq + branchSeed + 47.3) * ampE;
      }
      // Parametric curvature (matches main.js walkInternode curve block —
      // including Weber-Penn asymmetric curveBack).
      const curveBack = L.curveBack ?? 0;
      if ((curveMode !== 'none' && curveAmt > 0) || Math.abs(curveBack) > 0.01) {
        const cx = Math.cos(curveAngle), cz = Math.sin(curveAngle);
        let curveBias = 0;
        if (curveMode === 'sCurve')       curveBias = Math.sin(tNorm * Math.PI * 2) * curveAmt * 0.25 * stepInv;
        else if (curveMode === 'backCurve') curveBias = tNorm * curveAmt * 0.18 * stepInv;
        else if (curveMode === 'helical') {
          const a = tNorm * Math.PI * 4 + branchSeed;
          dx += Math.cos(a) * curveAmt * 0.1 * stepInv;
          dz += Math.sin(a) * curveAmt * 0.1 * stepInv;
          curveBias = 0;
        }
        if (Math.abs(curveBack) > 0.01) {
          const firstHalf = tNorm < 0.5;
          const tH = firstHalf ? tNorm * 2 : (tNorm - 0.5) * 2;
          const v = firstHalf ? curveAmt * 0.18 : -curveBack * 0.18;
          curveBias += v * Math.sin(tH * Math.PI) * stepInv;
        }
        dx += cx * curveBias;
        dz += cz * curveBias;
      }
      d.x += dx; d.z += dz;
      // Tropism + attractors scaled by stepInv (mirror of main.js) — they
      // represent physical pull per unit length, not per integration step.
      if (tropP.enabled) {
        let f = tropP.falloff ? _sampleFalloffArr(tropP.falloff, tNorm) : 1;
        if (tropP.byLevel) f *= levelMul;
        const s = tropP.strength * susc * f * stepInv;
        if (tropP._useSun) { d.x += sunDirX * s; d.y += sunDirY * s; d.z += sunDirZ * s; }
        else               { d.x += tropP.dirX * s; d.y += tropP.dirY * s; d.z += tropP.dirZ * s; }
      }
      if (tropG.enabled) {
        let f = tropG.falloff ? _sampleFalloffArr(tropG.falloff, tNorm) : 1;
        if (tropG.byLevel) f *= levelMul;
        const s = tropG.strength * susc * f * stepInv;
        d.x += tropG.dirX * s; d.y += tropG.dirY * s; d.z += tropG.dirZ * s;
      }
      if (attractors) {
        for (const a of attractors) {
          if (!a || (a.strength ?? 0) <= 0) continue;
          const ax = a.x - pos.x, ay = a.y - pos.y, az = a.z - pos.z;
          const d2 = ax * ax + ay * ay + az * az;
          if (d2 < 0.05) continue;
          const inv = 1 / Math.sqrt(d2);
          const falloff = 1 / (1 + d2 * 0.03);
          const pull = a.strength * falloff * 0.08 * stepInv;
          d.x += ax * inv * pull;
          d.y += ay * inv * pull * 0.6;
          d.z += az * inv * pull;
        }
      }
      const twist = L.twist ?? 0;
      if (twist !== 0) {
        const tw = twist * segLen;
        const ct = Math.cos(tw), st = Math.sin(tw);
        const nx = d.x * ct - d.z * st;
        const nz = d.x * st + d.z * ct;
        d.x = nx; d.z = nz;
      }
      // Zero-length guard — see main.js walkInternode for rationale.
      if (d.x * d.x + d.y * d.y + d.z * d.z < 1e-8) d.copy(dir);
      d.normalize();
      pos.addScaledVector(d, segLen);
      const FLOOR_Y = 0.03;
      if (pos.y < FLOOR_Y) {
        pos.y = FLOOR_Y;
        d.y = 0;
        const hMag = Math.hypot(d.x, d.z);
        if (hMag > 1e-6) { d.x /= hMag; d.z /= hMag; }
        else             { d.x = 1; d.z = 0; }
      }
      const n = new _TNode(pos, cur);
      // Tag with branchT + branchLevel so the L.taper post-pass (mirror of
      // main.js buildTree) and any downstream consumer can distinguish
      // trunk nodes (no branchLevel) from branch nodes, and know where
      // along the parent each node sits.
      n.branchT = (s + 1) / L.kinkSteps;
      n.branchLevel = levelIdx;
      cur.children.push(n);
      nodes.push(n);
      cur = n;
      stepData.push({ node: n, pos: n.pos, dir: d.clone() });

      // Weber-Penn nSegSplits — expected forks across the branch length.
      // Each step has a probability of spawning a sibling at the SAME level.
      // Worker previously omitted this entirely, so species with segSplits
      // > 0 (Oak / Cherry / Willow / Birch / Acacia / Olive / Baobab /
      // Aspen / Tupelo / Sassafras / Lime + Maple/Tupelo L1 in some modes)
      // silently had fewer branches than main-thread fallback.
      const segSplits = L.segSplits ?? 0;
      const splitAngle = L.splitAngle ?? 0.25;
      if (segSplits > 0 && s < L.kinkSteps - 2) {
        const stepsLeft = L.kinkSteps - 1 - s;
        let splitMul = 1;
        if (Array.isArray(L.splitPoints) && L.splitPoints.length >= 2) {
          const arr = L.splitPoints;
          const an = arr.length;
          const af = Math.max(0, Math.min(1, tNorm)) * (an - 1);
          const ai1 = Math.floor(af), ai2 = Math.min(an - 1, ai1 + 1), ai0 = Math.max(0, ai1 - 1), ai3 = Math.min(an - 1, ai2 + 1);
          const au = af - ai1;
          const ap0 = arr[ai0], ap1 = arr[ai1], ap2 = arr[ai2], ap3 = arr[ai3];
          const aa = 2 * ap1, ab = ap2 - ap0, ac = 2 * ap0 - 5 * ap1 + 4 * ap2 - ap3, ad = -ap0 + 3 * ap1 - 3 * ap2 + ap3;
          splitMul = Math.max(0, 0.5 * (aa + ab * au + ac * au * au + ad * au * au * au));
        }
        const expected = (segSplits * splitMul) / L.kinkSteps;
        const forks = Math.floor(expected) + (bRng() < (expected - Math.floor(expected)) ? 1 : 0);
        for (let f = 0; f < forks; f++) {
          if (Math.abs(d.y) > 0.98) _w_scUp.set(1, 0, 0); else _w_scUp.set(0, 1, 0);
          const sright = _w_scRight.crossVectors(d, _w_scUp).normalize();
          const slocUp = _w_scLocUp.crossVectors(sright, d).normalize();
          const sroll = bRng() * Math.PI * 2;
          const sca = Math.cos(sroll), scb = Math.sin(sroll);
          const saxis = _w_scAzimuth.set(0, 0, 0).addScaledVector(sright, sca).addScaledVector(slocUp, scb);
          const forkDir = _w_scChildDir.set(0, 0, 0)
            .addScaledVector(d, Math.cos(splitAngle))
            .addScaledVector(saxis, Math.sin(splitAngle))
            .normalize()
            .clone();
          const forkLen = length * (stepsLeft / L.kinkSteps) * 0.9;
          // Route forks through a chainRoot bridge so the Weber-Penn radius
          // model scales the fork base from parent-local radius (× radiusRatio)
          // instead of inheriting the parent's full chainBase. Without this
          // the fork began at parent thickness and bulged at the junction.
          const fbridge = new _TNode(n.pos, n);
          fbridge.radius = n.radius || 0;
          fbridge.chainRoot = true;
          fbridge.branchLevel = levelIdx;
          n.children.push(fbridge);
          nodes.push(fbridge);
          growAtLevel(fbridge, n.pos, forkDir, forkLen, levelIdx);
        }
      }
    }
    return stepData;
  }

  function _w_shapeLenRatio(shape, ratio) {
    if (!shape || shape === 'free') return 1;
    const r = Math.max(0, Math.min(1, ratio));
    // MUST keep string set aligned with main.js shapeLenRatio — the main
    // thread sends whatever the user-facing dropdown uses ('inverse',
    // 'tend-flame'), and this function sees those same strings via the
    // worker state payload. Previously diverged into 'inverseConical' /
    // 'tendFlame' which silently fell through to default → tree looked
    // shape-less on species that picked one of those shapes (Oak / Aspen
    // / Tupelo / Baobab / ScotsPine).
    switch (shape) {
      case 'conical':        return 0.2 + 0.8 * (1 - r);
      case 'spherical':      return 0.2 + 0.8 * Math.sin(Math.PI * r);
      case 'hemispherical':  return 0.2 + 0.8 * Math.cos(Math.PI * r * 0.5);
      case 'cylindrical':    return 1;
      case 'tapered':        return 0.5 + 0.5 * (1 - r);
      case 'flame':          return r <= 0.7 ? 0.15 + 0.85 * r / 0.7 : 0.15 + 0.85 * (1 - r) / 0.3;
      case 'inverse':        return 0.2 + 0.8 * r;
      case 'tend-flame':     return r <= 0.7 ? 0.5 + 0.5 * r / 0.7 : 0.5 + 0.5 * (1 - r) / 0.3;
      default:               return 1;
    }
  }

  function spawnChildrenAlong(stepData, parentLen, childLevelIdx, fromTrunk = false, refCurve = null) {
    if (childLevelIdx >= P.levels.length) return;
    const L = P.levels[childLevelIdx];
    const baseSize = fromTrunk ? Math.max(0, Math.min(0.6, P.baseSize ?? 0)) : 0;
    // startPlacement is authoritative — baseSize used to clamp it from below.
    const tStart = Math.min(L.startPlacement, L.endPlacement);
    const tEnd = Math.max(L.startPlacement, L.endPlacement);
    // Mirror of main.js: 'density' mode derives count from parent length.
    const count = (L.placementMode === 'density')
      ? Math.max(1, Math.round((L.density ?? 4) * Math.max(0.001, parentLen) * (tEnd - tStart)))
      : L.children;
    const crownShape = fromTrunk ? (P.shape ?? 'free') : 'free';
    const lastIdx = stepData.length - 1;
    const phyllo = L.phyllotaxis ?? 'spiral';
    const apical = L.apicalDominance ?? 0;
    const stochastic = L.stochastic ?? 0;
    // Per-parent local RNG (mirror of main.js) so editing deeper levels
    // doesn't shift the random stream consumed by shallower ones.
    const _qpos = (v) => Math.round(v * 1000) | 0;
    const _anchor = stepData[0] && stepData[0].node && stepData[0].node.pos;
    const sRng = _w_localRng(
      P.seed | 0, 0xC01DB1A5, childLevelIdx,
      _anchor ? _qpos(_anchor.x) : 0,
      _anchor ? _qpos(_anchor.y) : 0,
      _anchor ? _qpos(_anchor.z) : 0,
      Math.round(parentLen * 1000),
    );
    // Opposite / decussate pair members at matching frac (mirror of main.js).
    const isPaired = phyllo === 'opposite' || phyllo === 'decussate';
    const pairCount = isPaired ? Math.ceil(count / 2) : count;
    let _pairJitter = 0;
    for (let c = 0; c < count; c++) {
      if (stochastic > 0 && sRng() < stochastic) continue;
      const pairIdx = isPaired ? Math.floor(c / 2) : c;
      const withinPair = isPaired ? (c % 2) : 0;
      const stepIdx = isPaired ? pairIdx : c;
      const stepCount = isPaired ? pairCount : count;
      let frac = stepCount === 1 ? (tStart + tEnd) * 0.5 : tStart + (tEnd - tStart) * (stepIdx / (stepCount - 1));
      if (stepCount > 1) {
        const spacing = (tEnd - tStart) / (stepCount - 1);
        if (!isPaired || withinPair === 0) {
          _pairJitter = (sRng() - 0.5) * spacing * 0.24;
        }
        frac += isPaired ? _pairJitter : (sRng() - 0.5) * spacing * 0.24;
        if (frac < tStart) frac = tStart;
        else if (frac > tEnd) frac = tEnd;
      }
      if (Array.isArray(L.densityPoints) && L.densityPoints.length >= 2) {
        const arr = L.densityPoints;
        const n = arr.length;
        const f = Math.max(0, Math.min(1, frac)) * (n - 1);
        const i1 = Math.floor(f), i2 = Math.min(n - 1, i1 + 1), i0 = Math.max(0, i1 - 1), i3 = Math.min(n - 1, i2 + 1);
        const u = f - i1;
        const p0 = arr[i0], p1 = arr[i1], p2 = arr[i2], p3 = arr[i3];
        const a = 2 * p1, b = p2 - p0, c = 2 * p0 - 5 * p1 + 4 * p2 - p3, d = -p0 + 3 * p1 - 3 * p2 + p3;
        const dens = 0.5 * (a + b * u + c * u * u + d * u * u * u);
        if (dens < 0.999 && sRng() > Math.max(0, Math.min(1, dens))) continue;
      }
      let _lenProfMul = 1;
      if (Array.isArray(L.lengthPoints) && L.lengthPoints.length >= 2) {
        const arr = L.lengthPoints;
        const n = arr.length;
        const f = Math.max(0, Math.min(1, frac)) * (n - 1);
        const i1 = Math.floor(f), i2 = Math.min(n - 1, i1 + 1), i0 = Math.max(0, i1 - 1), i3 = Math.min(n - 1, i2 + 1);
        const u = f - i1;
        const p0 = arr[i0], p1 = arr[i1], p2 = arr[i2], p3 = arr[i3];
        const a = 2 * p1, b = p2 - p0, c = 2 * p0 - 5 * p1 + 4 * p2 - p3, d = -p0 + 3 * p1 - 3 * p2 + p3;
        _lenProfMul = Math.max(0, 0.5 * (a + b * u + c * u * u + d * u * u * u));
      }
      // Resolve spawn pos+dir — prefer refCurve (subdivision-invariant) when provided.
      let _spPos, _spDir, _spNode;
      if (refCurve && refCurve.length >= 2) {
        const refLast = refCurve.length - 1;
        const idxF = Math.max(0, Math.min(refLast, frac * refLast));
        const ri0 = Math.floor(idxF);
        const ri1 = Math.min(refLast, ri0 + 1);
        const u = idxF - ri0;
        _spDir = refCurve[ri0].dir.clone().lerp(refCurve[ri1].dir, u);
        if (_spDir.lengthSq() < 1e-10) _spDir.copy(refCurve[ri0].dir);
        _spDir.normalize();
        // Snap bridge position to nearest parent chain node — guarantees
        // the bridge lies on the parent tube's Catmull-Rom curve.
        const skelIdx = Math.max(0, Math.min(lastIdx, Math.round(frac * lastIdx)));
        _spNode = stepData[skelIdx].node;
        _spPos = _spNode.pos.clone();
      } else {
        const idxF = Math.max(0, Math.min(lastIdx, frac * lastIdx));
        const sIdx = Math.floor(idxF);
        const sIdx1 = Math.min(lastIdx, sIdx + 1);
        const uSp = idxF - sIdx;
        const sp0 = stepData[sIdx];
        const sp1 = stepData[sIdx1];
        _spDir = sp0.dir.clone().lerp(sp1.dir, uSp);
        if (_spDir.lengthSq() < 1e-10) _spDir.copy(sp0.dir);
        _spDir.normalize();
        _spNode = uSp < 0.5 ? sp0.node : sp1.node;
        _spPos = _spNode.pos.clone();
      }
      const sp = { pos: _spPos, dir: _spDir, node: _spNode };
      if (Math.abs(sp.dir.y) > 0.98) _w_scUp.set(1, 0, 0); else _w_scUp.set(0, 1, 0);
      const right = _w_scRight.crossVectors(sp.dir, _w_scUp).normalize();
      const locUp = _w_scLocUp.crossVectors(right, sp.dir).normalize();
      const apicalSide = L.apicalInverted ? frac : (1 - frac);
      // Halved (matches main.js) — softens the tip-fan.
      const apicalLenMul = 1 - apical * apicalSide * 0.5;
      const apicalAngleBoost = apical * apicalSide * 0.35;
      const declineBias = (L.angleDecline ?? 0) * (frac - 0.5) * 2;
      const angleRamp = L.startAnglePoints ? _sampleFalloffArr(L.startAnglePoints, frac) : 0;
      const angle = L.angle + apicalAngleBoost + declineBias + angleRamp + (sRng() - 0.5) * L.angleVar;
      let roll;
      switch (phyllo) {
        case 'opposite':  roll = withinPair * Math.PI; break;
        case 'decussate': roll = withinPair * Math.PI + pairIdx * (Math.PI / 2); break;
        case 'whorled':   roll = (c / count) * Math.PI * 2; break;
        default: /* 'spiral' */ roll = P.goldenRoll * (c + 1);
      }
      roll += (L.rollStart ?? 0);
      // Branch-formula toggle — mirror of main.js.
      const _branchModel = P.branchModel || 'weber-penn';
      if (_branchModel === 'fibonacci') {
        roll = P.goldenRoll * (c + 1) + (L.rollStart ?? 0);
      } else {
        roll += (sRng() - 0.5) * L.rollVar;
      }
      const apicalContinue = L.apicalContinue ?? 0;
      const isApicalChild = apicalContinue > 0 && count > 1 && c === count - 1;
      const effAngle = isApicalChild ? angle * (1 - apicalContinue) : angle;
      const cosR = Math.cos(roll), sinR = Math.sin(roll);
      const azimuth = _w_scAzimuth.set(0, 0, 0).addScaledVector(right, cosR).addScaledVector(locUp, sinR);
      const childDir = _w_scChildDir.set(0, 0, 0)
        .addScaledVector(sp.dir, Math.cos(effAngle))
        .addScaledVector(azimuth, Math.sin(effAngle))
        .normalize();
      const sig = L.signalDecay ?? 0;
      const signalVigor = isApicalChild ? 1 : (sig > 0 ? Math.max(0.25, 1 - c * sig) : 1);
      const shapeMul = _w_shapeLenRatio(crownShape, (frac - baseSize) / Math.max(0.001, 1 - baseSize));
      const apicalLenBoost = isApicalChild ? (1 + apicalContinue * 0.6) : 1;
      // Honda R1/R2 length ratios when branch formula = 'honda'.
      let hondaMul = 1;
      if (_branchModel === 'honda') {
        const _r1 = P.hondaR1 ?? 0.94;
        const _r2 = P.hondaR2 ?? 0.86;
        hondaMul = isApicalChild ? _r1 : (c === 0 ? _r2 : _r2 * 0.81);
      }
      const _apicalLenMulEff = isApicalChild ? 1 : apicalLenMul;
      const childLen = parentLen * L.lenRatio * _apicalLenMulEff * signalVigor * shapeMul * _lenProfMul * apicalLenBoost * hondaMul;
      // Always insert a chainRoot bridge so buildChains identifies this as a
      // branch start and tubeFromChain applies the junction flare + pad.
      const bridge = new _TNode(sp.pos, sp.node);
      bridge.radius = sp.node.radius || 0;
      bridge.chainRoot = true;
      bridge.branchLevel = childLevelIdx;
      sp.node.children.push(bridge);
      nodes.push(bridge);
      growAtLevel(bridge, sp.pos, childDir, childLen, childLevelIdx);
    }
  }

  function growAtLevel(startNode, startPos, dir, length, levelIdx) {
    if (levelIdx >= P.levels.length) return;
    const phase = P.growthPhase ?? 1;
    const lastLevel = P.levels.length - 1;
    if (levelIdx === lastLevel && phase <= 0) return;
    const phaseLenMul = levelIdx < lastLevel ? 1 : Math.min(1, phase);
    const L = P.levels[levelIdx];
    const lenMul = lengthSampler ? lengthSampler.sample(P.levels.length > 1 ? levelIdx / (P.levels.length - 1) : 0) : 1;
    const effLen = length * lenMul * phaseLenMul;
    if (effLen < P.minLen) return;
    const stepData = walkInternode(startNode, startPos, dir, effLen, L, levelIdx);
    if (levelIdx + 1 < P.levels.length && phaseLenMul >= 1) {
      spawnChildrenAlong(stepData, effLen, levelIdx + 1);
    }
  }

  // Trunks — refCurve-based, matches main.js buildTree
  const trunkCount = Math.max(1, P.trunkCount | 0);
  const trunkSpread = P.trunkSplitSpread ?? 0.45;
  const trunkSplitHeight = Math.max(0, Math.min(0.95, P.trunkSplitHeight ?? 0));
  const useDelayedSplit = trunkCount > 1 && trunkSplitHeight > 0;
  let tk0ForkNode = null;
  let tk0NoisePhase = 0;
  const trunkSegLen = P.trunkHeight / P.trunkSteps;
  const lean = P.trunkLean ?? 0;
  const leanDirRad = ((P.trunkLeanDir ?? 0) * Math.PI) / 180;
  const leanAxisX = Math.cos(leanDirRad);
  const leanAxisZ = Math.sin(leanDirRad);
  const bow = P.trunkBow ?? 0;
  for (let tk = 0; tk < trunkCount; tk++) {
    const tpos = new THREE.Vector3();
    const tdir = new THREE.Vector3(0, 1, 0);
    let tkAz = 0, tkOutward = 0;
    if (trunkCount > 1) {
      const az = (tk / trunkCount) * Math.PI * 2 + random() * 0.4;
      tkAz = az; tkOutward = trunkSpread;
      if (!useDelayedSplit) {
        tdir.set(Math.cos(az) * trunkSpread, 1, Math.sin(az) * trunkSpread).normalize();
        tpos.set(Math.cos(az) * 0.25 * trunkSpread, 0, Math.sin(az) * 0.25 * trunkSpread);
      }
    }
    if (lean > 0) {
      const s = Math.sin(lean), c = Math.cos(lean);
      tdir.set(tdir.x * c + leanAxisX * s, tdir.y * c, tdir.z * c + leanAxisZ * s).normalize();
    }
    let tcur = root;
    const trunkSteps = [];
    const trunkTwist = P.trunkTwist ?? 0;
    const tRng = _w_localRng((state.seed | 0), 0xA1A1, tk);
    let trunkNoisePhase;
    if (useDelayedSplit) {
      if (tk === 0) tk0NoisePhase = tRng() * 1000;
      trunkNoisePhase = tk0NoisePhase;
    } else {
      trunkNoisePhase = tRng() * 1000;
    }
    const startDirX = tdir.x, startDirY = tdir.y, startDirZ = tdir.z;
    const startPosX = tpos.x, startPosY = tpos.y, startPosZ = tpos.z;
    const jAmp = P.trunkJitter * 6.5;
    const multiRestoreCap = (trunkCount > 1 && !useDelayedSplit) ? 0.4 : 0;

    // Canonical reference trunk curve at fixed resolution — branch spawn
    // positions (below) come from here so trunkSteps only affects visible
    // tessellation, not branch anchoring.
    const REF_TRUNK_STEPS = 64;
    const refSteps = [];
    {
      const refSegLen = P.trunkHeight / REF_TRUNK_STEPS;
      const refPos = new THREE.Vector3(startPosX, startPosY, startPosZ);
      const refDir = new THREE.Vector3(startDirX, startDirY, startDirZ);
      const sinAmt  = (P.trunkSinuous ?? 0);
      const sinFreq = (P.trunkSinuousFreq ?? 1.0);
      for (let i = 0; i < REF_TRUNK_STEPS; i++) {
        const tN = (i + 0.5) / REF_TRUNK_STEPS;
        let nX = _smoothNoise1D(trunkNoisePhase + tN * 3.2) * jAmp
               + _smoothNoise1D(trunkNoisePhase + tN * 9.7 + 11.1) * jAmp * 0.3;
        let nZ = _smoothNoise1D(trunkNoisePhase + tN * 3.2 + 17.3) * jAmp
               + _smoothNoise1D(trunkNoisePhase + tN * 9.7 + 29.4) * jAmp * 0.3;
        const nY = _smoothNoise1D(trunkNoisePhase + tN * 2.4 + 51.7) * 0.12;
        if (sinAmt > 0) {
          nX += _smoothNoise1D(trunkNoisePhase * 0.13 + tN * sinFreq) * sinAmt;
          nZ += _smoothNoise1D(trunkNoisePhase * 0.13 + tN * sinFreq + 73.1) * sinAmt;
        }
        let dx = startDirX + nX;
        let dy = startDirY + nY;
        let dz = startDirZ + nZ;
        if (multiRestoreCap > 0) dy += Math.min(1, tN / 0.6) * multiRestoreCap;
        if (useDelayedSplit && tN > trunkSplitHeight) {
          const span = Math.max(0.05, 1 - trunkSplitHeight);
          const f = Math.min(1, (tN - trunkSplitHeight) / span);
          const smooth = f * f * (3 - 2 * f);
          dx += Math.cos(tkAz) * tkOutward * smooth;
          dz += Math.sin(tkAz) * tkOutward * smooth;
        }
        if (bow > 0) {
          const bowIntegral = 1 - Math.cos(tN * Math.PI);
          const bowAmp = bow * 1.3;
          dx += leanAxisX * bowIntegral * bowAmp;
          dz += leanAxisZ * bowIntegral * bowAmp;
        }
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        refDir.set(dx / dl, dy / dl, dz / dl);
        if (trunkTwist !== 0) {
          const tw = trunkTwist * refSegLen;
          const ct = Math.cos(tw), st = Math.sin(tw);
          const nx = refDir.x * ct - refDir.z * st;
          const nz = refDir.x * st + refDir.z * ct;
          refDir.x = nx; refDir.z = nz;
        }
        refPos.addScaledVector(refDir, refSegLen);
        refSteps.push({ pos: refPos.clone(), dir: refDir.clone(), tN });
      }
    }

    // Build user-resolution skeleton by sampling the reference curve.
    const lerpDir = new THREE.Vector3();
    if (useDelayedSplit && tk > 0 && tk0ForkNode) tcur = tk0ForkNode;
    for (let i = 0; i < P.trunkSteps; i++) {
      const tN = (i + 0.5) / P.trunkSteps;
      if (useDelayedSplit && tk > 0 && tN < trunkSplitHeight) continue;
      const refIdxF = tN * REF_TRUNK_STEPS - 0.5;
      const ri0 = Math.max(0, Math.floor(refIdxF));
      const ri1 = Math.min(REF_TRUNK_STEPS - 1, ri0 + 1);
      const u = Math.max(0, Math.min(1, refIdxF - ri0));
      const nPos = refSteps[ri0].pos.clone().lerp(refSteps[ri1].pos, u);
      lerpDir.copy(refSteps[ri0].dir).lerp(refSteps[ri1].dir, u);
      if (lerpDir.lengthSq() < 1e-10) lerpDir.copy(refSteps[ri0].dir);
      lerpDir.normalize();
      const n = new _TNode(nPos, tcur);
      n.branchT = (i + 1) / P.trunkSteps;
      n.isTrunk = true;
      tcur.children.push(n);
      nodes.push(n);
      tcur = n;
      tpos.copy(nPos);
      tdir.copy(lerpDir);
      trunkSteps.push({ node: n, pos: n.pos, dir: lerpDir.clone() });
    }
    if (useDelayedSplit && tk === 0 && trunkSteps.length > 0) {
      let bestIdx = 0, bestDiff = Infinity;
      for (let s = 0; s < trunkSteps.length; s++) {
        const stN = (s + 0.5) / P.trunkSteps;
        const diff = Math.abs(stN - trunkSplitHeight);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = s; }
      }
      tk0ForkNode = trunkSteps[bestIdx].node;
    }
    {
      const apexLen = trunkSegLen * 1.2;
      const apexPos1 = tpos.clone().addScaledVector(tdir, apexLen);
      const apex1 = new _TNode(apexPos1, tcur);
      apex1.branchT = 1; apex1.isTrunk = true;
      tcur.children.push(apex1); nodes.push(apex1);
      const apexPos2 = apexPos1.clone().addScaledVector(tdir, apexLen * 0.7);
      const apex2 = new _TNode(apexPos2, apex1);
      apex2.branchT = 1; apex2.isTrunk = true;
      apex1.children.push(apex2); nodes.push(apex2);
    }
    const branchBaseLen = 9.0 * (P.globalScale ?? 1);
    if (P.levels.length > 0) spawnChildrenAlong(trunkSteps, branchBaseLen, 0, true, refSteps);
  }

  // Pruning
  if (P.pruneMode === 'ellipsoid') {
    const rxz = P.pruneRadius, ry = P.pruneHeight, cy = P.pruneCenterY;
    const inside = (n) => {
      const dx = n.pos.x, dy = n.pos.y - cy, dz = n.pos.z;
      return (dx * dx + dz * dz) / (rxz * rxz) + (dy * dy) / (ry * ry) <= 1;
    };
    const markPruned = (n) => {
      n.pruned = true;
      for (let i = 0; i < n.children.length; i++) markPruned(n.children[i]);
    };
    const prune = (n) => {
      for (let i = n.children.length - 1; i >= 0; i--) {
        const c = n.children[i];
        // ALWAYS preserve trunk nodes — see main.js for the bug history.
        if (c.isTrunk) { prune(c); continue; }
        if (c.pos.y < cy - ry) { prune(c); continue; }
        if (!inside(c)) {
          markPruned(c);
          n.children.splice(i, 1);
        } else {
          prune(c);
        }
      }
    };
    prune(root);
  }

  // Weber-Penn parametric radii (top-down). See main.js computeRadius for
  // model description — trunk tapers baseRadius→tipRadius along height, each
  // branch base = parent-local radius × level radiusRatio, tapering to tipR.
  const baseR = (P.baseRadius ?? 0.35) * ((P.trunkHeight ?? 10) / 10);
  const tipR = P.tipRadius;
  const taperExp = P.taperExp ?? 1.6;
  root.radius = baseR;
  root.chainBaseR = baseR;
  for (const n of nodes) {
    if (n === root) continue;
    const parent = n.parent;
    if (n.chainRoot) {
      const parentR = parent ? (parent.radius || tipR) : baseR;
      const L = P.levels[n.branchLevel ?? 0];
      const ratio = (L && L.radiusRatio != null) ? L.radiusRatio : 0.6;
      n.chainBaseR = Math.max(tipR, parentR * ratio);
      n.radius = n.chainBaseR;
    } else {
      const chainBase = (parent && parent.chainBaseR != null) ? parent.chainBaseR : baseR;
      const t = Math.max(0, Math.min(1, n.branchT ?? 1));
      const k = Math.pow(1 - t, taperExp);
      n.radius = tipR + (chainBase - tipR) * k;
      n.chainBaseR = chainBase;
    }
  }

  // Global branch-thickness multiplier (mirror of main.js).
  const bT = P.branchThickness ?? 1;
  if (Math.abs(bT - 1) > 1e-4) {
    for (const n of nodes) n.radius *= bT;
  }

  // Per-level taper — mirrors main.js buildTree. Reshapes branch radius
  // profile after the allometric pipe-model pass. taper < 1 = bulgy
  // middle, 1 ≤ taper ≤ 2 = sharper cone toward tip, > 2 = periodic
  // oscillation. Uses branchT + branchLevel tagged in walkInternode.
  for (const n of nodes) {
    if (n.branchT === undefined || n.branchLevel === undefined) continue;
    const L = P.levels[n.branchLevel];
    if (!L) continue;
    const taper = L.taper ?? 1;
    if (Math.abs(taper - 1) < 0.01) continue;
    const t = n.branchT;
    let profile;
    if (taper < 1) {
      profile = 1 - taper * t * t;
    } else if (taper <= 2) {
      profile = Math.pow(Math.max(0, 1 - t), taper);
    } else {
      const period = (taper - 2) * 1.5;
      profile = Math.max(0.1, 0.5 + 0.5 * Math.cos(t * Math.PI * 2 * period));
    }
    const linear = Math.max(0.05, 1 - t);
    const ratio = profile / linear;
    n.radius *= Math.max(0.3, Math.min(2.5, ratio));
  }

  // Root flare + maxY in one pass. Smoothstep bell over ~3.8 m so the trunk
  // bells out gradually instead of mushrooming pointy at the base. Mirror
  // of main.js — keep in sync.
  let maxY = 0;
  const rootFlare = P.rootFlare;
  const flareH = 3.8;
  // Mirror of main.js FLARE_BIAS — softens the buttress so default 1.0
  // doesn't double trunk base radius.
  const FLARE_BIAS = 0.5;
  for (const n of nodes) {
    const y = n.pos.y;
    if (y < flareH) {
      const u = 1 - y / flareH;
      const eased = u * u * (3 - 2 * u);
      n.radius *= 1 + rootFlare * eased * FLARE_BIAS;
    }
    if (y > maxY) maxY = y;
  }
  const invMax = maxY > 0 ? 1 / maxY : 0;
  const trunkScaleAmt = P.trunkScale - 1;
  if (trunkScaleAmt !== 0) {
    for (const n of nodes) {
      const tY = n.pos.y * invMax;
      const tClamp = tY < 0 ? 0 : (tY > 1 ? 1 : tY);
      n.radius *= 1 + trunkScaleAmt * (1 - tClamp);
    }
  }

  // Gravity sag — mirror of main.js _applyGravitySag. Keep in sync.
  // Skipped during slider scrubs (main thread sets _scrubSkipSag in payload).
  if (!P._scrubSkipSag) _applyGravitySagW(root, nodes, P);

  // Branch wobble — mirror of main.js _applyBranchWobble. Skeleton-level
  // perturbation; branches inherit by anchoring to the wobbled nodes.
  _applyBranchWobbleW(root, nodes, P);

  // Assign idx and return
  for (let i = 0; i < nodes.length; i++) nodes[i].idx = i;
  return { nodes, root };
}

function _applyBranchWobbleW(root, nodes, P) {
  const globalAmt  = P.branchWobble ?? 0;
  const globalFreq = P.branchWobbleFreq ?? 2.0;
  let anyLevelOverride = false;
  if (Array.isArray(P.levels)) {
    for (const L of P.levels) if (L && (L.wobble ?? 0) > 0) { anyLevelOverride = true; break; }
  }
  if (!(globalAmt > 0) && !anyLevelOverride) return;
  const N = nodes.length;
  if (N < 2) return;
  const oX = new Float32Array(N), oY = new Float32Array(N), oZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const n = nodes[i]; n.idx = i;
    oX[i] = n.pos.x; oY[i] = n.pos.y; oZ[i] = n.pos.z;
  }
  // Pass 1 — non-chainRoot nodes wobble independently.
  for (let i = 0; i < N; i++) {
    const n = nodes[i];
    const p = n.parent;
    if (!p || n.chainRoot) continue;
    const lvl = n.branchLevel;
    const Lvl = (lvl !== undefined && P.levels[lvl]) ? P.levels[lvl] : null;
    const lvlAmt  = Lvl && (Lvl.wobble     ?? 0) > 0 ? Lvl.wobble     : globalAmt;
    const lvlFreq = Lvl && (Lvl.wobbleFreq ?? 0) > 0 ? Lvl.wobbleFreq : globalFreq;
    if (!(lvlAmt > 0)) continue;
    const pi = p.idx;
    const ex = oX[i] - oX[pi];
    const ey = oY[i] - oY[pi];
    const ez = oZ[i] - oZ[pi];
    const eL = Math.hypot(ex, ey, ez);
    if (eL < 1e-6) continue;
    const tx = ex / eL, ty = ey / eL, tz = ez / eL;
    let upX = 0, upY = 1, upZ = 0;
    if (ty > 0.97 || ty < -0.97) { upX = 1; upY = 0; upZ = 0; }
    const dotUp = tx * upX + ty * upY + tz * upZ;
    let ax = upX - tx * dotUp;
    let ay = upY - ty * dotUp;
    let az = upZ - tz * dotUp;
    const am = Math.hypot(ax, ay, az) || 1;
    ax /= am; ay /= am; az /= am;
    const bx = ty * az - tz * ay;
    const by = tz * ax - tx * az;
    const bz = tx * ay - ty * ax;
    const fSc = lvlFreq * 0.3;
    const wxN = oX[i] * fSc, wyN = oY[i] * fSc, wzN = oZ[i] * fSc;
    const n1 = _fbm3D(wxN,        wyN,        wzN       ) * 2 - 1;
    const n2 = _fbm3D(wxN + 47.3, wyN + 13.7, wzN + 91.1) * 2 - 1;
    const lvlIdx = (lvl ?? 0);
    const depthScale = 0.6 + lvlIdx * 0.35;
    const wMul = lvlAmt * depthScale * 0.12;
    n.pos.x += (ax * n1 + bx * n2) * wMul;
    n.pos.y += (ay * n1 + by * n2) * wMul;
    n.pos.z += (az * n1 + bz * n2) * wMul;
  }
  // Pass 2 — chainRoot nodes inherit parent's offset (mirror of main.js).
  for (let i = 0; i < N; i++) {
    const n = nodes[i];
    if (!n.chainRoot || !n.parent) continue;
    const pi = n.parent.idx;
    n.pos.x = oX[i] + (n.parent.pos.x - oX[pi]);
    n.pos.y = oY[i] + (n.parent.pos.y - oY[pi]);
    n.pos.z = oZ[i] + (n.parent.pos.z - oZ[pi]);
  }
}

function _applyGravitySagW(root, nodes, P) {
  const gravity = P.gravityStrength ?? 0;
  if (!(gravity > 0)) return;
  const stiffness = Math.max(0, P.gravityStiffness ?? 0.5);
  const N = nodes.length;
  if (N < 2) return;
  const oX = new Float32Array(N), oY = new Float32Array(N), oZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const n = nodes[i]; n.idx = i;
    oX[i] = n.pos.x; oY[i] = n.pos.y; oZ[i] = n.pos.z;
  }
  const sagW = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const n = nodes[i], p = n.parent;
    if (!p) continue;
    const pi = p.idx;
    const dx = oX[i] - oX[pi], dy = oY[i] - oY[pi], dz = oZ[i] - oZ[pi];
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const r = n.radius || 0.01;
    sagW[i] = len * r * r;
  }
  for (let i = N - 1; i >= 0; i--) {
    const p = nodes[i].parent;
    if (p) sagW[p.idx] += sagW[i];
  }
  const qX = new Float32Array(N), qY = new Float32Array(N);
  const qZ = new Float32Array(N), qW = new Float32Array(N);
  qW[root.idx] = 1;
  for (let i = 0; i < N; i++) {
    const n = nodes[i], p = n.parent;
    if (!p) continue;
    const pi = p.idx;
    let rx = oX[i] - oX[pi], ry = oY[i] - oY[pi], rz = oZ[i] - oZ[pi];
    const pqx = qX[pi], pqy = qY[pi], pqz = qZ[pi], pqw = qW[pi];
    const tx = 2 * (pqy * rz - pqz * ry);
    const ty = 2 * (pqz * rx - pqx * rz);
    const tz = 2 * (pqx * ry - pqy * rx);
    const newRx = rx + pqw * tx + (pqy * tz - pqz * ty);
    const newRy = ry + pqw * ty + (pqz * tx - pqx * tz);
    const newRz = rz + pqw * tz + (pqx * ty - pqy * tx);
    n.pos.set(p.pos.x + newRx, p.pos.y + newRy, p.pos.z + newRz);
    const tlen = Math.sqrt(newRx*newRx + newRy*newRy + newRz*newRz);
    let lqx = 0, lqy = 0, lqz = 0, lqw = 1;
    if (tlen > 1e-6) {
      const tnx = newRx / tlen, tnz = newRz / tlen;
      const aLen = Math.sqrt(tnx*tnx + tnz*tnz);
      if (aLen > 1e-5) {
        const r = n.radius || 0.01;
        const stiff = stiffness * (r / 0.04);
        let theta = aLen * Math.sqrt(sagW[i]) * gravity * 0.015 / (1 + stiff * 4);
        if (theta > 0.5) theta = 0.5;
        const half = theta * 0.5;
        const s = Math.sin(half), c = Math.cos(half), inv = 1 / aLen;
        lqx = tnz * inv * s;
        lqz = -tnx * inv * s;
        lqw = c;
      }
    }
    qX[i] = lqw * pqx + pqw * lqx + (lqy * pqz - lqz * pqy);
    qY[i] = lqw * pqy + pqw * lqy + (lqz * pqx - lqx * pqz);
    qZ[i] = lqw * pqz + pqw * lqz + (lqx * pqy - lqy * pqx);
    qW[i] = lqw * pqw - (lqx * pqx + lqy * pqy + lqz * pqz);
  }
}

function buildChainsWorker(root) {
  // Matches main.js buildChains — the trunk is one unbroken continuation
  // spline; chainRoot branches start their own independent chains.
  const chains = [];
  const stack = [root];
  while (stack.length) {
    const start = stack.pop();
    if (start.pruned) continue;
    const chain = [start];
    let cur = start;
    while (cur.children.length > 0) {
      let contChild = null;
      for (const c of cur.children) {
        if (c.pruned) continue;
        if (c.chainRoot) stack.push(c);
        else if (!contChild) contChild = c;
        else stack.push(c);
      }
      if (!contChild) break;
      chain.push(contChild);
      cur = contChild;
    }
    if (chain.length >= 2) chains.push(chain);
  }
  return chains;
}

// --- Tube builder (identical shape to main.js tubeFromChain) -------------
const _tubeCenter = new THREE.Vector3();

// Outward vertex normals via central differences on the written position grid.
// Replaces geo.computeVertexNormals() — one linear pass, no index walk, no
// triangle-face averaging. Matches computeVertexNormals numerically on smooth
// surfaces and carries the bump shading of displaced bark. Wraps the seam at
// k=0..radial so both seam copies share one normal.
function _tubeAnalyticNormals(posArr, normArr, tubular, radial) {
  const radial1 = radial + 1;
  const stride = radial1 * 3;
  for (let u = 0; u <= tubular; u++) {
    const uP = u > 0 ? u - 1 : u;
    const uN = u < tubular ? u + 1 : u;
    const rowP = uP * stride;
    const rowN = uN * stride;
    const row  = u * stride;
    for (let k = 0; k <= radial; k++) {
      const kk = k === radial ? 0 : k;
      const kN = (kk + 1) % radial;
      const kP = (kk - 1 + radial) % radial;
      const ip3 = row + kP * 3;
      const in3 = row + kN * 3;
      const jp3 = rowP + kk * 3;
      const jn3 = rowN + kk * 3;
      const dux = posArr[jn3    ] - posArr[jp3    ];
      const duy = posArr[jn3 + 1] - posArr[jp3 + 1];
      const duz = posArr[jn3 + 2] - posArr[jp3 + 2];
      const dvx = posArr[in3    ] - posArr[ip3    ];
      const dvy = posArr[in3 + 1] - posArr[ip3 + 1];
      const dvz = posArr[in3 + 2] - posArr[ip3 + 2];
      let nx = duy * dvz - duz * dvy;
      let ny = duz * dvx - dux * dvz;
      let nz = dux * dvy - duy * dvx;
      const m = Math.hypot(nx, ny, nz);
      if (m > 1e-8) { const inv = 1 / m; nx *= inv; ny *= inv; nz *= inv; }
      else { nx = 0; ny = 1; nz = 0; }
      const o = row + k * 3;
      normArr[o    ] = nx;
      normArr[o + 1] = ny;
      normArr[o + 2] = nz;
    }
  }
}

// ez-tree-inspired imperative tube extruder. Replaces CatmullRomCurve3 +
// TubeGeometry on every chain — each accounted for ~30-40% of worker time on
// a heavy tree, multiplied across ~5000 chains.
//
// What's the same: vertex layout (tubular+1 rings × radial+1 ring verts each,
// last column duplicated for UV continuity), nodeA/B/W skeleton mapping,
// radialRest, post-pass displacement / buttress / reaction wood, analytic
// normals.
//
// What's different: chain is treated as a polyline (no Catmull-Rom curve).
// Ring centers come from linear-lerp between consecutive chain points, with
// K subdivisions per segment to preserve current quality on the radius
// spline. Frames are parallel-transported across rings — initial frame
// matches three.js's computeFrenetFrames recipe (world axis with smallest
// tangent component → cross to get a perpendicular vector → cross with
// tangent for normal). Subsequent frames rotate prev normal about
// (prev_t × cur_t) by the angle between tangents (Rodrigues).
//
// Returns same shape as old buildTube: { position, normal, uv, index,
// radialRest, nodeA, nodeB, nodeW, vertCount }.
function _buildRingFrames(pts, tubular, framesOut) {
  // pts: array of THREE.Vector3 chain centers (deduped).
  // tubular: number of segments along tube → tubular+1 rings.
  // Writes ring center + tangent + normal + binormal + radius-lerp-pair into framesOut SoA.
  const tub1 = tubular + 1;
  const lastSeg = pts.length - 1;
  const invTubular = 1 / tubular;
  const cx = framesOut.cx, cy = framesOut.cy, cz = framesOut.cz;
  const tx = framesOut.tx, ty = framesOut.ty, tz = framesOut.tz;
  const nx = framesOut.nx, ny = framesOut.ny, nz = framesOut.nz;
  const bx = framesOut.bx, by = framesOut.by, bz = framesOut.bz;
  const segIdx = framesOut.segIdx, segU = framesOut.segU;

  // 1) Ring centers via linear lerp between consecutive chain points.
  for (let i = 0; i <= tubular; i++) {
    const t = i * invTubular;
    const fp = t * lastSeg;
    let i0 = Math.floor(fp);
    if (i0 >= lastSeg) i0 = lastSeg - 1;
    if (i0 < 0) i0 = 0;
    const i1 = i0 + 1;
    const u = fp - i0;
    segIdx[i] = i0;
    segU[i] = u;
    const a = pts[i0], b = pts[i1];
    cx[i] = a.x * (1 - u) + b.x * u;
    cy[i] = a.y * (1 - u) + b.y * u;
    cz[i] = a.z * (1 - u) + b.z * u;
  }

  // 2) Tangents via central differences. Forward at start, backward at end.
  for (let i = 0; i <= tubular; i++) {
    const i0 = i === 0 ? 0 : i - 1;
    const i1 = i === tubular ? tubular : i + 1;
    let dx = cx[i1] - cx[i0];
    let dy = cy[i1] - cy[i0];
    let dz = cz[i1] - cz[i0];
    const m = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (m > 1e-9) { dx /= m; dy /= m; dz /= m; }
    else { dx = 0; dy = 1; dz = 0; }
    tx[i] = dx; ty[i] = dy; tz[i] = dz;
  }

  // 3) Initial frame — matches three.js's computeFrenetFrames recipe so any
  // visual identity check against TubeGeometry holds. Pick world axis with
  // the SMALLEST absolute tangent component as our reference normal axis;
  // cross with tangent gives a vector perpendicular to both (call it `vec`);
  // cross tangent with vec gives our normal0.
  {
    const t0x = tx[0], t0y = ty[0], t0z = tz[0];
    const ax = Math.abs(t0x), ay = Math.abs(t0y), az = Math.abs(t0z);
    let axisX, axisY, axisZ;
    if (ax <= ay && ax <= az)      { axisX = 1; axisY = 0; axisZ = 0; }
    else if (ay <= az)             { axisX = 0; axisY = 1; axisZ = 0; }
    else                           { axisX = 0; axisY = 0; axisZ = 1; }
    // vec = normalize(tangent × axis)
    let vx = t0y * axisZ - t0z * axisY;
    let vy = t0z * axisX - t0x * axisZ;
    let vz = t0x * axisY - t0y * axisX;
    let m = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (m > 1e-9) { vx /= m; vy /= m; vz /= m; }
    // normal = tangent × vec
    nx[0] = t0y * vz - t0z * vy;
    ny[0] = t0z * vx - t0x * vz;
    nz[0] = t0x * vy - t0y * vx;
    // binormal = tangent × normal
    bx[0] = t0y * nz[0] - t0z * ny[0];
    by[0] = t0z * nx[0] - t0x * nz[0];
    bz[0] = t0x * ny[0] - t0y * nx[0];
  }

  // 4) Parallel-transport: rotate previous normal about (prevT × curT) by the
  // angle between tangents. Recompute binormal as cross(curT, normal). Same
  // numerical recipe as three.js Curve.computeFrenetFrames.
  for (let i = 1; i <= tubular; i++) {
    const ptx = tx[i - 1], pty = ty[i - 1], ptz = tz[i - 1];
    const ctx = tx[i],     cty = ty[i],     ctz = tz[i];
    let axX = pty * ctz - ptz * cty;
    let axY = ptz * ctx - ptx * ctz;
    let axZ = ptx * cty - pty * ctx;
    const axM = Math.sqrt(axX * axX + axY * axY + axZ * axZ);
    let pnx = nx[i - 1], pny = ny[i - 1], pnz = nz[i - 1];
    if (axM > 1e-7) {
      const inv = 1 / axM;
      axX *= inv; axY *= inv; axZ *= inv;
      let dot = ptx * ctx + pty * cty + ptz * ctz;
      if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
      const angle = Math.acos(dot);
      const ca = Math.cos(angle), sa = Math.sin(angle);
      // Rodrigues: v_rot = v cosθ + (k × v) sinθ + k(k·v)(1 − cosθ)
      const dotKN = axX * pnx + axY * pny + axZ * pnz;
      const oneMinusCa = 1 - ca;
      const rnx = pnx * ca + (axY * pnz - axZ * pny) * sa + axX * dotKN * oneMinusCa;
      const rny = pny * ca + (axZ * pnx - axX * pnz) * sa + axY * dotKN * oneMinusCa;
      const rnz = pnz * ca + (axX * pny - axY * pnx) * sa + axZ * dotKN * oneMinusCa;
      pnx = rnx; pny = rny; pnz = rnz;
    }
    nx[i] = pnx; ny[i] = pny; nz[i] = pnz;
    bx[i] = cty * pnz - ctz * pny;
    by[i] = ctz * pnx - ctx * pnz;
    bz[i] = ctx * pny - cty * pnx;
  }
}

function buildTube(chainNodes, profile, taper, isScrubbing, displace, isBranch, parentRadius) {
  // Guard: chain needs ≥2 distinct points (for tangent + frame computation).
  if (!chainNodes || chainNodes.length < 2) return null;
  const pts = [new THREE.Vector3(chainNodes[0].x, chainNodes[0].y, chainNodes[0].z)];
  const kept = [0];
  const EPS2 = 1e-12;
  for (let i = 1; i < chainNodes.length; i++) {
    const a = pts[pts.length - 1];
    const n = chainNodes[i];
    const dx = n.x - a.x, dy = n.y - a.y, dz = n.z - a.z;
    if (dx*dx + dy*dy + dz*dz > EPS2) {
      pts.push(new THREE.Vector3(n.x, n.y, n.z));
      kept.push(i);
    }
  }
  if (pts.length < 2) return null;
  const r0 = chainNodes[kept[0]].radius;
  // Flare collar only — backward pad removed (per-node radius sampling +
  // cap-and-scale handle the join width match, and the pad was poking
  // through the far side of thin parents).
  const parentRad = isBranch && typeof parentRadius === 'number' ? parentRadius : 0;
  const flareRatio = (isBranch && parentRad > r0 * 1.05)
    ? Math.min(6, parentRad / Math.max(0.004, r0))
    : 1;
  const flareEnd = 0.22;
  // Strict clamp — must match main.js tubeFromChain. Below 4 tubular per
  // step the Frenet frames flip on tight curves; below 8 radial sides the
  // trunk reads as a faceted polygon.
  const tubularPerStep = Math.max(4, Math.min(10, (displace && displace.tubularDensity) || 6));
  const fullTub = Math.min(768, Math.max(12, (pts.length - 1) * tubularPerStep));
  const baseRad = Math.max(8, Math.min(24, (displace && displace.radialSegs) || 16));
  const fullRad = r0 > 0.3 ? baseRad : Math.max(4, baseRad >> 1);
  // Trunk chains skip the scrub downsize — the user dragging mesh-detail
  // sliders needs to see the actual result, not a quartered preview. Mirror
  // of main.js. `isBranch` is passed in from the caller; `!isBranch` = trunk.
  const _isTrunk = !isBranch;
  const tubular = (isScrubbing && !_isTrunk) ? Math.max(4, Math.floor(fullTub * 0.28)) : fullTub;
  const radial  = (isScrubbing && !_isTrunk) ? Math.max(4, Math.floor(fullRad * 0.5))  : fullRad;

  // Allocate ring-frame SoA + write rings + parallel-transport frames.
  const tub1 = tubular + 1;
  const radial1 = radial + 1;
  const numVerts = tub1 * radial1;
  const _ringFrames = {
    cx: new Float32Array(tub1), cy: new Float32Array(tub1), cz: new Float32Array(tub1),
    tx: new Float32Array(tub1), ty: new Float32Array(tub1), tz: new Float32Array(tub1),
    nx: new Float32Array(tub1), ny: new Float32Array(tub1), nz: new Float32Array(tub1),
    bx: new Float32Array(tub1), by: new Float32Array(tub1), bz: new Float32Array(tub1),
    segIdx: new Int32Array(tub1), segU: new Float32Array(tub1),
  };
  _buildRingFrames(pts, tubular, _ringFrames);

  // Generate ring vertices into a flat position array. Same convention as
  // three.js TubeGeometry: vertex = center + radius * (-cos(a)*N + sin(a)*B).
  const arr = new Float32Array(numVerts * 3);
  {
    const cxA = _ringFrames.cx, cyA = _ringFrames.cy, czA = _ringFrames.cz;
    const nxA = _ringFrames.nx, nyA = _ringFrames.ny, nzA = _ringFrames.nz;
    const bxA = _ringFrames.bx, byA = _ringFrames.by, bzA = _ringFrames.bz;
    const twoPi = Math.PI * 2;
    for (let i = 0; i <= tubular; i++) {
      const cxi = cxA[i], cyi = cyA[i], czi = czA[i];
      const nxi = nxA[i], nyi = nyA[i], nzi = nzA[i];
      const bxi = bxA[i], byi = byA[i], bzi = bzA[i];
      const rowBase = i * radial1 * 3;
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * twoPi;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = -ca * nxi + sa * bxi;
        const dy = -ca * nyi + sa * byi;
        const dz = -ca * nzi + sa * bzi;
        const o = rowBase + j * 3;
        arr[o    ] = cxi + dx * r0;
        arr[o + 1] = cyi + dy * r0;
        arr[o + 2] = czi + dz * r0;
      }
    }
  }

  const profileMul = new Array(radial1);
  const twoPi = Math.PI * 2;
  for (let j = 0; j <= radial; j++) {
    profileMul[j] = profile ? profile.sample((j / radial) * twoPi) : 1;
  }
  const invR0 = 1 / r0;
  const invTubular = 1 / tubular;
  const dispAmt     = (displace && displace.amount) || 0;
  const dispFreq    = (displace && displace.freq)   || 3;
  const dispMode    = (displace && displace.mode)   || 'ridges';
  const ridgeSharp  = (displace && displace.ridgeSharp) || 0;
  const knots       = (displace && displace.knots) || 0;
  const knotScale   = (displace && displace.knotScale) || 2.0;
  const detail      = (displace && displace.detail) || 0;
  const detailFreq  = (displace && displace.detailFreq) || 12.0;
  const vertBias    = (displace && displace.verticalBias != null) ? displace.verticalBias : 0.7;
  const hasDisplace = dispAmt > 1e-4 || knots > 1e-4 || detail > 1e-4;
  // Branch wobble is now applied at SKELETON BUILD TIME (see
  // _applyBranchWobble in buildTreeWorker). Was previously applied here at
  // extrusion time but that disconnected branches from their parents — tube
  // rings shifted, anchored skeleton nodes didn't.
  // Polyline arc length — close enough to Catmull-Rom curve length for the
  // displacement noise's axial coordinate.
  let curveLenForDisp = 0;
  if (hasDisplace) {
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s], b = pts[s + 1];
      curveLenForDisp += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
  }
  // Buttress + reaction wood — trunk-base lobes and horizontal-branch
  // compression-side thickening. Mirrors main.js tubeFromChain so the worker
  // path produces the same shape when these sliders are non-zero.
  const buttressAmt   = (displace && displace.buttressAmount)  || 0;
  const buttressH     = (displace && displace.buttressHeight != null) ? displace.buttressHeight : 1.5;
  const buttressLobes = (displace && displace.buttressLobes)   || 5;
  const reactAmt      = (displace && displace.reactionWood)    || 0;
  // Trunk chains have chainRoot = false (they start at the tree root, not
  // branching off a parent). Buttress only applies to them.
  const isTrunkChain = !isBranch;
  const hasButtress = buttressAmt > 0 && isTrunkChain && buttressH > 0;
  const twoPiAng = Math.PI * 2;
  let chainTilt = 0;
  if (reactAmt > 0 && chainNodes.length >= 2) {
    const aN = chainNodes[0], bN = chainNodes[chainNodes.length - 1];
    const dy = bN.y - aN.y;
    const cl = Math.hypot(bN.x - aN.x, dy, bN.z - aN.z) || 1;
    chainTilt = Math.max(0, 1 - Math.abs(dy) / cl);
  }
  const hasReact = reactAmt * chainTilt > 0.01;
  // Precompute taper samples once per row; inner loop reads from the array.
  // Radius Curve is trunk-only — branches skip the spline so the user-drawn
  // trunk profile doesn't reshape every limb in the tree.
  const taperRow = new Float32Array(tubular + 1);
  if (taper && !isBranch) {
    for (let i = 0; i <= tubular; i++) taperRow[i] = taper.sample(i * invTubular);
  } else {
    taperRow.fill(1);
  }
  // Per-chain-node radius sampling (matches main.js): tube tapers through
  // each node's individual allometric radius so branch bases match parents.
  const chainRadii = chainNodes.map((n) => Math.max(1e-4, n.radius || r0));
  // Cap branch base at 80 % of parent's local radius, then scale the whole
  // branch down proportionally — prevents "branch fatter than parent" poke.
  if (isBranch && parentRad > 0) {
    const cap = parentRad * 0.8;
    if (chainRadii[0] > cap) {
      const s = cap / chainRadii[0];
      for (let k = 0; k < chainRadii.length; k++) chainRadii[k] *= s;
    }
  }
  const lastChainIdx = chainNodes.length - 1;
  for (let i = 0; i <= tubular; i++) {
    const t = i * invTubular;
    const cfp = t * lastChainIdx;
    const cI0 = Math.max(0, Math.min(lastChainIdx, Math.floor(cfp)));
    const cI1 = Math.min(lastChainIdx, cI0 + 1);
    const cU = cfp - cI0;
    const localR = chainRadii[cI0] * (1 - cU) + chainRadii[cI1] * cU;
    const baseScl = localR * invR0;
    const splMul = taperRow[i];
    // Ring center already computed in _buildRingFrames.
    const cx = _ringFrames.cx[i], cy = _ringFrames.cy[i], cz = _ringFrames.cz[i];
    const rowBase = i * radial1 * 3;
    let flareMul = 1;
    if (flareRatio > 1 && t < flareEnd) {
      const k = t / flareEnd;
      const s = k * k * (3 - 2 * k);
      flareMul = flareRatio * (1 - s) + 1 * s;
    }
    // Per-slice buttress height envelope — lobes fall off linearly with Y.
    const buttressH_here = hasButtress && cy < buttressH ? Math.max(0, 1 - cy / buttressH) : 0;
    for (let j = 0; j <= radial; j++) {
      const o = rowBase + j * 3;
      let scl = baseScl * splMul * profileMul[j] * flareMul;
      if (hasDisplace) {
        // See main.js for rationale — world-space 3D sampling; axial is a
        // uniform scalar offset so pattern flows along branch regardless
        // of orientation.
        const rx = arr[o] - cx;
        const ry = arr[o + 1] - cy;
        const rz = arr[o + 2] - cz;
        const rInv = 1 / (Math.hypot(rx, ry, rz) || 1);
        const rux = rx * rInv, ruy = ry * rInv, ruz = rz * rInv;
        const sAxial = t * curveLenForDisp;
        const fAx = dispFreq;
        const fRad = dispFreq * Math.PI;
        const axOff = sAxial * fAx * 0.35;
        let d = 0;
        if (dispAmt > 1e-4) {
          // Compute ONLY the noise channels each mode actually consumes —
          // 'ridges' (default) uses nVert+nBlob, 'blobby' uses nBlob,
          // 'cellular' uses nCell, 'mixed' uses all three. Was always
          // computing all three per vertex (one wasted worley call in the
          // hot path on every default-mode bark vertex).
          let nMix = 0;
          if (dispMode === 'cellular') {
            const wN = _worley3D(rux * fRad * 0.8 + axOff, ruy * fRad * 0.8 + axOff, ruz * fRad * 0.8 + axOff);
            nMix = 1 - Math.min(1, wN * 1.6);
          } else {
            const sharpen = (x) => {
              if (ridgeSharp < 1e-3) return x;
              const s = Math.min(1, ridgeSharp);
              const r = 1 - Math.abs(x);
              return (1 - s) * x + s * (r * 2 - 1);
            };
            const nBlob = _fbm3D(rux * fRad + axOff, ruy * fRad + axOff, ruz * fRad + axOff);
            if (dispMode === 'blobby') {
              nMix = sharpen(nBlob);
            } else if (dispMode === 'mixed') {
              const axV = sAxial * fAx * 0.12;
              const nVert = _fbm3D(rux * fRad * 2.2 + axV, ruy * fRad * 2.2 + axV, ruz * fRad * 2.2 + axV);
              const wN = _worley3D(rux * fRad * 0.8 + axOff, ruy * fRad * 0.8 + axOff, ruz * fRad * 0.8 + axOff);
              const nCell = 1 - Math.min(1, wN * 1.6);
              const nR = (1 - vertBias) * nBlob + vertBias * nVert;
              nMix = sharpen(nR) * 0.55 + nCell * 0.45;
            } else {
              // 'ridges' default
              const axV = sAxial * fAx * 0.12;
              const nVert = _fbm3D(rux * fRad * 2.2 + axV, ruy * fRad * 2.2 + axV, ruz * fRad * 2.2 + axV);
              const nR = (1 - vertBias) * nBlob + vertBias * nVert;
              nMix = sharpen(nR);
            }
          }
          d += nMix * dispAmt * 0.35;
        }
        if (knots > 1e-4) {
          const kAx = sAxial * knotScale * 0.2;
          const kW = _worley3D(rux * knotScale * 1.4 + kAx, ruy * knotScale * 1.4 + kAx, ruz * knotScale * 1.4 + kAx);
          const knot = Math.max(0, 1 - kW * 2.4);
          d += knot * knot * knots * 0.45;
        }
        if (detail > 1e-4) {
          const dAx = sAxial * detailFreq * 0.3;
          const det = _fbm3D(rux * detailFreq + dAx, ruy * detailFreq + dAx, ruz * detailFreq + dAx);
          d += det * detail * 0.12;
        }
        scl *= 1 + d;
      }
      if (buttressH_here > 0) {
        const ang = (j / radial) * twoPiAng;
        const lobe = Math.max(0, Math.cos(ang * buttressLobes));
        scl *= 1 + buttressAmt * buttressH_here * lobe * lobe;
      }
      if (hasReact) {
        const radialY = arr[o + 1] - cy;
        const under = radialY < 0 ? Math.min(1, -radialY / Math.max(1e-5, r0)) : 0;
        scl *= 1 + reactAmt * chainTilt * under * 0.45;
      }
      arr[o    ] = (arr[o    ] - cx) * scl + cx;
      arr[o + 1] = (arr[o + 1] - cy) * scl + cy;
      arr[o + 2] = (arr[o + 2] - cz) * scl + cz;
    }
  }
  // UVs in world meters on both axes (uv.x along, uv.y around). curveLen
  // approximated as the sum of polyline segment lengths — close enough to
  // the Catmull-Rom arc length for texture spacing.
  const uvArr = new Float32Array(numVerts * 2);
  let polyLen = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s], b = pts[s + 1];
    polyLen += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  {
    const twoPiLoc = Math.PI * 2;
    for (let i = 0; i <= tubular; i++) {
      const ti = i * invTubular;
      const sAlong = ti * polyLen;
      const cfpU = ti * lastChainIdx;
      const uI0 = Math.max(0, Math.min(lastChainIdx, Math.floor(cfpU)));
      const uI1 = Math.min(lastChainIdx, uI0 + 1);
      const uU = cfpU - uI0;
      const rHere = Math.max(0.002, chainRadii[uI0] * (1 - uU) + chainRadii[uI1] * uU);
      const circumHere = twoPiLoc * rHere;
      for (let j = 0; j <= radial; j++) {
        const sAround = (j / radial) * circumHere;
        const idx = (i * radial1 + j) * 2;
        uvArr[idx    ] = sAlong;
        uvArr[idx + 1] = sAround;
      }
    }
  }

  // Per-vertex skeleton mapping + rest radial vector.
  const nodeA = new Int32Array(numVerts);
  const nodeB = new Int32Array(numVerts);
  const nodeW = new Float32Array(numVerts);
  const radialRest = new Float32Array(numVerts * 3);
  const posArrLive = arr;
  const lastSeg = pts.length - 1;
  for (let i = 0; i <= tubular; i++) {
    const cp = (i * invTubular) * lastSeg;
    const a = Math.min(Math.floor(cp), lastSeg);
    const b = Math.min(a + 1, lastSeg);
    const w = cp - a;
    const iw = 1 - w;
    const nAk = chainNodes[kept[a]];
    const nBk = chainNodes[kept[b]];
    const aIdx = nAk.idx, bIdx = nBk.idx;
    const skCx = nAk.x * iw + nBk.x * w;
    const skCy = nAk.y * iw + nBk.y * w;
    const skCz = nAk.z * iw + nBk.z * w;
    const rowBase = i * radial1;
    for (let j = 0; j <= radial; j++) {
      const vi = rowBase + j;
      nodeA[vi] = aIdx;
      nodeB[vi] = bIdx;
      nodeW[vi] = w;
      const o3 = vi * 3;
      radialRest[o3    ] = posArrLive[o3    ] - skCx;
      radialRest[o3 + 1] = posArrLive[o3 + 1] - skCy;
      radialRest[o3 + 2] = posArrLive[o3 + 2] - skCz;
    }
  }

  // Index buffer — two triangles per (i, j) quad. Same winding as TubeGeometry.
  const indexCount = tubular * radial * 6;
  const idxArr = numVerts > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  {
    let p = 0;
    for (let i = 0; i < tubular; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * radial1 + j;
        const b = (i + 1) * radial1 + j;
        const c = (i + 1) * radial1 + (j + 1);
        const d = i * radial1 + (j + 1);
        idxArr[p++] = a; idxArr[p++] = b; idxArr[p++] = d;
        idxArr[p++] = b; idxArr[p++] = c; idxArr[p++] = d;
      }
    }
  }
  // posArr, uvArr, idxArr are already fresh typed arrays we own — no clones.
  const posArr = arr;
  const normArr = new Float32Array(numVerts * 3);
  _tubeAnalyticNormals(posArr, normArr, tubular, radial);

  return {
    position: posArr,
    normal: normArr,
    uv: uvArr,
    index: idxArr,
    radialRest,
    nodeA,
    nodeB,
    nodeW,
    vertCount: numVerts,
  };
}

// --- Message handler -----------------------------------------------------
self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'build-tubes') {
    const { chains, profilePoints, taperPoints, isScrubbing, displace, reqId } = msg.payload;
    const profile = profilePoints ? new ProfileSampler(profilePoints) : null;
    const taper   = taperPoints   ? new SplineSampler(taperPoints)   : null;

    const tubes = [];
    const transferables = [];
    // Per-chain try/catch: a single bad chain (e.g. collapsed/NaN input)
    // MUST NOT abort the whole batch. If it did, the batch's reply never
    // posts, main's Promise hangs forever, and the UI freezes.
    for (const chain of chains) {
      let t = null;
      try {
        t = buildTube(chain.nodes, profile, taper, isScrubbing, displace, chain.chainRoot, chain.parentRadius);
      } catch (err) {
        t = null;
      }
      tubes.push(t);
      if (!t) continue;
      transferables.push(t.position.buffer, t.normal.buffer, t.uv.buffer,
                         t.radialRest.buffer,
                         t.nodeA.buffer, t.nodeB.buffer, t.nodeW.buffer);
      if (t.index) transferables.push(t.index.buffer);
    }
    try {
      self.postMessage({ type: 'tubes-built', payload: { reqId, tubes } }, transferables);
    } catch (err) {
      // Last resort — reply with nulls (no transferables) so main unblocks.
      self.postMessage({ type: 'tubes-built', payload: { reqId, tubes: chains.map(() => null) } });
    }
    return;
  }

  if (msg.type === 'build-tree-and-chains') {
    // Build tree + chains only; do NOT build tubes. Main thread fans tube work
    // out across the worker pool for parallelism. Returns SoA tree state plus
    // per-chain serialized node data (ready for `build-tubes`).
    const { state, reqId } = msg.payload;

    let treeResult;
    try {
      treeResult = buildTreeWorker(state);
    } catch (err) {
      self.postMessage({ type: 'tree-build-error', payload: { reqId, message: err?.message || String(err) } });
      return;
    }
    const nodes = treeResult.nodes;
    const chains = buildChainsWorker(treeResult.root);

    const n = nodes.length;
    const posX = new Float32Array(n);
    const posY = new Float32Array(n);
    const posZ = new Float32Array(n);
    const parentIdx = new Int32Array(n);
    const radius = new Float32Array(n);
    const prunedFlags = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      posX[i] = node.pos.x;
      posY[i] = node.pos.y;
      posZ[i] = node.pos.z;
      parentIdx[i] = node.parent ? node.parent.idx : -1;
      radius[i] = node.radius;
      prunedFlags[i] = node.pruned ? 1 : 0;
    }
    const chainsIdx = chains.map((chain) => {
      const arr = new Int32Array(chain.length);
      for (let i = 0; i < chain.length; i++) arr[i] = chain[i].idx;
      return arr;
    });
    // Serialize chain node data (what buildTube needs). Plain objects are
    // structured-clone friendly and cheap for small chains.
    const chainsSer = chains.map((chain) => {
      const nodesOut = new Array(chain.length);
      for (let i = 0; i < chain.length; i++) {
        const cn = chain[i];
        nodesOut[i] = { x: cn.pos.x, y: cn.pos.y, z: cn.pos.z, radius: cn.radius, idx: cn.idx };
      }
      // Flag lateral-branch chains so buildTube can pad backward for junction
      // overlap. Also pass parent radius so the pad distance can target it.
      const parentR = (chain[0].parent && chain[0].parent.radius) || 0;
      return { nodes: nodesOut, chainRoot: !!chain[0].chainRoot, parentRadius: parentR };
    });
    const transferables = [
      posX.buffer, posY.buffer, posZ.buffer,
      parentIdx.buffer, radius.buffer, prunedFlags.buffer,
    ];
    for (const ci of chainsIdx) transferables.push(ci.buffer);
    self.postMessage({
      type: 'tree-and-chains-built',
      payload: {
        reqId,
        tree: { posX, posY, posZ, parentIdx, radius, prunedFlags, numNodes: n },
        chainsIdx,
        chainsSer,
      },
    }, transferables);
    return;
  }
};

// Signal readiness so the main thread knows the module + three.js loaded OK.
self.postMessage({ type: 'ready' });
