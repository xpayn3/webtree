// gpu-tube.js — EXPERIMENTAL GPU compute path for tube extrusion.
//
// STATUS: untested. Written without a live WebGPU device to iterate against.
// You'll need to run the app, toggle this on (`P.gpuExtrude = true`), and
// expect to debug. Ships gated behind that flag so the default path is
// untouched. If the GPU pass throws, the caller falls back to the CPU
// `buildTube` so the tree still renders.
//
// SCOPE OF THIS SPIKE:
//   ✓ Ring extrusion with parallel-transport frames (positions, UVs)
//   ✓ Per-vertex radius attribute (drives the TSL bark wind sway)
//   ✗ Bark displacement (ridges / blobby / cellular / mixed) — TODO, hook
//     into tsl-noise.js once positions are verified
//   ✗ Buttress lobes — TODO
//   ✗ Reaction-wood underside thickening — TODO
//   ✗ Junction flare collar at branch base — TODO
//   ✗ Skeleton mapping (nodeA / nodeB / nodeW) — handled CPU-side after the
//     GPU pass returns; that math is index lookups, not worth a kernel
//   ✗ Triangle indices — CPU-generated (deterministic grid pattern, no need
//     to round-trip through GPU)
//
// API:
//   await extrudeChainGPU(renderer, chainNodes, opts) → same shape as
//   growth-engine.js buildTube returns: { position, normal, uv, index,
//   radialRest, nodeA, nodeB, nodeW, radius, vertCount }. Drop-in compatible
//   with the existing pool-fill loop in main.js.
//
// PERFORMANCE EXPECTATION:
//   For a single 200-vert chain, GPU dispatch overhead probably exceeds the
//   compute cost — slower than CPU. The win shows up when batching N chains
//   into one kernel + one storage buffer + one dispatch. That batching is
//   future work; this spike does one chain at a time to keep the kernel
//   readable.

import * as THREE from 'three';
import { Fn, instanceIndex, storage, vec3, float, uint, sin, cos, floor, fract } from 'three/tsl';
import { buildRingFrames } from './growth-engine.js?v=r18';

const TWO_PI = Math.PI * 2;

// Storage buffer / pass cache. Same chain count + density → reuse the
// allocated buffers + recompiled compute. Without this, every regen
// reallocates GPU resources and the driver chokes on a few hundred
// allocations per second during a slider drag.
const _passCache = new Map();
function _cacheKey(numChainPoints, tubular, radial) {
  return `${numChainPoints}:${tubular}:${radial}`;
}

