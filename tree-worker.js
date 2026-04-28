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
// All of the growth math (buildTree / buildChains / buildTube / sag / wobble /
// noise / spline samplers / tropism) lives in growth-engine.js — same source
// as main.js's sync-fallback path. The worker is now a thin message-handling
// shim: it owns the postMessage protocol + structured-clone serialization,
// but every actual numeric calculation routes through the shared module.
//
// Three.js is imported from the same CDN the main app uses. Workers don't
// inherit importmaps, so the URL is absolute.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js';
import {
  SplineSampler,
  ProfileSampler,
  buildChains,
  buildTube,
  makeTreeBuilder,
} from './growth-engine.js?v=r18';
const _treeBuilder = makeTreeBuilder(THREE);
const buildTreeWorker = _treeBuilder.buildTree;


// --- Message handler -----------------------------------------------------
self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'build-tubes') {
    const { chains, profilePoints, taperPoints, isScrubbing, displace, reqId, barkTexScaleV } = msg.payload;
    const profile = profilePoints ? new ProfileSampler(profilePoints) : null;
    const taper   = taperPoints   ? new SplineSampler(taperPoints)   : null;
    const _svForUV = (typeof barkTexScaleV === 'number' && barkTexScaleV > 0) ? barkTexScaleV : 0.5;

    const tubes = [];
    const transferables = [];
    // Per-chain try/catch: a single bad chain (e.g. collapsed/NaN input)
    // MUST NOT abort the whole batch. If it did, the batch's reply never
    // posts, main's Promise hangs forever, and the UI freezes.
    for (const chain of chains) {
      let t = null;
      try {
        t = buildTube(chain.nodes, profile, taper, isScrubbing, displace, chain.chainRoot, chain.parentRadius, _svForUV);
      } catch (err) {
        t = null;
      }
      tubes.push(t);
      if (!t) continue;
      transferables.push(t.position.buffer, t.normal.buffer, t.uv.buffer,
                         t.radialRest.buffer,
                         t.nodeA.buffer, t.nodeB.buffer, t.nodeW.buffer,
                         t.radius.buffer);
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
    const chains = buildChains(treeResult.root);

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
