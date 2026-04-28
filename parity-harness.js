// parity-harness.js — manual regression check for the growth pipeline.
//
// USAGE (browser console, after the app has loaded a tree):
//   1. await __parity.snapshot('oak-baseline');       // labels + stores in localStorage
//   2. (refactor stuff)
//   3. await __parity.snapshot('oak-after');
//   4. __parity.compare('oak-baseline', 'oak-after'); // logs which fields drifted
//
// Or for a "run a quick sweep" workflow:
//   await __parity.sweep('baseline', 5);              // generates 5 seeds, snapshots each
//   (refactor stuff)
//   await __parity.sweep('after', 5);
//   __parity.compareSweep('baseline', 'after');
//
// What gets hashed: tree node positions (rounded to 4 decimal places — roughly
// 0.1 mm precision for a 10 m tree), tree node radii, chain segmentation, bark
// vertex positions per chain. Hash function is FNV-1a on the float-quantized
// byte stream — stable across browsers, no native deps.
//
// Why quantize before hashing: small floating-point drift (e.g. CPU vs worker
// f64 vs f32 paths, or future GPU compute) shouldn't trigger false positives
// for a refactor that's "the same math." 4 decimal places (0.0001 m) is below
// the visible threshold for any tree at usual viewing distance but tight
// enough that real algorithmic divergence shows up as a different hash.

const QUANTIZE = 10000; // 4 decimal places

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hashFloatStream(streamFn) {
  // streamFn(write) — caller invokes write(value) repeatedly. We quantize each
  // value, pack as int32, and feed bytes to FNV. Avoids materializing a full
  // typed array when the source is itself iterating (chains, nodes, etc.).
  let h = 0x811c9dc5;
  const buf = new ArrayBuffer(4);
  const i32 = new Int32Array(buf);
  const u8 = new Uint8Array(buf);
  const write = (v) => {
    if (!Number.isFinite(v)) v = 0;
    i32[0] = Math.round(v * QUANTIZE) | 0;
    h ^= u8[0]; h = Math.imul(h, 0x01000193);
    h ^= u8[1]; h = Math.imul(h, 0x01000193);
    h ^= u8[2]; h = Math.imul(h, 0x01000193);
    h ^= u8[3]; h = Math.imul(h, 0x01000193);
  };
  streamFn(write);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Hash the post-build skeleton from the SoA arrays main.js maintains. Catches
// drift in walkInternode, sag, wobble, allometric radii — any of the
// growth-engine stages. Order matters (we walk by node index), so a topology
// change shifts every hash even when individual pos/radius numbers match.
//
// `soa` is { posX, posY, posZ, radius, parentIdx, count }. main.js fills these
// in generateTreeOnce; the harness reads them post-commit.
export function hashSkeletonSoA(soa) {
  if (!soa || !soa.count) return 'no-skeleton';
  return hashFloatStream((w) => {
    const N = soa.count;
    for (let i = 0; i < N; i++) {
      w(soa.posX[i]); w(soa.posY[i]); w(soa.posZ[i]);
      w(soa.radius[i]);
      w(soa.parentIdx ? soa.parentIdx[i] : -1);
    }
  });
}

// Hash chain segmentation — buildChains output. Same trunk/branch decomposition
// across regenerations means the per-chain tube extrusion sees identical input.
export function hashChains(chains) {
  return hashFloatStream((w) => {
    for (const chain of chains) {
      w(chain.length);
      for (const node of chain) w(node.idx);
    }
  });
}

// Hash a single tube extrusion result (output of buildTube). Position is the
// dominant signal — it folds in ring frames, taper, profile, displacement,
// buttress, react wood. Normals + UVs are excluded; they're derived from
// position so any position drift already shows up.
export function hashTube(tube) {
  if (!tube) return 'null';
  const pos = tube.position;
  const radius = tube.radius;
  return hashFloatStream((w) => {
    w(tube.vertCount);
    for (let i = 0; i < pos.length; i++) w(pos[i]);
    if (radius) for (let i = 0; i < radius.length; i++) w(radius[i]);
  });
}

// Hash the merged bark mesh straight from the live treeMesh.geometry. Useful
// after a regen to capture the "what the user sees" state in one number.
export function hashLiveTree(treeMesh) {
  if (!treeMesh || !treeMesh.geometry) return 'no-mesh';
  const posAttr = treeMesh.geometry.attributes.position;
  if (!posAttr) return 'no-pos';
  const radAttr = treeMesh.geometry.attributes.aRadius;
  return hashFloatStream((w) => {
    w(posAttr.count);
    const arr = posAttr.array;
    for (let i = 0; i < posAttr.count * 3; i++) w(arr[i]);
    if (radAttr) {
      const ra = radAttr.array;
      for (let i = 0; i < posAttr.count; i++) w(ra[i]);
    }
  });
}

// Combined snapshot. `state` is whatever main.js can supply at console-call
// time — pass { skeletonSoA, treeMesh, P }. Returns a labeled bundle the
// caller can stash and compare later.
export function snapshotState(label, state) {
  const seed = state.P ? state.P.seed : null;
  const species = state.P ? (state.P._lastSpecies || 'unknown') : 'unknown';
  const out = {
    label,
    timestamp: Date.now(),
    seed,
    species,
    skeleton: state.skeletonSoA ? hashSkeletonSoA(state.skeletonSoA) : null,
    liveTree: state.treeMesh ? hashLiveTree(state.treeMesh) : null,
  };
  return out;
}

// Compare two snapshots and report which sub-hashes drifted. Returns an array
// of {field, baseline, actual} entries — empty array means perfect match.
export function compareSnapshots(baseline, actual) {
  const fields = ['skeleton', 'liveTree'];
  const out = [];
  for (const f of fields) {
    if (baseline[f] !== actual[f]) {
      out.push({ field: f, baseline: baseline[f], actual: actual[f] });
    }
  }
  return out;
}

// Console-friendly helper — wires up the storage layer. main.js wires this to
// window.__parity for one-line console use.
const STORAGE_KEY = 'parity-harness:snapshots';

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveSnapshots(snaps) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snaps)); } catch (e) {}
}