// Build (or fetch from cache) the storage buffers + compute pass for a
// tube of (tubular+1) × (radial+1) verts driven by `numChainPoints` chain
// points + per-row ring frames.
//
// THIS IS THE PART MOST LIKELY TO NEED FIXING. The TSL compute API has
// shifted across three.js versions; the function names below are the
// current (r0.18x) shape but you may need to swap `storage` for
// `instancedArray` or add `.toReadOnly()` calls. Watch the console for
// "X is not a function" — that's where to look.
function _getOrBuildPass(numChainPoints, tubular, radial) {
  const key = _cacheKey(numChainPoints, tubular, radial);
  const cached = _passCache.get(key);
  if (cached) return cached;

  const tub1 = tubular + 1;
  const radial1 = radial + 1;
  const numVerts = tub1 * radial1;

  // INPUT: ring-frame SoA, pre-computed on CPU and uploaded once per build.
  // Each ring carries 12 floats: cx, cy, cz, tx, ty, tz, nx, ny, nz, bx,
  // by, bz. Tangent is unused inside the kernel (we only need normal +
  // binormal for the radial offset) but keeping it makes the layout
  // identical to growth-engine.js's buildRingFrames output, which makes
  // the upload a single `set()` instead of a strided copy.
  const frameAttr = new THREE.StorageBufferAttribute(new Float32Array(tub1 * 12), 12);

  // INPUT: per-row local radius, profile sample, taper sample, flare. CPU
  // computes these because they involve spline samples (profile/taper) +
  // chain-radii lerp, both cheaper to do once on CPU than to re-derive in
  // the kernel.
  const rowAttr = new THREE.StorageBufferAttribute(new Float32Array(tub1 * 4), 4);
  // Layout per row: [localR, profileMul (per-radial varies — see below),
  // splMul (= taperRow), flareMul]. profileMul is actually per-radial so
  // it goes in its own buffer.
  const profileAttr = new THREE.StorageBufferAttribute(new Float32Array(radial1), 1);

  // OUTPUT: vertex position + uv + per-vertex radius.
  const posAttr = new THREE.StorageBufferAttribute(new Float32Array(numVerts * 3), 3);
  const uvAttr  = new THREE.StorageBufferAttribute(new Float32Array(numVerts * 2), 2);
  const radAttr = new THREE.StorageBufferAttribute(new Float32Array(numVerts), 1);

  const frameNode    = storage(frameAttr,   'vec4', tub1 * 3).toReadOnly(); // 12 floats = 3 vec4
  const rowNode      = storage(rowAttr,     'vec4', tub1).toReadOnly();
  const profileNode  = storage(profileAttr, 'float', radial1).toReadOnly();
  const posOutNode   = storage(posAttr,     'vec3', numVerts);
  const uvOutNode    = storage(uvAttr,      'vec2', numVerts);
  const radOutNode   = storage(radAttr,     'float', numVerts);

  // Constants the kernel needs. Plain JS numbers — TSL nodes can mul/div
  // them directly without a uniform.
  const radialF = float(radial);
  const radial1F = float(radial1);
  const TWO_PI_F = float(TWO_PI);

  const computeFn = Fn(() => {
    // One thread per output vertex. Decode (rowIdx, ringIdx) from instanceIndex.
    const v = instanceIndex;
    const rowIdx = v.div(uint(radial1));    // 0..tubular
    const j      = v.mod(uint(radial1));    // 0..radial (ring vertex index)

    // Pull the row's frame: 3 vec4s per row (12 floats: c.xyz, t.xyz,
    // n.xyz, b.xyz). Indices 3*row + {0,1,2}.
    const baseIdx = rowIdx.mul(uint(3));
    const fc = frameNode.element(baseIdx).xyz;            // ring center
    // const ft = frameNode.element(baseIdx.add(uint(1))).xyz; // tangent (unused)
    // For the second/third packed vec4 we read the .xyz (normal then binormal)
    // along with one extra float each — we ignore those.
    const fn = frameNode.element(baseIdx.add(uint(1))).yzw; // normal: packed past tangent
    const fb = frameNode.element(baseIdx.add(uint(2))).xyz; // binormal

    // Pull the row scalars: localR, _, splMul, flareMul.
    const row = rowNode.element(rowIdx);
    const localR  = row.x;
    const splMul  = row.z;
    const flareMul = row.w;

    // Profile sample for this radial slot.
    const profMul = profileNode.element(j);

    // Angle around the ring. j ∈ [0, radial] but j=0 and j=radial are the
    // seam (same vertex, doubled for UV continuity).
    const a = float(j).div(radialF).mul(TWO_PI_F);
    const ca = cos(a);
    const sa = sin(a);

    // Radial direction = -cos(a)*N + sin(a)*B (matches three.js TubeGeometry
    // and growth-engine.js buildTube convention).
    const dir = fn.mul(ca.negate()).add(fb.mul(sa));

    // Final radius along this slice = localR · profile · spline-taper · flare.
    const r = localR.mul(profMul).mul(splMul).mul(flareMul);

    const pos = fc.add(dir.mul(r));
    posOutNode.element(v).assign(pos);

    // UV: along = row's row.y (== sAlong, precomputed CPU); around = j *
    // (seamCircum / radial). Both come pre-baked in profileNode? Actually
    // profileNode is just radial profile. UVs need their own buffer, so
    // for this spike we emit placeholder UVs and let the CPU overwrite —
    // see the postprocess step in extrudeChainGPU.
    uvOutNode.element(v).assign(vec3(float(rowIdx), float(j), float(0)).xy);

    // Per-vertex radius drives the bark wind sway weight in the TSL bark
    // material. Just pass localR through.
    radOutNode.element(v).assign(localR);
  });

  // Dispatch one workgroup per vertex. Three.js packs to its own workgroup
  // size internally; numVerts is the logical thread count.
  const computePass = computeFn().compute(numVerts);

  const entry = {
    numVerts, tub1, radial1,
    frameAttr, rowAttr, profileAttr, posAttr, uvAttr, radAttr,
    computePass,
  };
  _passCache.set(key, entry);
  return entry;
}

