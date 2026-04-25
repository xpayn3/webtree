// Surface root system: N tendrils radiating from the trunk base, arcing
// outward and down into the ground. Each root is a tapered CatmullRom tube,
// merged into a single geometry sharing the bark material.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function buildRootsGeometry({
  count = 6,
  spread = 1.6,           // outward distance (meters)
  length = 1.4,           // arc length factor — controls curvature reach
  depth = 0.6,            // how far the tip sinks below ground (meters)
  baseRadius = 0.18,      // radius at the trunk-side
  tipRadius = 0.04,       // radius at the buried tip
  jitter = 0.4,           // per-root randomization (0 = perfectly even)
  rise = 0.25,            // small upward bow before plunging — gives a bridged-arch look
  radialSegments = 8,
  tubularSegments = 12,
  seed = 1,
} = {}) {
  if (count <= 0) return null;
  let s = (seed >>> 0) || 1;
  const rng = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const geos = [];
  const twoPi = Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const baseTheta = (i / count) * twoPi;
    const theta = baseTheta + (rng() - 0.5) * jitter * (twoPi / count);
    const cx = Math.cos(theta);
    const cz = Math.sin(theta);
    const sJitter = 1 + (rng() - 0.5) * jitter;
    const dJitter = 1 + (rng() - 0.5) * jitter;
    const lJitter = 1 + (rng() - 0.5) * jitter * 0.5;
    const sp = spread * sJitter;
    const dp = depth * dJitter;
    const ln = length * lJitter;

    // 4-point CatmullRom: trunk anchor, slight bow up, midpoint, buried tip.
    const p0 = new THREE.Vector3(0, 0.05, 0);
    const p1 = new THREE.Vector3(cx * sp * 0.25, rise * 0.6, cz * sp * 0.25);
    const p2 = new THREE.Vector3(cx * sp * 0.7, -dp * 0.35, cz * sp * 0.7);
    const p3 = new THREE.Vector3(cx * sp, -dp, cz * sp);
    const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3], false, 'catmullrom', 0.5);
    curve.arcLengthDivisions = 16;

    const tubular = Math.max(4, Math.round(tubularSegments * ln));
    const geo = new THREE.TubeGeometry(curve, tubular, baseRadius, radialSegments, false);

    // Taper the tube: scale the radius along its length by lerp(base→tip).
    // TubeGeometry doesn't support taper natively, so post-process the verts.
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const verts = pos.count;
    const ringCount = tubular + 1;
    const ringSize = radialSegments + 1;
    for (let r = 0; r < ringCount; r++) {
      const t = r / tubular;
      const radius = baseRadius * (1 - t) + tipRadius * t;
      const scale = radius / baseRadius;
      // ring center = curve point at t
      const center = curve.getPointAt(t);
      for (let k = 0; k < ringSize; k++) {
        const idx = r * ringSize + k;
        if (idx >= verts) break;
        const x = pos.getX(idx) - center.x;
        const y = pos.getY(idx) - center.y;
        const z = pos.getZ(idx) - center.z;
        pos.setXYZ(idx, center.x + x * scale, center.y + y * scale, center.z + z * scale);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    void nrm;

    geos.push(geo);
  }
  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}