export function makeConsoleAPI(getState) {
  return {
    snapshot(label) {
      if (!label) { console.warn('parity.snapshot needs a label'); return null; }
      const snap = snapshotState(label, getState());
      const all = loadSnapshots();
      all[label] = snap;
      saveSnapshots(all);
      console.log('[parity] snapshot saved as', label, snap);
      return snap;
    },
    list() {
      const all = loadSnapshots();
      console.table(Object.values(all).map((s) => ({
        label: s.label,
        species: s.species,
        seed: s.seed,
        skeleton: s.skeleton,
        liveTree: s.liveTree,
      })));
      return all;
    },
    get(label) {
      const all = loadSnapshots();
      return all[label] || null;
    },
    compare(labelA, labelB) {
      const all = loadSnapshots();
      const a = all[labelA], b = all[labelB];
      if (!a) { console.warn('no snapshot:', labelA); return null; }
      if (!b) { console.warn('no snapshot:', labelB); return null; }
      const drift = compareSnapshots(a, b);
      if (drift.length === 0) {
        console.log(`[parity] ✓ ${labelA} vs ${labelB} — identical`);
      } else {
        console.warn(`[parity] ✗ ${labelA} vs ${labelB} — drift in ${drift.length} field(s)`);
        console.table(drift);
      }
      return drift;
    },
    clear(label) {
      const all = loadSnapshots();
      if (label) { delete all[label]; }
      else { for (const k of Object.keys(all)) delete all[k]; }
      saveSnapshots(all);
      console.log('[parity] cleared', label || 'all');
    },
    help() {
      console.log(`parity-harness — manual regression check.

  __parity.snapshot('label')       capture current tree state under a label
  __parity.list()                  show all saved snapshots
  __parity.compare('a', 'b')       diff two snapshots, report drift
  __parity.get('label')            retrieve a saved snapshot
  __parity.clear('label')          delete one snapshot
  __parity.clear()                 wipe all snapshots
  __parity.help()                  this message

Snapshots persist in localStorage between page reloads. Workflow for verifying
a refactor: snapshot('before') → make changes → snapshot('after') → compare.`);
    },
  };
}