// Pre-compute ring frames + per-row scalars on CPU, upload to storage
// buffers, dispatch the compute, read back. Returns the same shape as
// growth-engine.js buildTube.
//
// `chainNodes` is array of POJOs { x, y, z, radius, idx } — same as the
// CPU buildTube input.
export async function extrudeChainGPU(renderer, chainNodes, opts = {}) {
  if (!chainNodes || chainNodes.length < 2) return null;
  const profile = opts.profile || null; // SplineEditor or ProfileSampler with .sample(angle)
  const taper   = opts.taper   || null; // SplineEditor or SplineSampler with .sample(t)
  const isBranch = !!opts.isBranch;
  const parentRadius = opts.parentRadius ?? 0;
  const isScrubbing = !!opts.isScrubbing;
  const displace = opts.displace || {};

  // Dedup coincident points (same as CPU buildTube).
  const pts = [{ x: chainNodes[0].x, y: chainNodes[0].y, z: chainNodes[0].z }];
  const kept = [0];
  const EPS2 = 1e-12;
  for (let i = 1; i < chainNodes.length; i++) {
    const a = pts[pts.length - 1];
    const n = chainNodes[i];
    const dx = n.x - a.x, dy = n.y - a.y, dz = n.z - a.z;
    if (dx*dx + dy*dy + dz*dz > EPS2) { pts.push({ x: n.x, y: n.y, z: n.z }); kept.push(i); }
  }
  if (pts.length < 2) return null;
  const r0 = chainNodes[kept[0]].radius;

  // Density clamps — must match CPU path so cache keys align.
  const tubularPerStep = Math.max(4, Math.min(10, displace.tubularDensity || 6));
  const fullTub = Math.min(768, Math.max(12, (pts.length - 1) * tubularPerStep));
  const baseRad = Math.max(8, Math.min(24, displace.radialSegs || 16));
  const fullRad = r0 > 0.3 ? baseRad : Math.max(4, baseRad >> 1);
  const _isTrunk = !isBranch;
  const tubular = (isScrubbing && !_isTrunk) ? Math.max(4, Math.floor(fullTub * 0.28)) : fullTub;
  const radial  = (isScrubbing && !_isTrunk) ? Math.max(4, Math.floor(fullRad * 0.5))  : fullRad;

  const pass = _getOrBuildPass(pts.length, tubular, radial);
  const tub1 = pass.tub1;
  const radial1 = pass.radial1;
  const numVerts = pass.numVerts;

  // ---- Upload inputs ----------------------------------------------------
  // 1) Ring frames via the shared CPU helper (parallel-transport math is
  //    identical to what the CPU path does, no point re-implementing).
  const frames = {
    cx: new Float32Array(tub1), cy: new Float32Array(tub1), cz: new Float32Array(tub1),
    tx: new Float32Array(tub1), ty: new Float32Array(tub1), tz: new Float32Array(tub1),
    nx: new Float32Array(tub1), ny: new Float32Array(tub1), nz: new Float32Array(tub1),
    bx: new Float32Array(tub1), by: new Float32Array(tub1), bz: new Float32Array(tub1),
    segIdx: new Int32Array(tub1), segU: new Float32Array(tub1),
  };
  buildRingFrames(pts, tubular, frames);
  const frameSrc = pass.frameAttr.array;
  for (let i = 0; i < tub1; i++) {
    const o = i * 12;
    frameSrc[o     ] = frames.cx[i]; frameSrc[o + 1 ] = frames.cy[i]; frameSrc[o + 2 ] = frames.cz[i]; frameSrc[o + 3 ] = 0;
    frameSrc[o + 4 ] = frames.tx[i]; frameSrc[o + 5 ] = frames.ty[i]; frameSrc[o + 6 ] = frames.tz[i]; frameSrc[o + 7 ] = 0;
    frameSrc[o + 8 ] = frames.nx[i]; frameSrc[o + 9 ] = frames.ny[i]; frameSrc[o + 10] = frames.nz[i]; frameSrc[o + 11] = 0;
  }
  pass.frameAttr.needsUpdate = true;

  // 2) Per-row scalars: [localR, sAlong, splMul, flareMul].
  const chainRadii = chainNodes.map((n) => Math.max(1e-4, n.radius || r0));
  if (isBranch && parentRadius > 0) {
    const cap = parentRadius * 0.8;
    if (chainRadii[0] > cap) {
      const s = cap / chainRadii[0];
      for (let k = 0; k < chainRadii.length; k++) chainRadii[k] *= s;
    }
  }
  const flareRatio = (isBranch && parentRadius > r0 * 1.05)
    ? Math.min(6, parentRadius / Math.max(0.004, r0))
    : 1;
  const flareEnd = 0.22;
  const lastChainIdx = chainNodes.length - 1;
  const invTubular = 1 / tubular;
  let polyLen = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s], b = pts[s + 1];
    polyLen += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const rowSrc = pass.rowAttr.array;
  for (let i = 0; i <= tubular; i++) {
    const t = i * invTubular;
    const cfp = t * lastChainIdx;
    const cI0 = Math.max(0, Math.min(lastChainIdx, Math.floor(cfp)));
    const cI1 = Math.min(lastChainIdx, cI0 + 1);
    const cU = cfp - cI0;
    const localR = chainRadii[cI0] * (1 - cU) + chainRadii[cI1] * cU;
    let flareMul = 1;
    if (flareRatio > 1 && t < flareEnd) {
      const k = t / flareEnd;
      const s = k * k * (3 - 2 * k);
      flareMul = flareRatio * (1 - s) + 1 * s;
    }
    const splMul = (taper && !isBranch) ? taper.sample(t) : 1;
    const o = i * 4;
    rowSrc[o]     = localR;
    rowSrc[o + 1] = t * polyLen;  // sAlong — CPU postprocess writes UVs from this
    rowSrc[o + 2] = splMul;
    rowSrc[o + 3] = flareMul;
  }
  pass.rowAttr.needsUpdate = true;

  // 3) Profile multipliers per radial slot.
  const profSrc = pass.profileAttr.array;
  for (let j = 0; j <= radial; j++) {
    profSrc[j] = profile ? profile.sample((j / radial) * TWO_PI) : 1;
  }
  pass.profileAttr.needsUpdate = true;

  // ---- Dispatch ---------------------------------------------------------
  // computeAsync is the one I'm most uncertain about. The renderer.compute()
  // synchronous variant exists too. If the async path doesn't return, swap
  // to the sync call and remove the await.
  await renderer.computeAsync(pass.computePass);

  // ---- Read back --------------------------------------------------------
  // getArrayBufferAsync — alternate names: readBuffer, getStorageBufferAsync.
  // If undefined, swap to renderer.readbackAsync(buffer).
  const posBuf = await renderer.getArrayBufferAsync(pass.posAttr);
  const radBuf = await renderer.getArrayBufferAsync(pass.radAttr);
  const position = new Float32Array(posBuf);
  const radiusArr = new Float32Array(radBuf);

  // ---- CPU-side fixups --------------------------------------------------
  // UVs — overwrite the placeholder the kernel wrote with the proper
  // meters-along × tile-snapped-around layout (cheap to do on CPU since
  // it's a tight 2D loop).
  const uv = new Float32Array(numVerts * 2);
  const sv = (typeof opts.barkTexScaleV === 'number' && opts.barkTexScaleV > 0) ? opts.barkTexScaleV : 0.5;
  let maxR = 0;
  for (let k = 0; k < chainRadii.length; k++) if (chainRadii[k] > maxR) maxR = chainRadii[k];
  const tubeCircumMax = TWO_PI * Math.max(0.002, maxR);
  const tilesAround = Math.max(1, Math.round(tubeCircumMax * sv));
  const seamCircum = tilesAround / sv;
  for (let i = 0; i <= tubular; i++) {
    const sAlong = (i * invTubular) * polyLen;
    for (let j = 0; j <= radial; j++) {
      const sAround = (j / radial) * seamCircum;
      const idx = (i * radial1 + j) * 2;
      uv[idx]     = sAlong;
      uv[idx + 1] = sAround;
    }
  }

  // Skeleton mapping — index lookups, cheaper on CPU.
  const nodeA = new Int32Array(numVerts);
  const nodeB = new Int32Array(numVerts);
  const nodeW = new Float32Array(numVerts);
  const radialRest = new Float32Array(numVerts * 3);
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
      radialRest[o3]     = position[o3]     - skCx;
      radialRest[o3 + 1] = position[o3 + 1] - skCy;
      radialRest[o3 + 2] = position[o3 + 2] - skCz;
    }
  }

  // Triangle indices — same grid pattern as the CPU buildTube.
  const indexCount = tubular * radial * 6;
  const idxArr = numVerts > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let p = 0;
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const aV = i * radial1 + j;
      const bV = (i + 1) * radial1 + j;
      const cV = (i + 1) * radial1 + (j + 1);
      const dV = i * radial1 + (j + 1);
      idxArr[p++] = aV; idxArr[p++] = bV; idxArr[p++] = dV;
      idxArr[p++] = bV; idxArr[p++] = cV; idxArr[p++] = dV;
    }
  }

  // Normals — central differences on the GPU-written positions. The CPU
  // helper from growth-engine.js does this in one tight pass; reusing it
  // means the normals are bit-identical to the CPU path.
  const normal = new Float32Array(numVerts * 3);
  // Lazy import to avoid dragging tubeAnalyticNormals into the GPU module's
  // top-level when this experimental path may never be enabled.
  const { tubeAnalyticNormals } = await import('./growth-engine.js?v=r18');
  tubeAnalyticNormals(position, normal, tubular, radial);

  return {
    position,
    normal,
    uv,
    index: idxArr,
    radialRest,
    nodeA, nodeB, nodeW,
    radius: radiusArr,
    vertCount: numVerts,
  };
}

// Wraps `extrudeChainGPU` with a CPU fallback. Use this from the
// `tubeFromChain` wrapper in main.js — if the GPU path throws (compile
// error, missing API, etc.), the CPU buildTube takes over and the user
// still sees a tree.
export async function extrudeChainGPUSafe(renderer, chainNodes, opts, cpuFallback) {
  try {
    return await extrudeChainGPU(renderer, chainNodes, opts);
  } catch (e) {
    console.warn('[gpu-tube] GPU compute path failed, falling back to CPU:', e.message);
    return cpuFallback ? cpuFallback() : null;
  }
}
