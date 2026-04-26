import * as THREE from 'three';

// --- Embed mode: ?embed=clean strips every UI affordance and forces a pure
// black background so the canvas blends with whatever page is hosting the
// iframe. Used by the portfolio's tree.html showcase. The body class drives
// the visibility (style.css `body.embed-clean` block); this just toggles it
// at boot before the rest of init runs.
const EMBED_CLEAN = new URLSearchParams(location.search).get('embed') === 'clean';
if (EMBED_CLEAN) document.body.classList.add('embed-clean');
import { positionLocal, time, uniform, sin, vec3, vec4, float, instanceIndex, pass, mrt, output, normalView, normalWorld, mix, renderOutput, frontFacing, texture as tslTexture, smoothstep, max as tslMax } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
// Optional post-FX (loaded lazily so missing files don't break the whole app).
let aoFn = null, dofFn = null;
try { ({ ao: aoFn } = await import('three/addons/tsl/display/GTAONode.js')); } catch (e) { console.warn('GTAO unavailable:', e.message); }
try { ({ dof: dofFn } = await import('three/addons/tsl/display/DepthOfFieldNode.js')); } catch (e) { console.warn('DOF unavailable:', e.message); }
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { mulberry32, _hashSeed, _localRng, hash1D, smoothNoise1D, hash2D, valueNoise2D, fbm2D, worley2D, fbm3D, worley3D } from './noise.js?v=r18';
import { PARAM_SCHEMA, LEVEL_SCHEMA, makeDefaultLevel, sampleDensityArr, PHYSICS_SCHEMA, SPECIES, BROADLEAF_KEYS, CONIFER_KEYS, BUSH_KEYS, CONIFER_SCHEMA, BUSH_SCHEMA, PARAM_DESCRIPTIONS } from './schema.js?v=r18';
import { SplineEditor, TropismPanel, ProfileEditor, LeafSilhouetteEditor, normalizeTropism, sampleFalloffArr } from './ui-widgets.js?v=r18';
import { buildRootsGeometry } from './roots.js?v=r18';
// meshoptimizer — higher-quality LOD simplification than three's SimplifyModifier.
// Lazy-loaded from CDN; falls back to SimplifyModifier if unavailable.
let MeshoptSimplifier = null;
let _meshoptReady = false;
import('https://cdn.jsdelivr.net/npm/meshoptimizer@0.22.0/meshopt_simplifier.module.js')
  .then(async (mod) => {
    MeshoptSimplifier = mod.MeshoptSimplifier;
    await MeshoptSimplifier.ready;
    _meshoptReady = true;
  })
  .catch((e) => console.warn('meshoptimizer unavailable:', e.message));
// FBX has no native exporter in three.js.

if (!navigator.gpu) {
  document.getElementById('fallback').hidden = false;
  const sp0 = document.getElementById('splash'); if (sp0) sp0.remove();
  throw new Error('WebGPU not supported');
}

// First-load splash — minimal logo animation; JS only dismisses it.
const _splash = document.getElementById('splash');
function splashDismiss() {
  if (!_splash) return;
  requestAnimationFrame(() => {
    _splash.classList.add('hide');
    setTimeout(() => { _splash.remove(); }, 700);
  });
}
// Hard-ceiling safety: no splash should linger past 6 s under any scenario.
setTimeout(splashDismiss, 6000);

// --- Prewarm tree workers ------------------------------------------------
// Boot the worker pool BEFORE `await renderer.init()` so worker module load
// overlaps with GPU adapter + device acquisition. Workers queue any 'ready'
// messages until the real onmessage handlers are attached further down.
// Without this hoist, workers only start booting after renderer.init()
// resolves, leaving ~100–300 ms per worker on the cold-start critical path.
const _prewarmPoolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const _prewarmedWorkers = [];
try {
  for (let i = 0; i < _prewarmPoolSize; i++) {
    const w = new Worker(
      new URL(`./tree-worker.js?v=${Date.now()}`, import.meta.url),
      { type: 'module' },
    );
    // Buffer messages received before the pool init attaches the real handler.
    // Without this, workers post 'ready' immediately on module load, the main
    // thread has no listener yet, and the message is dropped — _treeWorkerReady
    // stays false forever and every build falls back to the sync path.
    // `addEventListener` keeps the message port draining; we collect into a
    // queue that the pool init replays once the real handler is wired up.
    w._earlyMsgs = [];
    w._earlyListener = (e) => { w._earlyMsgs.push(e.data); };
    w.addEventListener('message', w._earlyListener);
    _prewarmedWorkers.push(w);
  }
} catch (err) {
  console.warn('[tree-worker] prewarm failed, will retry in pool init:', err);
}

const canvasWrap = document.getElementById('canvas-wrap');
const renderer = new THREE.WebGPURenderer({ antialias: true });
try {
  await renderer.init();
} catch (e) {
  console.error('WebGPU init failed:', e);
  document.getElementById('fallback').hidden = false;
  if (_splash) _splash.remove();
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(Math.max(1, canvasWrap.clientWidth), Math.max(1, canvasWrap.clientHeight));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
canvasWrap.appendChild(renderer.domElement);

// GPU device loss — driver crash / sleep-wake / timeout. The TSL graph and
// skeleton DataTextures are pinned to this device, so full re-init isn't
// cheap. Show a toast and let the user reload.
try {
  renderer.backend?.device?.lost?.then((info) => {
    if (info?.reason === 'destroyed') return; // intentional teardown
    console.warn('WebGPU device lost:', info?.message || info);
    if (typeof toast === 'function') toast('GPU device lost — please reload.', 'error', 10000);
  });
} catch {}

const scene = new THREE.Scene();
// Overlay scene — transform gizmos render here so the TSL pipeline can
// composite them on top of the post-processed main scene without bloom/AO/DOF
// touching them. Populated lower down (_attractorRoot).
const gizmoScene = new THREE.Scene();
gizmoScene.background = null;
const camera = new THREE.PerspectiveCamera(38, canvasWrap.clientWidth / canvasWrap.clientHeight, 0.1, 400);
camera.position.set(0, 9, 42);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 7, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.5;
controls.maxDistance = 200;
// maxPolarAngle is recomputed every frame in updateOrbitFloorClamp() so the
// camera can swing under the canopy (look up at the tree) without ever
// dipping below the ground plane — matches Unity / Unreal viewport
// behaviour. The static value here is just a safe initial state.
controls.maxPolarAngle = Math.PI * 0.49;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: null, // reserved for branch grab
};
controls.addEventListener('start', () => { reframeAnim = null; });

// Floor-aware orbit clamp. Recomputes maxPolarAngle every frame so the
// camera can swing under the canopy (look up at the tree) but never dips
// below the ground plane — same behaviour as the Unity / Unreal viewports.
// Math: at polar angle θ from world-up, camera.y = target.y + dist·cos(θ).
// We require camera.y ≥ FLOOR_Y, so cos(θ) ≥ (FLOOR_Y − target.y) / dist,
// which gives θ ≤ acos((FLOOR_Y − target.y) / dist).
const ORBIT_FLOOR_Y = 0.05;
function updateOrbitFloorClamp() {
  // Specialized modes (leaf creator, sculpt) drive their own controls and
  // expect the original 0.49π behaviour — bail out so we don't fight them.
  if (_leafCreatorActive) return;
  const dy = controls.target.y - ORBIT_FLOOR_Y;
  const dist = camera.position.distanceTo(controls.target);
  if (dist < 1e-3 || dy <= 0) {
    // Camera target is at/below the floor — fall back to horizon clamp
    // rather than computing acos of an out-of-range value.
    controls.maxPolarAngle = Math.PI * 0.5;
    return;
  }
  const cosLimit = Math.max(-1, Math.min(1, -dy / dist));
  // Tiny epsilon so floating-point bounce doesn't poke the camera through
  // the floor on the next frame.
  controls.maxPolarAngle = Math.acos(cosLimit) - 0.001;
}

// --- Orbit pivot re-target (3D-app-style) ------------------------------
// On left-button pointerdown we can move controls.target so the camera
// orbits around what's under the cursor (Blender/Maya-like) or around the
// tree's bounding-box center. Mode lives on sceneCfg.orbitPivot and is
// chosen in the Scene sidebar.
const _orbitRay = new THREE.Raycaster();
const _orbitNdc = new THREE.Vector2();
const _orbitHitOut = new THREE.Vector3();
const _orbitPlane = new THREE.Plane();
const _orbitViewDir = new THREE.Vector3();

function _orbitRayablesList() {
  const list = [];
  if (treeMesh) list.push(treeMesh);
  if (cycMesh) list.push(cycMesh);
  return list;
}

function _raycastOrbitPivot(clientX, clientY, out) {
  const rect = renderer.domElement.getBoundingClientRect();
  _orbitNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _orbitNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _orbitRay.setFromCamera(_orbitNdc, camera);
  const rayables = _orbitRayablesList();
  if (rayables.length) {
    const hits = _orbitRay.intersectObjects(rayables, false);
    if (hits.length) { out.copy(hits[0].point); return true; }
  }
  // Fallback: plane perpendicular to view direction, passing through current
  // target. Keeps the apparent pivot depth stable when clicking empty sky.
  camera.getWorldDirection(_orbitViewDir);
  _orbitPlane.setFromNormalAndCoplanarPoint(_orbitViewDir.clone().negate(), controls.target);
  return _orbitRay.ray.intersectPlane(_orbitPlane, out) !== null;
}

function _sceneCenterPivot(out) {
  if (treeMesh) {
    treeMesh.geometry.computeBoundingBox();
    const b = treeMesh.geometry.boundingBox;
    if (b) { b.getCenter(out); return true; }
  }
  out.set(0, 7, 0);
  return true;
}

function onOrbitPivotPointerDown(e) {
  if (e.button !== 0) return;                   // only LEFT-drag rotate
  if (grabbedNodeIdx >= 0) return;              // branch grab takes priority
  if (e.target !== renderer.domElement) return; // ignore clicks on overlays
  const mode = sceneCfg.orbitPivot;
  if (mode === 'target') return;                // classic behavior: no move
  let ok = false;
  if (mode === 'cursor') {
    ok = _raycastOrbitPivot(e.clientX, e.clientY, _orbitHitOut);
  } else if (mode === 'center') {
    ok = _sceneCenterPivot(_orbitHitOut);
  }
  if (ok) controls.target.copy(_orbitHitOut);
}
// Capture-phase so we run before OrbitControls' bubble-phase pointerdown.
renderer.domElement.addEventListener('pointerdown', onOrbitPivotPointerDown, true);

// --- LOD preview state (declared here so the sidebar block can reference
// these without a TDZ — the LOD sidebar runs during module init before the
// LOD pipeline functions further down get their declarations executed).
// LOD slots are user-editable — each has a unique id so two slots can share
// the same ratio/tri target without colliding in the preview maps.
const _lodPreviewMeshes = new Map(); // slotId -> THREE.Mesh
const _lodWireMeshes = new Map();    // slotId -> THREE.Mesh (wireframe inspection overlay)
const _lodTriCounts = new Map();     // slotId -> actual tri count after simplify
let _nextLodId = 1;
function makeLodSlot({ mode = 'ratio', ratio = 0.5, tris = 5000, lockBorder = false, sloppy = false } = {}) {
  return { id: _nextLodId++, mode, ratio, tris, lockBorder, sloppy };
}
// Default chain mirrors the old fixed slots (50% / 25% / 12%). LOD3 uses
// meshopt's sloppy path by default since <15% often collapses under the
// quality-preserving path.
const lodSlots = [
  makeLodSlot({ ratio: 0.50 }),
  makeLodSlot({ ratio: 0.25 }),
  makeLodSlot({ ratio: 0.12, sloppy: true }),
];
let _hideLOD0 = false;
let _lodCardsRender = null;          // set by the LOD drawer when it's built
let _lodTechRender = null;
let _refreshLeafShapePanel = null;   // set by the Leaf Shape sidebar block
let _lodStubRender = null;           // sidebar summary stub renderer
function refreshLODUI() {
  _lodStubRender?.();
  _lodCardsRender?.();
  _lodTechRender?.();
  _reconcileTreeLabels?.();
}

// --- Click-and-drag: grab a branch and pull on it ------------------------
let grabbedNodeIdx = -1;
let grabChainMask = null;          // Uint8Array — ancestors of grabbed node get softer bending
let physicsOn = false;             // toolbar toggle — off by default; turn on to right-drag branches

// --- Sculpt (Edit) mode -------------------------------------------------
// A dedicated context for manually reshaping the tree: right-drag bends a
// branch and the pose sticks on release instead of springing back. Wind
// and spring-back physics are paused so nothing fights the user's edits.
// Exit via Finish (commit current pos as new rest) or Discard (restore
// pre-sculpt pose). Regenerating the tree clears any sculpt.
let _sculptActive = false;
let _sculptSnapshot = null;   // { posX, posY, posZ, restX, restY, restZ } copies at entry
const _sculptUndoStack = [];  // pose snapshots before each grab; Ctrl+Z pops one
let _sculptSavedPhysics = false;
let _sculptSavedWind = false;
let _sculptEditCount = 0;     // how many distinct grab edits since entering
// `_sculptIsLive` stays true AFTER committing a sculpt so later param
// changes don't silently regenerate the tree and wipe the shape. Cleared
// when the user explicitly rebuilds (Regenerate button, new seed, new
// species / tree type, preset load — anything that calls generateTree()
// directly, not through debouncedGenerate).
let _sculptIsLive = false;
let _sculptBlockedToastAt = 0;
function _applySculptLiveClass() {
  document.body.classList.toggle('sculpt-live', !!_sculptIsLive);
}

// --- Brush sub-mode inside sculpt ---------------------------------------
// Grabs many joints at once within a screen-space radius with a smooth
// falloff — drag once and the whole canopy flows with you.
let _brushMode = false;
let _brushRadius = 42;        // screen-space pixels (range 20..400)
let _brushStrength = 1.0;     // multiplier applied to cursor delta (0..1)
let _brushActive = false;     // true between pointerdown+pointerup in brush drag
let _brushedIdxs = null;      // Int32Array of affected joints
let _brushedFalloff = null;   // Float32Array 0..1 per brushed joint
let _brushedInitX = null, _brushedInitY = null, _brushedInitZ = null;
let _brushInitCursor = new THREE.Vector3();   // world pos at click, for delta math
let _brushSavedInvMass = null; // {idx[], value[]} to restore on release
// Right-click in brush mode is "pending" until the pointer moves past
// threshold — that's what disambiguates "open popover" vs "start grab".
let _brushPending = false;
let _brushPendingStartX = 0, _brushPendingStartY = 0;
let _brushPendingEvent = null;
const _BRUSH_PENDING_THRESH = 5;
const grabTargetWorldOffset = new THREE.Vector3();
const _grabPlane = new THREE.Plane();
const _grabRay = new THREE.Raycaster();
const _grabNdc = new THREE.Vector2();
const _grabHitPoint = new THREE.Vector3();
const _grabCamDir = new THREE.Vector3();
const _grabInitialCursor = new THREE.Vector3();
const _grabInitialOffset = new THREE.Vector3();

function grabScreenToWorld(clientX, clientY, outPoint) {
  const rect = renderer.domElement.getBoundingClientRect();
  _grabNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _grabNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _grabRay.setFromCamera(_grabNdc, camera);
  return _grabRay.ray.intersectPlane(_grabPlane, outPoint);
}

const _grabProj = new THREE.Vector3();
const _grabNodeWorld = new THREE.Vector3();

function pickNearestNodeScreen(clientX, clientY, pixelThresh) {
  const rect = renderer.domElement.getBoundingClientRect();
  const cx = clientX - rect.left, cy = clientY - rect.top;
  const halfW = rect.width / 2, halfH = rect.height / 2;
  if (treeMesh) treeMesh.updateMatrixWorld();
  let bestIdx = -1, bestD2 = pixelThresh * pixelThresh;
  for (let i = 0; i < skeleton.length; i++) {
    const s = skeleton[i];
    if (s.invMass === 0) continue;
    _grabProj.set(s.pos.x + s.worldOffset.x, s.pos.y + s.worldOffset.y, s.pos.z + s.worldOffset.z);
    if (treeMesh) _grabProj.applyMatrix4(treeMesh.matrixWorld);
    _grabProj.project(camera);
    if (_grabProj.z < -1 || _grabProj.z > 1) continue;
    const sx = _grabProj.x * halfW + halfW;
    const sy = -_grabProj.y * halfH + halfH;
    const dx = sx - cx, dy = sy - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  return bestIdx;
}

function beginGrab(nodeIdx, anchorWorldPoint, e) {
  // In sculpt mode, snapshot the pose BEFORE this drag so Ctrl+Z can revert
  // the release as a single undoable operation.
  if (_sculptActive) _sculptPushUndoSnapshot();
  grabbedNodeIdx = nodeIdx;
  // Mark ancestors — these get softened bending so the whole branch bends,
  // not just the grabbed joint.
  grabChainMask = new Uint8Array(skeleton.length);
  let ci = nodeIdx;
  while (ci >= 0) {
    grabChainMask[ci] = 1;
    ci = skeleton[ci].parentIdx;
  }
  camera.getWorldDirection(_grabCamDir);
  _grabPlane.setFromNormalAndCoplanarPoint(_grabCamDir.clone().negate(), anchorWorldPoint);
  _grabInitialCursor.copy(anchorWorldPoint);
  _grabInitialOffset.copy(skeleton[nodeIdx].worldOffset);
  grabTargetWorldOffset.copy(_grabInitialOffset);
  _simActive = true;
  renderer.domElement.style.cursor = 'grabbing';
  e.stopPropagation();
  e.preventDefault();
  window.addEventListener('pointermove', onGrabMove);
  window.addEventListener('pointerup', onGrabEnd);
  window.addEventListener('pointercancel', onGrabEnd);
}

function onGrabStart(e) {
  if (e.button !== 2 || !treeMesh || !skeleton.length) return;
  // Brush sub-mode inside sculpt — defer: a pure right-click opens the
  // controls popover, while a right-drag past threshold starts the brush
  // grab. Handled BEFORE the physicsOn check so the popover still opens
  // if the user toggled physics off after entering sculpt.
  if (_sculptActive && _brushMode) {
    // Clean up any stale pending state from a dropped prior gesture.
    if (_brushPending) _brushPendingCleanup();
    _brushPending = true;
    _brushPendingStartX = e.clientX;
    _brushPendingStartY = e.clientY;
    _brushPendingEvent = e;
    // Listen in capture so we win against handlers that stopPropagation.
    window.addEventListener('pointermove', _brushPendingMove, true);
    window.addEventListener('pointerup', _brushPendingEnd, true);
    window.addEventListener('pointercancel', _brushPendingEnd, true);
    // Last-resort fallback: if pointerup is swallowed somewhere, the
    // contextmenu event will still fire and clean up via the handler.
    return;
  }
  if (!physicsOn) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _grabNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _grabNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _grabRay.setFromCamera(_grabNdc, camera);

  // 1) Precise hit on bark mesh — pick exactly where the cursor lands
  const hits = _grabRay.intersectObject(treeMesh, false);
  if (hits.length) {
    const hit = hits[0];
    const v = hit.face.a;
    const nodeIdx = (barkNodeW[v] < 0.5) ? barkNodeA[v] : barkNodeB[v];
    if (nodeIdx != null && skeleton[nodeIdx]) {
      beginGrab(nodeIdx, hit.point, e);
      return;
    }
  }

  // 2) Fallback: nearest skeleton node in screen space (generous pick radius)
  const pickRadius = P.physics?.grabPickRadius ?? 60;
  const nearIdx = pickNearestNodeScreen(e.clientX, e.clientY, pickRadius);
  if (nearIdx < 0) return; // truly empty — let OrbitControls rotate
  const s = skeleton[nearIdx];
  _grabNodeWorld.set(s.pos.x + s.worldOffset.x, s.pos.y + s.worldOffset.y, s.pos.z + s.worldOffset.z);
  treeMesh.updateMatrixWorld();
  _grabNodeWorld.applyMatrix4(treeMesh.matrixWorld);
  camera.getWorldDirection(_grabCamDir);
  _grabPlane.setFromNormalAndCoplanarPoint(_grabCamDir.clone().negate(), _grabNodeWorld);
  const init = _grabRay.ray.intersectPlane(_grabPlane, _grabHitPoint);
  if (!init) return;
  beginGrab(nearIdx, _grabHitPoint.clone(), e);
}

function onGrabMove(e) {
  if (grabbedNodeIdx < 0) return;
  if (grabScreenToWorld(e.clientX, e.clientY, _grabHitPoint)) {
    const sens = P.physics?.grabSensitivity ?? 1;
    const maxPull = P.physics?.grabMaxPull ?? 12;
    grabTargetWorldOffset.x = _grabInitialOffset.x + (_grabHitPoint.x - _grabInitialCursor.x) * sens;
    grabTargetWorldOffset.y = _grabInitialOffset.y + (_grabHitPoint.y - _grabInitialCursor.y) * sens;
    grabTargetWorldOffset.z = _grabInitialOffset.z + (_grabHitPoint.z - _grabInitialCursor.z) * sens;
    const lsq = grabTargetWorldOffset.lengthSq();
    if (lsq > maxPull * maxPull) grabTargetWorldOffset.setLength(maxPull);
    _simActive = true;
  }
  // Halo: follow the cursor while dragging (in screen-space — shows exactly
  // where the drag anchor is, even when the rod tip lags behind it).
  if (_grabHalo) {
    _grabHalo.style.left = e.clientX + 'px';
    _grabHalo.style.top  = e.clientY + 'px';
    _grabHalo.hidden = false;
    _grabHalo.classList.add('show');
  }
}

function onGrabEnd() {
  if (grabbedNodeIdx < 0) return;
  const wasSculpt = _sculptActive;
  grabbedNodeIdx = -1;
  grabChainMask = null;
  // Release snap-back: bend stiffness flips from "loose chain" to full rigidity
  // in one frame. Heavily damp the first ~0.5s so the transition eases instead
  // of ringing. Same mechanism as post-rebuild settle.
  _simSettleBoost = Math.max(_simSettleBoost, 1.5);
  renderer.domElement.style.cursor = '';
  if (_grabHalo) { _grabHalo.classList.remove('show'); _grabHalo.hidden = true; }
  window.removeEventListener('pointermove', onGrabMove);
  window.removeEventListener('pointerup', onGrabEnd);
  window.removeEventListener('pointercancel', onGrabEnd);
  if (wasSculpt) {
    // Apply the dragged pose as the new rest immediately so subsequent
    // grabs don't see stale rest caches pulling this branch back.
    _sculptBakePose();
    _sculptEditCount++;
    _sculptUpdateChrome?.();
  }
}

// --- Brush grab (sculpt-mode, many joints at once) --------------------
function _pickBrushJoints(clientX, clientY, radiusPx) {
  const rect = renderer.domElement.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const halfW = rect.width / 2, halfH = rect.height / 2;
  const r2 = radiusPx * radiusPx;
  const idxs = [];
  const falloffs = [];
  for (let i = 0; i < skN; i++) {
    if (skParentIdx[i] < 0) continue;  // skip root — never movable
    _grabProj.set(skPosX[i], skPosY[i], skPosZ[i]);
    if (treeMesh) _grabProj.applyMatrix4(treeMesh.matrixWorld);
    _grabProj.project(camera);
    if (_grabProj.z < -1 || _grabProj.z > 1) continue;
    const sx = _grabProj.x * halfW + halfW;
    const sy = -_grabProj.y * halfH + halfH;
    const dx = sx - cx, dy = sy - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    const t = Math.sqrt(d2) / radiusPx;             // 0 at center, 1 at edge
    const f = 1 - (t * t * (3 - 2 * t));            // smoothstep falloff
    idxs.push(i);
    falloffs.push(f);
  }
  return { idxs, falloffs };
}

function beginBrushGrab(e) {
  const picked = _pickBrushJoints(e.clientX, e.clientY, _brushRadius);
  if (!picked.idxs.length) return false;
  _brushedIdxs = new Int32Array(picked.idxs);
  _brushedFalloff = new Float32Array(picked.falloffs);
  _brushedInitX = new Float32Array(_brushedIdxs.length);
  _brushedInitY = new Float32Array(_brushedIdxs.length);
  _brushedInitZ = new Float32Array(_brushedIdxs.length);
  _brushSavedInvMass = new Float32Array(_brushedIdxs.length);
  // Pin all brushed joints (invMass=0) so the solver respects our direct
  // position writes, and remember initial positions for cursor-relative math.
  for (let k = 0; k < _brushedIdxs.length; k++) {
    const i = _brushedIdxs[k];
    _brushedInitX[k] = skPosX[i];
    _brushedInitY[k] = skPosY[i];
    _brushedInitZ[k] = skPosZ[i];
    _brushSavedInvMass[k] = skInvMass[i];
    skInvMass[i] = 0;
  }
  // Grab plane: camera-aligned through the centroid of brushed joints.
  let sx = 0, sy = 0, sz = 0;
  for (let k = 0; k < _brushedIdxs.length; k++) {
    const w = _brushedFalloff[k];
    sx += _brushedInitX[k] * w;
    sy += _brushedInitY[k] * w;
    sz += _brushedInitZ[k] * w;
  }
  let ws = 0;
  for (let k = 0; k < _brushedFalloff.length; k++) ws += _brushedFalloff[k];
  if (ws > 1e-6) { sx /= ws; sy /= ws; sz /= ws; }
  _grabNodeWorld.set(sx, sy, sz);
  if (treeMesh) { treeMesh.updateMatrixWorld(); _grabNodeWorld.applyMatrix4(treeMesh.matrixWorld); }
  camera.getWorldDirection(_grabCamDir);
  _grabPlane.setFromNormalAndCoplanarPoint(_grabCamDir.clone().negate(), _grabNodeWorld);
  if (!grabScreenToWorld(e.clientX, e.clientY, _grabHitPoint)) return false;
  _brushInitCursor.copy(_grabHitPoint);
  _brushActive = true;
  _simActive = true;
  renderer.domElement.style.cursor = 'grabbing';
  // Snapshot state for undo, same as single grab.
  if (_sculptActive) _sculptPushUndoSnapshot();
  e.stopPropagation();
  e.preventDefault();
  window.addEventListener('pointermove', onBrushMove);
  window.addEventListener('pointerup', onBrushEnd);
  window.addEventListener('pointercancel', onBrushEnd);
  return true;
}

function onBrushMove(e) {
  if (!_brushActive) return;
  if (!grabScreenToWorld(e.clientX, e.clientY, _grabHitPoint)) return;
  const dx = (_grabHitPoint.x - _brushInitCursor.x) * _brushStrength;
  const dy = (_grabHitPoint.y - _brushInitCursor.y) * _brushStrength;
  const dz = (_grabHitPoint.z - _brushInitCursor.z) * _brushStrength;
  for (let k = 0; k < _brushedIdxs.length; k++) {
    const i = _brushedIdxs[k];
    const f = _brushedFalloff[k];
    skPosX[i] = _brushedInitX[k] + dx * f;
    skPosY[i] = _brushedInitY[k] + dy * f;
    skPosZ[i] = _brushedInitZ[k] + dz * f;
  }
  _simActive = true;
  markRenderDirty(2);
}

function onBrushEnd() {
  if (!_brushActive) return;
  _brushActive = false;
  // Restore invMass for the brushed joints.
  for (let k = 0; k < _brushedIdxs.length; k++) {
    skInvMass[_brushedIdxs[k]] = _brushSavedInvMass[k];
  }
  _brushedIdxs = null;
  _brushedFalloff = null;
  _brushedInitX = _brushedInitY = _brushedInitZ = null;
  _brushSavedInvMass = null;
  renderer.domElement.style.cursor = '';
  window.removeEventListener('pointermove', onBrushMove);
  window.removeEventListener('pointerup', onBrushEnd);
  window.removeEventListener('pointercancel', onBrushEnd);
  // Bake the new pose as the new rest — same mechanism as single grab.
  if (_sculptActive) {
    _sculptBakePose();
    _sculptEditCount++;
    _sculptUpdateChrome?.();
  }
  markRenderDirty(3);
}

function _brushPendingCleanup() {
  _brushPending = false;
  _brushPendingEvent = null;
  window.removeEventListener('pointermove', _brushPendingMove, true);
  window.removeEventListener('pointerup', _brushPendingEnd, true);
  window.removeEventListener('pointercancel', _brushPendingEnd, true);
}
function _brushPendingMove(e) {
  if (!_brushPending) return;
  const dx = e.clientX - _brushPendingStartX;
  const dy = e.clientY - _brushPendingStartY;
  if (dx * dx + dy * dy < _BRUSH_PENDING_THRESH * _BRUSH_PENDING_THRESH) return;
  // Past threshold — the user is dragging. Promote to a real brush grab.
  const startEvent = _brushPendingEvent;
  _brushPendingCleanup();
  if (startEvent && beginBrushGrab(startEvent)) {
    _brushGrabHappened = true;
    // Apply the current cursor delta immediately so the drag doesn't feel
    // like it starts from the click point.
    onBrushMove(e);
  }
}
function _brushPendingEnd(e) {
  if (!_brushPending) return;
  // Click threshold check: if the pointer stayed within the dead zone,
  // this was a pure right-click — open the popover now. Don't rely on
  // the contextmenu event firing, because some handler upstream can
  // swallow it on certain gestures.
  const within = e
    && typeof e.clientX === 'number'
    && (e.clientX - _brushPendingStartX) ** 2 + (e.clientY - _brushPendingStartY) ** 2
         < _BRUSH_PENDING_THRESH * _BRUSH_PENDING_THRESH;
  const x = e?.clientX ?? _brushPendingStartX;
  const y = e?.clientY ?? _brushPendingStartY;
  _brushPendingCleanup();
  if (within && _sculptActive && _brushMode) {
    _openBrushControls(x, y);
    // Suppress the follow-up contextmenu event for this gesture so it
    // doesn't re-open the popover or close it via the outside-click guard.
    _brushSuppressNextContextMenu = true;
  }
}
let _brushSuppressNextContextMenu = false;

// Capture phase so we can intercept before OrbitControls' bubble-phase handler
renderer.domElement.addEventListener('pointerdown', onGrabStart, true);

// --- Sculpt mode: enter / exit / undo / commit -------------------------
let _sculptUpdateChrome = null; // set by the chrome-bar builder

// Full-state snapshot: pos + every rest cache + bark caches + leaf data.
// Used for discard AND undo, because per-release bakes mutate all of these
// and reverting any one without the others would leave the solver inconsistent.
function _snapshotSculptState() {
  return {
    posX: skPosX.slice(), posY: skPosY.slice(), posZ: skPosZ.slice(),
    restX: skRestX.slice(), restY: skRestY.slice(), restZ: skRestZ.slice(),
    restOffX: skRestOffX.slice(), restOffY: skRestOffY.slice(), restOffZ: skRestOffZ.slice(),
    restLen: skRestLen.slice(),
    restParentDirX: skRestParentDirX.slice(),
    restParentDirY: skRestParentDirY.slice(),
    restParentDirZ: skRestParentDirZ.slice(),
    hasParentDir: skHasParentDir.slice(),
    barkRestPos: barkRestPos ? new Float32Array(barkRestPos) : null,
    barkRadialRest: barkRadialRest ? new Float32Array(barkRadialRest) : null,
    leafA: _snapshotLeafPositions(leafDataA),
    leafB: _snapshotLeafPositions(leafDataB),
  };
}
function _applySculptSnapshot(snap) {
  skPosX.set(snap.posX); skPosY.set(snap.posY); skPosZ.set(snap.posZ);
  skRestX.set(snap.restX); skRestY.set(snap.restY); skRestZ.set(snap.restZ);
  skRestOffX.set(snap.restOffX); skRestOffY.set(snap.restOffY); skRestOffZ.set(snap.restOffZ);
  skRestLen.set(snap.restLen);
  skRestParentDirX.set(snap.restParentDirX);
  skRestParentDirY.set(snap.restParentDirY);
  skRestParentDirZ.set(snap.restParentDirZ);
  skHasParentDir.set(snap.hasParentDir);
  if (snap.barkRestPos && barkRestPos) barkRestPos.set(snap.barkRestPos);
  if (snap.barkRadialRest && barkRadialRest) barkRadialRest.set(snap.barkRadialRest);
  _restoreLeafPositions(leafDataA, snap.leafA);
  _restoreLeafPositions(leafDataB, snap.leafB);
  for (let i = 0; i < skN; i++) {
    skWorldOffX[i] = 0; skWorldOffY[i] = 0; skWorldOffZ[i] = 0;
    const s = skeleton[i];
    s.restPos.x = skRestX[i]; s.restPos.y = skRestY[i]; s.restPos.z = skRestZ[i];
    s.worldOffset.set(0, 0, 0);
    s.restLen = skRestLen[i];
    s.restOffFromParent.set(skRestOffX[i], skRestOffY[i], skRestOffZ[i]);
    s.hasRestParentDir = !!skHasParentDir[i];
    if (s.hasRestParentDir) {
      s.restParentDirGP.set(skRestParentDirX[i], skRestParentDirY[i], skRestParentDirZ[i]);
    }
  }
  if (skPrevX) { skPrevX.set(skPosX); skPrevY.set(skPosY); skPrevZ.set(skPosZ); }
  if (skVelX)  { skVelX.fill(0); skVelY.fill(0); skVelZ.fill(0); }
  _skeletonSoAToObjects();
  if (typeof buildStemBaseMatrices === 'function') buildStemBaseMatrices();
  _simActive = true;
  markRenderDirty(3);
}

function _sculptPushUndoSnapshot() {
  _sculptUndoStack.push(_snapshotSculptState());
  if (_sculptUndoStack.length > 30) _sculptUndoStack.shift();
}

function sculptUndo() {
  if (!_sculptActive) return;
  const snap = _sculptUndoStack.pop();
  if (!snap) { toast('Nothing to undo', 'info', 900); return; }
  _applySculptSnapshot(snap);
  _sculptEditCount = Math.max(0, _sculptEditCount - 1);
  _sculptUpdateChrome?.();
}

function _snapshotLeafPositions(data) {
  if (!data) return null;
  const out = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const L = data[i];
    out[i] = {
      x: L.pos.x, y: L.pos.y, z: L.pos.z,
      sbx: L._stemBaseX, sby: L._stemBaseY, sbz: L._stemBaseZ,
    };
  }
  return out;
}
function _restoreLeafPositions(data, snap) {
  if (!data || !snap) return;
  for (let i = 0; i < data.length && i < snap.length; i++) {
    const L = data[i], s = snap[i];
    L.pos.x = s.x; L.pos.y = s.y; L.pos.z = s.z;
    if (s.sbx !== undefined) { L._stemBaseX = s.sbx; L._stemBaseY = s.sby; L._stemBaseZ = s.sbz; }
  }
}

function enterSculptMode() {
  if (_sculptActive) return;
  if (!treeMesh) { toast('Generate a tree first', 'error', 1500); return; }
  _sculptSnapshot = _snapshotSculptState();
  _sculptUndoStack.length = 0;
  _sculptEditCount = 0;
  _sculptSavedWind = P.wind.enabled;
  _sculptSavedPhysics = physicsOn;
  // Pause wind, force physics on (grab needs it). Toolbar classes follow.
  P.wind.enabled = false;
  physicsOn = true;
  const _tbPhysicsBtn = document.getElementById('tb-physics');
  if (_tbPhysicsBtn) _tbPhysicsBtn.classList.add('active');
  _sculptActive = true;
  document.body.classList.add('sculpt-mode');
  _buildSculptChrome();
  _buildSculptToolbar();
  setBrushMode(_brushMode); // re-sync cursor now that sculpt is active
  _setModeTabActive?.('sculpt');
  const tbEdit = document.getElementById('tb-edit');
  if (tbEdit) tbEdit.classList.add('active');
  _sculptUpdateChrome?.();
  _sculptSidebarUpdate?.();
  toast('Sculpt mode — right-drag branches to reshape', 'info', 1800);
  markRenderDirty(3);
}

// Bake the current pose as the new rest. Called after each grab-release in
// sculpt mode so subsequent grabs don't see stale rest caches pulling the
// just-released branch back to its original shape.
function _sculptBakePose() {
  if (treeMesh && barkRestPos) {
    const arr = treeMesh.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i++) barkRestPos[i] = arr[i];
  }
  for (const data of [leafDataA, leafDataB]) {
    if (!data) continue;
    for (const L of data) {
      if (L.anchorIdx < 0 || L.anchorIdx >= skN) continue;
      const wx = skWorldOffX[L.anchorIdx];
      const wy = skWorldOffY[L.anchorIdx];
      const wz = skWorldOffZ[L.anchorIdx];
      L.pos.x += wx; L.pos.y += wy; L.pos.z += wz;
      if (L._stemBaseX !== undefined) {
        L._stemBaseX += wx; L._stemBaseY += wy; L._stemBaseZ += wz;
      }
    }
  }
  for (let i = 0; i < skN; i++) {
    skRestX[i] = skPosX[i]; skRestY[i] = skPosY[i]; skRestZ[i] = skPosZ[i];
  }
  for (let i = 0; i < skN; i++) {
    const p = skParentIdx[i];
    if (p < 0) {
      skRestOffX[i] = 0; skRestOffY[i] = 0; skRestOffZ[i] = 0;
      skRestLen[i] = 0;
      skHasParentDir[i] = 0;
      continue;
    }
    skRestOffX[i] = skRestX[i] - skRestX[p];
    skRestOffY[i] = skRestY[i] - skRestY[p];
    skRestOffZ[i] = skRestZ[i] - skRestZ[p];
    skRestLen[i] = Math.hypot(skRestOffX[i], skRestOffY[i], skRestOffZ[i]);
    const gp = skParentIdx[p];
    if (gp >= 0) {
      const dx = skRestX[p] - skRestX[gp];
      const dy = skRestY[p] - skRestY[gp];
      const dz = skRestZ[p] - skRestZ[gp];
      const rl2 = dx * dx + dy * dy + dz * dz;
      if (rl2 > 1e-12) {
        const inv = 1 / Math.sqrt(rl2);
        skRestParentDirX[i] = dx * inv;
        skRestParentDirY[i] = dy * inv;
        skRestParentDirZ[i] = dz * inv;
        skHasParentDir[i] = 1;
      } else {
        skHasParentDir[i] = 0;
      }
    } else {
      skHasParentDir[i] = 0;
    }
  }
  if (barkRadialRest && barkNodeA) {
    // Bound by the geometry's actual vert count, not the pool array's length
    // — pools are grow-only and stay bigger than the live mesh after a shrink.
    const vCount = treeMesh && treeMesh.geometry?.attributes?.position
      ? treeMesh.geometry.attributes.position.count
      : barkNodeA.length;
    for (let v = 0; v < vCount; v++) {
      const a = barkNodeA[v], b = barkNodeB[v], w = barkNodeW[v], iw = 1 - w;
      const cx = skRestX[a] * iw + skRestX[b] * w;
      const cy = skRestY[a] * iw + skRestY[b] * w;
      const cz = skRestZ[a] * iw + skRestZ[b] * w;
      const i3 = v * 3;
      barkRadialRest[i3    ] = barkRestPos[i3    ] - cx;
      barkRadialRest[i3 + 1] = barkRestPos[i3 + 1] - cy;
      barkRadialRest[i3 + 2] = barkRestPos[i3 + 2] - cz;
    }
  }
  for (let i = 0; i < skN; i++) {
    skWorldOffX[i] = 0; skWorldOffY[i] = 0; skWorldOffZ[i] = 0;
    const s = skeleton[i];
    s.restPos.x = skRestX[i]; s.restPos.y = skRestY[i]; s.restPos.z = skRestZ[i];
    s.worldOffset.set(0, 0, 0);
    s.restLen = skRestLen[i];
    s.restOffFromParent.set(skRestOffX[i], skRestOffY[i], skRestOffZ[i]);
    s.hasRestParentDir = !!skHasParentDir[i];
    if (s.hasRestParentDir) {
      s.restParentDirGP.set(skRestParentDirX[i], skRestParentDirY[i], skRestParentDirZ[i]);
    }
  }
  if (skPrevX) { skPrevX.set(skPosX); skPrevY.set(skPosY); skPrevZ.set(skPosZ); }
  if (skVelX)  { skVelX.fill(0); skVelY.fill(0); skVelZ.fill(0); }
  if (typeof buildStemBaseMatrices === 'function') buildStemBaseMatrices();
  _sculptIsLive = true;
  _applySculptLiveClass();
}

function exitSculptMode({ commit }) {
  if (!_sculptActive) return;
  if (grabbedNodeIdx >= 0) onGrabEnd();
  if (commit) {
    // Per-release bakes have already written everything into rest, so
    // commit is just a mode teardown.
    toast(_sculptEditCount
      ? `Finished — ${_sculptEditCount} sculpt edit${_sculptEditCount === 1 ? '' : 's'} baked`
      : 'Sculpt mode exited', 'success', 1500);
  } else {
    _applySculptSnapshot(_sculptSnapshot);
    _sculptIsLive = false;
    _applySculptLiveClass();
    toast('Sculpt discarded', 'info', 1400);
  }
  P.wind.enabled = _sculptSavedWind;
  physicsOn = _sculptSavedPhysics;
  const _tbPhysicsBtn = document.getElementById('tb-physics');
  if (_tbPhysicsBtn) _tbPhysicsBtn.classList.toggle('active', physicsOn);
  _sculptActive = false;
  _sculptSnapshot = null;
  _sculptUndoStack.length = 0;
  _sculptEditCount = 0;
  document.body.classList.remove('sculpt-mode');
  if (_brushCursorEl) _brushCursorEl.hidden = true;
  if (typeof _closeBrushControls === 'function') _closeBrushControls();
  if (_brushPending) _brushPendingCleanup();
  _brushSuppressNextContextMenu = false;
  _brushGrabHappened = false;
  _destroySculptChrome();
  _simActive = true;
  markRenderDirty(5);
  const tbEdit = document.getElementById('tb-edit');
  if (tbEdit) tbEdit.classList.remove('active');
  _setModeTabActive?.('edit');
}

// Chrome bar floating at the top of the canvas while sculpting.
let _sculptChromeEl = null;
function _buildSculptChrome() {
  if (_sculptChromeEl) return _sculptChromeEl;
  const bar = document.createElement('div');
  bar.id = 'sculpt-bar';
  bar.innerHTML = `
    <div class="sc-bar-left">
      <span class="sc-bar-dot"></span>
      <span class="sc-bar-title">Sculpt</span>
      <span class="sc-bar-count"></span>
    </div>
    <div class="sc-bar-tool">
      <button type="button" class="sc-tool sc-tool-point" title="Grab a single branch" data-tool="point">
        ${iconSvg('mouse-pointer-2', 13)}
        <span>Point</span>
      </button>
      <button type="button" class="sc-tool sc-tool-brush" title="Brush-grab many joints with falloff ([/] to resize)" data-tool="brush">
        ${iconSvg('circle-dot', 13)}
        <span>Brush</span>
      </button>
      <span class="sc-brush-radius mono"></span>
    </div>
    <div class="sc-bar-actions">
      <button type="button" class="sc-bar-btn sc-undo" title="Undo last edit (Ctrl+Z)">
        ${iconSvg('rotate-ccw', 12)}
        <span>Undo</span>
      </button>
      <button type="button" class="sc-bar-btn sc-discard">Discard</button>
      <button type="button" class="sc-bar-btn sc-finish">Finish</button>
    </div>
  `;
  canvasWrap.appendChild(bar);
  _sculptChromeEl = bar;
  bar.querySelector('.sc-undo').addEventListener('click', sculptUndo);
  bar.querySelector('.sc-discard').addEventListener('click', () => exitSculptMode({ commit: false }));
  bar.querySelector('.sc-finish').addEventListener('click', () => exitSculptMode({ commit: true }));
  bar.querySelector('.sc-tool-point').addEventListener('click', () => setBrushMode(false));
  bar.querySelector('.sc-tool-brush').addEventListener('click', () => setBrushMode(true));
  const countEl = bar.querySelector('.sc-bar-count');
  const radiusEl = bar.querySelector('.sc-brush-radius');
  const ptBtn = bar.querySelector('.sc-tool-point');
  const brBtn = bar.querySelector('.sc-tool-brush');
  _sculptUpdateChrome = () => {
    const n = _sculptEditCount;
    countEl.textContent = n ? `· ${n} edit${n === 1 ? '' : 's'}` : '';
    const undoBtn = bar.querySelector('.sc-undo');
    undoBtn.disabled = _sculptUndoStack.length === 0;
    ptBtn.classList.toggle('on', !_brushMode);
    brBtn.classList.toggle('on', _brushMode);
    radiusEl.textContent = _brushMode ? `${Math.round(_brushRadius)}px` : '';
  };
  requestAnimationFrame(() => bar.classList.add('open'));
  return bar;
}
function _destroySculptChrome() {
  if (!_sculptChromeEl) return;
  const el = _sculptChromeEl;
  _sculptChromeEl = null;
  _sculptUpdateChrome = null;
  el.classList.remove('open');
  setTimeout(() => el.remove(), 220);
}

// --- Mode bar (Edit ↔ Sculpt) + entry warning -------------------------
let _sculptWarnSeen = false;
let _sculptWarnModalEl = null;

function _setModeTabActive(mode) {
  const bar = document.getElementById('mode-bar');
  if (!bar) return;
  for (const btn of bar.querySelectorAll('.mode-tab')) {
    btn.classList.toggle('on', btn.dataset.mode === mode);
  }
}

function requestEnterSculptMode() {
  if (_sculptActive) return;
  if (_sculptWarnSeen) { enterSculptMode(); return; }
  _buildSculptWarnModal()._open();
}

function _buildSculptWarnModal() {
  if (_sculptWarnModalEl) return _sculptWarnModalEl;
  const overlay = document.createElement('div');
  overlay.className = 'modal sculpt-warn-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-card" role="dialog" aria-label="Enter sculpt mode">
      <header class="modal-header">
        <div class="modal-title">Entering Sculpt mode</div>
        <button class="modal-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="modal-body">
        <p class="sw-lead">Sculpt mode lets you reshape branches by hand — and the sculpt is <strong>final</strong>.</p>
        <ul class="sw-list">
          <li>Wind and physics pause while you sculpt.</li>
          <li>Each branch you release becomes the new rest pose.</li>
          <li>After finishing, shape sliders (branching, length, thickness…) stay locked until you regenerate — otherwise the sculpt would be erased.</li>
          <li>You can always <strong>Discard</strong> mid-sculpt to undo everything in one go.</li>
        </ul>
        <label class="sw-dontshow"><input type="checkbox" class="sw-dontshow-cb" /> Don't show this again this session</label>
      </div>
      <footer class="modal-footer">
        <button class="modal-secondary sw-cancel" type="button">Cancel</button>
        <button class="modal-primary sw-go" type="button">Enter Sculpt</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  _sculptWarnModalEl = overlay;
  const hide = () => {
    overlay.hidden = true;
    _setModeTabActive(_sculptActive ? 'sculpt' : 'edit');
  };
  overlay.querySelector('.modal-close').addEventListener('click', hide);
  overlay.querySelector('.sw-cancel').addEventListener('click', hide);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
  overlay.querySelector('.modal-card').addEventListener('click', (e) => e.stopPropagation());
  const goBtn = overlay.querySelector('.sw-go');
  const dontCb = overlay.querySelector('.sw-dontshow-cb');
  goBtn.addEventListener('click', () => {
    if (dontCb.checked) _sculptWarnSeen = true;
    overlay.hidden = true;
    enterSculptMode();
  });
  window.addEventListener('keydown', (e) => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') { hide(); e.stopPropagation(); }
    else if (e.key === 'Enter') { goBtn.click(); e.stopPropagation(); }
  });
  overlay._open = () => { overlay.hidden = false; };
  return overlay;
}


// --- Sculpt mini toolbar (left floating bar, sculpt-mode only) ---------
let _sculptToolbarEl = null;
let _sculptSidebarUpdate = null;  // kept as the global sync hook name

function _buildSculptToolbar() {
  if (_sculptToolbarEl) return _sculptToolbarEl;
  const bar = document.getElementById('sculpt-toolbar');
  if (!bar) return null;
  _sculptToolbarEl = bar;

  const mkBtn = (title, svg, onClick, opts = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toolbar-btn' + (opts.danger ? ' danger' : '');
    b.title = title;
    b.innerHTML = svg;
    b.addEventListener('click', onClick);
    return b;
  };
  const mkSep = () => {
    const s = document.createElement('div');
    s.className = 'toolbar-sep';
    return s;
  };

  // Icons all sourced from the central Lucide registry (ICONS).
  const icoPoint = iconSvg('mouse-pointer-2');
  const icoBrush = iconSvg('circle-dot');
  const icoSkel  = iconSvg('spline');
  const icoWire  = iconSvg('box');
  const icoLeaf  = iconSvg('leaf');
  const icoUndo  = iconSvg('rotate-ccw');

  const btnPoint = mkBtn('Point — right-drag a single branch', icoPoint, () => setBrushMode(false));
  const btnBrush = mkBtn('Brush — right-drag many joints (right-click for settings)', icoBrush, () => setBrushMode(true));
  const btnSkel  = mkBtn('Skeleton view (S)', icoSkel, () => applySplineView(!splineViewOn));
  const btnWire  = mkBtn('Wireframe (W)', icoWire, () => applyMeshView(!meshViewOn));
  const btnLeaf  = mkBtn('Leaves (L)', icoLeaf, () => applyLeavesVisible(!leavesOn));
  const btnUndo  = mkBtn('Undo last edit (Ctrl+Z)', icoUndo, () => sculptUndo());

  bar.append(
    btnPoint, btnBrush,
    mkSep(),
    btnSkel, btnWire, btnLeaf,
    mkSep(),
    btnUndo,
  );

  _sculptSidebarUpdate = () => {
    btnPoint.classList.toggle('active', !_brushMode);
    btnBrush.classList.toggle('active', _brushMode);
    btnSkel.classList.toggle('active', splineViewOn);
    btnWire.classList.toggle('active', meshViewOn);
    btnLeaf.classList.toggle('active', leavesOn);
    btnUndo.disabled = _sculptUndoStack.length === 0;
    btnUndo.style.opacity = btnUndo.disabled ? '0.4' : '';
  };
  _sculptSidebarUpdate();
  return bar;
}

// Mode-bar click wiring (runs once at startup).
(function wireModeTabs() {
  const bar = document.getElementById('mode-bar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-tab');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'sculpt') {
      if (_sculptActive) return;
      _setModeTabActive('sculpt');
      requestEnterSculptMode();
    } else {
      // Edit — exit sculpt if active. Sculpt commits (the sculpted pose is
      // what the user wants to keep).
      if (_sculptActive) exitSculptMode({ commit: true });
    }
  });
})();

// --- Brush sub-mode plumbing: cursor indicator + radius control -------
const _brushCursorEl = document.getElementById('brush-cursor');
function setBrushMode(on) {
  _brushMode = !!on;
  if (_brushCursorEl) {
    if (_brushMode && _sculptActive) {
      _brushCursorEl.hidden = false;
      _brushCursorEl.style.width = _brushCursorEl.style.height = (_brushRadius * 2) + 'px';
    } else {
      _brushCursorEl.hidden = true;
    }
  }
  if (!_brushMode) _closeBrushControls();
  _sculptUpdateChrome?.();
  _sculptSidebarUpdate?.();
}
function _setBrushRadius(px) {
  _brushRadius = Math.max(20, Math.min(400, px));
  if (_brushCursorEl && !_brushCursorEl.hidden) {
    _brushCursorEl.style.width = _brushCursorEl.style.height = (_brushRadius * 2) + 'px';
  }
  _sculptUpdateChrome?.();
  _sculptSidebarUpdate?.();
}
// Follow the cursor while brush is visible.
if (_brushCursorEl) {
  window.addEventListener('pointermove', (e) => {
    if (_brushCursorEl.hidden) return;
    const rect = renderer.domElement.getBoundingClientRect();
    _brushCursorEl.style.left = (e.clientX - rect.left) + 'px';
    _brushCursorEl.style.top  = (e.clientY - rect.top)  + 'px';
  });
}
// [ and ] shrink / grow the brush while in sculpt + brush mode.
window.addEventListener('keydown', (e) => {
  if (!(_sculptActive && _brushMode)) return;
  const editable = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
  if (editable) return;
  if (e.key === '[') { _setBrushRadius(_brushRadius - 10); _syncBrushControls(); e.preventDefault(); }
  else if (e.key === ']') { _setBrushRadius(_brushRadius + 10); _syncBrushControls(); e.preventDefault(); }
});

// --- Brush controls popover (left-click in brush mode) ----------------
let _brushControlsEl = null;
function _syncBrushControls() {
  if (!_brushControlsEl) return;
  _brushControlsEl._radiusScrubber?._applyValue?.(_brushRadius);
}
// Scrubber-row builder used here expects a parameter descriptor, getter,
// setter, and an onAfter callback. We reuse it directly so brush sliders
// behave identically to sidebar sliders (drag, dbl-click reset, right-click
// menu, type-exact value).
const _BRUSH_RADIUS_PARAM   = { key: '_brush_radius',   label: 'Radius',   min: 20, max: 400, step: 1,    default: 42 };
const _BRUSH_STRENGTH_PARAM = { key: '_brush_strength', label: 'Strength', min: 0,  max: 1,   step: 0.01, default: 1  };

function _openBrushControls(clientX, clientY) {
  _closeBrushControls();
  const pop = document.createElement('div');
  pop.className = 'brush-controls';
  const title = document.createElement('div');
  title.className = 'bc-title';
  title.textContent = 'Brush';
  pop.appendChild(title);

  const radiusRow = createSliderRow(
    _BRUSH_RADIUS_PARAM,
    () => _brushRadius,
    (v) => { _setBrushRadius(v); },
    null,
    { noRegen: true },
  );
  const strengthRow = createSliderRow(
    _BRUSH_STRENGTH_PARAM,
    () => _brushStrength,
    (v) => { _brushStrength = v; },
    null,
    { noRegen: true },
  );
  pop.append(radiusRow, strengthRow);

  const hint = document.createElement('div');
  hint.className = 'bc-hint';
  hint.textContent = '[ ] resize · dbl-click to reset · click outside to close';
  pop.appendChild(hint);

  canvasWrap.appendChild(pop);
  _brushControlsEl = pop;
  // Keep a reference to the radius scrubber so keyboard [/] can sync the UI.
  _brushControlsEl._radiusScrubber = radiusRow.querySelector('.scrubber');

  const rect = canvasWrap.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  const popW = 260, popH = 140;
  pop.style.left = Math.max(8, Math.min(px + 8, rect.width - popW - 8)) + 'px';
  pop.style.top  = Math.max(8, Math.min(py + 8, rect.height - popH - 8)) + 'px';

  setTimeout(() => document.addEventListener('pointerdown', _brushControlsOutsideHandler, true), 0);
}
function _brushControlsOutsideHandler(e) {
  if (!_brushControlsEl) return;
  if (_brushControlsEl.contains(e.target)) return;
  _closeBrushControls();
}
function _closeBrushControls() {
  if (!_brushControlsEl) return;
  _brushControlsEl.remove();
  _brushControlsEl = null;
  document.removeEventListener('pointerdown', _brushControlsOutsideHandler, true);
}

// Flag set when a right-click actually started a brush grab, so the
// contextmenu handler can skip opening the popover on release.
let _brushGrabHappened = false;
// Track right-button press position. Installed on window with capture=true
// so it runs BEFORE any handler (branch grab, etc.) that might stopPropagation.
// At contextmenu time we compare coords directly — a drag never opens the menu.
let _rmbDownX = 0, _rmbDownY = 0;
const RMB_DRAG_THRESHOLD = 5;
window.addEventListener('pointerdown', (e) => {
  if (e.button === 2) { _rmbDownX = e.clientX; _rmbDownY = e.clientY; }
}, true);
// Block the browser's default right-click menu everywhere in the app.
// Element-level contextmenu handlers (scrubbers, canvas) bubble up first
// and open our own menus; this document-level preventDefault only stops
// the native menu where we don't show one.
document.addEventListener('contextmenu', (e) => { e.preventDefault(); });
renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // Drain single-shot suppression flags first so they never persist.
  const suppressed = _brushSuppressNextContextMenu;
  _brushSuppressNextContextMenu = false;
  const brushGrabJustEnded = _brushGrabHappened;
  _brushGrabHappened = false;
  // Drop any still-pending brush click from this gesture.
  if (_brushPending) _brushPendingCleanup();

  if (grabbedNodeIdx >= 0) return; // active grab swallows the event
  const dx = e.clientX - _rmbDownX, dy = e.clientY - _rmbDownY;
  const wasDrag = dx * dx + dy * dy > RMB_DRAG_THRESHOLD * RMB_DRAG_THRESHOLD;
  // Sculpt+brush owns the right-click in its mode — no canvas context menu.
  if (_sculptActive && _brushMode) {
    if (suppressed) return;        // pointerup already opened the popover
    if (brushGrabJustEnded) return; // drag finished a brush grab, not a click
    if (wasDrag) return;            // drag canceled without starting a grab
    _openBrushControls(e.clientX, e.clientY); // fallback path
    return;
  }
  if (wasDrag) return;
  if (brushGrabJustEnded) return;
  showCanvasContextMenu(e.clientX, e.clientY);
});

// --- Studio environment --------------------------------------------------
const THEMES = {
  light: {
    bg: 0xa09a8c,
    // `groundBg` is used when the backdrop is the Houdini-style infinite
    // plane — picked to blend the lit floor into the sky at the fog horizon
    // so the edge is invisible.
    groundBg: 0xb0a89a,
    gridBase: '#a09a8c',
    gridMinor: '#898274',
    gridMajor: '#6a6456',
    keyIntensity: 2.6,
    ambientIntensity: 0.3,
    wireColor: 0x1b2a3a,
  },
  dark: {
    bg: 0x242428,
    groundBg: 0x4a4a52,
    gridBase: '#1f1f23',
    gridMinor: '#141418',
    gridMajor: '#08080c',
    keyIntensity: 2.2,
    ambientIntensity: 0.15,
    wireColor: 0xa0c4ff,
  },
};
let currentTheme = 'dark';
const pmrem = new THREE.PMREMGenerator(renderer);
// Instant fallback so lighting is never "black" before the HDRI loads.
const _roomEnvRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
scene.environment = _roomEnvRT.texture;
// Embed mode matches the portfolio's tree.html page bg (#06070a) so the
// canvas seam is invisible against the host page.
const EMBED_BG = 0x06070a;
scene.background = new THREE.Color(EMBED_CLEAN ? EMBED_BG : THEMES[currentTheme].bg);
// Subtle atmospheric fog — pushed well past the tree's orbit range so the
// subject stays fully lit at normal zoom. Only kicks in on the far cyclorama.
// Embed mode fades the fog to the host page bg.
scene.fog = new THREE.Fog(EMBED_CLEAN ? EMBED_BG : THEMES[currentTheme].bg, 10, 258);

// HDRI environment (better reflections + color bounce). Keeps solid background.
let skyHDRTex = null;
new HDRLoader().load('./sky.hdr', (hdrTex) => {
  hdrTex.mapping = THREE.EquirectangularReflectionMapping;
  const envRt = pmrem.fromEquirectangular(hdrTex);
  scene.environment = envRt.texture;
  skyHDRTex = hdrTex; // keep alive so it can be shown as background
  // Drop the fallback room-env PMREM target — HDRI has replaced it.
  _roomEnvRT.dispose();
  if (sceneCfg.skyHdr) applySkyBackground();
});

// --- Post-processing (bloom + optional AO + DOF) ------------------------
const postProcessing = new THREE.RenderPipeline(renderer);
// We apply tone mapping + sRGB ourselves per-pass (see output node below) so
// the gizmo overlay can bypass tone mapping and stay flat UI-sharp.
postProcessing.outputColorTransform = false;
const scenePass = pass(scene, camera);
// MRT: render color + normal so AO can sample normal buffer.
if (aoFn) scenePass.setMRT(mrt({ output, normal: normalView }));
const scenePassColor  = scenePass.getTextureNode('output');
const scenePassDepth  = scenePass.getTextureNode('depth');
const scenePassNormal = aoFn ? scenePass.getTextureNode('normal') : null;

const bloomPass = bloom(scenePassColor, 0.35, 0.6, 0.9); // strength, radius, threshold
const uBloomScale = uniform(1.0); // multiplies bloom contribution — live-tunable via Settings

// Gizmo overlay pass — rendered from the dedicated gizmoScene. Alpha-blended
// on top of the post-processed scene in the output node, so bloom/AO/DOF
// never touch it. This is the canonical transform-handle approach.
const gizmoPass = pass(gizmoScene, camera);
const gizmoColor = gizmoPass.getTextureNode('output');

// AO uniforms & node
const uSsaoIntensity = uniform(1.0);
let aoTex = null;
if (aoFn && scenePassNormal) {
  try {
    aoTex = aoFn(scenePassDepth, scenePassNormal, camera).getTextureNode();
  } catch (e) { console.warn('AO init failed:', e.message); aoTex = null; }
}

// DOF uniforms & node
const uDofFocus    = uniform(12.0);
const uDofAperture = uniform(0.5);
const uDofMaxBlur  = uniform(0.015);
let dofPass = null;
if (dofFn) {
  try {
    dofPass = dofFn(scenePassColor, scenePassDepth, uDofFocus, uDofAperture, uDofMaxBlur);
  } catch (e) { console.warn('DOF init failed:', e.message); dofPass = null; }
}

function updatePostPipeline() {
  let colorNode = scenePassColor;
  if (sceneCfg && sceneCfg.dofOn && dofPass) colorNode = dofPass;
  if (sceneCfg && sceneCfg.ssaoOn && aoTex) {
    // Lerp between 1.0 (no AO) and the AO texture based on intensity uniform.
    const aoMixed = float(1.0).sub(float(1.0).sub(aoTex).mul(uSsaoIntensity));
    colorNode = colorNode.mul(aoMixed);
  }
  const scenePlusBloom = colorNode.add(bloomPass.mul(uBloomScale));
  // Scene: full output transform (ACES tone mapping + sRGB).
  const sceneFinal = renderOutput(scenePlusBloom);
  // Gizmos: sRGB conversion only — NoToneMapping keeps them flat UI-sharp.
  const gizmoFinal = renderOutput(gizmoColor, THREE.NoToneMapping);
  postProcessing.outputNode = mix(sceneFinal, gizmoFinal, gizmoColor.a);
}
// Safe default until sceneCfg is declared later in init.
postProcessing.outputNode = mix(
  renderOutput(scenePassColor.add(bloomPass.mul(uBloomScale))),
  renderOutput(gizmoColor, THREE.NoToneMapping),
  gizmoColor.a,
);

// --- Tree worker pool ---------------------------------------------------
// Pool of N workers. Worker #0 also handles single-threaded tree building
// ('build-tree-and-chains'); all workers handle parallel tube construction
// ('build-tubes'). Pool size = min(4, hardwareConcurrency - 1) — leaves one
// core for the main thread + GPU driver.
const _treePoolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const _treeWorkers = [];
const _workerReady = [];      // parallel — true once that worker sent 'ready'
let _treeWorkerReady = false; // becomes true once ALL workers are ready
let _workerReqSeq = 0;
// Each pending entry: { resolve, workerIdx, timer }. Knowing which worker
// owns a request lets us fail pending promises when that worker errors,
// instead of hanging Promise.all forever. `timer` is a watchdog.
const _workerPending = new Map();

function _settlePending(reqId, value) {
  const p = _workerPending.get(reqId);
  if (!p) return;
  _workerPending.delete(reqId);
  if (p.timer) clearTimeout(p.timer);
  p.resolve(value);
}

function _failWorkerPending(workerIdx) {
  // Resolve every in-flight request owned by this worker with null so the
  // caller falls back to sync instead of hanging.
  for (const [reqId, p] of _workerPending) {
    if (p.workerIdx === workerIdx) {
      _workerPending.delete(reqId);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(null);
    }
  }
}

function _onPoolMessageFor(workerIdx, e) {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'ready') {
    _workerReady[workerIdx] = true;
    if (_workerReady.length && _workerReady.every(Boolean)) _treeWorkerReady = true;
    return;
  }
  if (msg.type === 'tubes-built') {
    _settlePending(msg.payload.reqId, msg.payload.tubes);
    return;
  }
  if (msg.type === 'tree-and-chains-built') {
    const { reqId, tree, chainsIdx, chainsSer } = msg.payload;
    _settlePending(reqId, { tree, chainsIdx, chainsSer });
    return;
  }
  if (msg.type === 'tree-build-error') {
    _settlePending(msg.payload.reqId, null);
    console.warn('[tree-worker] tree build failed, falling back to sync:', msg.payload.message);
    return;
  }
}
try {
  for (let i = 0; i < _treePoolSize; i++) {
    // Reuse prewarmed worker if available (hoisted above renderer.init), else
    // spawn now. Prewarmed workers may have already posted 'ready' — those
    // queue until onmessage is attached on the next line.
    const w = _prewarmedWorkers[i]
      || new Worker(new URL(`./tree-worker.js?v=${Date.now()}`, import.meta.url), { type: 'module' });
    const idx = i;
    // Detach the prewarm buffering listener and replay any messages it caught.
    if (w._earlyListener) {
      w.removeEventListener('message', w._earlyListener);
      const queued = w._earlyMsgs || [];
      w._earlyListener = null;
      w._earlyMsgs = null;
      // Defer replay to next microtask so onmessage is wired up first.
      queueMicrotask(() => {
        for (const data of queued) _onPoolMessageFor(idx, { data });
      });
    }
    w.onmessage = (e) => _onPoolMessageFor(idx, e);
    w.onerror = (err) => {
      console.warn(`[tree-worker #${idx}] error, disabling worker path:`, err.message || err);
      _treeWorkerReady = false;
      // Unblock any callers awaiting a reply from this worker — otherwise
      // Promise.all inside buildTubesViaPool hangs forever and the UI freezes.
      _failWorkerPending(idx);
    };
    w.onmessageerror = () => {
      console.warn(`[tree-worker #${idx}] messageerror; unblocking pending`);
      _failWorkerPending(idx);
    };
    _treeWorkers.push(w);
    _workerReady.push(false);
  }
} catch (err) {
  console.warn('[tree-worker] pool unavailable, using sync build:', err);
}

// Send a 'build-tubes' batch to a specific worker in the pool. A 15s
// watchdog resolves with null if the worker never replies (e.g. it crashed
// hard and neither onerror nor onmessageerror fired). Keeps the UI alive.
const _WORKER_WATCHDOG_MS = 15000;
function _sendTubeBatch(workerIdx, chainsSer, profilePoints, taperPoints, isScrubbingArg, displace) {
  const reqId = ++_workerReqSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (_workerPending.has(reqId)) {
        console.warn(`[tree-worker #${workerIdx}] watchdog fired on reqId=${reqId}`);
        _settlePending(reqId, null);
      }
    }, _WORKER_WATCHDOG_MS);
    _workerPending.set(reqId, { resolve, workerIdx, timer });
    _treeWorkers[workerIdx].postMessage({
      type: 'build-tubes',
      payload: { chains: chainsSer, profilePoints, taperPoints, isScrubbing: isScrubbingArg, displace, reqId, barkTexScaleV: P.barkTexScaleV ?? 0.5 },
    });
  });
}

// Longest-first greedy bin-packing: group chains into `poolSize` bins by total
// node count so each bin carries a similar workload.
function _splitChainsAcrossPool(chainsSer, poolSize) {
  if (poolSize <= 1 || chainsSer.length === 0) {
    return [{ chains: chainsSer.slice(), origIdx: chainsSer.map((_, i) => i) }];
  }
  if (chainsSer.length <= poolSize) {
    // one chain per bin, some bins may stay empty
    const bins = [];
    chainsSer.forEach((c, i) => bins.push({ chains: [c], origIdx: [i] }));
    return bins;
  }
  const sorted = chainsSer.map((c, i) => ({ c, i, len: c.nodes.length }))
    .sort((a, b) => b.len - a.len);
  const bins = Array.from({ length: poolSize }, () => ({ chains: [], origIdx: [], load: 0 }));
  for (const item of sorted) {
    let minBin = bins[0];
    for (let k = 1; k < bins.length; k++) if (bins[k].load < minBin.load) minBin = bins[k];
    minBin.chains.push(item.c);
    minBin.origIdx.push(item.i);
    minBin.load += item.len;
  }
  return bins.filter((b) => b.chains.length);
}

// Parallel tube build across the pool. Returns tubes in the ORIGINAL order.
async function buildTubesViaPool(chainsSer, profilePoints, taperPoints, isScrubbingArg, displace) {
  if (!_treeWorkerReady || _treeWorkers.length === 0 || chainsSer.length === 0) return null;
  const bins = _splitChainsAcrossPool(chainsSer, _treeWorkers.length);
  const results = await Promise.all(bins.map((bin, k) =>
    _sendTubeBatch(k, bin.chains, profilePoints, taperPoints, isScrubbingArg, displace)
      .then((tubes) => ({ tubes, origIdx: bin.origIdx }))
  ));
  const out = new Array(chainsSer.length);
  for (const { tubes, origIdx } of results) {
    if (!tubes) return null;
    for (let j = 0; j < tubes.length; j++) out[origIdx[j]] = tubes[j];
  }
  return out;
}

// Orchestrates the full pipeline across the worker pool:
//   1. Worker #0 builds tree + chains (sequential — buildTree is branchy,
//      not parallelizable).
//   2. All pool workers (including #0) build tubes in parallel — chains are
//      split into N bins by a longest-first greedy bin-packing pass so each
//      worker gets roughly the same node-count load.
// Returns `{ tree, chains, tubes }` or null if the pool is unavailable /
// fails so the caller can fall back to sync.
async function buildTreeAndTubesViaWorker(profilePoints, taperPoints, isScrubbingArg, displace) {
  if (!_treeWorkerReady || _treeWorkers.length === 0) return null;
  const state = {
    seed: P.seed >>> 0,
    attractors: Array.isArray(P.attractors) ? P.attractors.map((a) => ({ x: a.x, y: a.y, z: a.z, strength: a.strength })) : [],
    lengthPoints: (lengthSpline && lengthSpline.points) ? lengthSpline.points.slice() : null,
    P: {
      trunkHeight: P.trunkHeight, trunkSteps: P.trunkSteps, trunkJitter: P.trunkJitter,
      trunkCount: P.trunkCount, trunkSplitSpread: P.trunkSplitSpread, trunkSplitHeight: P.trunkSplitHeight, trunkTwist: P.trunkTwist,
      trunkSinuous: P.trunkSinuous, trunkSinuousFreq: P.trunkSinuousFreq,
      trunkLean: P.trunkLean, trunkLeanDir: P.trunkLeanDir, trunkBow: P.trunkBow,
      trunkScale: P.trunkScale, rootFlare: P.rootFlare,
      tipRadius: P.tipRadius, baseRadius: P.baseRadius, taperExp: P.taperExp,
      alloExp: P.alloExp, branchThickness: P.branchThickness,
      minLen: P.minLen, growthPhase: P.growthPhase, goldenRoll: P.goldenRoll, globalScale: P.globalScale,
      branchModel: P.branchModel, hondaR1: P.hondaR1, hondaR2: P.hondaR2,
      // Crown silhouette + clean-bole fraction. Previously omitted from the
      // worker payload, so worker-built trees silently defaulted to 'free'
      // (no shape envelope) and baseSize=0 (no clean bole). That broke the
      // intended silhouette for every species that sets these.
      shape: P.shape, baseSize: P.baseSize,
      // Scrub flag: worker skips its gravity-sag mirror during drags.
      _scrubSkipSag: isScrubbingArg ? 1 : 0,
      gravityStrength: P.gravityStrength, gravityStiffness: P.gravityStiffness,
      branchWobble: P.branchWobble, branchWobbleFreq: P.branchWobbleFreq,
      sunAzimuth: P.sunAzimuth, sunElevation: P.sunElevation,
      pruneMode: P.pruneMode, pruneRadius: P.pruneRadius, pruneHeight: P.pruneHeight, pruneCenterY: P.pruneCenterY,
      levels: P.levels.map((L) => ({ ...L })),
    },
  };
  // Phase 1: tree + chains on worker #0.
  const reqId = ++_workerReqSeq;
  const treeRes = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (_workerPending.has(reqId)) {
        console.warn(`[tree-worker #0] watchdog fired on tree-build reqId=${reqId}`);
        _settlePending(reqId, null);
      }
    }, _WORKER_WATCHDOG_MS);
    _workerPending.set(reqId, { resolve, workerIdx: 0, timer });
    _treeWorkers[0].postMessage({
      type: 'build-tree-and-chains',
      payload: { state, reqId },
    });
  });
  if (!treeRes) return null;
  const { tree, chainsIdx, chainsSer } = treeRes;
  // Phase 2: tubes in parallel across the pool.
  const tubes = await buildTubesViaPool(chainsSer, profilePoints, taperPoints, isScrubbingArg, displace);
  if (!tubes) return null;
  // chainsSer is returned so the caller can cache it for the tubes-only fast
  // path — re-extruding tubes after a taper/profile/displace slider drag
  // skips the whole buildTree+buildChains phase.
  return { tree, chains: chainsIdx, tubes, chainsSer };
}

// Rehydrate a transferred SoA tree into a main-thread TNode array. Downstream
// code (_foliagePhase, skeleton construction) reads `.pos`, `.parent`,
// `.children`, `.radius`, `.pruned`, `.idx` — we supply exactly that interface.
function rehydrateTreeFromSoA(tree, chainsIdx) {
  const n = tree.numNodes;
  const nodes = new Array(n);
  const posX = tree.posX, posY = tree.posY, posZ = tree.posZ;
  const parentIdx = tree.parentIdx, radius = tree.radius, prunedFlags = tree.prunedFlags;
  for (let i = 0; i < n; i++) {
    nodes[i] = new TNode(new THREE.Vector3(posX[i], posY[i], posZ[i]));
    nodes[i].radius = radius[i];
    nodes[i].pruned = prunedFlags[i] !== 0;
    nodes[i].idx = i;
  }
  for (let i = 0; i < n; i++) {
    const p = parentIdx[i];
    if (p >= 0) {
      nodes[i].parent = nodes[p];
      nodes[p].children.push(nodes[i]);
    }
  }
  const chains = new Array(chainsIdx.length);
  for (let i = 0; i < chainsIdx.length; i++) {
    const ci = chainsIdx[i];
    const chain = new Array(ci.length);
    for (let k = 0; k < ci.length; k++) chain[k] = nodes[ci[k]];
    chains[i] = chain;
  }
  return { nodes, chains };
}

// --- Majestic backlit hero lighting -------------------------------------
// Backlit landscape-photography setup: warm golden 3/4 back-light wraps
// every branch in rim halo, soft cool front fill keeps the shadow side
// readable, side warm rim adds depth. The classic look photographers go
// for when shooting a hero tree at golden hour.
//
// `key` is the BACKLIGHT (camera looks toward sun, sun behind tree).
const key = new THREE.DirectionalLight(0xfff4ea, 3.4); // near-daylight ~5500 K with a hint of warm
key.position.set(-7, 13, -11); // behind-left, elevated ~30°
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
// Frustum sized for the new backlight: shadow extends FORWARD of the
// tree (toward camera) rather than just beneath it, so the ground side
// (negative-Y in light space) needs more room than the old front-key did.
key.shadow.camera.left = -28;
key.shadow.camera.right = 28;
key.shadow.camera.top = 32;
key.shadow.camera.bottom = -12;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 70;
key.shadow.bias = -0.0015;
// NB: shadow.radius is ignored by PCFSoftShadowMap — don't set it here.
scene.add(key);
// Front fill — soft cool, lifts the shadow side without flattening contrast.
const fill = new THREE.DirectionalLight(0xc0d4ee, 0.6);
fill.position.set(8, 5, 11);
scene.add(fill);
// Side rim — neutral white edge so the wrap continues around the tree
// instead of clipping to silhouette on the front.
const rim = new THREE.DirectionalLight(0xffffff, 1.2);
rim.position.set(11, 7, -3);
scene.add(rim);
// Tiny pure-ambient lift so the deepest shadow pockets aren't crushed.
const ambient = new THREE.AmbientLight(0xffffff, 0.12);
scene.add(ambient);

const LIGHTING_PRESETS = {
  Majestic: {
    // Studio backlit hero — neutral daylight key from behind, cool fill
    // from the front, neutral white side rim. Same backlight DRAMA as
    // golden hour but without the orange cast (use 'Golden Hour' preset
    // for that look).
    key:     { color: 0xfff4ea, intensity: 3.4, pos: [-7, 13, -11] },
    fill:    { color: 0xc0d4ee, intensity: 0.6, pos: [8, 5, 11] },
    rim:     { color: 0xffffff, intensity: 1.2, pos: [11, 7, -3] },
    ambient: { color: 0xffffff, intensity: 0.12 },
  },
  Studio: {
    key:     { color: 0xfff3e4, intensity: 2.6, pos: [10, 18, 8] },
    fill:    { color: 0xc8dfff, intensity: 0.9, pos: [-9, 7, 5] },
    rim:     { color: 0xffffff, intensity: 1.4, pos: [0, 9, -14] },
    ambient: { color: 0xffffff, intensity: 0.30 },
  },
  'Golden Hour': {
    key:     { color: 0xffb070, intensity: 3.2, pos: [14, 6, 10] },
    fill:    { color: 0xff9060, intensity: 0.5, pos: [-8, 5, 6] },
    rim:     { color: 0xffd8a0, intensity: 1.8, pos: [-4, 8, -14] },
    ambient: { color: 0xffc090, intensity: 0.25 },
  },
  Overcast: {
    key:     { color: 0xdfe4ea, intensity: 1.3, pos: [6, 22, 6] },
    fill:    { color: 0xcdd4de, intensity: 1.0, pos: [-8, 12, 4] },
    rim:     { color: 0xe8ecf0, intensity: 0.8, pos: [0, 14, -12] },
    ambient: { color: 0xe8ecf0, intensity: 0.75 },
  },
  Moonlight: {
    key:     { color: 0x8fb0e0, intensity: 1.4, pos: [6, 16, 4] },
    fill:    { color: 0x5f7fb0, intensity: 0.5, pos: [-8, 8, 6] },
    rim:     { color: 0xaac4ff, intensity: 1.2, pos: [-2, 10, -14] },
    ambient: { color: 0x2a3548, intensity: 0.50 },
  },
  Noon: {
    key:     { color: 0xffffff, intensity: 3.2, pos: [2, 24, 3] },
    fill:    { color: 0xd4e4ff, intensity: 0.6, pos: [-10, 8, 8] },
    rim:     { color: 0xffffff, intensity: 0.8, pos: [0, 10, -14] },
    ambient: { color: 0xffffff, intensity: 0.45 },
  },
  Dramatic: {
    key:     { color: 0xfff0e0, intensity: 2.2, pos: [14, 10, -4] },
    fill:    { color: 0x30405c, intensity: 0.2, pos: [-10, 6, 6] },
    rim:     { color: 0xffffff, intensity: 2.8, pos: [-4, 10, -12] },
    ambient: { color: 0x1e2230, intensity: 0.10 },
  },
  Sunset: {
    key:     { color: 0xff7040, intensity: 2.8, pos: [16, 4, 8] },
    fill:    { color: 0xd850a0, intensity: 0.8, pos: [-10, 4, 0] },
    rim:     { color: 0xff9060, intensity: 2.0, pos: [-4, 8, -12] },
    ambient: { color: 0x604060, intensity: 0.30 },
  },
};
let currentLighting = 'Majestic';
function applyLighting(name) {
  const L = LIGHTING_PRESETS[name];
  if (!L) return;
  currentLighting = name;
  key.color.setHex(L.key.color);
  key.intensity = L.key.intensity;
  key.position.set(L.key.pos[0], L.key.pos[1], L.key.pos[2]);
  fill.color.setHex(L.fill.color);
  fill.intensity = L.fill.intensity;
  fill.position.set(L.fill.pos[0], L.fill.pos[1], L.fill.pos[2]);
  rim.color.setHex(L.rim.color);
  rim.intensity = L.rim.intensity;
  rim.position.set(L.rim.pos[0], L.rim.pos[1], L.rim.pos[2]);
  ambient.color.setHex(L.ambient.color);
  ambient.intensity = L.ambient.intensity;
}

// --- Settings appliers (live renderer + scene tuning) --------------------
const TONE_MAPPINGS = {
  'None':        THREE.NoToneMapping,
  'Linear':      THREE.LinearToneMapping,
  'Reinhard':    THREE.ReinhardToneMapping,
  'Cineon':      THREE.CineonToneMapping,
  'ACES Filmic': THREE.ACESFilmicToneMapping,
  'AgX':         THREE.AgXToneMapping,
  'Neutral':     THREE.NeutralToneMapping,
};
const SHADOW_QUALITIES = { Low: 1024, Medium: 2048, High: 4096 };
let _axesHelper = null;

// Coalesce rapid slider changes so expensive re-allocations (pixel ratio →
// swap-chain resize, shadow quality → dispose + realloc shadow maps) only
// fire once after the user stops dragging.
const _applyTimers = new Map();
function debouncedApply(key, fn, ms = 220) {
  const prev = _applyTimers.get(key);
  if (prev) clearTimeout(prev);
  _applyTimers.set(key, setTimeout(() => { _applyTimers.delete(key); fn(); }, ms));
}

function applyExposure(v) {
  renderer.toneMappingExposure = v;
}
// Mark the handful of materials that actually need a shader recompile on
// tone-mapping / shadow toggles. Cheaper than scene.traverse.
function refreshCoreMaterials() {
  const mats = [barkMat, leafMatA, leafMatB, cycMaterial, stemMat, coneMat,
                needleMatA, needleMatB];
  for (const m of mats) { if (m) m.needsUpdate = true; }
}
function applyToneMapping(name) {
  const t = TONE_MAPPINGS[name];
  if (t === undefined) return;
  renderer.toneMapping = t;
  refreshCoreMaterials();
}
function applyPixelRatio(r) {
  renderer.setPixelRatio(r);
  renderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
}
function applyShadowsEnabled(on) {
  renderer.shadowMap.enabled = on;
  refreshCoreMaterials();
}
function applyShadowQuality(name) {
  const size = SHADOW_QUALITIES[name] ?? 2048;
  scene.traverse((o) => {
    if (o.isLight && o.shadow && o.castShadow) {
      o.shadow.mapSize.set(size, size);
      if (o.shadow.map) { o.shadow.map.dispose(); o.shadow.map = null; }
    }
  });
}
function applyBloom(on, intensity) {
  uBloomScale.value = on ? intensity : 0;
}
function applyFog(enabled, near, far) {
  if (!enabled) { scene.fog = null; return; }
  const bgColor = (THEMES[currentTheme] && THEMES[currentTheme].bg) ?? 0x0a0a0a;
  if (!scene.fog) scene.fog = new THREE.Fog(bgColor, near, far);
  else { scene.fog.near = near; scene.fog.far = far; }
}
function applyEnvIntensity(v) {
  scene.environmentIntensity = v;
}
function applyAxes(on) {
  if (on && !_axesHelper) {
    _axesHelper = new THREE.AxesHelper(6);
    _axesHelper.position.y = 0.02;
    scene.add(_axesHelper);
  } else if (!on && _axesHelper) {
    scene.remove(_axesHelper);
    _axesHelper.dispose?.();
    _axesHelper = null;
  }
}

// --- Attractor gizmos: sphere target + XYZ drag handles -------------------
// Keeps one gizmo per entry in P.attractors. Raycast picks axis shafts/tips
// for single-axis dragging — project cursor onto a plane that contains the
// axis and is most perpendicular to the view direction, then clamp motion
// to the axis.
const _attractorGizmos = [];
const _attractorRoot = new THREE.Group();
_attractorRoot.name = 'attractorGizmos';
gizmoScene.add(_attractorRoot);
let _refreshAttractorUI = null; // set by the attractor IIFE so drag can sync sliders

function _makeAttractorGizmo() {
  const group = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0xf2f3f5, depthTest: false }),
  );
  sphere.renderOrder = 999;
  group.add(sphere);

  const axes = {};
  const axisDefs = [
    { key: 'x', color: 0xff5a6a, dir: new THREE.Vector3(1, 0, 0) },
    { key: 'y', color: 0x7dd87d, dir: new THREE.Vector3(0, 1, 0) },
    { key: 'z', color: 0x66a0ff, dir: new THREE.Vector3(0, 0, 1) },
  ];
  for (const def of axisDefs) {
    const arrow = new THREE.Group();
    const shaftMat = new THREE.MeshBasicMaterial({ color: def.color, depthTest: false });
    const tipMat = new THREE.MeshBasicMaterial({ color: def.color, depthTest: false });
    shaftMat.userData._baseColor = def.color;
    tipMat.userData._baseColor = def.color;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.25, 10), shaftMat);
    shaft.position.y = 0.625;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.32, 14), tipMat);
    tip.position.y = 1.42;
    // Invisible wider hitboxes — picking feels forgiving without bloating
    // the visible arrow. One chunky capsule covering the full shaft+tip.
    const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const pickShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.7, 10), pickMat);
    pickShaft.position.y = 0.85;
    pickShaft.renderOrder = 1002;
    pickShaft.userData.axis = def.key;
    pickShaft.userData._parentGroup = group;
    arrow.add(shaft, tip, pickShaft);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), def.dir);
    shaft.renderOrder = 1001; tip.renderOrder = 1001;
    shaft.userData.axis = def.key; tip.userData.axis = def.key;
    shaft.userData._parentGroup = group; tip.userData._parentGroup = group;
    group.add(arrow);
    axes[def.key] = { group: arrow, shaft, tip, pickShaft };
  }
  return { group, sphere, axes };
}

function syncAttractorGizmos() {
  // Only manual attractors get full draggable gizmos. Seeded crown attractors
  // would flood the scene with hundreds of overlapping arrow widgets.
  const manualIdx = [];
  for (let i = 0; i < P.attractors.length; i++) if (!P.attractors[i].seeded) manualIdx.push(i);
  while (_attractorGizmos.length < manualIdx.length) {
    const giz = _makeAttractorGizmo();
    _attractorRoot.add(giz.group);
    _attractorGizmos.push(giz);
  }
  while (_attractorGizmos.length > manualIdx.length) {
    const giz = _attractorGizmos.pop();
    _attractorRoot.remove(giz.group);
    giz.sphere.geometry.dispose(); giz.sphere.material.dispose();
    for (const k of ['x','y','z']) {
      giz.axes[k].shaft.geometry.dispose(); giz.axes[k].shaft.material.dispose();
      giz.axes[k].tip.geometry.dispose(); giz.axes[k].tip.material.dispose();
      giz.axes[k].pickShaft.geometry.dispose(); giz.axes[k].pickShaft.material.dispose();
    }
  }
  for (let g = 0; g < manualIdx.length; g++) {
    const i = manualIdx[g];
    const a = P.attractors[i];
    _attractorGizmos[g].group.position.set(a.x, a.y, a.z);
    _attractorGizmos[g].group.userData.attractorIdx = i;
  }
}

const _gizRay = new THREE.Raycaster();
const _gizNdc = new THREE.Vector2();
const _gizViewDir = new THREE.Vector3();
const _gizCross = new THREE.Vector3();
const _gizHitStart = new THREE.Vector3();
const _gizHit = new THREE.Vector3();
let _gizDrag = null;

function _collectGizmoPickTargets() {
  const out = [];
  for (const giz of _attractorGizmos) {
    // pickShaft goes first so its chunky hitbox wins over the thin visible mesh.
    out.push(giz.axes.x.pickShaft, giz.axes.y.pickShaft, giz.axes.z.pickShaft,
             giz.axes.x.shaft, giz.axes.x.tip,
             giz.axes.y.shaft, giz.axes.y.tip,
             giz.axes.z.shaft, giz.axes.z.tip);
  }
  return out;
}

function onAttractorPointerDown(e) {
  if (e.button !== 0 || _attractorGizmos.length === 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _gizNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _gizNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _gizRay.setFromCamera(_gizNdc, camera);
  const hits = _gizRay.intersectObjects(_collectGizmoPickTargets(), false);
  if (!hits.length) return;
  const hit = hits[0];
  const groupRef = hit.object.userData._parentGroup;
  const idx = groupRef?.userData.attractorIdx;
  if (idx == null) return;
  const axisKey = hit.object.userData.axis;
  const axisDir = new THREE.Vector3(axisKey === 'x' ? 1 : 0, axisKey === 'y' ? 1 : 0, axisKey === 'z' ? 1 : 0);
  camera.getWorldDirection(_gizViewDir);
  // Plane normal = axis × (view × axis). Degenerate if axis ∥ view.
  _gizCross.crossVectors(_gizViewDir, axisDir);
  const normal = new THREE.Vector3().crossVectors(axisDir, _gizCross);
  if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);
  normal.normalize();
  const origin = new THREE.Vector3(P.attractors[idx].x, P.attractors[idx].y, P.attractors[idx].z);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
  if (!_gizRay.ray.intersectPlane(plane, _gizHitStart)) return;
  _gizDrag = {
    idx, axisKey, axisDir,
    plane,
    hitStart: _gizHitStart.clone(),
    startVal: P.attractors[idx][axisKey],
  };
  e.stopPropagation();
  e.preventDefault();
  renderer.domElement.style.cursor = 'grabbing';
  window.addEventListener('pointermove', onAttractorPointerMove, true);
  window.addEventListener('pointerup', onAttractorPointerUp, true);
}

function onAttractorPointerMove(e) {
  if (!_gizDrag) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _gizNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _gizNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _gizRay.setFromCamera(_gizNdc, camera);
  if (!_gizRay.ray.intersectPlane(_gizDrag.plane, _gizHit)) return;
  const along = _gizHit.sub(_gizDrag.hitStart).dot(_gizDrag.axisDir);
  P.attractors[_gizDrag.idx][_gizDrag.axisKey] = _gizDrag.startVal + along;
  syncAttractorGizmos();
  debouncedGenerate();
}

function onAttractorPointerUp() {
  if (!_gizDrag) return;
  _gizDrag = null;
  renderer.domElement.style.cursor = '';
  window.removeEventListener('pointermove', onAttractorPointerMove, true);
  window.removeEventListener('pointerup', onAttractorPointerUp, true);
  if (_refreshAttractorUI) _refreshAttractorUI();
}

renderer.domElement.addEventListener('pointerdown', onAttractorPointerDown, true);

// Hover highlight: flash the axis arrow white so the user knows what they'll
// grab. Runs only when gizmos exist and no drag is active.
const _gizHoverWhite = 0xffffff;
let _gizHovered = null; // { group, axisKey } | null
function _setGizmoHover(next) {
  if (next && _gizHovered && next.group === _gizHovered.group && next.axisKey === _gizHovered.axisKey) return;
  if (_gizHovered) {
    const ax = _gizHovered.group?.userData?.attractorIdx;
    const giz = ax != null ? _attractorGizmos[ax] : null;
    if (giz) {
      const a = giz.axes[_gizHovered.axisKey];
      if (a) {
        a.shaft.material.color.setHex(a.shaft.material.userData._baseColor);
        a.tip.material.color.setHex(a.tip.material.userData._baseColor);
      }
    }
  }
  _gizHovered = next;
  if (_gizHovered) {
    const ax = _gizHovered.group?.userData?.attractorIdx;
    const giz = ax != null ? _attractorGizmos[ax] : null;
    if (giz) {
      const a = giz.axes[_gizHovered.axisKey];
      if (a) {
        a.shaft.material.color.setHex(_gizHoverWhite);
        a.tip.material.color.setHex(_gizHoverWhite);
      }
    }
  }
}
function onAttractorPointerHover(e) {
  if (_gizDrag || _attractorGizmos.length === 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _gizNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _gizNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _gizRay.setFromCamera(_gizNdc, camera);
  const hits = _gizRay.intersectObjects(_collectGizmoPickTargets(), false);
  if (!hits.length) { _setGizmoHover(null); return; }
  const hit = hits[0];
  const groupRef = hit.object.userData._parentGroup;
  const axisKey = hit.object.userData.axis;
  if (!groupRef || !axisKey) { _setGizmoHover(null); return; }
  _setGizmoHover({ group: groupRef, axisKey });
}
renderer.domElement.addEventListener('pointermove', onAttractorPointerHover);
renderer.domElement.addEventListener('pointerleave', () => _setGizmoHover(null));

// --- Studio floor: Unity-style grid ---------------------------------------
function makeGridTexture(size, cells, baseColor, minorColor, majorColor) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, size, size);
  const step = size / cells;
  ctx.strokeStyle = minorColor;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.65;
  for (let i = 1; i < cells; i++) {
    const p = i * step;
    ctx.beginPath(); ctx.moveTo(p + 0.5, 0); ctx.lineTo(p + 0.5, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p + 0.5); ctx.lineTo(size, p + 0.5); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = majorColor;
  ctx.lineWidth = 1;
  // Major interval = 1 m (every 4 cells at 0.25 m per cell).
  for (let i = 0; i <= cells; i += 4) {
    const p = i * step;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  // Scale label inside one 1 m × 1 m major cell. Picked off-centre so the
  // tiled copies never land on the tree base. Drawn in the same colour as
  // the grid's major lines so it reads as part of the grid graphic, not as
  // a separate UI overlay. Flipped 180° so it faces the default camera.
  {
    const major = step * 4;          // px per 1 m square
    const labelCol = 5;
    const labelRow = 5;
    const lx = labelCol * major;
    const ly = labelRow * major;
    const cx = lx + major * 0.5;
    const cy = ly + major * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = majorColor;
    ctx.font = `600 ${Math.round(major * 0.34)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Rotate 180° around the cell centre so the glyphs face the camera
    // when the texture is mapped onto the floor plane (looking down/forward
    // from the default orbit pose, the un-flipped text reads upside-down).
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI);
    ctx.fillText('1 m', 0, 0);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Cyclorama studio backdrop: floor → quarter-circle sweep → wall, single mesh
// World-aligned UVs so the grid flows seamlessly across all three sections.
const CYC = {
  width: 360,
  floorLength: 90,   // floor extent forward from sweep start (toward camera)
  sweepRadius: 22,   // quarter-circle fillet radius
  wallHeight: 80,    // wall top above ground
  widthSegs: 6,
  floorSegs: 24,
  sweepSegs: 18,
  wallSegs: 18,
  sweepStartZ: -30,  // where the floor ends and sweep begins (behind tree)
};
const TILE_METERS = 40; // one texture tile covers 40m → 40 cells at 1m each

// Houdini-style infinite ground: a single large plane at y=0, world-aligned
// UVs so the grid tile lines up exactly with the cyclorama's grid. Fog fades
// the edge so there's no visible border.
function buildGroundGeometry() {
  const extent = 2000; // half-size → 4km plane, well beyond any reasonable fog far
  const segs = 1;
  const geo = new THREE.PlaneGeometry(extent * 2, extent * 2, segs, segs);
  geo.rotateX(-Math.PI / 2);
  // World-aligned UVs (each tile = TILE_METERS) so the same grid texture works
  // seamlessly with the cyclorama.
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / TILE_METERS, pos.getZ(i) / TILE_METERS);
  }
  uv.needsUpdate = true;
  return geo;
}

function buildCycloramaGeometry() {
  // Profile in (z, y) — seam placed at z = sweepStartZ
  const profile = [];
  // Floor (camera-side down to sweep start)
  for (let i = 0; i <= CYC.floorSegs; i++) {
    const t = i / CYC.floorSegs;
    profile.push({ z: CYC.sweepStartZ + CYC.floorLength * (1 - t), y: 0 });
  }
  // Quarter-circle sweep (center at z = sweepStartZ, y = sweepRadius)
  for (let i = 1; i <= CYC.sweepSegs; i++) {
    const t = i / CYC.sweepSegs;
    const a = -Math.PI / 2 - t * (Math.PI / 2);
    profile.push({
      z: CYC.sweepStartZ + CYC.sweepRadius * Math.cos(a),
      y: CYC.sweepRadius + CYC.sweepRadius * Math.sin(a),
    });
  }
  // Wall, going up from the top of the sweep
  const wallBaseY = CYC.sweepRadius;
  const wallZ = CYC.sweepStartZ - CYC.sweepRadius;
  for (let i = 1; i <= CYC.wallSegs; i++) {
    const t = i / CYC.wallSegs;
    profile.push({ z: wallZ, y: wallBaseY + t * (CYC.wallHeight - wallBaseY) });
  }

  const nProfile = profile.length;
  // Accumulate arc length for V
  const arc = [0];
  for (let j = 1; j < nProfile; j++) {
    const dz = profile[j].z - profile[j - 1].z;
    const dy = profile[j].y - profile[j - 1].y;
    arc.push(arc[j - 1] + Math.hypot(dz, dy));
  }

  const positions = [];
  const uvs = [];
  const indices = [];
  const halfW = CYC.width / 2;
  for (let i = 0; i <= CYC.widthSegs; i++) {
    const x = -halfW + (i / CYC.widthSegs) * CYC.width;
    for (let j = 0; j < nProfile; j++) {
      positions.push(x, profile[j].y, profile[j].z);
      // World-aligned UV: each texture tile spans TILE_METERS on both axes
      uvs.push(x / TILE_METERS, arc[j] / TILE_METERS);
    }
  }
  for (let i = 0; i < CYC.widthSegs; i++) {
    for (let j = 0; j < nProfile - 1; j++) {
      const a = i * nProfile + j;
      const b = (i + 1) * nProfile + j;
      const c = (i + 1) * nProfile + (j + 1);
      const d = i * nProfile + (j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Cache one grid texture per theme — redrawing a 1024² canvas on every swap
// is wasteful when there are only two themes.
const _gridTexCache = Object.create(null);
function gridTextureFor(themeName) {
  let tex = _gridTexCache[themeName];
  if (tex) return tex;
  const T = THEMES[themeName];
  // 2048 px / 160 cells over a 40 m tile → 0.25 m minor, 1 m major, ~13 px
  // per cell so thin lines stay crisp at close-up camera zoom.
  tex = makeGridTexture(2048, 160, T.gridBase, T.gridMinor, T.gridMajor);
  tex.repeat.set(1, 1); // UVs are pre-scaled to world meters
  _gridTexCache[themeName] = tex;
  return tex;
}

let cycMaterial = null;
let cycMesh = null;
{
  cycMaterial = new THREE.MeshStandardMaterial({ map: gridTextureFor(currentTheme), roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  cycMesh = new THREE.Mesh(buildGroundGeometry(), cycMaterial);
  cycMesh.receiveShadow = true;
  scene.add(cycMesh);
}

// Scene config (non-tree, post-fx / environment toggles)
const sceneCfg = {
  skyHdr: false,
  ssaoOn: false,
  ssaoIntensity: 1.0,
  dofOn: false,
  dofFocus: 12,
  dofAperture: 0.5,
  // 'ground' = Houdini-style infinite plane with fog-faded edge (default);
  // 'cyclorama' = studio floor → sweep → wall backdrop.
  backdrop: 'ground',
  // 'target' = classic OrbitControls (pan moves pivot); 'cursor' = 3D-app-style
  // (pivot snaps under mouse at rotate start); 'center' = tree bbox center.
  orbitPivot: 'target',
};

function applyBackdrop() {
  if (!cycMesh) return;
  if (cycMesh.geometry) cycMesh.geometry.dispose();
  cycMesh.geometry = sceneCfg.backdrop === 'cyclorama'
    ? buildCycloramaGeometry()
    : buildGroundGeometry();
  // Sky/fog color depends on the backdrop mode, so refresh it.
  if (typeof applySkyBackground === 'function') applySkyBackground();
}
// Sync uniforms to defaults & rebuild outputNode now that sceneCfg exists.
uSsaoIntensity.value = sceneCfg.ssaoIntensity;
uDofFocus.value = sceneCfg.dofFocus;
uDofAperture.value = sceneCfg.dofAperture;
updatePostPipeline();

// Pick the right background/fog hex for the current backdrop. The infinite
// ground mode uses a lighter `groundBg` so the floor blends into the sky at
// the fog horizon; the cyclorama uses the regular theme bg.
function currentBgHex() {
  const T = THEMES[currentTheme];
  return (sceneCfg.backdrop === 'ground' && T.groundBg != null) ? T.groundBg : T.bg;
}

function applySkyBackground() {
  if (sceneCfg.skyHdr && skyHDRTex) {
    scene.background = skyHDRTex;
    if (scene.fog) scene.fog.far = 1000; // hide fog when sky is visible
  } else {
    const hex = currentBgHex();
    scene.background = new THREE.Color(hex);
    if (scene.fog) { scene.fog.color.setHex(hex); scene.fog.far = P.settings?.fogFar ?? 500; }
  }
}
// Initial scene.background was set before sceneCfg existed, so refresh it now
// that ground-mode can pick the lighter groundBg. Inlined (not calling
// applySkyBackground) because `P` — referenced by that function — is declared
// further down the file and would throw a TDZ error if called here.
{
  const hex = currentBgHex();
  scene.background = new THREE.Color(hex);
  if (scene.fog) scene.fog.color.setHex(hex);
}

function applyTheme(name) {
  const T = THEMES[name];
  if (!T) return; // unknown theme — ignore instead of crashing
  currentTheme = name;
  const hex = currentBgHex();
  if (sceneCfg.skyHdr && skyHDRTex) {
    scene.background = skyHDRTex;
  } else {
    scene.background = new THREE.Color(hex);
  }
  if (scene.fog) scene.fog.color.setHex(hex);
  const newTex = gridTextureFor(name);
  if (cycMaterial.map !== newTex) {
    cycMaterial.map = newTex;
    cycMaterial.needsUpdate = true; // map swap requires a pipeline rebuild
  }
  if (treeWireMat) treeWireMat.color.setHex(T.wireColor);
}

// (Soft contact shadow blob removed — was a transparent radial-gradient
// quad parked at the tree base. Duplicated work the proper directional
// shadow map already does, and its polygonOffset was bleeding a dark
// strip onto the bottom of every vertical mesh. The cyc backdrop's
// receiveShadow + the tree's castShadow handle ground darkening now.)

// --- Scale-reference human silhouette (1.8 m) --------------------------
// A flat outline of a person, placed ~3 m from the tree base so you can
// eyeball how big the tree actually is. Toggled via the left toolbar.
let personRefMesh = null;
{
  // 2D anatomical silhouette, 0..1.80 m Y, ~±0.26 m X (origin at feet
  // centerline). Continuous quadraticCurveTo path so bezier tessellation
  // gives a smooth high-poly outline. Hands sit at hip level (y ~ 0.80)
  // and the inner-arm column stays outside the leg outer edge so the
  // polygon never overlaps itself. Legs end at the ground — no feet.
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.80);
  // --- Right side --------------------------------------------------------
  // Head: smooth oval, jaw curve to chin/neck
  shape.quadraticCurveTo(0.140, 1.795, 0.140, 1.66);
  shape.quadraticCurveTo(0.135, 1.555, 0.070, 1.520);
  // Neck
  shape.lineTo(0.060, 1.480);
  // Shoulder slope outward to deltoid
  shape.quadraticCurveTo(0.140, 1.475, 0.230, 1.460);
  // Outside of right arm — gentle bicep then taper to wrist (hands ~ hip)
  shape.quadraticCurveTo(0.255, 1.290, 0.245, 1.080);
  shape.quadraticCurveTo(0.235, 0.920, 0.230, 0.830);
  // Right hand (rounded curl just above hip — y stays > 0.78)
  shape.quadraticCurveTo(0.230, 0.780, 0.210, 0.770);
  shape.quadraticCurveTo(0.190, 0.770, 0.190, 0.820);
  // Inside of right arm back up to armpit. x stays >= 0.180 the entire
  // way — never crosses the leg outer line below the hip.
  shape.quadraticCurveTo(0.184, 0.950, 0.180, 1.080);
  shape.lineTo(0.180, 1.300);
  // Side of torso meets inner arm at armpit, tucks for waist, flares hip
  shape.quadraticCurveTo(0.150, 1.100, 0.158, 0.950);
  shape.quadraticCurveTo(0.184, 0.920, 0.184, 0.880);
  // Right thigh -> knee -> calf -> ankle (legs stop at ground, no foot)
  shape.quadraticCurveTo(0.166, 0.620, 0.142, 0.350);
  shape.quadraticCurveTo(0.125, 0.130, 0.112, 0.000);
  // Across ground to inner ankle — no foot extension.
  shape.lineTo(0.040, 0.000);
  // Inside of right leg up to crotch
  shape.quadraticCurveTo(0.045, 0.350, 0.030, 0.640);
  shape.quadraticCurveTo(0.020, 0.820, 0.000, 0.860);
  // --- Left side (mirror) ------------------------------------------------
  shape.quadraticCurveTo(-0.020, 0.820, -0.030, 0.640);
  shape.quadraticCurveTo(-0.045, 0.350, -0.040, 0.000);
  shape.lineTo(-0.112, 0.000);
  shape.quadraticCurveTo(-0.125, 0.130, -0.142, 0.350);
  shape.quadraticCurveTo(-0.166, 0.620, -0.184, 0.880);
  shape.quadraticCurveTo(-0.184, 0.920, -0.158, 0.950);
  shape.quadraticCurveTo(-0.150, 1.100, -0.180, 1.300);
  shape.lineTo(-0.180, 1.080);
  shape.quadraticCurveTo(-0.184, 0.950, -0.190, 0.820);
  shape.quadraticCurveTo(-0.190, 0.770, -0.210, 0.770);
  shape.quadraticCurveTo(-0.230, 0.780, -0.230, 0.830);
  shape.quadraticCurveTo(-0.235, 0.920, -0.245, 1.080);
  shape.quadraticCurveTo(-0.255, 1.290, -0.230, 1.460);
  shape.quadraticCurveTo(-0.140, 1.475, -0.060, 1.480);
  shape.lineTo(-0.070, 1.520);
  shape.quadraticCurveTo(-0.135, 1.555, -0.140, 1.660);
  shape.quadraticCurveTo(-0.140, 1.795, 0, 1.80);
  shape.closePath();
  // curveSegments 24 — bezier resolution per quadraticCurveTo. Default 12
  // gives faceted shoulders/calves at 1.8 m; 24 reads as smooth.
  const geo = new THREE.ShapeGeometry(shape, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
    depthTest: true, toneMapped: false,
  });
  personRefMesh = new THREE.Mesh(geo, mat);
  personRefMesh.position.set(2.8, 0, 0); // 2.8 m from origin, on the right
  personRefMesh.visible = false;
  scene.add(personRefMesh);

  // Outline edges so it reads as a silhouette even when bloomed.
  const edges = new THREE.EdgesGeometry(geo, 10);
  const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.9, toneMapped: false,
  }));
  personRefMesh.add(outline);
}

// --- Textures ------------------------------------------------------------
const texLoader = new THREE.TextureLoader();
function loadColor(url) {
  const t = texLoader.load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const leafMapA = loadColor('./tex/leaf.png');
const leafMapB = loadColor('./tex/leaf_b.png');
const leafNormal = texLoader.load('./tex/leaf_normal.jpg');
leafNormal.anisotropy = 8;
// Original image textures — kept as a hard fallback if the generator fails
// for any reason, and as the initial map until the first species applies.
const _barkImgAlbedo = loadColor('./tex/bark.jpg');
const _barkImgNormal = texLoader.load('./tex/bark_normal.jpg');
_barkImgNormal.anisotropy = 8;
for (const t of [_barkImgAlbedo, _barkImgNormal]) {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
}

// --- Procedural bark texture generator ----------------------------------
// Generates a tilable albedo + normal canvas texture per bark style. Each
// style is a recipe of (vertical fissure / horizontal band / large-scale /
// micro-detail) parameters. Result is cached by `style:seed` so repeated
// species switches don't re-run the generator. Tilable: built from a
// periodic value-noise grid (true wrap) plus pure-sine fissure/band
// patterns (perfectly periodic by construction).
const _BARK_TEX_CACHE = new Map();

// Recipes tuned for default 0.5 tiles/m repeat (2 m per tile) at 5-15 m
// camera distance. Each recipe targets a real-tree-bark archetype:
const BARK_STYLES = {
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
function generateBarkTexture(style = 'oak', seed = 1) {
  // Merge: start with the style preset's full recipe, then override any
  // field with the matching P.bark* slider. P is declared further down
  // the file (~line 3634); during the initial bark paint at startup
  // it's still in the temporal dead zone, so guard with try/catch and
  // fall through to recipe-only on TDZ ReferenceError.
  const recipe = BARK_STYLES[style] || BARK_STYLES.oak;
  let Ps;
  try { Ps = P; } catch { Ps = {}; }
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
  const cached = _BARK_TEX_CACHE.get(key);
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
    _BARK_TEX_CACHE.set(key, result);
    return result;
  } catch (err) {
    // Bulletproof fallback — render-time consumer (applyBarkStyle) sees
    // null canvases and keeps the previous textures rather than mapping
    // unfilled black.
    console.warn('[bark-gen] failed for style', style, '— keeping previous', err);
    return null;
  }
}

// Singleton bark CanvasTextures — created ONCE, then `.image` is swapped
// to the canvas the generator produces for the active style. Because the
// THREE.Texture object identity stays stable across style changes, the
// TSL colorNode binding (built at line ~2624) keeps working for the
// lifetime of the page.
const barkAlbedo = (() => {
  const t = new THREE.CanvasTexture(document.createElement('canvas'));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.repeat.set(2, 2);
  return t;
})();
const barkNormal = (() => {
  const t = new THREE.CanvasTexture(document.createElement('canvas'));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.repeat.set(2, 2);
  return t;
})();

// Paint the initial 'oak' style into the singletons before the bark
// material's colorNode is built — that way the TSL binding sees real
// pixels from frame zero.
{
  const init = generateBarkTexture('oak', 1);
  if (init) {
    barkAlbedo.image = init.albedoCanvas;
    barkNormal.image = init.normalCanvas;
  } else {
    // Last-resort fallback — copy the bundled JPGs into the singleton
    // textures' .image. They'll behave like normal textures.
    barkAlbedo.image = _barkImgAlbedo.image;
    barkNormal.image = _barkImgNormal.image;
  }
  barkAlbedo.needsUpdate = true;
  barkNormal.needsUpdate = true;
}

// Slim albedo-only renderer for the style picker thumbnails. Uses the
// preset recipe defaults (no P slider overrides) so each thumbnail always
// shows the canonical look of that preset, regardless of the user's
// current edits. Cached forever — recipes never change at runtime.
const _BARK_THUMB_CACHE = new Map();
function generateBarkThumbnail(style, size = 48) {
  const key = style + ':' + size;
  const cached = _BARK_THUMB_CACHE.get(key);
  if (cached) return cached;
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
  _BARK_THUMB_CACHE.set(key, cv);
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
function generateNoiseThumbnail(patternName, size = 48) {
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

const THUMBNAIL_FACTORIES = {
  barkPreset: generateBarkThumbnail,
  noise:      generateNoiseThumbnail,
};

// --- Wind (TSL vertex displacement) --------------------------------------
// Two independent enables. Leaves can keep swaying via the shader even when
// the bark is being driven by the CPU skeleton sim (during a grab interaction
// or when the user explicitly picked 'skeleton' mode). Bark wind disables
// itself in those cases so the shader-side disp doesn't stack on top of CPU
// bark deformation.
const uWindEnable     = uniform(0); // leaf wind gate (legacy name)
const uBarkWindEnable = uniform(0); // bark wind gate — only on in shader mode
const uWindStrength = uniform(0.08);
const uWindFreq = uniform(1.2);
const uWindDirX = uniform(1.0);
const uWindDirZ = uniform(0.3);
const uWindGust = uniform(0.4);

// Bark: shader-only wind. Per-vertex phase from XZ position so adjacent verts
// sway in sync but distant branches drift. Sway weight = max(0, localY * k)
// — trunk base barely moves, twig tips sway most. Replaces the per-frame CPU
// updateBark() pass when wind mode is 'shader' (default).
const _barkPhaseHash = positionLocal.x.mul(0.21).add(positionLocal.z.mul(0.17));
const _barkPhase  = time.mul(uWindFreq).add(_barkPhaseHash);
const _barkPhase2 = time.mul(uWindFreq.mul(0.55)).add(_barkPhaseHash.mul(1.7));
const _barkHeightWeight = tslMax(float(0), positionLocal.y.mul(0.06));
const _barkAmp = sin(_barkPhase).mul(0.025)
  .add(sin(_barkPhase2).mul(0.015).mul(uWindGust))
  .mul(uWindStrength).mul(_barkHeightWeight);
const barkWindDisp = vec3(_barkAmp.mul(uWindDirX), float(0), _barkAmp.mul(uWindDirZ)).mul(uBarkWindEnable);

// Leaves: per-instance phase from instanceIndex so they don't all flutter in sync.
const _leafPhase = time.mul(uWindFreq.mul(2.2)).add(instanceIndex.toFloat().mul(0.43));
const _leafPhase2 = time.mul(uWindFreq.mul(0.9)).add(instanceIndex.toFloat().mul(0.31));
const _leafAmp = sin(_leafPhase).mul(0.05)
  .add(sin(_leafPhase2).mul(0.03).mul(uWindGust))
  .mul(uWindStrength).mul(4);
const leafWindDisp = vec3(_leafAmp.mul(uWindDirX), float(0), _leafAmp.mul(uWindDirZ)).mul(uWindEnable);

// --- Materials (Node variants so TSL displacement applies) ---------------
const barkMat = new THREE.MeshStandardNodeMaterial({
  map: barkAlbedo, normalMap: barkNormal, roughness: 0.95, metalness: 0,
});
// Bark deformation: TSL wind disp is always wired in. Gated by uBarkWindEnable
// so the CPU skeleton sim path (grab / skeleton mode) can take exclusive
// control of the position buffer without the shader stacking sway on top.
barkMat.positionNode = positionLocal.add(barkWindDisp);

// --- Moss / lichen world-up blend ----------------------------------------
// Tints bark toward moss color on the upward-facing sides of branches where
// rain + light collect. Driven by world-space normal's Y component.
const _mossCol = uniform(new THREE.Color(0.18, 0.28, 0.12));
const _mossTint = uniform(new THREE.Color(1, 1, 1));   // hue tint (overlay color)
const _barkSatU = uniform(1.0);                         // texture saturation multiplier (0=B&W, 1=natural, >1=punchy)
const _barkBrightU = uniform(1.0);                      // final brightness multiplier
const _mossAmount = uniform(0);
const _mossThreshold = uniform(0.35);
{
  const tex = tslTexture(barkAlbedo);
  // Photoshop-style HSL adjustment IN-SHADER:
  //   1. Compute Rec.709 luminance of the bark texture.
  //   2. mix(luminance, tex.rgb, _barkSatU) — true saturation (works
  //      regardless of tint amount because it operates on the texture
  //      itself, not on a separate tint multiplier).
  //   3. Multiply by _mossTint (the hue overlay — driven by hue + tint
  //      sliders on CPU).
  //   4. Scale by _barkBrightU.
  const lum709 = tex.x.mul(0.2126).add(tex.y.mul(0.7152)).add(tex.z.mul(0.0722));
  const desat = mix(vec3(lum709, lum709, lum709), tex.xyz, _barkSatU);
  const tinted = desat.mul(_mossTint).mul(_barkBrightU);
  const upFactor = normalWorld.y;
  const mask = smoothstep(_mossThreshold.sub(0.25), _mossThreshold, upFactor).mul(_mossAmount);
  barkMat.colorNode = vec4(mix(tinted, _mossCol, mask), tex.w);
}

// Factory: every leaf/needle material shares the TSL wind-displacement node.
// Keep this in one place so shader-graph changes don't have to be applied 4×.
// Dual-sided color: front + back uniforms blended by gl_FrontFacing so leaf
// undersides can be tinted lighter / yellower like real foliage.
const _leafFrontCol = uniform(new THREE.Color(1, 1, 1));
const _leafBackCol  = uniform(new THREE.Color(1, 1, 1));
function makeLeafMaterial(props, opts = {}) {
  const m = new THREE.MeshPhysicalNodeMaterial(props);
  m.positionNode = positionLocal.add(leafWindDisp);
  if (opts.dualColor && props.map) {
    const tex = tslTexture(props.map);
    const tint = mix(_leafBackCol, _leafFrontCol, float(frontFacing));
    m.colorNode = vec4(tex.xyz.mul(tint), tex.w);
    // Expose the TSL texture node so code that swaps `m.map` (e.g. picking a
    // new leaf shape) can also update the shader's texture reference.
    // Otherwise the colorNode keeps sampling the original texture bound at
    // material-creation time — the infamous "old PNG still shows in custom
    // leaves" bug.
    m._leafColorTexNode = tex;
  }
  return m;
}
const LEAF_MAT_DEFAULTS = {
  // Vein normals visible at canopy distance + waxy cuticle sheen + thinner
  // SSS so backlit leaves glow against the new backlight key.
  normalMap: leafNormal, normalScale: new THREE.Vector2(0.55, 0.55),
  alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0,
  transmission: 0.6, thickness: 0.18, ior: 1.35,
  sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xffffff),
};
const leafMatA = makeLeafMaterial({ ...LEAF_MAT_DEFAULTS, map: leafMapA }, { dualColor: true });
const leafMatB = makeLeafMaterial({ ...LEAF_MAT_DEFAULTS, map: leafMapB }, { dualColor: true });

// Leaf geometry. Built procedurally as a curved low-poly mesh from the same
// _leafHalfWidth silhouette used by the canvas rasterizer — so the mesh
// silhouette matches the texture exactly, but now the leaf has real 3D
// cupping along the midrib and slight apex curl. Pivot is at the BASE
// (local y = 0) so rotations spin the leaf around the petiole, not its
// center — matches the previous translated-plane behavior.
let leafGeo = null;
let leafInstFall = null;
// Hoisted so rebuildLeafGeo can retarget these in place when the user picks
// a new leaf shape — declarations further down the file are in TDZ during
// the initial rebuildLeafGeo() call at boot.
let leafInstA = null;
let leafInstB = null;
let vineLeafInst = null;
function _buildSilhouetteLeafGeo(p, maxHalfW_u, lenF, midribCurl, apexCurl) {
  // Build a closed THREE.Shape from the sampled silhouette and let
  // ShapeGeometry triangulate it. Apply midrib cup + apex curl as z-offsets
  // after triangulation so the flat polygon becomes a gently cupped 3D leaf.
  const sampled = _sampleSilhouette(p.silhouette, 10);
  const shape = new THREE.Shape();
  const m0x = (sampled[0].x - 0.5) * 2 * maxHalfW_u;
  const m0y = sampled[0].y * lenF;
  shape.moveTo(m0x, m0y);
  for (let i = 1; i < sampled.length; i++) {
    const mx = (sampled[i].x - 0.5) * 2 * maxHalfW_u;
    const my = sampled[i].y * lenF;
    shape.lineTo(mx, my);
  }
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape, 6);
  const pos = g.attributes.position;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const wX = (maxX - minX) || 1;
  const wY = (maxY - minY) || 1;
  const uvs = new Float32Array(pos.count * 2);
  const edgeSpan = Math.max(Math.abs(minX), Math.abs(maxX)) || 1;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    uvs[i * 2]     = (x - minX) / wX;
    uvs[i * 2 + 1] = (y - minY) / wY;
    const edgeFactor = Math.min(1, Math.abs(x) / edgeSpan);
    const tNorm = Math.max(0, Math.min(1, (y - minY) / wY));
    const zApex = -apexCurl * tNorm * tNorm;
    const zEdge = zApex - midribCurl * edgeFactor * edgeFactor;
    pos.setZ(i, zEdge);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function rebuildLeafGeo() {
  const base = P.leafProfile || {};
  // If a named preset is selected, sample its profile (matches what
  // applyLeafShape draws into the texture). Custom uses the user's tuned
  // P.leafProfile directly. 'Texture'/'Upload' fall back to the base profile
  // so the silhouette is at least leaf-shaped (texture's alpha test still
  // trims to the actual leaf image).
  const shape = P.leafShape || 'Texture';
  const p = (shape !== 'Texture' && shape !== 'Upload' && shape !== 'Custom' && LEAF_PRESETS[shape])
    ? { ...base, ...LEAF_PRESETS[shape] }
    : base;
  const midribCurl = (P.leafMidribCurl ?? 0.15);
  const apexCurl   = (P.leafApexCurl ?? 0.08);
  const lenF = Math.max(0.3, Math.min(1, p.length ?? 1));
  const maxHalfW = (p.aspect ?? 0.5) * 0.9;

  // Flat UV-0-1 card for all shapes — the texture's alpha defines the visible
  // silhouette (procedural polygon, bundled PNG, or user upload). Card size
  // matches the leaf bbox in 3D units. Two qualities:
  //   'flat'  — 4 verts, 2 tris.
  //   'bent'/'silhouette' — 3-column curved strip with midrib cup + apex curl
  //     for real 3D depth. (silhouette quality kept for back-compat; visually
  //     equivalent to bent now that alpha-cutout drives the outline.)
  const quality = P.leafQuality || 'bent';
  const halfW = maxHalfW;
  let g;
  if (quality === 'flat') {
    const positions = new Float32Array([
      -halfW, 0,    0,
       halfW, 0,    0,
       halfW, lenF, 0,
      -halfW, lenF, 0,
    ]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeVertexNormals();
  } else {
    const rows = 8;
    const positions = new Float32Array((rows + 1) * 3 * 3);
    const uvs       = new Float32Array((rows + 1) * 3 * 2);
    const indices   = new Uint16Array(rows * 4 * 3);
    let pi = 0, ui = 0, ii = 0;
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      const y = t * lenF;
      const zApex = -apexCurl * t * t;
      const zEdge = zApex - midribCurl;
      positions[pi++] = -halfW; positions[pi++] = y; positions[pi++] = zEdge;
      positions[pi++] =   0;    positions[pi++] = y; positions[pi++] = zApex;
      positions[pi++] =  halfW; positions[pi++] = y; positions[pi++] = zEdge;
      uvs[ui++] = 0;   uvs[ui++] = t;
      uvs[ui++] = 0.5; uvs[ui++] = t;
      uvs[ui++] = 1;   uvs[ui++] = t;
    }
    for (let i = 0; i < rows; i++) {
      const a = i * 3;
      const b = (i + 1) * 3;
      indices[ii++] = a;     indices[ii++] = b;     indices[ii++] = b + 1;
      indices[ii++] = a;     indices[ii++] = b + 1; indices[ii++] = a + 1;
      indices[ii++] = a + 1; indices[ii++] = b + 1; indices[ii++] = b + 2;
      indices[ii++] = a + 1; indices[ii++] = b + 2; indices[ii++] = a + 2;
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeVertexNormals();
  }
  const old = leafGeo;
  leafGeo = g;
  // Retarget every live broadleaf instance so they render with the new
  // silhouette immediately. Without this, the old geometry gets disposed
  // below while the instances still reference its (now-freed) GPU buffer —
  // the user picks a new leaf shape and sees nothing change until regen.
  // Conifer needle instances use `activeNeedleGeo`, not leafGeo, so they're
  // intentionally untouched here.
  if (leafInstFall) leafInstFall.geometry = g;
  if (leafInstA && P.treeType !== 'conifer') leafInstA.geometry = g;
  if (leafInstB && P.treeType !== 'conifer') leafInstB.geometry = g;
  if (vineLeafInst) vineLeafInst.geometry = g;
  if (old) old.dispose();
}
// Initial build deferred — runs after P.leafProfile is populated below.

// --- Procedural leaf silhouette ----------------------------------------
// A parametric width-profile drives both an SVG representation (for export)
// and a canvas-rasterized texture used as the leaf's alpha mask. Presets
// are pre-tuned overlays on top of P.leafProfile.
const LEAF_PRESETS = {
  // Each preset tunes width/curve/tip behavior. tipWidth > 0 gives a blunt
  // or flat terminus (fan, heart); tipSharpness controls how quickly the
  // silhouette reaches that terminal width (0 = round taper, 1 = spike).
  // Each preset ships a real 2D silhouette polygon (control points in [0,1]²,
  // midrib at x=0.5, stem at y=0, tip at y=1). This drives both the 3D mesh
  // (via ShapeGeometry) and the canvas texture, so the heart's cordate notch
  // and the maple's deep 5-lobe sinuses actually render — impossible with the
  // old monotonic half-width profile.
  Oval: {
    mode: 'silhouette', veinCount: 5, aspect: 0.5, length: 1.0,
    silhouette: [
      { x: 0.50, y: 0.02 }, { x: 0.62, y: 0.08 }, { x: 0.74, y: 0.22 },
      { x: 0.80, y: 0.40 }, { x: 0.80, y: 0.60 }, { x: 0.74, y: 0.78 },
      { x: 0.62, y: 0.92 }, { x: 0.50, y: 0.98 }, { x: 0.38, y: 0.92 },
      { x: 0.26, y: 0.78 }, { x: 0.20, y: 0.60 }, { x: 0.20, y: 0.40 },
      { x: 0.26, y: 0.22 }, { x: 0.38, y: 0.08 },
    ],
  },
  Lanceolate: {
    mode: 'silhouette', veinCount: 6, aspect: 0.38, length: 1.0,
    silhouette: [
      { x: 0.50, y: 0.00 }, { x: 0.54, y: 0.05 }, { x: 0.62, y: 0.18 },
      { x: 0.68, y: 0.35 }, { x: 0.68, y: 0.55 }, { x: 0.62, y: 0.75 },
      { x: 0.55, y: 0.90 }, { x: 0.50, y: 1.00 }, { x: 0.45, y: 0.90 },
      { x: 0.38, y: 0.75 }, { x: 0.32, y: 0.55 }, { x: 0.32, y: 0.35 },
      { x: 0.38, y: 0.18 }, { x: 0.46, y: 0.05 },
    ],
  },
  Heart: {
    // Cordate: two basal lobes with a deep notch at the stem, tapering to a
    // sharp point at the tip.
    mode: 'silhouette', veinCount: 5, aspect: 0.62, length: 0.95,
    silhouette: [
      { x: 0.50, y: 0.12 },
      { x: 0.58, y: 0.06 }, { x: 0.66, y: 0.02 }, { x: 0.74, y: 0.04 },
      { x: 0.82, y: 0.14 }, { x: 0.88, y: 0.28 }, { x: 0.90, y: 0.45 },
      { x: 0.86, y: 0.62 }, { x: 0.76, y: 0.80 }, { x: 0.62, y: 0.93 },
      { x: 0.50, y: 1.00 },
      { x: 0.38, y: 0.93 }, { x: 0.24, y: 0.80 }, { x: 0.14, y: 0.62 },
      { x: 0.10, y: 0.45 }, { x: 0.12, y: 0.28 }, { x: 0.18, y: 0.14 },
      { x: 0.26, y: 0.04 }, { x: 0.34, y: 0.02 }, { x: 0.42, y: 0.06 },
    ],
  },
  Maple: {
    // Palmate with 5 lobes separated by deep sinuses. Traversed CCW from the
    // central tip down the right side, across the base, up the left side.
    mode: 'silhouette', veinCount: 5, aspect: 0.6, length: 1.0,
    silhouette: [
      { x: 0.50, y: 1.00 },
      { x: 0.56, y: 0.88 },
      { x: 0.62, y: 0.78 },
      { x: 0.70, y: 0.82 }, { x: 0.78, y: 0.86 }, { x: 0.82, y: 0.74 },
      { x: 0.78, y: 0.62 },
      { x: 0.84, y: 0.52 },
      { x: 0.94, y: 0.50 }, { x: 0.98, y: 0.38 }, { x: 0.90, y: 0.30 },
      { x: 0.78, y: 0.30 },
      { x: 0.70, y: 0.18 }, { x: 0.58, y: 0.08 },
      { x: 0.50, y: 0.00 },
      { x: 0.42, y: 0.08 }, { x: 0.30, y: 0.18 },
      { x: 0.22, y: 0.30 }, { x: 0.10, y: 0.30 }, { x: 0.02, y: 0.38 },
      { x: 0.06, y: 0.50 },
      { x: 0.16, y: 0.52 },
      { x: 0.22, y: 0.62 },
      { x: 0.18, y: 0.74 }, { x: 0.22, y: 0.86 }, { x: 0.30, y: 0.82 },
      { x: 0.38, y: 0.78 },
      { x: 0.44, y: 0.88 },
    ],
  },
  Oak: {
    // Lobed oak: shallow rounded lobes with gentle sinuses, tapered base.
    mode: 'silhouette', veinCount: 6, aspect: 0.58, length: 1.0,
    silhouette: [
      { x: 0.50, y: 1.00 },
      { x: 0.62, y: 0.95 }, { x: 0.70, y: 0.86 }, { x: 0.62, y: 0.78 },
      { x: 0.74, y: 0.70 }, { x: 0.82, y: 0.60 }, { x: 0.74, y: 0.52 },
      { x: 0.80, y: 0.42 }, { x: 0.86, y: 0.32 }, { x: 0.76, y: 0.24 },
      { x: 0.80, y: 0.14 }, { x: 0.68, y: 0.08 },
      { x: 0.50, y: 0.00 },
      { x: 0.32, y: 0.08 }, { x: 0.20, y: 0.14 }, { x: 0.24, y: 0.24 },
      { x: 0.14, y: 0.32 }, { x: 0.20, y: 0.42 }, { x: 0.26, y: 0.52 },
      { x: 0.18, y: 0.60 }, { x: 0.26, y: 0.70 }, { x: 0.38, y: 0.78 },
      { x: 0.30, y: 0.86 }, { x: 0.38, y: 0.95 },
    ],
  },
  Fan: {
    // Ginkgo-style fan: narrow stem, broad flat top with a central notch.
    mode: 'silhouette', veinCount: 8, aspect: 0.72, length: 0.9,
    silhouette: [
      { x: 0.50, y: 0.00 }, { x: 0.54, y: 0.06 }, { x: 0.62, y: 0.20 },
      { x: 0.76, y: 0.40 }, { x: 0.92, y: 0.62 }, { x: 0.96, y: 0.78 },
      { x: 0.86, y: 0.92 }, { x: 0.68, y: 0.98 },
      { x: 0.58, y: 0.92 }, { x: 0.50, y: 0.86 }, { x: 0.42, y: 0.92 },
      { x: 0.32, y: 0.98 }, { x: 0.14, y: 0.92 }, { x: 0.04, y: 0.78 },
      { x: 0.08, y: 0.62 }, { x: 0.24, y: 0.40 }, { x: 0.38, y: 0.20 },
      { x: 0.46, y: 0.06 },
    ],
  },
  Willow: {
    // Long narrow lance, pointed both ends. Polygon fills bbox so the alpha
    // cutout matches the bbox shape directly.
    mode: 'silhouette', veinCount: 1, aspect: 0.2, length: 1.0,
    silhouette: [
      { x: 0.50, y: 0.00 }, { x: 0.62, y: 0.18 }, { x: 0.68, y: 0.40 },
      { x: 0.74, y: 0.60 }, { x: 0.62, y: 0.82 }, { x: 0.50, y: 1.00 },
      { x: 0.38, y: 0.82 }, { x: 0.26, y: 0.60 }, { x: 0.32, y: 0.40 },
      { x: 0.38, y: 0.18 },
    ],
  },
  Birch: {
    // Ovate with a pointed tip and rounded base.
    mode: 'silhouette', veinCount: 6, aspect: 0.55, length: 1.0,
    silhouette: [
      { x: 0.50, y: 0.00 }, { x: 0.62, y: 0.06 }, { x: 0.74, y: 0.18 },
      { x: 0.80, y: 0.36 }, { x: 0.74, y: 0.56 }, { x: 0.66, y: 0.76 },
      { x: 0.56, y: 0.92 }, { x: 0.50, y: 1.00 }, { x: 0.44, y: 0.92 },
      { x: 0.34, y: 0.76 }, { x: 0.26, y: 0.56 }, { x: 0.20, y: 0.36 },
      { x: 0.26, y: 0.18 }, { x: 0.38, y: 0.06 },
    ],
  },
};

function _sampleCatmull(points, t) {
  const n = points.length;
  if (n === 1) return points[0];
  const f = Math.max(0, Math.min(1, t)) * (n - 1);
  const i1 = Math.floor(f);
  const i2 = Math.min(n - 1, i1 + 1);
  const i0 = Math.max(0, i1 - 1);
  const i3 = Math.min(n - 1, i2 + 1);
  const u = f - i1;
  const p0 = points[i0], p1 = points[i1], p2 = points[i2], p3 = points[i3];
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * u + c * u * u + d * u * u * u);
}

function _leafHalfWidth(t, p) {
  let w;
  const tipW = p.tipWidth ?? 0;
  const baseW = p.baseWidth ?? 0;
  if (p.mode === 'spline' && Array.isArray(p.splinePoints) && p.splinePoints.length >= 2) {
    w = _sampleCatmull(p.splinePoints, t);
  } else if (t < p.widthAt) {
    // Base → widest. tipSharpness inverted here by design: base ramp uses
    // the same idea but symmetric — sharper "base corner" means the leaf
    // flares out fast from a narrow base.
    const u = t / p.widthAt;
    const exp = 0.4 + (1 - (p.baseSharpness ?? 0.5)) * 2.0;
    w = baseW + (1 - baseW) * (1 - Math.pow(1 - u, exp));
  } else {
    const u = (t - p.widthAt) / (1 - p.widthAt);
    // tipSharpness 0 = round/blunt tip (exponent ~2.3), 1 = very sharp
    // pointed tip (exponent ~0.3). Previous formula had this inverted.
    const exp = 0.3 + (1 - (p.tipSharpness ?? 0.5)) * 2.0;
    w = tipW + (1 - tipW) * Math.pow(1 - u, exp);
  }
  if (p.serration > 0) {
    const osc = 0.5 + 0.5 * Math.sin(t * Math.PI * 12);
    w *= 1 - osc * p.serration * 0.16;
  }
  return Math.max(0, w);
}

// Build an initial closed-polygon silhouette by sampling an analytic
// half-width profile. Used when the user switches from a preset (e.g. Heart)
// to Custom: the silhouette drawer opens with points matching the preset so
// the user starts from "what they were just looking at" and can sculpt from
// there. Half-width is normalized 0..1 (1 = fully wide), mapped into silhouette
// space where x=0.5 is midrib.
function _seedSilhouetteFromAnalytic(profile) {
  const N = 10;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const halfW = _leafHalfWidth(t, profile);
    pts.push({ x: 0.5 + halfW * 0.5, y: t });
  }
  for (let i = N - 1; i > 0; i--) {
    const t = i / N;
    const halfW = _leafHalfWidth(t, profile);
    pts.push({ x: 0.5 - halfW * 0.5, y: t });
  }
  return pts;
}

// Sample a closed Catmull-Rom through the user's silhouette control points,
// returning a dense [{x, y}] polygon in the same [0,1]² space. Used by both
// the canvas rasterizer and the mesh builder so the texture edge and mesh
// outline stay pixel-identical.
function _sampleSilhouette(pts, samplesPerSeg = 8) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const out = [];
  for (let seg = 0; seg < n; seg++) {
    const p0 = pts[(seg - 1 + n) % n];
    const p1 = pts[seg];
    const p2 = pts[(seg + 1) % n];
    const p3 = pts[(seg + 2) % n];
    for (let i = 0; i < samplesPerSeg; i++) {
      const u = i / samplesPerSeg;
      const u2 = u * u, u3 = u2 * u;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3);
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3);
      out.push({ x, y });
    }
  }
  return out;
}

function _leafPathPoints(p, size, samples = 56, opts = {}) {
  // Use the SAME unit measurements as rebuildLeafGeo (the 3D mesh) so the
  // 2D preview fills the canvas with the same leaf proportions the 3D
  // preview shows. Old code hard-coded halfH = 0.46*size which produced a
  // different aspect than the 3D mesh's lenF × (2·maxHalfW) bbox.
  const lenF = Math.max(0.3, Math.min(1, p.length ?? 1));
  const maxHalfW_u = (p.aspect ?? 0.5) * 0.9;     // 3D world-unit half-width
  const widthU = 2 * maxHalfW_u;
  const heightU = lenF;
  // `stretch:true` — fill canvas non-uniformly so polygon bbox === canvas.
  // Used by the 3D leaf texture so a flat UV-0-1 card samples polygon-shaped
  // alpha. Default uses uniform fit + 4% margin (preview thumbnails).
  const stretch = !!opts.stretch;
  const MARGIN = stretch ? 0.005 : 0.04;
  const avail = size * (1 - 2 * MARGIN);
  let fitX, fitY;
  if (stretch) {
    fitX = avail / widthU;
    fitY = avail / heightU;
  } else {
    fitX = fitY = Math.min(avail / widthU, avail / heightU);
  }
  const halfH = (heightU / 2) * fitY;
  const maxHalfW = maxHalfW_u * fitX;
  const cx = size / 2;
  const cy = size / 2;
  const topY = cy - halfH;
  const botY = cy + halfH;

  // Silhouette mode: trace the user's closed polygon. The polygon in [0,1]²
  // has x=0.5 as midrib and y=0 at the stem, y=1 at the tip.
  if (p.mode === 'silhouette' && Array.isArray(p.silhouette) && p.silhouette.length >= 3) {
    const sampled = _sampleSilhouette(p.silhouette, 10);
    const pts = [];
    for (const s of sampled) {
      const px = cx + (s.x - 0.5) * 2 * maxHalfW;
      const py = botY + (topY - botY) * s.y;  // y=0 → botY (base), y=1 → topY (tip)
      pts.push([px, py]);
    }
    return { pts, cx, topY, botY, maxHalfW };
  }

  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = botY + (topY - botY) * t;
    const w = maxHalfW * _leafHalfWidth(t, p);
    pts.push([cx + w, y]);
  }
  for (let i = samples; i >= 0; i--) {
    const t = i / samples;
    const y = botY + (topY - botY) * t;
    const w = maxHalfW * _leafHalfWidth(t, p);
    pts.push([cx - w, y]);
  }
  return { pts, cx, topY, botY, maxHalfW };
}

function drawLeafToCanvas(ctx, p, size, opts = {}) {
  // Both preview and 3D texture render with alpha — clear canvas, fill the
  // silhouette polygon. The mesh is a flat UV-0-1 card so the texture's
  // alpha defines the visible leaf shape (lobes, notches, etc).
  // Preview adds a thin outline for UI clarity; 3D texture stretches the
  // polygon to fill the canvas so UV 0-1 maps directly to the polygon bbox.
  const preview = !!opts.preview;
  ctx.clearRect(0, 0, size, size);
  ctx.globalAlpha = 1;
  const { pts, cx, topY, botY, maxHalfW } = _leafPathPoints(p, size, 56, { stretch: !preview });
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = p.color || '#4a7a3a';
  ctx.fill();
  if (preview) {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.clip();
  const vein = p.veinColor || '#33462a';
  ctx.strokeStyle = vein;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(1, size / 180);
  ctx.beginPath();
  ctx.moveTo(cx, botY);
  ctx.lineTo(cx, topY + size * 0.02);
  ctx.stroke();
  const n = Math.max(0, p.veinCount | 0);
  ctx.lineWidth = Math.max(0.8, size / 240);
  ctx.globalAlpha = 0.42;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const y = botY + (topY - botY) * t;
    const w = maxHalfW * _leafHalfWidth(t, p);
    const vy = y + w * 0.35;
    ctx.beginPath();
    ctx.moveTo(cx, vy);
    ctx.quadraticCurveTo(cx + w * 0.5, y, cx + w * 0.92, y - w * 0.05);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, vy);
    ctx.quadraticCurveTo(cx - w * 0.5, y, cx - w * 0.92, y - w * 0.05);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

let _proceduralLeafCanvas = null;
let _proceduralLeafTex = null;
let _proceduralLeafBumpCanvas = null;
let _proceduralLeafBumpTex = null;
function _ensureProceduralLeafTex(size = 256) {
  if (!_proceduralLeafCanvas) {
    _proceduralLeafCanvas = document.createElement('canvas');
    _proceduralLeafCanvas.width = _proceduralLeafCanvas.height = size;
  }
  if (!_proceduralLeafTex) {
    _proceduralLeafTex = new THREE.CanvasTexture(_proceduralLeafCanvas);
    _proceduralLeafTex.colorSpace = THREE.SRGBColorSpace;
    _proceduralLeafTex.anisotropy = 4;
  }
  if (!_proceduralLeafBumpCanvas) {
    _proceduralLeafBumpCanvas = document.createElement('canvas');
    _proceduralLeafBumpCanvas.width = _proceduralLeafBumpCanvas.height = size;
  }
  if (!_proceduralLeafBumpTex) {
    // Greyscale height map — NOT SRGB.
    _proceduralLeafBumpTex = new THREE.CanvasTexture(_proceduralLeafBumpCanvas);
    _proceduralLeafBumpTex.colorSpace = THREE.NoColorSpace;
    _proceduralLeafBumpTex.anisotropy = 4;
  }
}

// Grayscale height map matching the drawn veins — bright = raised. Used
// as `bumpMap` so veins catch light like real ridges. Soft radial bell
// across the blade gives the leaf a gentle dome instead of reading flat.
function drawLeafBumpToCanvas(ctx, p, size) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  const { pts, cx, topY, botY, maxHalfW } = _leafPathPoints(p, size, 56, { stretch: true });
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.clip();
  const dome = ctx.createRadialGradient(cx, (topY + botY) * 0.5, size * 0.02, cx, (topY + botY) * 0.5, maxHalfW * 1.3);
  dome.addColorStop(0, 'rgba(255,255,255,0.22)');
  dome.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = dome;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  // Midrib — thickest ridge.
  ctx.lineWidth = Math.max(2, size / 96);
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.moveTo(cx, botY);
  ctx.lineTo(cx, topY + size * 0.02);
  ctx.stroke();
  // Secondary veins.
  const n = Math.max(0, p.veinCount | 0);
  ctx.lineWidth = Math.max(1.2, size / 160);
  ctx.globalAlpha = 0.8;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const y = botY + (topY - botY) * t;
    const w = maxHalfW * _leafHalfWidth(t, p);
    const vy = y + w * 0.35;
    ctx.beginPath();
    ctx.moveTo(cx, vy);
    ctx.quadraticCurveTo(cx + w * 0.5, y, cx + w * 0.92, y - w * 0.05);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, vy);
    ctx.quadraticCurveTo(cx - w * 0.5, y, cx - w * 0.92, y - w * 0.05);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// Swap BOTH `m.map` (legacy .map property) AND the TSL colorNode's texture
// reference so the shader actually samples the new texture. Without the
// second step the shader keeps sampling whatever texture was bound at
// material-creation time (see makeLeafMaterial), producing the "old PNG
// still shows" bug on shape swaps.
function _setLeafMapFor(m, tex) {
  m.map = tex;
  if (m._leafColorTexNode) m._leafColorTexNode.value = tex;
  m.needsUpdate = true;
}

// leaf_normal.jpg has the original PNG's vein impressions baked in. It's
// correct for Texture / Upload modes (where the albedo image matches), but
// wrong for every procedural shape — the bumps don't line up with the
// drawn veins and leak the old PNG's silhouette into the shading. Toggle
// it per mode.
function _setLeafNormalFor(m, useBakedNormal) {
  m.normalMap = useBakedNormal ? leafNormal : null;
  m.needsUpdate = true;
}
// Toggle the procedural bump map (generated from veins). Baked normal is
// for Texture/Upload modes; procedural modes use this instead so veins
// line up with what's drawn.
function _setLeafBumpFor(m, tex, scale) {
  m.bumpMap = tex;
  m.bumpScale = scale;
  m.needsUpdate = true;
}

function applyLeafShape() {
  // Always rebuild the curved leaf mesh so its silhouette matches the
  // current profile. The mesh is what defines the leaf shape; the texture
  // (when one is in use) just supplies surface color/veins.
  rebuildLeafGeo();
  const shape = P.leafShape || 'Texture';
  if (shape === 'Texture') {
    for (const m of [leafMatA, leafMatB]) {
      if (m.map && m.map !== leafMapA && m.map !== leafMapB && m.map !== _proceduralLeafTex) {
        m.map.dispose();
      }
    }
    _setLeafMapFor(leafMatA, leafMapA);
    _setLeafMapFor(leafMatB, leafMapB);
    _setLeafNormalFor(leafMatA, true);
    _setLeafNormalFor(leafMatB, true);
    _setLeafBumpFor(leafMatA, null, 0);
    _setLeafBumpFor(leafMatB, null, 0);
    return;
  }
  if (shape === 'Upload') {
    _setLeafNormalFor(leafMatA, true);
    _setLeafNormalFor(leafMatB, true);
    _setLeafBumpFor(leafMatA, null, 0);
    _setLeafBumpFor(leafMatB, null, 0);
    return;
  }
  const base = P.leafProfile;
  // Presets carry their own silhouette polygon; Custom uses the user's
  // sculpted P.leafProfile.silhouette directly.
  const profile = shape === 'Custom' ? base : { ...base, ...LEAF_PRESETS[shape] };
  _ensureProceduralLeafTex(256);
  drawLeafToCanvas(_proceduralLeafCanvas.getContext('2d'), profile, 256);
  drawLeafBumpToCanvas(_proceduralLeafBumpCanvas.getContext('2d'), profile, 256);
  _proceduralLeafTex.needsUpdate = true;
  _proceduralLeafBumpTex.needsUpdate = true;
  const bumpScale = P.leafBumpScale ?? 0.015;
  for (const m of [leafMatA, leafMatB]) {
    if (m.map && m.map !== leafMapA && m.map !== leafMapB && m.map !== _proceduralLeafTex) {
      m.map.dispose();
    }
    _setLeafMapFor(m, _proceduralLeafTex);
    _setLeafNormalFor(m, false);
    _setLeafBumpFor(m, _proceduralLeafBumpTex, bumpScale);
  }
}

// --- Leaf stems (thin cylinder, shared across broadleaf leaves) ---------
// radiusTop (at +y/leaf end) = 0.006, radiusBottom (at -y/twig end) = 0.012 —
// petioles are thicker at the twig attachment and narrow toward the blade.
const stemGeo = new THREE.CylinderGeometry(0.006, 0.012, 1, 5, 1, false);
// Default cylinder is centered vertically; shift so pivot is at one end (y=0)
// and the stem extends along +Y from there.
stemGeo.translate(0, 0.5, 0);
const stemMat = new THREE.MeshStandardMaterial({
  color: 0x5d4027, roughness: 0.85, metalness: 0,
});
let stemInst = null;

// --- Needles: narrow long planes, procedural green texture --------------
function makeNeedleTexture() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 32, 256);
  const grad = ctx.createLinearGradient(16, 0, 16, 256);
  grad.addColorStop(0,   '#2a5f2a');
  grad.addColorStop(0.5, '#3f8a3e');
  grad.addColorStop(1,   '#2a5f2a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(16, 128, 6, 124, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,45,20,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(16, 8); ctx.lineTo(16, 248); ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const needleTex = makeNeedleTexture();
// Narrow & long — 1:~8 aspect. `activeNeedleGeo` is what gets assigned to
// leaf instance meshes; `needleGeo` is the immutable base, never disposed.
const needleGeo = new THREE.PlaneGeometry(0.14, 1);
let activeNeedleGeo = needleGeo;
const NEEDLE_MAT_DEFAULTS = {
  map: needleTex, alphaTest: 0.3, side: THREE.DoubleSide,
  roughness: 0.8, metalness: 0,
  transmission: 0.2, thickness: 0.1, ior: 1.3,
};
const needleMatA = makeLeafMaterial(NEEDLE_MAT_DEFAULTS);
const needleMatB = makeLeafMaterial(NEEDLE_MAT_DEFAULTS);

// Seasonal palette: hue lightness → tint color + density multiplier
// t=0 spring green, 0.5 summer, 0.75 autumn, 1 winter bare
function seasonInfo(t) {
  const stops = [
    { t: 0,    h: 0.28, s: 0.55, l: 0.55, density: 1.0 },
    { t: 0.5,  h: 0.28, s: 0.45, l: 0.40, density: 1.0 },
    { t: 0.75, h: 0.08, s: 0.75, l: 0.48, density: 0.82 },
    { t: 0.9,  h: 0.05, s: 0.65, l: 0.36, density: 0.45 },
    { t: 1.0,  h: 0.05, s: 0.40, l: 0.30, density: 0.0  },
  ];
  let i = 0;
  while (i < stops.length - 1 && t > stops[i + 1].t) i++;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return {
    h: a.h + (b.h - a.h) * f,
    s: a.s + (b.s - a.s) * f,
    l: a.l + (b.l - a.l) * f,
    density: a.density + (b.density - a.density) * f,
  };
}

// Scratch colors — mutated per call, not re-allocated.
const _leafTint = new THREE.Color();
const _leafFinal = new THREE.Color();
const _leafBack = new THREE.Color();
function applyLeafMaterial() {
  const season = seasonInfo(P.season ?? 0.2);
  if (P.leafColorOverride) {
    // Manual override — parse the hex directly into _leafFinal and skip the
    // seasonal/hueShift mixing. Used by blossoming species (cherry, magnolia)
    // where the spring-pink the user wants doesn't fall on the season curve.
    try { _leafFinal.set(P.leafColor || '#ffffff'); }
    catch { _leafFinal.setRGB(1, 1, 1); }
  } else {
    // Combine seasonal tint with user hue shift; mix toward white by (1 - season strength)
    const seasonStrength = Math.max(0, (P.season ?? 0.2) - 0.5) * 2; // 0 through spring/summer, rises from 0.5 onward
    _leafTint.setHSL(
      ((season.h + (P.leafHueShift ?? 0)) + 1) % 1,
      Math.min(1, season.s),
      Math.min(0.85, Math.max(0.35, season.l + 0.15)),
    );
    _leafFinal.setRGB(1, 1, 1).lerp(_leafTint, Math.min(1, seasonStrength + Math.abs(P.leafHueShift ?? 0) * 3));
  }
  // Backside color — user-tunable hue/brightness, blended toward front by mix amount
  _leafBack.setHSL(P.leafBackHue ?? 0.12, 0.45, P.leafBackLum ?? 0.6);
  const backMix = P.leafBackMix ?? 0;
  _leafBackCol.value.copy(_leafFinal).lerp(_leafBack, backMix);
  _leafFrontCol.value.copy(_leafFinal);
  const sheen = P.leafSheen ?? 0;
  for (const m of [leafMatA, leafMatB]) {
    // Mutate in place — replacing m.color would detach the uniform binding.
    m.color.copy(_leafFinal);
    m.roughness = P.leafRoughness;
    m.transmission = P.leafTransmission;
    m.thickness = P.leafThickness;
    m.ior = P.leafIOR;
    m.normalScale.set(P.leafNormalStrength, P.leafNormalStrength);
    // bumpScale is a scalar on the material; bumpMap presence is managed by
    // applyLeafShape (only set for procedural modes).
    if (m.bumpMap) m.bumpScale = P.leafBumpScale ?? 0.015;
    m.clearcoat = P.leafClearcoat ?? 0;
    m.clearcoatRoughness = P.leafClearcoatRough ?? 0.3;
    m.sheen = sheen;
    if (sheen > 0) {
      if (m.sheenColor) m.sheenColor.copy(_leafFinal);
      m.sheenRoughness = 0.5;
    }
    // No needsUpdate — all changes above are uniform/scalar writes that flow
    // live through the NodeMaterial binding. Flagging would force a shader
    // recompile on every slider tick.
  }
}

const _barkTint = new THREE.Color();
// Bark style + layer manager.
// - Style dropdown change → load that preset's values into P.bark* layer
//   sliders, then regen.
// - Layer slider change → P.bark* changes; regen with whatever's in P.
// - The cache key in generateBarkTexture covers every layer field, so a
//   given combination only regenerates once.
let _activeBarkStyle = '__init__';
const _BARK_LAYER_KEYS = [
  'vertFreq','vertSharp','vertWobble','vertDepth',
  'horizFreq','horizSharp','horizAmp',
  'largeFreq','largeAmp','microFreq','microAmp',
  'normalStrength','grain',
];
function _loadBarkPreset(name) {
  const recipe = BARK_STYLES[name] || BARK_STYLES.oak;
  P.barkVertFreq     = recipe.vertFreq;
  P.barkVertSharp    = recipe.vertSharp;
  P.barkVertWobble   = recipe.vertWobble;
  P.barkVertDepth    = recipe.vertDepth;
  P.barkHorizFreq    = recipe.horizFreq;
  P.barkHorizSharp   = recipe.horizSharp;
  P.barkHorizAmp     = recipe.horizAmp;
  P.barkLargeFreq    = recipe.largeFreq;
  P.barkLargeAmp     = recipe.largeAmp;
  P.barkMicroFreq    = recipe.microFreq;
  P.barkMicroAmp     = recipe.microAmp;
  P.barkBumpStrength = recipe.normalStrength;
  P.barkGrain        = recipe.grain;
}
// rAF coalescer — slider drags fire applyBarkMaterial up to 60×/s; each
// regen costs ~50-100 ms. Without this, the queue of onAfter callbacks
// stacks faster than the generator drains, locking the UI. With it, the
// next regen runs at most once per animation frame using whatever values
// P holds at that moment.
let _barkRegenPending = false;
function applyBarkStyle() {
  const style = P.barkStyle || 'oak';
  // Style preset switch → load the preset values into the per-layer
  // sliders so they reflect the active style. After that, layer-slider
  // edits stand on their own.
  if (style !== _activeBarkStyle) {
    _loadBarkPreset(style);
    _activeBarkStyle = style;
    if (typeof syncUI === 'function') syncUI();
  }
  if (_barkRegenPending) return;
  _barkRegenPending = true;
  requestAnimationFrame(() => {
    _barkRegenPending = false;
    const s = P.barkStyle || 'oak';
    const seed = P.barkSeed ?? 1;
    const tex = generateBarkTexture(s, seed);
    if (!tex) return; // generator failed — keep the previous bark
    barkAlbedo.image = tex.albedoCanvas;
    barkNormal.image = tex.normalCanvas;
    barkAlbedo.needsUpdate = true;
    barkNormal.needsUpdate = true;
  });
}

function applyBarkMaterial() {
  applyBarkStyle();
  const hue = P.barkHue ?? 0.08;
  const tint = P.barkTint ?? 0;
  const brightness = P.barkBrightness ?? 1.0;
  const saturation = P.barkSaturation ?? 1.0;
  // Hue overlay: a saturated swatch at the chosen hue; mix amount is `tint`.
  // When tint = 0 the overlay is pure white (no hue cast — texture's natural
  // colour passes through); when tint = 1 the overlay is the full hue swatch.
  _barkTint.setHSL(hue, 0.5, 0.5);
  _mossTint.value.setRGB(1, 1, 1).lerp(_barkTint, tint);
  // Saturation + Brightness are now applied IN-SHADER on the bark texture
  // itself (via _barkSatU / _barkBrightU). That way Saturation actually
  // de/saturates the bark colours regardless of tint amount, instead of
  // silently no-op-ing on a white CPU-side multiplier.
  _barkSatU.value = saturation;
  _barkBrightU.value = brightness;
  // Keep barkMat.color roughly synced for any fallback path that reads it.
  barkMat.color.copy(_mossTint.value).multiplyScalar(brightness);
  barkMat.roughness = P.barkRoughness ?? 0.95;
  const ns = P.barkNormalStrength ?? 1.0;
  if (barkMat.normalScale) barkMat.normalScale.set(ns, ns);
  // su = tiles/m along trunk (→ repeat.x since uv.x = meters along)
  // sv = tiles/m around trunk (→ repeat.y since uv.y = meters around)
  const su = P.barkTexScaleU ?? 0.5;
  const sv = P.barkTexScaleV ?? 0.5;
  // Texture rotation in radians around the (0.5, 0.5) UV centre. THREE
  // applies this matrix-side, no regen — pure GPU-side.
  const rot = (P.barkRotation ?? 0) * (Math.PI / 180);
  if (barkAlbedo) {
    barkAlbedo.repeat.set(su, sv);
    barkAlbedo.center.set(0.5, 0.5);
    barkAlbedo.rotation = rot;
  }
  if (barkNormal) {
    barkNormal.repeat.set(su, sv);
    barkNormal.center.set(0.5, 0.5);
    barkNormal.rotation = rot;
  }
  // Moss blend driven by P.mossAmount / hue / lum / threshold
  _mossAmount.value = P.mossAmount ?? 0;
  _mossThreshold.value = P.mossThreshold ?? 0.35;
  _mossCol.value.setHSL(P.mossHue ?? 0.3, 0.55, P.mossLum ?? 0.25);
  _updateBarkSwatchHues();
}

// Push barkHue / mossHue into the `--swatch-hue` CSS var on every bark- /
// moss-prefixed scrubber so saturation, brightness, and tint sliders show
// their gradient at the *current* colour (Photoshop / Figma style). Cheap:
// runs once per applyBarkMaterial, ~30 setProperty calls.
function _updateBarkSwatchHues() {
  if (typeof document === 'undefined') return;
  const barkDeg = ((P.barkHue ?? 0.08) * 360).toFixed(1);
  const mossDeg = ((P.mossHue ?? 0.3) * 360).toFixed(1);
  for (const el of document.querySelectorAll('.scrubber[data-pkey^="bark"]')) {
    el.style.setProperty('--swatch-hue', barkDeg);
  }
  for (const el of document.querySelectorAll('.scrubber[data-pkey^="moss"]')) {
    el.style.setProperty('--swatch-hue', mossDeg);
  }
}

// Wireframe is rendered as a Mesh with wireframe=true so it shares treeMesh's
// geometry reference — CPU vertex deformations (branch grab, wind sim) apply
// to both in lockstep without any copy.
const treeWireMat = new THREE.MeshBasicMaterial({
  color: THEMES[currentTheme].wireColor,
  wireframe: true,
  transparent: true,
  opacity: 0.75,
  depthTest: true,
});

const treeSplineMat = new THREE.LineBasicMaterial({
  color: 0x4aa8ff,
  transparent: true,
  opacity: 0.95,
  depthTest: true,
});
// Using instanced spheres — PointsMaterial can render as 1px under WebGPU.
const treeSplineDotGeo = new THREE.SphereGeometry(0.02, 8, 6);
const treeSplineDotMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  depthTest: true,
  depthWrite: true,
  toneMapped: false,
});

// --- Seeded RNG ----------------------------------------------------------
let random = mulberry32(1);

// --- Parameter store -----------------------------------------------------
const P = {};
for (const g of PARAM_SCHEMA) for (const p of g.params) P[p.key] = p.default;
P.leafFacing = 0; // internal — driven by species presets (broadleaf) and cNeedleFacing (conifer)
P.goldenRoll = 137.5 * Math.PI / 180;
P.seed = 1;
// WIND_SCHEMA lives here (not schema.js) because each row carries a live
// uniform() node reference that's created above.
const WIND_SCHEMA = [
  { key: 'strength',   label: 'Strength',   min: 0,    max: 1,             step: 0.01, default: 0.08, uni: uWindStrength },
  { key: 'frequency',  label: 'Frequency',  min: 0.1,  max: 5,             step: 0.05, default: 1.2,  uni: uWindFreq },
  { key: 'gust',       label: 'Gust',       min: 0,    max: 1,             step: 0.01, default: 0.4,  uni: uWindGust },
  { key: 'direction',  label: 'Direction',  min: 0,    max: Math.PI * 2,   step: 0.01, default: Math.atan2(0.3, 1.0) },
  { key: 'turbulence', label: 'Turbulence', min: 0,    max: 2,             step: 0.01, default: 0.35 },
  { key: 'swirl',      label: 'Swirl',      min: 0,    max: 1,             step: 0.01, default: 0.15 },
];
P.wind = { enabled: false };
for (const p of WIND_SCHEMA) P.wind[p.key] = p.default;
let profileEditor = null;
let taperSpline = null;
let lengthSpline = null;
let rootsMesh = null;
let _rootsMat = null;
// Roots params use prefixed keys (rootCount/rootSpread/...) so the scrubbers'
// data-pkey doesn't collide with the trunk's baseRadius/tipRadius keys —
// syncUI() walks all scrubbers and pulls from top-level P[key].
P.roots = {
  enabled: false,
  rootCount: 6,
  rootSpread: 1.6,
  rootLength: 1.4,
  rootDepth: 0.6,
  rootBaseR: 0.18,
  rootTipR: 0.04,
  rootJitter: 0.4,
  rootRise: 0.25,
};
P.physics = {};
for (const p of PHYSICS_SCHEMA) P.physics[p.key] = p.default;
// Live renderer + scene settings (exposed via the Settings section)
P.settings = {
  exposure: 1.15,
  toneMapping: 'ACES Filmic',
  pixelRatio: Math.min(window.devicePixelRatio, 2),
  shadowsEnabled: true,
  shadowQuality: 'Medium',
  bloomEnabled: true,
  bloomIntensity: 1.0,
  fogEnabled: true,
  fogNear: 10,
  fogFar: 258,
  envIntensity: 1.0,
  showAxes: false,
  // App-level (Session 14): quality preset that bundles pixelRatio +
  // shadowQuality + bloom into one knob; FPS / triangle stats overlay
  // visibility; auto-orbit for hero shots / screen recordings.
  qualityPreset: 'Balanced',
  statsVisible: true,
  autoOrbit: false,
  autoOrbitSpeed: 8,
};
P.treeType = 'broadleaf';
// Procedural bark style. Picked per species; falls back to 'oak'. The
// generator produces an albedo + normal CanvasTexture pair on first use
// per (style, seed) and caches the result.
P.barkStyle = 'oak';
P.barkSeed  = 1;
// Bake mode: self-organizing tree growth simulation (Palubicki-lite).
// Leaf shape source: 'Texture' (bundled PNG), 'Upload' (user PNG),
// 'Oval' / 'Lanceolate' / 'Heart' / 'Fan' / 'Willow' / 'Birch' (preset
// procedural), or 'Custom' (user-tuned procedural via P.leafProfile).
P.leafShape = 'Texture';
// Bend-geometry keys (owned by the Leaf Shape 3D panel, no longer in the
// Leaf Detail schema). Initialize on P so sliders have a starting value.
if (P.leafMidribCurl === undefined) P.leafMidribCurl = 0.15;
if (P.leafApexCurl === undefined)   P.leafApexCurl   = 0.08;
P.leafProfile = {
  // Profile source. 'analytic' drives the silhouette from the
  // widthAt/baseWidth/tipSharpness params (used by named presets). 'silhouette'
  // uses `silhouette` below — a closed polygon of {x,y} control points in
  // [0,1]² sculpted by the user (Custom). 'spline' is a legacy half-width
  // Catmull-Rom kept for save-file backwards compat.
  mode: 'analytic',
  widthAt: 0.5,
  baseWidth: 0.28,
  baseSharpness: 0.5,
  tipSharpness: 0.35,
  tipWidth: 0.06,
  length: 1.0,
  // Legacy spline half-width (kept for old save files).
  splinePoints: [0.18, 0.55, 0.85, 1.0, 0.98, 0.82, 0.55, 0.12],
  // Closed 2D silhouette, stem at y=0, tip at y=1, midrib at x=0.5. Points are
  // traversed counter-clockwise and smoothed with a closed Catmull-Rom.
  silhouette: [
    { x: 0.50, y: 0.00 }, // base (stem)
    { x: 0.58, y: 0.08 },
    { x: 0.72, y: 0.25 },
    { x: 0.80, y: 0.50 },
    { x: 0.70, y: 0.78 },
    { x: 0.56, y: 0.94 },
    { x: 0.50, y: 1.00 }, // tip
    { x: 0.44, y: 0.94 },
    { x: 0.30, y: 0.78 },
    { x: 0.20, y: 0.50 },
    { x: 0.28, y: 0.25 },
    { x: 0.42, y: 0.08 },
  ],
  serration: 0,
  veinCount: 5,
  aspect: 0.55,
  color: '#4a7a3a',
  veinColor: '#33462a',
};
rebuildLeafGeo();
// Attractor points — each { x, y, z, strength }. Branches bend toward these
// during growth (space-colonization-style pull).
P.attractors = [];
// Populate conifer defaults
for (const g of CONIFER_SCHEMA) for (const p of g.params) P[p.key] = p.default;
// Populate bush defaults
for (const g of BUSH_SCHEMA) for (const p of g.params) P[p.key] = p.default;

P.levels = [
  { ...makeDefaultLevel(), children: 6, lenRatio: 0.62, angle: 0.95, angleVar: 0.25, rollVar: 0.85, distortion: 0.2, startPlacement: 0.42, endPlacement: 1, apicalDominance: 0.2, curveMode: 'sCurve', curveAmount: 0.3, susceptibility: 1.4 },
  { ...makeDefaultLevel(), children: 5, lenRatio: 0.72, angle: 0.75, angleVar: 0.22, rollVar: 0.7, distortion: 0.18, apicalDominance: 0.12, curveMode: 'sCurve', curveAmount: 0.22 },
  { ...makeDefaultLevel(), children: 4, lenRatio: 0.7,  angle: 0.6,  angleVar: 0.2,  rollVar: 0.65, distortion: 0.16, stochastic: 0.15, curveMode: 'backCurve', curveAmount: 0.2 },
  { ...makeDefaultLevel(), children: 3, lenRatio: 0.55, angle: 0.5,  angleVar: 0.2,  rollVar: 0.6,  distortion: 0.14, stochastic: 0.2 },
];

// --- Tree build ----------------------------------------------------------
class TNode {
  constructor(pos, parent = null) {
    this.pos = pos.clone();
    this.parent = parent;
    this.children = [];
    this.radius = 0;
  }
}

// Scratch vectors for the inner child-spawn loop. buildTree runs on a single
// thread and never recurses, so these can be module-global without clashing.
const _scUp       = new THREE.Vector3();
const _scRight    = new THREE.Vector3();
const _scLocUp    = new THREE.Vector3();
const _scAzimuth  = new THREE.Vector3();
const _scChildDir = new THREE.Vector3();

// Sun direction for phototropism — recomputed each buildTree() from the
// azimuth/elevation params. Elevation=90° yields (0,1,0) — pure up-bias.
let _sunDirX = 0, _sunDirY = 1, _sunDirZ = 0;
function _recomputeSunDir() {
  const el = ((P.sunElevation ?? 90) * Math.PI) / 180;
  const az = ((P.sunAzimuth   ?? 0)  * Math.PI) / 180;
  const c = Math.cos(el);
  _sunDirX = c * Math.sin(az);
  _sunDirY = Math.sin(el);
  _sunDirZ = c * Math.cos(az);
}

// normalizeTropism, _TROPISM_DEFAULTS, sampleFalloffArr live in ui-widgets.js
// (imported above) because TropismPanel uses them internally.

function buildTree(nodesOut) {
  _recomputeSunDir();
  const nodes = nodesOut;
  const root = new TNode(new THREE.Vector3(0, 0, 0));
  nodes.push(root);

  // Walk an internode and grow a chain of nodes. Returns step data for children placement.
  // Each branch-walk call gets a LOCAL rng keyed off the parent node's id +
  // level + length. That means whatever number of random draws happens inside
  // (for per-step distortion, forks, etc.) is isolated — changing kinkSteps
  // refines the branch silhouette but never shifts the downstream random stream.
  function walkInternode(startNode, startPos, dir, length, L, levelIdx = 0) {
    const segLen = length / L.kinkSteps;
    let cur = startNode;
    const pos = startPos.clone();
    const d = dir.clone();
    const stepData = [];
    // Position-keyed branch RNG — decoupled from the global random() stream
    // so this branch's internal decisions don't shift when siblings or
    // deeper levels consume draws. Spatial keys make it invariant under
    // trunk / parent-branch subdivision changes.
    const _qpos = (v) => Math.round(v * 1000) | 0;
    const bRng = _localRng(
      P.seed | 0,
      _qpos(startPos.x), _qpos(startPos.y), _qpos(startPos.z),
      _qpos(dir.x), _qpos(dir.y), _qpos(dir.z),
      levelIdx,
      Math.round(length * 1000),
    );
    // Derived from the local stream so it costs no global draws.
    const branchSeed = bRng() * 137.5;
    const freq = L.distortionFreq ?? 3;
    const type = L.distortionType ?? 'random';
    const amp = L.distortion ?? 0;
    const susc = L.susceptibility ?? 1;
    // ez-tree's `1/√radius` gnarliness rule, adapted for our pre-radius walk.
    // Thicker → barely wobble, thinner → flap freely. We don't have node
    // radius at this point (assignRadii is a post-pass), so use level depth
    // as a proxy: trunk + main scaffolds (L0..L2) at 1×, mid (L3) at 1.4×,
    // deepest twigs (last level) at 2.0×. Matches the "alive twigs, steady
    // trunk" feel without per-species tuning.
    const lastLevel = (P.levels.length - 1);
    const thinScale = levelIdx >= lastLevel ? 2.0
                    : levelIdx === lastLevel - 1 ? 1.4
                    : 1.0;
    const curveMode = L.curveMode ?? 'none';
    const curveAmt = L.curveAmount ?? 0;
    const tropG = normalizeTropism(L.gravitropism, 'gravity');
    const tropP = normalizeTropism(L.phototropism, 'photo');
    const levelMul = levelIdx + 1;
    // Pick a stable curvature axis per branch (perpendicular-ish to initial dir)
    const curveAngle = branchSeed;
    const randPts = L.randomnessPoints;
    for (let s = 0; s < L.kinkSteps; s++) {
      const tNorm = s / L.kinkSteps;
      let dx = 0, dz = 0;

      // MTree-style randomness ramp — multiplies distortion amp at this step.
      const rampMul = randPts ? sampleDensityArr(randPts, tNorm) : 1;
      // kinkSteps invariance — perlin's smooth/correlated noise accumulates
      // linearly across direction perturbations, so doubling kinkSteps
      // doubled the total bend amount. Scale per-step amplitude by
      // (8/kinkSteps) so the *total* curve stays constant regardless of
      // segment count. Default kinkSteps=8 → factor 1 (no visible change).
      const stepInv = 8 / Math.max(1, L.kinkSteps);
      const ampE = amp * rampMul * thinScale * stepInv;

      // Distortion noise — always perlin. Sine/twist/random variants removed
      // (every species used 'perlin' anyway; switch overhead is gone now).
      // Torsion removed — was rotating the perturbation around the growth axis,
      // a per-spawn quaternion-style mult that no preset relied on.
      if (ampE > 0) {
        dx = smoothNoise1D(tNorm * freq + branchSeed) * ampE;
        dz = smoothNoise1D(tNorm * freq + branchSeed + 47.3) * ampE;
      }

      // Parametric curvature (on top of noise). Weber-Penn's CurveBack lets
      // the branch curve one way in its first half and back (or further) in
      // the second half — tuned per level via (curveAmount, curveBack).
      // Per-step contributions are scaled by stepInv (8/kinkSteps) so the
      // total bend stays constant when the user changes Segments.
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
        // Weber-Penn asymmetric curve: first half uses curveAmount, second
        // half reverses toward curveBack. Additive with the mode above.
        if (Math.abs(curveBack) > 0.01) {
          const firstHalf = tNorm < 0.5;
          const t = firstHalf ? tNorm * 2 : (tNorm - 0.5) * 2;
          const v = firstHalf ? curveAmt * 0.18 : -curveBack * 0.18;
          curveBias += v * Math.sin(t * Math.PI) * stepInv;
        }
        dx += cx * curveBias;
        dz += cz * curveBias;
      }

      // Tropism with susceptibility. Phototropism pulls toward sun (legacy) or
      // an explicit direction (panel-authored); gravitropism pulls along its dir
      // vector. Falloff samples 0..1 along the branch; byLevel scales by depth.
      d.x += dx; d.z += dz;
      // Tropism + attractors are physical pulls per unit length, not per
      // step — scale by stepInv so doubling kinkSteps doesn't double the
      // total drift toward gravity / sun / attractor points.
      if (tropP.enabled) {
        let f = tropP.falloff ? sampleFalloffArr(tropP.falloff, tNorm) : 1;
        if (tropP.byLevel) f *= levelMul;
        const s = tropP.strength * susc * f * stepInv;
        if (tropP._useSun) { d.x += _sunDirX * s; d.y += _sunDirY * s; d.z += _sunDirZ * s; }
        else               { d.x += tropP.dirX * s; d.y += tropP.dirY * s; d.z += tropP.dirZ * s; }
      }
      if (tropG.enabled) {
        let f = tropG.falloff ? sampleFalloffArr(tropG.falloff, tNorm) : 1;
        if (tropG.byLevel) f *= levelMul;
        const s = tropG.strength * susc * f * stepInv;
        d.x += tropG.dirX * s; d.y += tropG.dirY * s; d.z += tropG.dirZ * s;
      }

      // Attractors — bend heading toward user-placed world-space points
      if (P.attractors && P.attractors.length > 0) {
        for (const a of P.attractors) {
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

      // Branch twist — spiral the heading around world Y each step
      const twist = L.twist ?? 0;
      if (twist !== 0) {
        const tw = twist * segLen;
        const ct = Math.cos(tw), st = Math.sin(tw);
        const nx = d.x * ct - d.z * st;
        const nz = d.x * st + d.z * ct;
        d.x = nx; d.z = nz;
      }

      // Zero-length guard: if tropism/curve/attractor terms cancelled d down
      // to near-zero, normalize() would produce (0,0,0) and the branch
      // would stall or snap back toward origin on the next step. Fall back
      // to the initial dir (still valid, passed in by caller).
      if (d.lengthSq() < 1e-8) d.copy(dir);
      d.normalize();
      pos.addScaledVector(d, segLen);
      // Floor awareness — instead of letting droopy branches clip through
      // the ground, bend them flat along y = FLOOR_Y. Once a branch touches
      // the floor, we zero its vertical direction so subsequent segments
      // continue horizontally (gravity will try to pull y down again each
      // step, but the clamp keeps resetting it — effect: branch fans out
      // along the ground instead of burying into it).
      const FLOOR_Y = 0.03;
      if (pos.y < FLOOR_Y) {
        pos.y = FLOOR_Y;
        d.y = 0;
        const hMag = Math.hypot(d.x, d.z);
        if (hMag > 1e-6) { d.x /= hMag; d.z /= hMag; }
        else             { d.x = 1; d.z = 0; }
      }
      // TNode's constructor clones `pos` internally, so we don't need our own clone here.
      const n = new TNode(pos, cur);
      cur.children.push(n);
      nodes.push(n);
      // Weber-Penn: stamp relative position along the branch (0 at base, 1 at
      // tip) and the level it belongs to so post-process taper can reshape
      // the radius profile per level.
      n.branchT = (s + 1) / L.kinkSteps;
      n.branchLevel = levelIdx;
      cur = n;
      // Reuse n.pos (already a fresh clone inside TNode); only dir needs its own
      // copy because `d` keeps mutating across steps.
      stepData.push({ node: n, pos: n.pos, dir: d.clone() });

      // Weber-Penn nSegSplits: expected number of forks across the branch.
      // Each segment has a probability of spawning a sibling branch of the
      // same level, angled by splitAngle. The original keeps growing straight.
      const segSplits = L.segSplits ?? 0;
      const splitAngle = L.splitAngle ?? 0.25;
      if (segSplits > 0 && s < L.kinkSteps - 2) {
        const stepsLeft = L.kinkSteps - 1 - s;
        // Curve-weighted fork rate: sample splitPoints at this step's tNorm
        // so the user can cluster forks near base, tip, or keep them even.
        const splitMul = Array.isArray(L.splitPoints)
          ? Math.max(0, sampleDensityArr(L.splitPoints, tNorm))
          : 1;
        const expected = (segSplits * splitMul) / L.kinkSteps;
        const forks = Math.floor(expected) + (bRng() < (expected - Math.floor(expected)) ? 1 : 0);
        for (let f = 0; f < forks; f++) {
          if (Math.abs(d.y) > 0.98) _scUp.set(1, 0, 0); else _scUp.set(0, 1, 0);
          const sright = _scRight.crossVectors(d, _scUp).normalize();
          const slocUp = _scLocUp.crossVectors(sright, d).normalize();
          const sroll = bRng() * Math.PI * 2;
          const sca = Math.cos(sroll), scb = Math.sin(sroll);
          const saxis = _scAzimuth.set(0, 0, 0).addScaledVector(sright, sca).addScaledVector(slocUp, scb);
          const forkDir = _scChildDir.set(0, 0, 0)
            .addScaledVector(d, Math.cos(splitAngle))
            .addScaledVector(saxis, Math.sin(splitAngle))
            .normalize()
            .clone();
          const forkLen = length * (stepsLeft / L.kinkSteps) * 0.9;
          // Spawn the fork through a chainRoot bridge so the Weber-Penn
          // radius model scales the fork base from parent-local radius
          // (× radiusRatio) instead of inheriting the parent's full
          // chainBase. Without this the fork began at parent thickness and
          // bulged at the junction, and downstream children inherited the
          // wrong chainBase.
          const fbridge = new TNode(n.pos, n);
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

  function spawnChildrenAlong(stepData, parentLen, childLevelIdx, fromTrunk = false, refCurve = null) {
    if (childLevelIdx >= P.levels.length) return;
    const L = P.levels[childLevelIdx];
    // Weber-Penn BaseSize is still fed to the crown-shape envelope below, but
    // no longer clamps tStart. startPlacement is the user-facing dial for
    // where branches begin; previously any value below baseSize was
    // silently ignored (e.g. Maple baseSize=0.3 swallowed startPlacement<0.3).
    const baseSize = fromTrunk ? Math.max(0, Math.min(0.6, P.baseSize ?? 0)) : 0;
    const tStart = Math.min(L.startPlacement, L.endPlacement);
    const tEnd = Math.max(L.startPlacement, L.endPlacement);
    // 'density' mode derives count from parent length × density × placement
    // window. Default 'count' preserves legacy preset behavior.
    const count = (L.placementMode === 'density')
      ? Math.max(1, Math.round((L.density ?? 4) * Math.max(0.001, parentLen) * (tEnd - tStart)))
      : L.children;
    const crownShape = fromTrunk ? (P.shape ?? 'free') : 'free';
    const lastIdx = stepData.length - 1;
    const phyllo = L.phyllotaxis ?? 'spiral';
    const apical = L.apicalDominance ?? 0;
    const stochastic = L.stochastic ?? 0;
    // Per-parent local RNG — decoupled from the global random() stream so
    // that editing deeper levels (L2/L3) doesn't shift the random draws that
    // L1 saw earlier. Seed from the parent branch's stable identity.
    const _qpos = (v) => Math.round(v * 1000) | 0;
    const _anchor = stepData[0] && stepData[0].node && stepData[0].node.pos;
    const sRng = _localRng(
      P.seed | 0, 0xC01DB1A5, childLevelIdx,
      _anchor ? _qpos(_anchor.x) : 0,
      _anchor ? _qpos(_anchor.y) : 0,
      _anchor ? _qpos(_anchor.z) : 0,
      Math.round(parentLen * 1000),
    );
    // Opposite / decussate phyllotaxis: children come in pairs sharing the
    // same parent-local height. pairIdx groups them so the frac calc yields
    // matching t's for the pair.
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
      if (Array.isArray(L.densityPoints)) {
        const d = sampleDensityArr(L.densityPoints, frac);
        if (d < 0.999 && sRng() > Math.max(0, Math.min(1, d))) continue;
      }
      // Spawn position + direction come from the parent's CANONICAL
      // reference curve (when provided), not its user-resolution skeleton.
      // This makes child spawn points invariant under subdivision changes
      // on the parent. Parent attachment still uses the nearest actual
      // skeleton node so physics / leaves stay hooked to real geometry.
      let _spPos, _spDir, _spNode;
      if (refCurve && refCurve.length >= 2) {
        const refLast = refCurve.length - 1;
        const idxF = Math.max(0, Math.min(refLast, frac * refLast));
        const ri0 = Math.floor(idxF);
        const ri1 = Math.min(refLast, ri0 + 1);
        const u = idxF - ri0;
        // Direction still uses the canonical ref curve so branch orientation
        // is invariant under parent-resolution changes.
        _spDir = refCurve[ri0].dir.clone().lerp(refCurve[ri1].dir, u);
        if (_spDir.lengthSq() < 1e-10) _spDir.copy(refCurve[ri0].dir);
        _spDir.normalize();
        // Position snaps to the nearest parent chain node — guarantees the
        // bridge sits exactly on the parent tube's Catmull-Rom curve instead
        // of on the ref curve (which the tube no longer follows after we
        // unified the trunk into a single sweep). Arbaro / Sapling / MTree
        // all position branch bases at parent chain nodes for this reason.
        const skelIdx = Math.max(0, Math.min(lastIdx, Math.round(frac * lastIdx)));
        _spNode = stepData[skelIdx].node;
        _spPos = _spNode.pos.clone();
      } else {
        // Fallback: snap to the nearest skeleton node so the bridge sits
        // exactly on the parent chain's Catmull-Rom curve.
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
      // Hoisted scratch — see _sc* constants below the function.
      if (Math.abs(sp.dir.y) > 0.98) _scUp.set(1, 0, 0); else _scUp.set(0, 1, 0);
      const right = _scRight.crossVectors(sp.dir, _scUp).normalize();
      const locUp = _scLocUp.crossVectors(right, sp.dir).normalize();

      // Apical dominance. Broadleaf default: base short, tip strong.
      // Conifer (apicalInverted): base LONG, tip short → conical silhouette.
      const apicalSide = L.apicalInverted ? frac : (1 - frac);
      // Halved from original `1 - apical * apicalSide` — the full effect
      // produced a "tip fan" where laterals near the parent tip grew much
      // longer than base laterals. Real crowns taper more subtly.
      const apicalLenMul = 1 - apical * apicalSide * 0.5;
      const apicalAngleBoost = apical * apicalSide * 0.35;

      // Weber-Penn nDownAngleV: angle varies along the parent branch.
      // Positive `angleDecline` makes children angle OUT more toward the tip;
      // negative makes them more vertical toward the tip (like conifers).
      const declineBias = (L.angleDecline ?? 0) * (frac - 0.5) * 2;
      // MTree-style start_angle ramp — additive, sampled at placement on parent.
      const angleRamp = L.startAnglePoints ? sampleDensityArr(L.startAnglePoints, frac) : 0;
      const angle = L.angle + apicalAngleBoost + declineBias + angleRamp + (sRng() - 0.5) * L.angleVar;

      // Phyllotaxis: different roll patterns between successive children.
      // rollStart offsets the whole pattern by a fixed phase so the user can
      // orient the arrangement (e.g. point a Palm whorl toward the sun).
      let roll;
      switch (phyllo) {
        // Opposite: pair members face 180° apart, all pairs share one plane.
        case 'opposite':  roll = withinPair * Math.PI; break;
        // Decussate: each successive pair rotates 90° from the last (maple, ash).
        case 'decussate': roll = withinPair * Math.PI + pairIdx * (Math.PI / 2); break;
        case 'whorled':   roll = (c / count) * Math.PI * 2; break;
        default: /* 'spiral' */ roll = P.goldenRoll * (c + 1);
      }
      roll += (L.rollStart ?? 0);
      // Fibonacci mode: force strict golden-angle spacing, suppress rollVar.
      // This minimizes self-shadowing — the same rule nature uses for leaves
      // and whorls. Branch-formula toggle in the Global group.
      const _branchModel = P.branchModel || 'weber-penn';
      if (_branchModel === 'fibonacci') {
        roll = P.goldenRoll * (c + 1) + (L.rollStart ?? 0);
      } else {
        roll += (sRng() - 0.5) * L.rollVar;
      }

      // Apical continuation: the last child (at the parent's tip) can be forced
      // to inherit the parent's direction with angle→0, creating a true central
      // leader instead of an L/Y fork at the top. Length is boosted so it reads
      // as the trunk's continuation, not a sibling.
      const apicalContinue = L.apicalContinue ?? 0;
      const isApicalChild = apicalContinue > 0 && count > 1 && c === count - 1;
      const effAngle = isApicalChild ? angle * (1 - apicalContinue) : angle;
      const cosR = Math.cos(roll), sinR = Math.sin(roll);
      const azimuth = _scAzimuth.set(0, 0, 0).addScaledVector(right, cosR).addScaledVector(locUp, sinR);
      const childDir = _scChildDir.set(0, 0, 0)
        .addScaledVector(sp.dir, Math.cos(effAngle))
        .addScaledVector(azimuth, Math.sin(effAngle))
        .normalize();
      // Context-sensitive signal decay: later siblings (higher c) get weaker.
      // Models acrotonic hormone flow — earlier sibling starves the next one.
      // Apical-continuation children bypass decay — they're THE leader.
      const sig = L.signalDecay ?? 0;
      const signalVigor = isApicalChild ? 1 : (sig > 0 ? Math.max(0.25, 1 - c * sig) : 1);
      // Weber-Penn Shape envelope — scales primary branch length by position
      // along the trunk to form canonical crown silhouettes (conical, spherical,
      // flame, etc.). Only applies when spawning from trunk.
      const shapeMul = shapeLenRatio(crownShape, (frac - baseSize) / Math.max(0.001, 1 - baseSize));
      // Per-level length profile — scales child length by position along parent.
      const lenMul = Array.isArray(L.lengthPoints) ? Math.max(0, sampleDensityArr(L.lengthPoints, frac)) : 1;
      // Central-leader length boost so the continuation reads as the trunk
      // extending, not as a fork sibling.
      const apicalLenBoost = isApicalChild ? (1 + apicalContinue * 0.6) : 1;
      // Honda (1971) straight/branch length ratios — apical child uses R1
      // (~0.82: straight continuation), laterals use R2 (~0.6: side branch).
      // Weber-Penn leaves lenRatio as-is.
      let hondaMul = 1;
      if (_branchModel === 'honda') {
        const _r1 = P.hondaR1 ?? 0.94; // apical / straight continuation
        const _r2 = P.hondaR2 ?? 0.86; // first lateral
        hondaMul = isApicalChild ? _r1 : (c === 0 ? _r2 : _r2 * 0.81);
      }
      // apicalDominance scaling shouldn't apply to the apical-continuation
      // child — that child is the leader and gets its own apicalLenBoost.
      const _apicalLenMulEff = isApicalChild ? 1 : apicalLenMul;
      const childLen = parentLen * L.lenRatio * _apicalLenMulEff * signalVigor * shapeMul * lenMul * apicalLenBoost * hondaMul;
      // Bridge node — ALWAYS inserted, not just when refCurve is present.
      // buildChains identifies branch-starts by `chainRoot`; without this
      // flag, lateral chains at L2/L3/L4 were being treated as "extra
      // siblings" of the continuation walk and skipped the junction flare +
      // backward pad, causing them to float off the parent's surface.
      // Bridge sits at sp.pos (already snapped to the parent's chain node).
      const bridge = new TNode(sp.pos, sp.node);
      bridge.radius = sp.node.radius || 0;
      bridge.chainRoot = true;
      bridge.branchLevel = childLevelIdx;
      sp.node.children.push(bridge);
      nodes.push(bridge);
      growAtLevel(bridge, sp.pos, childDir, childLen, childLevelIdx);
    }
  }

  // Weber-Penn crown-shape envelope. `ratio` runs 0 at trunk base to 1 at top.
  // Return value multiplies the primary branch length so the branches together
  // trace the named silhouette.
  function shapeLenRatio(shape, ratio) {
    if (!shape || shape === 'free') return 1;
    const r = Math.max(0, Math.min(1, ratio));
    switch (shape) {
      case 'conical':        return 0.2 + 0.8 * (1 - r);
      case 'spherical':      return 0.2 + 0.8 * Math.sin(Math.PI * r);
      // Dome shape — widest at the crown BASE (where the hemisphere meets
      // the trunk), narrow at the top. Old formula had this inverted:
      // sin(πr·0.5) grows from 0→1 giving a wide-topped inverted bowl.
      case 'hemispherical':  return 0.2 + 0.8 * Math.cos(Math.PI * r * 0.5);
      case 'cylindrical':    return 1;
      case 'tapered':        return 0.5 + 0.5 * (1 - r);
      case 'flame':          return r <= 0.7 ? 0.15 + 0.85 * r / 0.7 : 0.15 + 0.85 * (1 - r) / 0.3;
      case 'inverse':        return 0.2 + 0.8 * r;
      case 'tend-flame':     return r <= 0.7 ? 0.5 + 0.5 * r / 0.7 : 0.5 + 0.5 * (1 - r) / 0.3;
      default:               return 1;
    }
  }

  function growAtLevel(startNode, startPos, dir, length, levelIdx) {
    if (levelIdx >= P.levels.length) return;
    // Growth phase — levels beyond phase*max are skipped; the partial level is scaled.
    // growthPhase only scales the deepest (last) level — completed levels
    // stay full-length so adding a new level doesn't retroactively stretch
    // its parents.
    const phase = P.growthPhase ?? 1;
    const lastLevel = P.levels.length - 1;
    if (levelIdx === lastLevel && phase <= 0) return;
    const phaseLenMul = levelIdx < lastLevel ? 1 : Math.min(1, phase);
    const L = P.levels[levelIdx];
    const lenMul = lengthSpline ? lengthSpline.sample(P.levels.length > 1 ? levelIdx / (P.levels.length - 1) : 0) : 1;
    const effLen = length * lenMul * phaseLenMul;
    if (effLen < P.minLen) return;

    const stepData = walkInternode(startNode, startPos, dir, effLen, L, levelIdx);
    if (levelIdx + 1 < P.levels.length && phaseLenMul >= 1) {
      spawnChildrenAlong(stepData, effLen, levelIdx + 1);
    }
  }

  // Phase 1 — trunk(s). When trunkCount > 1 we fan multiple trunks from the
  // shared root, each angled slightly outward.
  const trunkCount = Math.max(1, P.trunkCount | 0);
  const trunkSpread = P.trunkSplitSpread ?? 0.45;
  // Y-fork: trunks share a single base, then diverge at this fraction of
  // trunk height. 0 = legacy (fan from ground). Active only when trunkCount>1.
  const trunkSplitHeight = Math.max(0, Math.min(0.95, P.trunkSplitHeight ?? 0));
  const useDelayedSplit = trunkCount > 1 && trunkSplitHeight > 0;
  let tk0ForkNode = null;     // tk=0 skeleton node closest to splitHeight
  let tk0NoisePhase = 0;      // shared noise so the lower bole overlaps exactly
  const trunkSegLen = P.trunkHeight / P.trunkSteps;
  // Lean: initial pitch of the trunk base, in the horizontal direction
  // `leanDirRad` (0 = +X, π/2 = +Z). Applied once to the starting tdir.
  const lean = P.trunkLean ?? 0;
  const leanDirRad = ((P.trunkLeanDir ?? 0) * Math.PI) / 180;
  const leanAxisX = Math.cos(leanDirRad);
  const leanAxisZ = Math.sin(leanDirRad);
  // Bow: subtle S-curve along the full trunk length. Positive phase gives a
  // single smooth arc that returns near vertical at the tip.
  const bow = P.trunkBow ?? 0;
  for (let tk = 0; tk < trunkCount; tk++) {
    const tpos = new THREE.Vector3();
    const tdir = new THREE.Vector3(0, 1, 0);
    let tkAz = 0, tkOutward = 0;
    if (trunkCount > 1) {
      const az = (tk / trunkCount) * Math.PI * 2 + random() * 0.4;
      const outward = trunkSpread;
      tkAz = az; tkOutward = outward;
      if (useDelayedSplit) {
        // Y-fork: every trunk launches vertical from the shared root; the
        // outward kick is applied later in the ref-curve loop above
        // trunkSplitHeight.
      } else {
        tdir.set(Math.cos(az) * outward, 1, Math.sin(az) * outward).normalize();
        tpos.set(Math.cos(az) * 0.25 * trunkSpread, 0, Math.sin(az) * 0.25 * trunkSpread);
      }
    }
    if (lean > 0) {
      // Tilt the initial heading by `lean` radians in the lean direction.
      const s = Math.sin(lean), c = Math.cos(lean);
      tdir.set(tdir.x * c + leanAxisX * s, tdir.y * c, tdir.z * c + leanAxisZ * s).normalize();
    }
    let tcur = root;
    const trunkSteps = [];
    const trunkTwist = P.trunkTwist ?? 0;
    // Per-trunk local RNG so changing P.trunkSteps no longer shifts the
    // downstream random stream.
    const tRng = _localRng(P.seed | 0, 0xA1A1, tk);
    // Noise phase for this trunk — picks the curve shape from the seed.
    // In Y-fork mode all trunks share tk=0's phase so the lower bole paths
    // coincide exactly until the split height.
    let trunkNoisePhase;
    if (useDelayedSplit) {
      if (tk === 0) tk0NoisePhase = tRng() * 1000;
      trunkNoisePhase = tk0NoisePhase;
    } else {
      trunkNoisePhase = tRng() * 1000;
    }
    // Capture starting direction before the loop (tdir is rebuilt per step).
    const startDirX = tdir.x, startDirY = tdir.y, startDirZ = tdir.z;
    const startPosX = tpos.x, startPosY = tpos.y, startPosZ = tpos.z;
    const jAmp = P.trunkJitter * 6.5;
    const multiRestoreCap = (trunkCount > 1 && !useDelayedSplit) ? 0.4 : 0;

    // === Build a CANONICAL reference trunk curve at fixed resolution ===
    // All branch spawn positions along this trunk come from the reference
    // curve — NOT from the user-resolution skeleton. That way changing
    // P.trunkSteps only refines the trunk's visible tessellation; branches
    // stay anchored to the exact same points along the true trunk curve.
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
        // Ramp noise / wander in over the first 15 % of trunk height so
        // the base ring stays perpendicular to the ground. The first
        // user-resolution trunk node samples ~refSteps[1] (tN ≈ 0.023);
        // with a 5 % zone that vert was still ~45 % noisy, leaving the
        // CatmullRom tangent at root tilted enough to lift one edge of
        // the bottom tube ring off the floor. 15 % puts the first 1-2
        // user nodes in the fully-vertical region. Smooth (smoothstep)
        // ramp so there's no visible kink at the transition.
        const _u = Math.max(0, Math.min(1, tN / 0.15));
        const _baseAnchor = _u * _u * (3 - 2 * _u);
        let nX = (smoothNoise1D(trunkNoisePhase + tN * 3.2) * jAmp
               + smoothNoise1D(trunkNoisePhase + tN * 9.7 + 11.1) * jAmp * 0.3) * _baseAnchor;
        let nZ = (smoothNoise1D(trunkNoisePhase + tN * 3.2 + 17.3) * jAmp
               + smoothNoise1D(trunkNoisePhase + tN * 9.7 + 29.4) * jAmp * 0.3) * _baseAnchor;
        const nY = smoothNoise1D(trunkNoisePhase + tN * 2.4 + 51.7) * 0.12 * _baseAnchor;
        // Low-freq sinuous wander — independent of jAmp so cranking jitter
        // doesn't compound it. Decoupled X/Z phases so the trunk doesn't just
        // bend in one plane.
        if (sinAmt > 0) {
          nX += smoothNoise1D(trunkNoisePhase * 0.13 + tN * sinFreq) * sinAmt * _baseAnchor;
          nZ += smoothNoise1D(trunkNoisePhase * 0.13 + tN * sinFreq + 73.1) * sinAmt * _baseAnchor;
        }
        let dx = startDirX + nX;
        let dy = startDirY + nY;
        let dz = startDirZ + nZ;
        if (multiRestoreCap > 0) dy += Math.min(1, tN / 0.6) * multiRestoreCap;
        if (useDelayedSplit && tN > trunkSplitHeight) {
          // Smooth ramp from 0 at the fork up to full trunkSpread by tN=1.
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

    // === Build the user-resolution skeleton by sampling the reference ===
    // Each user-visible trunk node's position is lerp'd from the canonical
    // curve, so the skeleton is a polyline approximation of the SAME curve
    // at every trunkSteps value. Branch spawn positions (below) pull from
    // the reference curve directly for exactness, using the nearest
    // skeleton node as parent for attachment.
    const lerpDir = new THREE.Vector3();
    // For tk>=1 in Y-fork mode, attach the first emitted node to tk=0's fork
    // node instead of the global root. The lower-bole nodes are skipped.
    if (useDelayedSplit && tk > 0 && tk0ForkNode) tcur = tk0ForkNode;
    for (let i = 0; i < P.trunkSteps; i++) {
      const tN = (i + 0.5) / P.trunkSteps;
      if (useDelayedSplit && tk > 0 && tN < trunkSplitHeight) continue;
      const refIdxF = tN * REF_TRUNK_STEPS - 0.5;
      // Clamp BOTH ends — if tN/refIdxF were ever NaN or > 1 (e.g. an
      // unsanitized P.trunkSteps), Math.floor/min still need a safe ceiling.
      let ri0 = Math.max(0, Math.min(REF_TRUNK_STEPS - 1, Math.floor(refIdxF) | 0));
      let ri1 = Math.max(0, Math.min(REF_TRUNK_STEPS - 1, ri0 + 1));
      if (!refSteps[ri0]) {
        if (typeof console !== 'undefined') console.warn('[buildTree] refSteps miss', { ri0, ri1, refIdxF, tN, trunkSteps: P.trunkSteps, len: refSteps.length });
        ri0 = 0; ri1 = Math.min(1, refSteps.length - 1);
        if (!refSteps[ri0]) continue; // can't recover, skip this trunk node
      }
      const u = Math.max(0, Math.min(1, refIdxF - ri0));
      const nPos = refSteps[ri0].pos.clone().lerp(refSteps[ri1].pos, u);
      lerpDir.copy(refSteps[ri0].dir).lerp(refSteps[ri1].dir, u);
      if (lerpDir.lengthSq() < 1e-10) lerpDir.copy(refSteps[ri0].dir);
      lerpDir.normalize();
      const n = new TNode(nPos, tcur);
      n.branchT = (i + 1) / P.trunkSteps;
      n.isTrunk = true;
      tcur.children.push(n);
      nodes.push(n);
      tcur = n;
      tpos.copy(nPos);
      tdir.copy(lerpDir);
      trunkSteps.push({ node: n, pos: n.pos, dir: lerpDir.clone() });
    }
    // Capture tk=0's fork node so subsequent trunks can attach there.
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
      const apex1 = new TNode(apexPos1, tcur);
      apex1.branchT = 1; apex1.isTrunk = true;
      tcur.children.push(apex1); nodes.push(apex1);
      const apexPos2 = apexPos1.clone().addScaledVector(tdir, apexLen * 0.7);
      const apex2 = new TNode(apexPos2, apex1);
      apex2.branchT = 1; apex2.isTrunk = true;
      apex1.children.push(apex2); nodes.push(apex2);
    }
    // Decoupled: level-0 branch length derives from a fixed reference scaled
    // by globalScale, NOT trunkHeight. Trunk height now only affects the
    // trunk pole — sliding it taller/shorter no longer inflates the canopy.
    const branchBaseLen = 9.0 * (P.globalScale ?? 1);
    if (P.levels.length > 0) spawnChildrenAlong(trunkSteps, branchBaseLen, 0, true, refSteps);
  }

  // Pruning envelope — cut branches whose nodes fall outside the silhouette
  if (P.pruneMode === 'ellipsoid') {
    const rxz = P.pruneRadius, ry = P.pruneHeight, cy = P.pruneCenterY;
    const inside = (n) => {
      const dx = n.pos.x, dy = n.pos.y - cy, dz = n.pos.z;
      return (dx * dx + dz * dz) / (rxz * rxz) + (dy * dy) / (ry * ry) <= 1;
    };
    // Mark every descendant of a cut-off branch as pruned. The tips filter in
    // _foliagePhase skips pruned nodes so leaves never spawn on invisible
    // branches (the node still lives in treeNodes[] even after being
    // disconnected from its parent's children array).
    const markPruned = (n) => {
      n.pruned = true;
      for (let i = 0; i < n.children.length; i++) markPruned(n.children[i]);
    };
    const prune = (n) => {
      for (let i = n.children.length - 1; i >= 0; i--) {
        const c = n.children[i];
        // ALWAYS preserve trunk nodes — the trunk must run from root to apex
        // regardless of envelope. The previous `c.pos.y < cy - ry` test failed
        // when a trunk node landed just barely above the ellipsoid bottom plus
        // just barely outside the ellipsoid (1.0036 instead of 1.0): that one
        // trunk node got killed, and markPruned then recursively wiped its
        // entire subtree, including everything above it. Whole-tree-disappears.
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

  // Weber-Penn parametric radii (top-down). Trunk tapers baseRadius→tipRadius
  // along its height; each side branch's base is parent-local radius × the
  // level's radiusRatio, and tapers to tipRadius over its own length. Adding a
  // new branch level doesn't disturb existing radii — each chain's base is
  // sampled once from its parent at spawn time.
  // baseRadius scales with trunkHeight so species variety works without
  // every preset specifying a value. At reference height 10 the slider maps
  // 1:1 to world units; taller/shorter trees scale proportionally.
  const baseR = (P.baseRadius ?? 0.35) * ((P.trunkHeight ?? 10) / 10);
  const tipR = P.tipRadius;
  const taperExp = P.taperExp ?? 1.6;
  root.radius = baseR;
  root.chainBaseR = baseR;
  for (const n of nodes) {
    if (n === root) continue;
    const parent = n.parent;
    if (n.chainRoot) {
      // Branch start — base scales from parent's LOCAL radius at spawn.
      const parentR = parent ? (parent.radius || tipR) : baseR;
      const L = P.levels[n.branchLevel ?? 0];
      const ratio = (L && L.radiusRatio != null) ? L.radiusRatio : 0.6;
      n.chainBaseR = Math.max(tipR, parentR * ratio);
      n.radius = n.chainBaseR;
    } else {
      // Walk node — interpolate along its own chain base→tip.
      const chainBase = (parent && parent.chainBaseR != null) ? parent.chainBaseR : baseR;
      const t = Math.max(0, Math.min(1, n.branchT ?? 1));
      const k = Math.pow(1 - t, taperExp);
      n.radius = tipR + (chainBase - tipR) * k;
      n.chainBaseR = chainBase;
    }
  }

  // Global branch-thickness multiplier — scales every node's radius uniformly
  // after the allometric pipe-model computation. A single dial for overall
  // tree weight / compensates thinning from density-curve culling.
  const bT = P.branchThickness ?? 1;
  if (Math.abs(bT - 1) > 1e-4) {
    for (const n of nodes) n.radius *= bT;
  }

  // Weber-Penn per-level Taper: reshape the radius profile within each branch.
  //   taper < 1 → tend to cylinder (mid segment stays thick)
  //   taper = 1 → linear (default, no change)
  //   taper ≤ 2 → cone / sharp cone (narrows faster toward tip)
  //   taper > 2 → periodic (oscillating radius — aesthetic effect)
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

  // Single pass: apply root-flare AND find maxY in one loop.
  // Spread the flare over ~4m with a smooth arch curve (ease-out cubic) so
  // the trunk bells out gradually instead of mushrooming right at the base.
  let maxY = 0;
  const rootFlare = P.rootFlare;
  const flareH = 3.8;
  // Bias factor halves the actual flare strength so default rootFlare=1
  // gives a natural ~1.4× buttress instead of doubling the trunk base.
  // Per-species rootFlare values were tuned with this softer effect in mind
  // — bumping the slider to 2.0 reproduces the old behavior.
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
  // Second pass: trunk-scale taper (depends on maxY, can't fuse with above).
  const invMax = maxY > 0 ? 1 / maxY : 0;
  const trunkScaleAmt = P.trunkScale - 1;
  if (trunkScaleAmt !== 0) {
    for (const n of nodes) {
      const tY = n.pos.y * invMax;
      const tClamp = tY < 0 ? 0 : (tY > 1 ? 1 : tY);
      n.radius *= 1 + trunkScaleAmt * (1 - tClamp);
    }
  }

  // Gravity sag — MTree-style post-pass. Mirror in tree-worker.js.
  // Scrub-skip: during a slider drag the user only needs a coarse preview;
  // sag is the heaviest post-pass on big trees (~30-50ms at 10k nodes).
  // Drag-end triggers a full rebuild that re-applies sag.
  if (!isScrubbing) _applyGravitySag(root, nodes, P);

  // Branch wobble — SpeedTree-style "wood noise" applied to skeleton node
  // positions. Branches anchor to these nodes so the wobble propagates to
  // every level naturally (no parent-branch disconnect). Per-level wobble
  // overrides: P.levels[lvl].wobble > 0 replaces the global at that level.
  _applyBranchWobble(root, nodes, P);

  return root;
}

// Skeleton-level lateral perturbation. For each non-root node, samples
// world-position 3D noise to build two orthogonal channels in the local
// perpendicular plane (perp to parent→node direction). Magnitude scales
// 1/√radius so twigs flex while trunks barely shift. Per-level override
// (P.levels[lvl].wobble > 0) takes precedence over the global value.
function _applyBranchWobble(root, nodes, P) {
  const globalAmt  = P.branchWobble ?? 0;
  const globalFreq = P.branchWobbleFreq ?? 2.0;
  // Quick check — if global is 0 AND no per-level override is set, skip.
  let anyLevelOverride = false;
  if (Array.isArray(P.levels)) {
    for (const L of P.levels) if (L && (L.wobble ?? 0) > 0) { anyLevelOverride = true; break; }
  }
  if (!(globalAmt > 0) && !anyLevelOverride) return;
  const N = nodes.length;
  if (N < 2) return;
  // Snapshot positions so a parent's wobble doesn't bias its child's
  // perpendicular basis (we offset against the original parent→child edge).
  const oX = new Float32Array(N), oY = new Float32Array(N), oZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const n = nodes[i]; n.idx = i;
    oX[i] = n.pos.x; oY[i] = n.pos.y; oZ[i] = n.pos.z;
  }
  // Pass 1 — non-chainRoot nodes wobble independently. Walking nodes in
  // topo order (parents before children) ensures every node's parent has
  // already had its offset applied by the time we read parent.pos.
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
    const n1 = fbm3D(wxN,        wyN,        wzN       ) * 2 - 1;
    const n2 = fbm3D(wxN + 47.3, wyN + 13.7, wzN + 91.1) * 2 - 1;
    const lvlIdx = (lvl ?? 0);
    const depthScale = 0.6 + lvlIdx * 0.35;
    let wMul = lvlAmt * depthScale * 0.12;
    // Trunk nodes near the floor must NOT wobble — otherwise the chain's
    // first node drifts off the y-axis, the CatmullRom tangent at root
    // tilts, and the bottom tube ring lifts off the ground. Smooth ramp:
    // 0 at trunk base, full by 15 % of trunkHeight. Branch nodes
    // (branchLevel set / not isTrunk) wobble at full strength as before.
    if (n.isTrunk || n.branchLevel === undefined) {
      const yFrac = oY[i] / Math.max(0.1, P.trunkHeight ?? 10);
      const _u = Math.max(0, Math.min(1, yFrac / 0.15));
      wMul *= _u * _u * (3 - 2 * _u);
    }
    n.pos.x += (ax * n1 + bx * n2) * wMul;
    n.pos.y += (ay * n1 + by * n2) * wMul;
    n.pos.z += (az * n1 + bz * n2) * wMul;
  }
  // Pass 2 — chainRoot nodes inherit their tree-parent's offset exactly.
  // Without this, a branch spawned at an interpolated position between two
  // parent-chain nodes computes its own noise sample at the midpoint, which
  // doesn't match the parent's CR-curve surface at the same t. Using the
  // parent's offset preserves the original parent-to-chainRoot edge vector,
  // so the branch base sits flush against its parent's wobbled surface.
  for (let i = 0; i < N; i++) {
    const n = nodes[i];
    if (!n.chainRoot || !n.parent) continue;
    const pi = n.parent.idx;
    n.pos.x = oX[i] + (n.parent.pos.x - oX[pi]);
    n.pos.y = oY[i] + (n.parent.pos.y - oY[pi]);
    n.pos.z = oZ[i] + (n.parent.pos.z - oZ[pi]);
  }
}

// Recursive weight accumulation + cumulative rotation cascade. Walks parent-
// before-child topo order (which buildTree already guarantees: walkInternode
// pushes children only after the parent). At each non-root node we compute
// a small rotation about (tangent × -Y) whose magnitude scales with
// horizontality × √(downstream weight) × gravityStrength, damped by node
// thickness × stiffness. The rotation accumulates down the chain so an
// entire heavy subtree pivots as one piece, just like a real branch.
function _applyGravitySag(root, nodes, P) {
  const gravity = P.gravityStrength ?? 0;
  if (!(gravity > 0)) return;
  const stiffness = Math.max(0, P.gravityStiffness ?? 0.5);
  const N = nodes.length;
  if (N < 2) return;
  // Snapshot positions; assign tentative idx (main re-stamps later).
  const oX = new Float32Array(N), oY = new Float32Array(N), oZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const n = nodes[i]; n.idx = i;
    oX[i] = n.pos.x; oY[i] = n.pos.y; oZ[i] = n.pos.z;
  }
  // Self segment-weighted contribution (length × radius²) — a stand-in for
  // wood mass plus the foliage mass it supports, monotone with both.
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
  // Reverse propagate child weight up — topo order means all children of
  // node i appear after i, so a single reverse pass suffices.
  for (let i = N - 1; i >= 0; i--) {
    const p = nodes[i].parent;
    if (p) sagW[p.idx] += sagW[i];
  }
  // Cumulative rotation cascade. accQ[i] is the rotation that should be
  // applied to a child's offset relative to node i.
  const qX = new Float32Array(N), qY = new Float32Array(N);
  const qZ = new Float32Array(N), qW = new Float32Array(N);
  qW[root.idx] = 1;
  for (let i = 0; i < N; i++) {
    const n = nodes[i], p = n.parent;
    if (!p) continue;
    const pi = p.idx;
    let rx = oX[i] - oX[pi], ry = oY[i] - oY[pi], rz = oZ[i] - oZ[pi];
    const pqx = qX[pi], pqy = qY[pi], pqz = qZ[pi], pqw = qW[pi];
    // Rotate offset by parent's accumulated quaternion.
    const tx = 2 * (pqy * rz - pqz * ry);
    const ty = 2 * (pqz * rx - pqx * rz);
    const tz = 2 * (pqx * ry - pqy * rx);
    const newRx = rx + pqw * tx + (pqy * tz - pqz * ty);
    const newRy = ry + pqw * ty + (pqz * tx - pqx * tz);
    const newRz = rz + pqw * tz + (pqx * ty - pqy * tx);
    n.pos.set(p.pos.x + newRx, p.pos.y + newRy, p.pos.z + newRz);
    // Local sag at this joint.
    const tlen = Math.sqrt(newRx*newRx + newRy*newRy + newRz*newRz);
    let lqx = 0, lqy = 0, lqz = 0, lqw = 1;
    if (tlen > 1e-6) {
      const tnx = newRx / tlen, tnz = newRz / tlen;
      // axis = cross(tangent, -Y) = (tnz, 0, -tnx)
      const aLen = Math.sqrt(tnx*tnx + tnz*tnz);
      if (aLen > 1e-5) {
        const r = n.radius || 0.01;
        const stiff = stiffness * (r / 0.04);
        let theta = aLen * Math.sqrt(sagW[i]) * gravity * 0.015 / (1 + stiff * 4);
        if (theta > 0.5) theta = 0.5;
        const half = theta * 0.5;
        const s = Math.sin(half), c = Math.cos(half), inv = 1 / aLen;
        lqx = tnz * inv * s;  // axis.x = tnz
        lqz = -tnx * inv * s; // axis.z = -tnx
        lqw = c;
      }
    }
    // accQ[i] = lq * pq (Hamilton): apply pq first, then lq.
    qX[i] = lqw * pqx + pqw * lqx + (lqy * pqz - lqz * pqy);
    qY[i] = lqw * pqy + pqw * lqy + (lqz * pqx - lqx * pqz);
    qZ[i] = lqw * pqz + pqw * lqz + (lqx * pqy - lqy * pqx);
    qW[i] = lqw * pqw - (lqx * pqx + lqy * pqy + lqz * pqz);
  }
}

function buildChains(root) {
  // A "chain" is the longest continuation-only path. Only chainRoot-flagged
  // children (lateral branches spawned by spawnChildrenAlong) start new
  // chains; non-chainRoot children extend the current chain. Result: the
  // trunk is ONE unbroken spline from root → top, swept with a single
  // circle profile → clean quad topology with continuous UVs and no seams
  // between branch insertion points. Branches stay independent tubes.
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
        if (c.chainRoot) {
          stack.push(c);           // lateral branch → new chain
        } else if (!contChild) {
          contChild = c;           // this chain's continuation
        } else {
          stack.push(c);           // extra sibling (multi-trunk split) → own chain
        }
      }
      if (!contChild) break;
      chain.push(contChild);
      cur = contChild;
    }
    if (chain.length >= 2) chains.push(chain);
  }
  return chains;
}

const _tubeCenter = new THREE.Vector3();
const _tubeTangent = new THREE.Vector3();

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

function tubeFromChain(chain) {
  if (!chain || chain.length < 2) return null;
  // Drop coincident consecutive pts. CatmullRomCurve3 on zero-length segments
  // divides by zero in getUtoTmapping → getPoint(NaN) → "undefined.x" crash
  // in computeFrenetFrames. Also cap tubular subdivisions so a huge chain
  // can't blow Float32Array allocation inside mergeGeometries.
  const rawPts = chain.map((n) => n.pos);
  const pts = [rawPts[0]];
  const kept = [0];
  const EPS2 = 1e-12;
  for (let i = 1; i < rawPts.length; i++) {
    const a = pts[pts.length - 1], b = rawPts[i];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    if (dx*dx + dy*dy + dz*dz > EPS2) { pts.push(b); kept.push(i); }
  }
  if (pts.length < 2) return null;
  const r0 = chain[kept[0]].radius;
  // Branch junction fuse: flare collar only. The per-chain-node radius
  // sampling + cap-and-scale elsewhere already makes the branch base equal
  // to the parent's local radius, so the extra backward curve pad isn't
  // needed and was causing poke-through on the far side of thin parents.
  const isBranch = !!chain[0].chainRoot;
  const parentRad = isBranch && chain[0].parent ? (chain[0].parent.radius || 0) : 0;
  const flareRatio = (isBranch && parentRad > r0 * 1.05)
    ? Math.min(6, parentRad / Math.max(0.004, r0))
    : 1;
  const flareEnd = 0.22;
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  // Halve longitudinal + radial detail while dragging sliders so the live
  // preview runs fast. On drag end a full-quality rebuild fires automatically.
  // Match the slider range. Keep both clamps strict so a malformed preset
  // (or older save) can't push the values into the unstable region.
  const tubularPerStep = Math.max(4, Math.min(10, P.barkTubularDensity ?? 6));
  // Cap raised 384 → 768. Long trunks with many skeleton subdivisions × high
  // mesh smoothness used to truncate at 384, which created a visible polycount
  // discontinuity between the unclamped twigs and the clamped trunk.
  const fullTub = Math.min(768, Math.max(12, (pts.length - 1) * tubularPerStep));
  const baseRad = Math.max(8, Math.min(24, P.barkRadialSegs ?? 16));
  // Twigs (root radius < 0.3 m) auto-halve sides since their silhouette is
  // dominated by the bark normal map at typical distance, never by the
  // polygon count. Capped at 4 minimum so even an 8-side trunk yields a
  // sane 4-side twig.
  const fullRad = r0 > 0.3 ? baseRad : Math.max(4, baseRad >> 1);
  // Trunk chain detection — needed before the scrub-downsize gate so the
  // user can drag Mesh sides / Mesh smoothness / Skeleton subdivisions and
  // see the actual result, not a quartered preview.
  const isTrunkChain = (() => {
    for (const n of chain) if (n.branchLevel !== undefined) return false;
    return true;
  })();
  // Aggressive scrub detail: slider drags rebuild ~7×/s — quarter-res keeps
  // the preview responsive on big trees. Drag-end triggers a full rebuild.
  // Trunk chains skip the downsize: dragging a trunk subdivision slider with
  // a quartered preview is misleading because the user can't see what their
  // actual setting produces. Branches stay quartered (still hundreds of
  // chains, dominant cost on big trees).
  const tubular = (isScrubbing && !isTrunkChain) ? Math.max(4, Math.floor(fullTub * 0.28)) : fullTub;
  const radial  = (isScrubbing && !isTrunkChain) ? Math.max(4, Math.floor(fullRad * 0.5))  : fullRad;
  const geo = new THREE.TubeGeometry(curve, tubular, r0, radial, false);
  const pos = geo.attributes.position;
  const arr = pos.array;
  // Per-radial profile multipliers (cached per loop)
  const radial1 = radial + 1;
  const profileMul = new Array(radial1);
  const hasProfile = !!profileEditor;
  const twoPi = Math.PI * 2;
  for (let j = 0; j <= radial; j++) {
    profileMul[j] = hasProfile ? profileEditor.sample((j / radial) * twoPi) : 1;
  }
  const invR0 = 1 / r0;
  const invTubular = 1 / tubular;
  // Procedural mesh displacer — radial noise on each vertex so the trunk and
  // branches look gnarly instead of perfectly extruded. Mode picks the noise
  // flavor; knots/detail layer on independently.
  const barkDisplace    = P.barkDisplace ?? 0;
  const barkDispFreq    = P.barkDisplaceFreq ?? 3.0;
  const barkDispMode    = P.barkDisplaceMode ?? 'ridges';
  const barkRidgeSharp  = P.barkRidgeSharp ?? 0.5;
  const barkKnots       = P.barkKnots ?? 0;
  const barkKnotScale   = P.barkKnotScale ?? 2.0;
  const barkDetail      = P.barkDetail ?? 0;
  const barkDetailFreq  = P.barkDetailFreq ?? 12.0;
  const barkVertBias    = P.barkVerticalBias ?? 0.7;
  const hasDisplace = barkDisplace > 1e-4 || barkKnots > 1e-4 || barkDetail > 1e-4;
  // Branch wobble is applied at SKELETON BUILD TIME now — see
  // _applyBranchWobble in buildTree. Was previously here at extrusion time
  // but that broke branch attachment: tube rings shift, but the chain nodes
  // they anchor to don't, so branches disconnected from their parents.
  // Skeleton-level wobble propagates through buildChains → branches inherit.
  // Arc-length in meters — makes the axial noise coord invariant to chain
  // orientation (branches at any angle share the same bark density).
  const curveLenForDisp = hasDisplace ? curve.getLength() : 0;
  // Precompute taper samples once per row instead of per vertex.
  // (isTrunkChain is computed earlier so the scrub-downsize gate can read
  // it; Radius Curve / buttress / etc. below also rely on it.)
  const taperRow = new Float32Array(tubular + 1);
  const hasTaper = !!taperSpline && isTrunkChain;
  if (hasTaper) {
    for (let i = 0; i <= tubular; i++) taperRow[i] = taperSpline.sample(i * invTubular);
  } else {
    taperRow.fill(1);
  }
  // Buttress / root flare — angular lobes at the base of the tree. Only
  // applies to chains whose first node is the root (trunk chain).
  const buttressAmt = P.buttressAmount ?? 0;
  const buttressH = P.buttressHeight ?? 1.5;
  const buttressLobes = P.buttressLobes ?? 5;
  const hasButtress = buttressAmt > 0 && isTrunkChain && buttressH > 0;
  // Reaction wood — horizontal branches thicken on compression side (underside)
  // as gravitropic response. Strength scales with tilt: 0 vertical → 1 horizontal.
  const reactAmt = P.reactionWood ?? 0;
  let chainTilt = 0;
  if (reactAmt > 0 && chain.length >= 2) {
    const a = chain[0].pos, b = chain[chain.length - 1].pos;
    const dy = b.y - a.y;
    const cl = Math.hypot(b.x - a.x, dy, b.z - a.z) || 1;
    chainTilt = Math.max(0, 1 - Math.abs(dy) / cl);
  }
  const hasReact = reactAmt * chainTilt > 0.01;
  // Per-node radius sampling: each chain node carries its own allometric
  // radius. Linearly interpolating only r0→r1 made the parent tube thicker
  // than its chain nodes actually were at mid-points, and branches spawning
  // there had matching-radius *mismatches*. We now interpolate between every
  // chain node's radius along the tube — this makes the trunk taper exactly
  // to each chain node's computed radius and guarantees a branch spawning
  // at chain[k] has its base (sized to chain[k].radius) equal to the parent
  // tube's local radius at that position.
  const chainRadii = chain.map((n) => Math.max(1e-4, n.radius || r0));
  // Cap branch base at 80 % of parent's local radius and shrink descendants
  // proportionally. Prevents a branch from being fatter than its parent at
  // the spawn point — the cause of the "branches poke through trunk" look
  // when the parent has tapered thinner than the branch's own allometric.
  if (isBranch && parentRad > 0) {
    const cap = parentRad * 0.8;
    if (chainRadii[0] > cap) {
      const s = cap / chainRadii[0];
      for (let k = 0; k < chainRadii.length; k++) chainRadii[k] *= s;
    }
  }
  const lastChainIdx = chain.length - 1;
  for (let i = 0; i <= tubular; i++) {
    const t = i * invTubular;
    // Interpolate chain nodes' individual radii, not just r0→r1.
    const cfp = t * lastChainIdx;
    const cI0 = Math.max(0, Math.min(lastChainIdx, Math.floor(cfp)));
    const cI1 = Math.min(lastChainIdx, cI0 + 1);
    const cU = cfp - cI0;
    const localR = chainRadii[cI0] * (1 - cU) + chainRadii[cI1] * cU;
    const baseScl = localR * invR0;
    const splMul = taperRow[i];
    curve.getPointAt(t, _tubeCenter);
    const cx = _tubeCenter.x, cy = _tubeCenter.y, cz = _tubeCenter.z;
    const rowBase = i * radial1 * 3;
    const buttressH_here = hasButtress && cy < buttressH ? Math.max(0, 1 - cy / buttressH) : 0;
    // Base flare — starts at flareRatio (matches parent radius) at t=0 and
    // eases down to 1 (branch radius) by flareEnd. Smoothstep easing.
    let flareMul = 1;
    if (flareRatio > 1 && t < flareEnd) {
      const k = t / flareEnd;
      const s = k * k * (3 - 2 * k); // smoothstep
      flareMul = flareRatio * (1 - s) + 1 * s;
    }
    for (let j = 0; j <= radial; j++) {
      const o = rowBase + j * 3;
      let scl = baseScl * splMul * profileMul[j] * flareMul;
      if (hasDisplace) {
        // World-space noise coords. Radial unit vector (3D) + arc-length
        // along the branch in meters. Axial is injected as a uniform
        // offset to all three coords so it shifts the noise along the
        // *branch direction* rather than a world axis — this makes the
        // pattern flow along trunks and branches at any orientation, with
        // no Frenet spiral and no cylindrical seam.
        const rx = arr[o] - cx;
        const ry = arr[o + 1] - cy;
        const rz = arr[o + 2] - cz;
        const rInv = 1 / (Math.hypot(rx, ry, rz) || 1);
        const rux = rx * rInv, ruy = ry * rInv, ruz = rz * rInv;
        const sAxial = t * curveLenForDisp;
        const fAx = barkDispFreq;
        const fRad = barkDispFreq * Math.PI;
        // Axial offset — scalar added equally to all 3 coords. Scale chosen
        // so 1 m of axial travel ≈ similar noise-step to rotating ~30° around.
        const axOff = sAxial * fAx * 0.35;
        let d = 0;
        if (barkDisplace > 1e-4) {
          // Compute ONLY the noise channels each mode actually consumes.
          let nMix = 0;
          if (barkDispMode === 'cellular') {
            const wN = worley3D(rux * fRad * 0.8 + axOff, ruy * fRad * 0.8 + axOff, ruz * fRad * 0.8 + axOff);
            nMix = 1 - Math.min(1, wN * 1.6);
          } else {
            const sharpen = (x) => {
              if (barkRidgeSharp < 1e-3) return x;
              const s = Math.min(1, barkRidgeSharp);
              const r = 1 - Math.abs(x);
              return (1 - s) * x + s * (r * 2 - 1);
            };
            const nBlob = fbm3D(rux * fRad + axOff, ruy * fRad + axOff, ruz * fRad + axOff);
            if (barkDispMode === 'blobby') {
              nMix = sharpen(nBlob);
            } else if (barkDispMode === 'mixed') {
              const axV = sAxial * fAx * 0.12;
              const nVert = fbm3D(rux * fRad * 2.2 + axV, ruy * fRad * 2.2 + axV, ruz * fRad * 2.2 + axV);
              const wN = worley3D(rux * fRad * 0.8 + axOff, ruy * fRad * 0.8 + axOff, ruz * fRad * 0.8 + axOff);
              const nCell = 1 - Math.min(1, wN * 1.6);
              const nR = (1 - barkVertBias) * nBlob + barkVertBias * nVert;
              nMix = sharpen(nR) * 0.55 + nCell * 0.45;
            } else {
              // 'ridges' default
              const axV = sAxial * fAx * 0.12;
              const nVert = fbm3D(rux * fRad * 2.2 + axV, ruy * fRad * 2.2 + axV, ruz * fRad * 2.2 + axV);
              const nR = (1 - barkVertBias) * nBlob + barkVertBias * nVert;
              nMix = sharpen(nR);
            }
          }
          d += nMix * barkDisplace * 0.35;
        }
        if (barkKnots > 1e-4) {
          const kAx = sAxial * barkKnotScale * 0.2;
          const kW = worley3D(rux * barkKnotScale * 1.4 + kAx, ruy * barkKnotScale * 1.4 + kAx, ruz * barkKnotScale * 1.4 + kAx);
          const knot = Math.max(0, 1 - kW * 2.4);
          d += knot * knot * barkKnots * 0.45;
        }
        if (barkDetail > 1e-4) {
          const dAx = sAxial * barkDetailFreq * 0.3;
          const det = fbm3D(rux * barkDetailFreq + dAx, ruy * barkDetailFreq + dAx, ruz * barkDetailFreq + dAx);
          d += det * barkDetail * 0.12;
        }
        scl *= 1 + d;
      }
      if (buttressH_here > 0) {
        const ang = (j / radial) * twoPi;
        const lobe = Math.max(0, Math.cos(ang * buttressLobes));
        scl *= 1 + buttressAmt * buttressH_here * lobe * lobe;
      }
      if (hasReact) {
        // Underside = radial vertex below the chain centerline (in world Y).
        const radialY = arr[o + 1] - cy;
        const under = radialY < 0 ? Math.min(1, -radialY / Math.max(1e-5, r0)) : 0;
        scl *= 1 + reactAmt * chainTilt * under * 0.45;
      }
      arr[o    ] = (arr[o    ] - cx) * scl + cx;
      arr[o + 1] = (arr[o + 1] - cy) * scl + cy;
      arr[o + 2] = (arr[o + 2] - cz) * scl + cz;
    }
  }
  pos.needsUpdate = true;
  // Normals via analytic central differences on the displaced grid — see
  // _tubeAnalyticNormals. computeVertexNormals would walk the index buffer
  // and face-average; this is strictly faster on the parametric tube.

  // Rewrite UVs in world METERS on both axes. TubeGeometry defaults to a
  // flat [0,1]×[0,1] square per tube, which stretches bark across long trunks
  // and squashes it on short twigs. Writing meters + `texture.repeat = tiles
  // per meter` gives consistent bark density everywhere, and since uv.x
  // varies with `i` (along) and uv.y with `j` (around), the texture tiles in
  // both directions — no more uniform stripes around the cylinder.
  {
    const curveLen = curve.getLength();
    const uvAttr = geo.attributes.uv;
    if (uvAttr) {
      const uvArr = uvAttr.array;
      const twoPiLoc = Math.PI * 2;
      // Snap the around-tube UV span ONCE per tube (using the max radius
      // along the chain) so every ring wraps the bark canvas the same
      // integer number of tiles. Per-ring snapping (the previous attempt)
      // produced visible horizontal banding wherever a tile-count step
      // landed (e.g. a 4-tile ring next to a 3-tile ring left a hard line).
      // With a constant tile count, texture density varies smoothly along
      // the tube (more stretch on the trunk base, less on twigs) and the
      // seam vertex always lands on an integer texel boundary — clean wrap.
      const sv = P.barkTexScaleV ?? 0.5;
      let maxR = 0;
      for (let k = 0; k < chainRadii.length; k++) if (chainRadii[k] > maxR) maxR = chainRadii[k];
      const tubeCircumMax = twoPiLoc * Math.max(0.002, maxR);
      const tilesAround = Math.max(1, Math.round(tubeCircumMax * sv));
      const seamCircum = tilesAround / sv; // CONSTANT for whole tube
      for (let i = 0; i <= tubular; i++) {
        const ti = i * invTubular;
        const sAlong = ti * curveLen;
        for (let j = 0; j <= radial; j++) {
          const sAround = (j / radial) * seamCircum;
          const idx = (i * radial1 + j) * 2;
          uvArr[idx    ] = sAlong;   // uv.x = meters ALONG the tube
          uvArr[idx + 1] = sAround;  // uv.y = constant-tile UV AROUND
        }
      }
      uvAttr.needsUpdate = true;
    }
  }

  // Per-vertex skeleton mapping + rest radial vector, folded into one pass.
  // Both derive from the same (kept segA, segB, w) triple, so interleaving
  // them saves a full bark-vertex re-walk on the main thread. radialRest is
  // the rest radial vector from the LINEAR skeleton centerline (not the
  // Catmull-Rom curve) — that's what updateBark() uses each frame.
  const numVerts = (tubular + 1) * radial1;
  const nodeA = new Int32Array(numVerts);
  const nodeB = new Int32Array(numVerts);
  const nodeW = new Float32Array(numVerts);
  const radialRest = new Float32Array(numVerts * 3);
  const posArrLive = geo.attributes.position.array;
  const lastSeg = pts.length - 1;
  for (let i = 0; i <= tubular; i++) {
    const cp = (i * invTubular) * lastSeg;
    const a = Math.min(Math.floor(cp), lastSeg);
    const b = Math.min(a + 1, lastSeg);
    const w = cp - a;
    const iw = 1 - w;
    const nAk = chain[kept[a]];
    const nBk = chain[kept[b]];
    const aIdx = nAk.idx, bIdx = nBk.idx;
    const skCx = nAk.pos.x * iw + nBk.pos.x * w;
    const skCy = nAk.pos.y * iw + nBk.pos.y * w;
    const skCz = nAk.pos.z * iw + nBk.pos.z * w;
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

  // Transfer-free output: fresh typed arrays for the sync-fallback path so
  // the generateTree pool-fill can absorb them exactly like the worker
  // returns. Normals are central-difference from posArr.
  const posArr = new Float32Array(posArrLive);
  const normArr = new Float32Array(numVerts * 3);
  const uvArr = new Float32Array(geo.attributes.uv.array);
  const idxSrc = geo.index ? geo.index.array : null;
  const idxArr = idxSrc ? (idxSrc instanceof Uint32Array ? new Uint32Array(idxSrc) : new Uint16Array(idxSrc)) : null;
  _tubeAnalyticNormals(posArr, normArr, tubular, radial);
  geo.dispose();

  return {
    position: posArr,
    normal: normArr,
    uv: uvArr,
    index: idxArr,
    radialRest,
    nodeA, nodeB, nodeW,
    vertCount: numVerts,
  };
}

// --- Vines ---------------------------------------------------------------
// Optional decoration: spiral tube wrapping around host chains with small
// instanced leaves along it. Static — vines don't bend with the tree during
// wind/grab. Rebuilt on full regen; hue/brightness are live-editable.
let vineMesh = null;
// vineLeafInst hoisted near leafGeo — don't redeclare here.
const vineMat = new THREE.MeshStandardMaterial({ color: 0x4a3a22, roughness: 0.88, metalness: 0 });
const _vineScratchPos = new THREE.Vector3();
const _vineScratchP1 = new THREE.Vector3();
const _vineScratchP2 = new THREE.Vector3();
const _vineScratchTan = new THREE.Vector3();
const _vineScratchA1 = new THREE.Vector3();
const _vineScratchA2 = new THREE.Vector3();
const _vineScratchUp = new THREE.Vector3(0, 1, 0);
const _vineScratchAlt = new THREE.Vector3(1, 0, 0);
const _vineDummy = new THREE.Object3D();

function _buildVineSpiral(chain, coverage, coils, thickness) {
  const pts = chain.map((n) => n.pos);
  if (pts.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  const chainLen = curve.getLength();
  if (chainLen < 0.1) return null;
  const samples = Math.max(48, Math.min(400, Math.floor(chainLen * 22)));
  const spiral = [];
  const totalTurns = coils * chainLen * coverage;
  const baseR = chain[0].radius;
  const tipR = chain[chain.length - 1].radius;
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const t = s * coverage;
    curve.getPointAt(t, _vineScratchPos);
    const tAhead = Math.min(1, t + 1e-3);
    const tBack  = Math.max(0, t - 1e-3);
    curve.getPointAt(tAhead, _vineScratchP2);
    curve.getPointAt(tBack,  _vineScratchP1);
    _vineScratchTan.subVectors(_vineScratchP2, _vineScratchP1).normalize();
    _vineScratchA1.crossVectors(_vineScratchUp, _vineScratchTan);
    if (_vineScratchA1.lengthSq() < 1e-4) _vineScratchA1.crossVectors(_vineScratchAlt, _vineScratchTan);
    _vineScratchA1.normalize();
    _vineScratchA2.crossVectors(_vineScratchTan, _vineScratchA1).normalize();
    const chainR = baseR * (1 - t) + tipR * t;
    const offset = chainR + thickness * 1.6;
    const ang = s * totalTurns * Math.PI * 2;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    spiral.push(new THREE.Vector3(
      _vineScratchPos.x + (_vineScratchA1.x * cos + _vineScratchA2.x * sin) * offset,
      _vineScratchPos.y + (_vineScratchA1.y * cos + _vineScratchA2.y * sin) * offset,
      _vineScratchPos.z + (_vineScratchA1.z * cos + _vineScratchA2.z * sin) * offset,
    ));
  }
  return spiral;
}

function buildVines(chains) {
  if (P.vinesEnable !== 'on') return;
  if (P.treeType && P.treeType !== 'broadleaf') return;
  const count = Math.min(P.vineCount | 0, chains.length);
  if (count <= 0) return;
  const coverage = P.vineCoverage;
  const coils = P.vineCoils;
  const thickness = P.vineThickness;
  // Pick thickest chains starting low (trunk + lower branches)
  const candidates = chains
    .map((c) => ({ c, r: c[0].radius, y: c[0].pos.y }))
    .filter((x) => x.c.length >= 3)
    .sort((a, b) => (b.r - a.r) || (a.y - b.y));
  const hosts = candidates.slice(0, count);
  if (hosts.length === 0) return;
  const tubeGeos = [];
  const leafPositions = [];
  for (const { c: chain } of hosts) {
    const spiral = _buildVineSpiral(chain, coverage, coils, thickness);
    if (!spiral || spiral.length < 4) continue;
    const curve = new THREE.CatmullRomCurve3(spiral, false, 'centripetal', 0.5);
    const tub = Math.max(32, spiral.length - 1);
    const tubeGeo = new THREE.TubeGeometry(curve, tub, thickness, 5, false);
    tubeGeos.push(tubeGeo);
    if (P.vineLeafDensity > 0 && leafGeo) {
      const vineLen = curve.getLength();
      const n = Math.max(1, Math.floor(P.vineLeafDensity * vineLen));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const p = curve.getPointAt(t);
        leafPositions.push(p);
      }
    }
  }
  if (tubeGeos.length === 0) return;
  const vineGeo = tubeGeos.length === 1 ? tubeGeos[0] : mergeGeometries(tubeGeos, false);
  if (tubeGeos.length > 1) for (const g of tubeGeos) g.dispose();
  vineMesh = new THREE.Mesh(vineGeo, vineMat);
  vineMesh.castShadow = true;
  vineMesh.receiveShadow = true;
  scene.add(vineMesh);
  if (leafPositions.length > 0 && leafGeo) {
    vineLeafInst = new THREE.InstancedMesh(leafGeo, leafMatA, leafPositions.length);
    const size = P.vineLeafSize;
    for (let i = 0; i < leafPositions.length; i++) {
      const p = leafPositions[i];
      const yaw = (i * 2.3998) % (Math.PI * 2);   // golden-angle phyllotaxis
      const pitch = -Math.PI / 2 + ((i * 0.771) % 1 - 0.5) * 0.6;
      _vineDummy.position.copy(p);
      _vineDummy.rotation.set(pitch, yaw, 0);
      const jitter = 0.75 + ((i * 0.613) % 1) * 0.5;
      _vineDummy.scale.setScalar(size * jitter);
      _vineDummy.updateMatrix();
      vineLeafInst.setMatrixAt(i, _vineDummy.matrix);
    }
    vineLeafInst.frustumCulled = false;
    vineLeafInst.castShadow = true;
    vineLeafInst.instanceMatrix.needsUpdate = true;
    scene.add(vineLeafInst);
  }
  applyVineMaterial();
}

function applyVineMaterial() {
  const hue = P.vineHue ?? 0.08;
  const lum = P.vineLum ?? 0.28;
  vineMat.color.setHSL(hue, 0.55, lum);
  vineMat.needsUpdate = true;
}

// --- Dead branch stubs (snags) -------------------------------------------
// Post-pass: every pruned node whose parent is NOT pruned gets a small
// oriented cylinder at the parent tip, pointing toward where the cut branch
// used to grow. Matches how real tree pruning leaves a stub behind.
let stubInst = null;
const stubMat = new THREE.MeshStandardMaterial({ color: 0x3a2a18, roughness: 0.95, metalness: 0 });
// Base geometry: narrow cylinder with pivot at the base, y-up.
const _stubGeo = new THREE.CylinderGeometry(0.4, 1, 1, 6, 1, false);
_stubGeo.translate(0, 0.5, 0);
const _stubDummy = new THREE.Object3D();
const _stubQuat = new THREE.Quaternion();
const _stubAxis = new THREE.Vector3(0, 1, 0);
const _stubDir = new THREE.Vector3();

function buildStubs(treeNodes) {
  if (P.stubsEnable !== 'on') return;
  const chance = P.stubsChance ?? 0.3;
  const length = P.stubsLength ?? 0.5;
  const taper = P.stubsTaper ?? 0.55;
  const sites = [];
  // Deterministic hash so the set of stubs is stable between regens at a
  // given seed (Math.random would flicker stubs every rebuild).
  const seedHash = (i) => {
    let h = (i * 0x9E3779B1 + (P.seed >>> 0)) >>> 0;
    h ^= h >>> 16; h = (h * 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = (h * 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 0xffffffff;
  };
  for (let i = 0; i < treeNodes.length; i++) {
    const n = treeNodes[i];
    if (!n.pruned || !n.parent || n.parent.pruned) continue;
    if (seedHash(i) > chance) continue;
    const p = n.parent.pos;
    _stubDir.set(n.pos.x - p.x, n.pos.y - p.y, n.pos.z - p.z);
    const len = _stubDir.length();
    if (len < 1e-3) continue;
    _stubDir.multiplyScalar(1 / len);
    sites.push({
      x: p.x, y: p.y, z: p.z,
      dx: _stubDir.x, dy: _stubDir.y, dz: _stubDir.z,
      r: Math.max(0.015, Math.min(0.15, (n.radius || 0.03))),
    });
  }
  if (sites.length === 0) return;
  stubInst = new THREE.InstancedMesh(_stubGeo, stubMat, sites.length);
  stubInst.castShadow = true;
  stubInst.receiveShadow = true;
  stubInst.frustumCulled = false;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    _stubDir.set(s.dx, s.dy, s.dz);
    _stubQuat.setFromUnitVectors(_stubAxis, _stubDir);
    _stubDummy.position.set(s.x, s.y, s.z);
    _stubDummy.quaternion.copy(_stubQuat);
    _stubDummy.scale.set(s.r * (1 - taper), length, s.r * (1 - taper));
    // Cylinder geometry had base-radius 1, tip-radius 0.4 at y-up scale 1.
    // We re-scale with xyz; the taper param affects thickness uniformly.
    _stubDummy.updateMatrix();
    stubInst.setMatrixAt(i, _stubDummy.matrix);
  }
  stubInst.instanceMatrix.needsUpdate = true;
  applyStubMaterial();
  scene.add(stubInst);
}

function applyStubMaterial() {
  const hue = P.stubsHue ?? 0.08;
  const lum = P.stubsLum ?? 0.18;
  stubMat.color.setHSL(hue, 0.35, lum);
  stubMat.needsUpdate = true;
}

// --- Fruits / flowers broadleaf decoration layer -------------------------
// Small instanced shapes hanging off twig (or chain-tip) endpoints. Density
// controls fraction of sites that get a fruit; shape switches the geometry.
let fruitInst = null;
const fruitMat = new THREE.MeshStandardMaterial({ color: 0xaa2222, roughness: 0.55, metalness: 0 });
const _fruitGeoSphere = new THREE.SphereGeometry(1, 10, 8);
const _fruitGeoTeardrop = (() => {
  const g = new THREE.ConeGeometry(1, 1.6, 10, 1, false);
  g.translate(0, -0.4, 0);
  return g;
})();
const _fruitGeoBlossom = new THREE.SphereGeometry(1, 8, 4);
const _fruitDummy = new THREE.Object3D();

function _fruitHash(i) {
  let h = ((i + 7) * 0x85ebca6b + (P.seed >>> 0)) >>> 0;
  h ^= h >>> 13; h = (h * 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

function buildFruits(tips) {
  if (P.fruitsEnable !== 'on') return;
  if (P.treeType && P.treeType !== 'broadleaf') return;
  const density = P.fruitDensity ?? 0.3;
  const size = P.fruitSize ?? 0.04;
  const hang = P.fruitHang ?? 0.04;
  const shape = P.fruitShape ?? 'sphere';
  const sites = [];
  for (let i = 0; i < tips.length; i++) {
    const tip = tips[i];
    if (!tip || tip.pruned) continue;
    if (_fruitHash(i) > density) continue;
    sites.push({ x: tip.pos.x, y: tip.pos.y - hang, z: tip.pos.z });
  }
  if (sites.length === 0) return;
  const geo = shape === 'teardrop' ? _fruitGeoTeardrop
            : shape === 'blossom'  ? _fruitGeoBlossom
            : _fruitGeoSphere;
  fruitInst = new THREE.InstancedMesh(geo, fruitMat, sites.length);
  fruitInst.castShadow = true;
  fruitInst.receiveShadow = true;
  fruitInst.frustumCulled = false;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const rs = size * (0.75 + _fruitHash(i * 3 + 1) * 0.5);
    _fruitDummy.position.set(s.x, s.y, s.z);
    _fruitDummy.rotation.set(0, _fruitHash(i * 3 + 2) * Math.PI * 2, 0);
    _fruitDummy.scale.set(rs, rs, rs);
    _fruitDummy.updateMatrix();
    fruitInst.setMatrixAt(i, _fruitDummy.matrix);
  }
  fruitInst.instanceMatrix.needsUpdate = true;
  applyFruitMaterial();
  scene.add(fruitInst);
}

function applyFruitMaterial() {
  const hue = P.fruitHue ?? 0;
  const lum = P.fruitLum ?? 0.45;
  const sat = P.fruitSat ?? 0.75;
  fruitMat.color.setHSL(hue, sat, lum);
  fruitMat.needsUpdate = true;
}

// --- Canopy dieback — remove leaves inside the crown shadow --------------
// Real tree branches inside the canopy shade die back. Approximated by
// sampling leaf positions and culling ones whose radial distance from the
// outer crown shell is below `diebackOuter`, with probability = `dieback`.
function applyCanopyDieback(leafData, treeBBox) {
  const strength = P.dieback ?? 0;
  if (strength <= 0 || !leafData || leafData.length === 0 || !treeBBox) return;
  const outerFrac = P.diebackOuter ?? 0.55;
  const cx = (treeBBox.min.x + treeBBox.max.x) * 0.5;
  const cz = (treeBBox.min.z + treeBBox.max.z) * 0.5;
  const dx = (treeBBox.max.x - treeBBox.min.x) * 0.5 || 1;
  const dz = (treeBBox.max.z - treeBBox.min.z) * 0.5 || 1;
  const minY = treeBBox.min.y, maxY = treeBBox.max.y;
  const ySpan = Math.max(0.01, maxY - minY);
  // Swap-and-pop cull. Walking the array forward, when a leaf is killed we
  // move the last survivor into its slot and shrink length — O(L) total.
  // (Previous splice-in-loop was O(L²) because each splice shifts every
  // subsequent element; noticeable at high dieback strength on dense canopy.)
  // Order within leafData is not semantically meaningful so the shuffle is
  // safe for every downstream consumer (updateLeafInstances reads by index
  // and sees the final layout).
  let i = 0;
  while (i < leafData.length) {
    const L = leafData[i];
    const lrx = (L.pos.x - cx) / dx;
    const lrz = (L.pos.z - cz) / dz;
    const rxz = Math.sqrt(lrx * lrx + lrz * lrz);
    const ry = (L.pos.y - minY) / ySpan;
    const interior = Math.max(0, 1 - rxz / Math.max(0.01, outerFrac)) * (1 - Math.max(0, ry - 0.6) * 2.5);
    if (interior > 0 && Math.random() < interior * strength) {
      const last = leafData.length - 1;
      if (i !== last) leafData[i] = leafData[last];
      leafData.length = last;
      // Re-test the swapped-in element at the same index next iteration.
      continue;
    }
    i++;
  }
}

// --- Tree generation -----------------------------------------------------
let treeMesh = null;
let treeWireMesh = null;
let treeSplineMesh = null;
let _chainsRef = null;
// Cached tree state from the last FULL rebuild. Enables incremental "leaves
// only" rebuilds that skip buildTree + tubeFromChain + mergeGeometries (~70ms
// saved) when only foliage params change.
let _cachedTreeNodes = null;
let _cachedTips = null;
let _cachedMaxTreeY = 0;
// Cached chain serialization from the last full build's worker phase-1
// response. Lets the "tubes-only" fast path (slider drags that change
// taper / profile / bark displace / buttress / react wood) re-extrude tubes
// via the worker pool without re-running buildTree+buildChains. Null when
// the last full build used the main-thread sync fallback — tubes-only then
// falls back to main-thread tubeFromChain over _chainsRef.
let _cachedChainsSer = null;
// leafInstA / leafInstB hoisted near leafGeo — don't redeclare here.
let coneInst = null;
const leafDataA = [];
// leafDataB / leafInstB / leafMatB / needleMatB are reserved for an optional
// dual-leaf-shape mode (random 50/50 split between two materials, like a real
// tree's leaf variation). Currently unused — `_foliagePhase` only writes to
// leafDataA, so leafDataB stays empty. Kept declared because:
//   • restoring the split would cost ~2× draw calls + matrix work per frame;
//   • removing fully touches ~30 sites (snapshot/restore, dieback, bake,
//     visibility, LOD count) with regression risk for negligible savings.
// Iterations over [leafDataA, leafDataB] no-op on the empty array — zero
// runtime cost. Don't restore the split unless the perf budget allows it.
const leafDataB = [];
// Pine cone geometry + material (reused across rebuilds)
const coneGeo = new THREE.ConeGeometry(0.35, 1, 8, 4, false);
coneGeo.translate(0, -0.4, 0); // pivot near top so cones hang
const coneMat = new THREE.MeshStandardMaterial({ color: 0x5d3a18, roughness: 0.85, metalness: 0 });
let lastTreeHeight = -1;
let reframeAnim = null;

// --- Skeleton simulation (Position-Based Dynamics) -----------------------
// Each skeleton node is a particle with mass ∝ r². Two constraints:
//   1) edge: rigid distance to parent (branch segment won't stretch)
//   2) bending: pulled toward parent.pos + restOffset (elastic restoring torque)
// Pin: root node (parentIdx < 0) and any grabbed node have invMass = 0 and
// their positions are forced. Chain propagation happens naturally through the
// iterative constraint solver — pulling a leaf tip bends the whole chain back
// to the root.
let skeleton = [];           // [{restPos, pos, prevPos, vel, worldOffset, radius, invMass, parentIdx, restLen, restOffFromParent}]
// Parallel SoA arrays — hot-path mirror of the skeleton[] object array. The
// PBD solver iterates these directly (cache-friendly, no pointer chasing).
// Non-hot readers (UI, picking, reframe) continue to use skeleton[].
//   Immutable after build: skRest*, skRestOff*, skRestParent*, skRestLen,
//                           skBendStiff, skRadius, skParentIdx, skHasParentDir.
//   Mutable per frame:     skPos*, skPrev*, skVel*, skWorldOff*, skInvMass (grab toggle).
let skN = 0;
let skPosX = null,  skPosY = null,  skPosZ = null;
let skPrevX = null, skPrevY = null, skPrevZ = null;
let skVelX = null,  skVelY = null,  skVelZ = null;
let skWorldOffX = null, skWorldOffY = null, skWorldOffZ = null;
let skRestX = null, skRestY = null, skRestZ = null;
let skRestOffX = null, skRestOffY = null, skRestOffZ = null;
let skRestLen = null;
let skRestParentDirX = null, skRestParentDirY = null, skRestParentDirZ = null;
let skHasParentDir = null;   // Uint8Array — 1 if restParentDirGP cached, 0 otherwise
let skRadius = null;
let skInvMass = null;
let skBendStiff = null;
let skParentIdx = null;
// Pool of skeleton[] entry objects. Grows to high-water on each rebuild and
// is reused — avoids thousands of Vector3 allocations per scrub-driven rebuild.
const _skeletonPool = [];
function _allocSkeletonSoA(n) {
  skN = n;
  skPosX = new Float32Array(n);  skPosY = new Float32Array(n);  skPosZ = new Float32Array(n);
  skPrevX = new Float32Array(n); skPrevY = new Float32Array(n); skPrevZ = new Float32Array(n);
  skVelX = new Float32Array(n);  skVelY = new Float32Array(n);  skVelZ = new Float32Array(n);
  skWorldOffX = new Float32Array(n); skWorldOffY = new Float32Array(n); skWorldOffZ = new Float32Array(n);
  skRestX = new Float32Array(n); skRestY = new Float32Array(n); skRestZ = new Float32Array(n);
  skRestOffX = new Float32Array(n); skRestOffY = new Float32Array(n); skRestOffZ = new Float32Array(n);
  skRestLen = new Float32Array(n);
  skRestParentDirX = new Float32Array(n);
  skRestParentDirY = new Float32Array(n);
  skRestParentDirZ = new Float32Array(n);
  skHasParentDir = new Uint8Array(n);
  skRadius = new Float32Array(n);
  skInvMass = new Float32Array(n);
  skBendStiff = new Float32Array(n);
  skParentIdx = new Int32Array(n);
}
// Mirror SoA state → skeleton[] objects so non-hot readers (leaf/stem
// instance updates, picking, reframe) see the fresh pose. Called once at the
// end of every stepSim; the skeleton objects are otherwise never written
// after build, so one post-step sync keeps them consistent.
function _skeletonSoAToObjects() {
  for (let i = 0; i < skN; i++) {
    const s = skeleton[i];
    s.pos.x = skPosX[i];    s.pos.y = skPosY[i];    s.pos.z = skPosZ[i];
    s.prevPos.x = skPrevX[i]; s.prevPos.y = skPrevY[i]; s.prevPos.z = skPrevZ[i];
    s.vel.x = skVelX[i];    s.vel.y = skVelY[i];    s.vel.z = skVelZ[i];
    s.worldOffset.x = skWorldOffX[i]; s.worldOffset.y = skWorldOffY[i]; s.worldOffset.z = skWorldOffZ[i];
  }
}
// Fill ALL skeleton[] object fields from SoA — used once per build to
// mirror the post-init SoA state into the object graph that non-hot
// consumers (sculpt, grab, UI) still read. Hot paths (updateBark, stepSim)
// read SoA directly, so this only runs at build time.
function _skeletonSoAToObjectsFull() {
  for (let i = 0; i < skN; i++) {
    const s = skeleton[i];
    s.restPos.x = skRestX[i]; s.restPos.y = skRestY[i]; s.restPos.z = skRestZ[i];
    s.pos.x = skPosX[i];    s.pos.y = skPosY[i];    s.pos.z = skPosZ[i];
    s.prevPos.x = skPrevX[i]; s.prevPos.y = skPrevY[i]; s.prevPos.z = skPrevZ[i];
    s.vel.x = skVelX[i];    s.vel.y = skVelY[i];    s.vel.z = skVelZ[i];
    s.worldOffset.x = skWorldOffX[i]; s.worldOffset.y = skWorldOffY[i]; s.worldOffset.z = skWorldOffZ[i];
    s.restOffFromParent.x = skRestOffX[i];
    s.restOffFromParent.y = skRestOffY[i];
    s.restOffFromParent.z = skRestOffZ[i];
    s.restLen = skRestLen[i];
    if (skHasParentDir[i]) {
      s.restParentDirGP.x = skRestParentDirX[i];
      s.restParentDirGP.y = skRestParentDirY[i];
      s.restParentDirGP.z = skRestParentDirZ[i];
      s.hasRestParentDir = true;
    } else {
      s.hasRestParentDir = false;
    }
    s.radius = skRadius[i];
    s.invMass = skInvMass[i];
    s.bendStiff = skBendStiff[i];
    s.parentIdx = skParentIdx[i];
  }
}
let barkNodeA = null;
let barkNodeB = null;
let barkNodeW = null;
let barkRestPos = null;
let barkRadialRest = null;   // per bark-vertex: rest offset from its chain center
// Grow-only pool buffers for the merged bark mesh. All chains (worker output
// OR main sync-fallback) write directly into these at precomputed offsets —
// no per-chain BufferGeometry allocation, no mergeGeometries pass, no dispose
// sweep. The active Mesh wraps subarrays of the pool; when the pool grows the
// old Mesh is already queued for disposal via _orphanBark so buffer-swap is safe.
let _barkPosPool = null;
let _barkNormPool = null;
let _barkUvPool = null;
let _barkIndexPool = null;
let _barkIndexIs32 = false;
function _ensureBarkPools(totalVerts, totalIdx) {
  const needP = totalVerts * 3;
  const needN = totalVerts * 3;
  const needU = totalVerts * 2;
  if (!_barkPosPool  || _barkPosPool.length  < needP) _barkPosPool  = new Float32Array(needP);
  if (!_barkNormPool || _barkNormPool.length < needN) _barkNormPool = new Float32Array(needN);
  if (!_barkUvPool   || _barkUvPool.length   < needU) _barkUvPool   = new Float32Array(needU);
  if (!barkNodeA || barkNodeA.length < totalVerts) barkNodeA = new Int32Array(totalVerts);
  if (!barkNodeB || barkNodeB.length < totalVerts) barkNodeB = new Int32Array(totalVerts);
  if (!barkNodeW || barkNodeW.length < totalVerts) barkNodeW = new Float32Array(totalVerts);
  if (!barkRestPos   || barkRestPos.length   < needP) barkRestPos   = new Float32Array(needP);
  if (!barkRadialRest|| barkRadialRest.length< needP) barkRadialRest= new Float32Array(needP);
  // Index width tracks vertex count. Promote to Uint32 when verts exceed the
  // Uint16 ceiling; once promoted, stay Uint32 so mid-build type swaps don't
  // confuse the bound BufferAttribute.
  const needI32 = totalVerts > 65535 || _barkIndexIs32;
  if (needI32) {
    if (!_barkIndexPool || !(_barkIndexPool instanceof Uint32Array) || _barkIndexPool.length < totalIdx) {
      _barkIndexPool = new Uint32Array(totalIdx);
    }
    _barkIndexIs32 = true;
  } else {
    if (!_barkIndexPool || _barkIndexPool.length < totalIdx) {
      _barkIndexPool = new Uint16Array(totalIdx);
    }
  }
}
let _simActive = false;
// Extra damping multiplier applied right after a rebuild. Decays each stepSim
// tick so wind doesn't snap branches around when the tree re-inits at rest.
let _simSettleBoost = 0;

// Scratch temporaries for the angle-preserving bending constraint
const _simRestDir = new THREE.Vector3();
const _simCurDir = new THREE.Vector3();
const _simRotQ = new THREE.Quaternion();
const _simRotOff = new THREE.Vector3();

function stepSim(dt, t) {
  if (!skeleton.length) return;
  // dt < ~0 would make `1/dt` blow up in the velocity reconstruction below,
  // injecting Infinities that NaN-cascade through the next frame. Skip the
  // step entirely — happens when two animate loops fire in the same frame.
  if (!(dt > 1e-6)) return;
  dt = Math.min(dt, 0.033);
  const strength = P.wind.strength;
  const freq = P.wind.frequency;
  const gust = P.wind.gust;
  const dir = P.wind.direction || 0;
  const turbulence = P.wind.turbulence ?? 0.35;
  const swirl = P.wind.swirl ?? 0.15;
  const waveSpeed = P.wind.waveSpeed ?? 1.4;
  const dirJitter = P.wind.dirJitter ?? 0.25;
  const profile = P.wind.profile || 'Gusty';
  const windOn = P.wind.enabled;
  const windDirX = Math.cos(dir);
  const windDirZ = Math.sin(dir);
  // Per-profile multipliers (scales the component mix inside the wind loop).
  const P_BREEZE  = profile === 'Breeze';
  const P_GUSTY   = profile === 'Gusty';
  const P_STORM   = profile === 'Storm';
  const P_SWIRL   = profile === 'Swirl';
  const P_CHAOTIC = profile === 'Chaotic';
  const pGust   = P_BREEZE ? 0.25 : P_STORM ? 1.8 : P_CHAOTIC ? 1.2 : 1.0;
  const pTurb   = P_BREEZE ? 0.4  : P_STORM ? 1.8 : P_CHAOTIC ? 2.2 : 1.0;
  const pSwirl  = P_SWIRL  ? 1.8  : P_CHAOTIC ? 1.2 : 1.0;
  const pWave   = P_STORM  ? 1.4  : P_BREEZE ? 0.6 : 1.0;
  const ph = P.physics;
  // Heavier damping during a grab so descendant tips don't build inertia and
  // whip around behind the cursor — they just track the bent pose.
  // Post-rebuild boost: generateTree() zeros velocities; without extra damping
  // here, wind would kick branches immediately and visibly ring. Boost decays
  // exponentially (~0.5s) so wind eases in instead of snapping on.
  const linearDamp = (grabbedNodeIdx >= 0 ? 18 : 7.5) * ph.damping * (1 + _simSettleBoost);
  if (_simSettleBoost > 0) {
    _simSettleBoost *= 0.94;
    if (_simSettleBoost < 0.01) _simSettleBoost = 0;
  }
  const windResp = ph.windResponse;
  const invMassScale = 1 / ph.massiveness;
  const stiffMul = ph.stiffness;
  const edgeStiff = 0.97;     // branch length ≈ rigid
  // More iterations = pulls propagate further along the tree in a single frame.
  // During a drag we crank it up so the whole chain bends, not just nearby nodes.
  // Adaptive: full cost during drag, normal while simulating, coasting pass
  // while decaying. Saves GPU/CPU when motion is tiny.
  // Constraint iterations — wind needs almost grab-level propagation for
  // the trunk-base torque to reach every joint in one frame. Otherwise
  // the force gets absorbed at the top and never swings the trunk.
  const windIter = P_STORM ? 22 : (strength > 0.3 ? 20 : windOn ? 16 : 6);
  // Scale grab iterations down on big trees so drag stays responsive.
  // Cost per frame is O(N × iter); 22 is tuned for ~500-node trees. Above
  // that, bend converges over 2-3 frames instead of 1 — imperceptible on a drag.
  const grabIter = skN <= 500 ? 22 : Math.max(10, Math.round(22 - (skN - 500) * 0.012));
  const iterations = (grabbedNodeIdx >= 0) ? grabIter : windIter;
  const dampFactor = Math.max(0, 1 - linearDamp * dt);
  const N = skN;
  // Hoist typed-array refs into locals — JIT keeps these in registers, faster
  // than re-reading the module-scope `let` each iteration.
  const posX = skPosX,  posY = skPosY,  posZ = skPosZ;
  const prevX = skPrevX, prevY = skPrevY, prevZ = skPrevZ;
  const velX = skVelX,  velY = skVelY,  velZ = skVelZ;
  const restX = skRestX, restY = skRestY, restZ = skRestZ;
  const restOffX = skRestOffX, restOffY = skRestOffY, restOffZ = skRestOffZ;
  const restParDirX = skRestParentDirX, restParDirY = skRestParentDirY, restParDirZ = skRestParentDirZ;
  const hasPD = skHasParentDir;
  const worldX = skWorldOffX, worldY = skWorldOffY, worldZ = skWorldOffZ;
  const radius = skRadius, invMass = skInvMass, bendStiff = skBendStiff, parentIdx = skParentIdx;
  const restLen = skRestLen;

  // 1. Apply wind forces to velocity, then damp.
  // Shared time envelopes — computed once per frame, read per node.
  const gustSlow   = Math.sin(t * freq * 0.22);
  const gustMicro  = Math.sin(t * freq * 0.73 + 1.3);
  const dirDriftX  = -windDirZ, dirDriftZ = windDirX;
  const dirDriftAmt = dirJitter * Math.sin(t * freq * 0.18);
  const swirlPhase = t * freq * 0.55;
  const chaosPhase = t * freq * 2.7;
  // --- Cinematic macro sway ---------------------------------------------
  // Mimics a user grabbing the trunk and slowly swinging it left / right.
  // A very low-frequency sine pushes every node along the wind direction
  // with a force proportional to height so the trunk bends at the root
  // and the canopy trails. Storm amplifies this dramatically.
  const macroFreq  = 0.22;                    // ~4.5 s period — feel of a real trunk swing
  const macroPhase = Math.sin(t * macroFreq * Math.PI * 2);
  // Secondary beat gives the swing a non-trivial cadence.
  const macroPhase2 = Math.sin(t * macroFreq * Math.PI * 2 * 0.31 + 1.2) * 0.35;
  const macroMix = macroPhase + macroPhase2;
  const macroAmp =
    (P_STORM   ? 16.0 :
     P_CHAOTIC ? 7.0 :
     P_SWIRL   ? 3.0 :
     P_GUSTY   ? 5.0 :
                 3.5) * strength * windResp;
  // Wind zone spatial falloff — precomputed for this step.
  const zoneR = P.wind.zoneRadius ?? 0;
  const zoneF = P.wind.zoneFalloff ?? 0.35;
  const hasZone = zoneR > 0;
  const zoneOuter = zoneR * (1 + zoneF);
  const zoneInner = zoneR * (1 - zoneF);
  for (let i = 0; i < N; i++) {
    if (parentIdx[i] < 0 || i === grabbedNodeIdx) continue;
    let ax = 0, ay = 0, az = 0;
    if (windOn) {
      const rx = restX[i], ry = restY[i], rz = restZ[i];

      // Macro trunk sway — applied to EVERY node, proportional to height.
      // Trunk base feels almost nothing (its rest y ≈ 0), but every node
      // above gets pushed progressively harder. Because the whole column
      // of joints pushes in the same direction, the cumulative torque at
      // the root actually bends the trunk — which is what you want for
      // "storm grabs the tree" feel.
      const heightF = Math.max(0, ry) * 0.9 + 0.1; // min 0.1 so even low branches sway
      const macro = macroMix * macroAmp * heightF;
      ax += macro * windDirX;
      az += macro * windDirZ;

      // Wave-front — the wind sweeps ACROSS the tree along its direction
      // so the windward side catches the gust first. Soft height taper
      // now instead of the old hard gate, so trunk nodes still participate.
      const alongDir = rx * windDirX + rz * windDirZ;
      const front = t * freq * waveSpeed * pWave - alongDir * 0.45;
      const hMask = Math.max(0.1, ry * 0.9); // was: ry > 0.4 ? ry - 0.4 : 0

      const base = Math.sin(front + ry * 0.25);
      const gustEnv = gust * pGust * (0.55 * gustSlow + 0.4 * gustMicro);
      const gustWave = Math.sin(front * 0.35 + rx * 0.1 + rz * 0.14) * gustEnv;
      const turb = turbulence * pTurb * (
        0.35 * Math.sin(t * freq * 3.1 + rx * 2.3 + ry * 1.1) +
        0.25 * Math.sin(t * freq * 4.7 + rz * 2.8 + ry * 0.6) +
        (P_CHAOTIC ? 0.25 * Math.sin(chaosPhase + rx * 5.1 + rz * 4.3 + ry * 3.7) : 0)
      );
      const wave = base + gustWave + turb;

      const area = (radius[i] + 0.02) * (0.5 + Math.sqrt(hMask) * 0.28);
      const accel = wave * strength * windResp * 22 * area * invMass[i];
      const dirX = windDirX + dirDriftX * dirDriftAmt;
      const dirZ = windDirZ + dirDriftZ * dirDriftAmt;
      ax += accel * dirX;
      az += accel * dirZ;

      if (swirl > 0) {
        const sw = swirl * pSwirl * strength * windResp * 22 * area * invMass[i];
        const swirlAng = swirlPhase + Math.atan2(rz, rx) * 1.2 + ry * 0.15;
        const swirlWave = Math.sin(swirlAng);
        const tangLen = Math.hypot(rx, rz) || 1;
        const tx = -rz / tangLen, tz = rx / tangLen;
        ax += tx * swirlWave * sw * 0.6;
        az += tz * swirlWave * sw * 0.6;
        ay += Math.abs(base) * sw * 0.35;
      }
    }
    // Snow / ice load — constant downward pull scaled by height × thinness
    // so tips bend dramatically, thick scaffolds barely sag. Independent of wind.
    const snowLoad = ph.snowLoad ?? 0;
    if (snowLoad > 0 && parentIdx[i] >= 0) {
      const ry = restY[i];
      const thinness = 1 / Math.max(0.005, radius[i]);
      ay -= snowLoad * Math.max(0, ry) * thinness * invMass[i] * 0.02;
    }
    // Wind-zone spatial falloff: fade wind accels to 0 beyond the zone edge.
    if (hasZone) {
      const dx = restX[i], dz = restZ[i];
      const d = Math.sqrt(dx * dx + dz * dz);
      const mul = d <= zoneInner ? 1
                : d >= zoneOuter ? 0
                : 1 - (d - zoneInner) / Math.max(1e-4, (zoneOuter - zoneInner));
      ax *= mul; ay *= mul; az *= mul;
    }
    velX[i] = (velX[i] + ax * dt) * dampFactor;
    velY[i] = (velY[i] + ay * dt) * dampFactor;
    velZ[i] = (velZ[i] + az * dt) * dampFactor;
  }

  // 2. Predict positions (or pin if root/grabbed)
  for (let i = 0; i < N; i++) {
    prevX[i] = posX[i]; prevY[i] = posY[i]; prevZ[i] = posZ[i];
    if (parentIdx[i] < 0) {
      posX[i] = restX[i]; posY[i] = restY[i]; posZ[i] = restZ[i]; // root pinned
    } else if (i === grabbedNodeIdx) {
      posX[i] = restX[i] + grabTargetWorldOffset.x; // cursor pinned
      posY[i] = restY[i] + grabTargetWorldOffset.y;
      posZ[i] = restZ[i] + grabTargetWorldOffset.z;
    } else {
      posX[i] += velX[i] * dt;
      posY[i] += velY[i] * dt;
      posZ[i] += velZ[i] * dt;
    }
  }

  // 3. Iterative constraint solver (all writes go directly to SoA — no pointer chasing)
  const edgeStiffVal = edgeStiff;
  const grabSpread = P.physics.grabSpread ?? 0.72;
  for (let iter = 0; iter < iterations; iter++) {
    // Edge (rigid): each child → parent at rest segment length.
    for (let i = 0; i < N; i++) {
      const p = parentIdx[i];
      if (p < 0) continue;
      const dx = posX[i] - posX[p];
      const dy = posY[i] - posY[p];
      const dz = posZ[i] - posZ[p];
      const cur2 = dx * dx + dy * dy + dz * dz;
      if (cur2 < 1e-12) continue;
      const cur = Math.sqrt(cur2);
      const wA = invMass[p] * invMassScale;
      const wB = (i === grabbedNodeIdx) ? 0 : invMass[i] * invMassScale;
      const wSum = wA + wB;
      if (wSum < 1e-8) continue;
      const diff = (cur - restLen[i]) / cur * edgeStiffVal;
      const cA = diff * (wA / wSum);
      const cB = diff * (wB / wSum);
      posX[p] += dx * cA; posY[p] += dy * cA; posZ[p] += dz * cA;
      posX[i] -= dx * cB; posY[i] -= dy * cB; posZ[i] -= dz * cB;
    }
    // Bending (elastic): rotation-aware pull toward rest offset. This is the
    // main force that drags a released branch back to rest — while sculpting
    // (after release), we skip it so the pose sticks. It still runs during
    // an active drag so the whole chain bends along with the grabbed node.
    const runBending = !(_sculptActive && grabbedNodeIdx < 0);
    for (let i = 0; runBending && i < N; i++) {
      const p = parentIdx[i];
      if (p < 0) continue;
      let tgtX, tgtY, tgtZ;
      if (!hasPD[i]) {
        tgtX = posX[p] + restOffX[i];
        tgtY = posY[p] + restOffY[i];
        tgtZ = posZ[p] + restOffZ[i];
      } else {
        const gp = parentIdx[p];
        const cdx = posX[p] - posX[gp];
        const cdy = posY[p] - posY[gp];
        const cdz = posZ[p] - posZ[gp];
        const cl2 = cdx * cdx + cdy * cdy + cdz * cdz;
        if (cl2 > 1e-12) {
          const inv = 1 / Math.sqrt(cl2);
          const ux = cdx * inv, uy = cdy * inv, uz = cdz * inv;
          // Inline quat-from-unit-vectors + rotate(restOffset) by it.
          const rdx = restParDirX[i], rdy = restParDirY[i], rdz = restParDirZ[i];
          const qxyzX = rdy * uz - rdz * uy;
          const qxyzY = rdz * ux - rdx * uz;
          const qxyzZ = rdx * uy - rdy * ux;
          const qw = rdx * ux + rdy * uy + rdz * uz + 1;
          const qlen = Math.sqrt(qxyzX * qxyzX + qxyzY * qxyzY + qxyzZ * qxyzZ + qw * qw);
          if (qlen > 1e-8) {
            const inv2 = 1 / qlen;
            const qx = qxyzX * inv2, qy = qxyzY * inv2, qz = qxyzZ * inv2, qwn = qw * inv2;
            const ox = restOffX[i], oy = restOffY[i], oz = restOffZ[i];
            // v + 2 * cross(qv, cross(qv, v) + qw*v)
            const tX = qy * oz - qz * oy + qwn * ox;
            const tY = qz * ox - qx * oz + qwn * oy;
            const tZ = qx * oy - qy * ox + qwn * oz;
            const rotOffX = ox + 2 * (qy * tZ - qz * tY);
            const rotOffY = oy + 2 * (qz * tX - qx * tZ);
            const rotOffZ = oz + 2 * (qx * tY - qy * tX);
            const rotMix = 0.65;
            tgtX = posX[p] + ox + (rotOffX - ox) * rotMix;
            tgtY = posY[p] + oy + (rotOffY - oy) * rotMix;
            tgtZ = posZ[p] + oz + (rotOffZ - oz) * rotMix;
          } else {
            tgtX = posX[p] + restOffX[i];
            tgtY = posY[p] + restOffY[i];
            tgtZ = posZ[p] + restOffZ[i];
          }
        } else {
          tgtX = posX[p] + restOffX[i];
          tgtY = posY[p] + restOffY[i];
          tgtZ = posZ[p] + restOffZ[i];
        }
      }
      const dx = tgtX - posX[i];
      const dy = tgtY - posY[i];
      const dz = tgtZ - posZ[i];
      const wA = invMass[p] * invMassScale;
      const wB = (i === grabbedNodeIdx) ? 0 : invMass[i] * invMassScale;
      const wSum = wA + wB;
      if (wSum < 1e-8) continue;
      let bendScale = 1;
      if (grabbedNodeIdx >= 0) {
        if (grabChainMask && grabChainMask[i]) bendScale = 1 - grabSpread;
        // Descendants were ×1.8 (fishing-rod feel) back when bendStiff floor
        // was 0.12. With the 0.3 floor, ×1.8 makes them rigid enough to hold
        // rest direction (usually "up") against the drag. 1.15 keeps them
        // slightly stiffer than idle so they still trail the tip, but loose
        // enough to follow the drag direction.
        else bendScale = 1.15;
      } else if (windOn) {
        // Wind softening — match the grab-chain behavior proportionally so
        // wind alone produces the "alive" sway you feel during a grab.
        // At strength=1 we approach bendScale ≈ 0.15 (same ballpark as a
        // grabbed chain), letting accumulated wind force propagate instead
        // of the bending constraint yanking the tree back to rest.
        const windSoften = Math.min(0.88, strength * (P_STORM ? 1.1 : 0.88));
        bendScale = 1 - windSoften;
      }
      const bs = Math.min(0.98, bendStiff[i] * stiffMul * bendScale);
      const fA = -bs * (wA / wSum);
      const fB =  bs * (wB / wSum);
      posX[p] += dx * fA; posY[p] += dy * fA; posZ[p] += dz * fA;
      posX[i] += dx * fB; posY[i] += dy * fB; posZ[i] += dz * fB;
    }
  }
  // Rest-pose anchor (single pass outside iteration — see commit history).
  // Skipped while sculpting OR while a strong wind is blowing so the trunk
  // can drift instead of being yanked back to rest every frame. The grab
  // path zeroes this entirely; we do the same at max wind strength.
  if (grabbedNodeIdx < 0 && !_sculptActive) {
    const restAnchorBase = 1 - Math.pow(1 - 0.05, iterations);
    const windRestDamp = windOn
      ? Math.max(0, 1 - strength * (P_STORM ? 1.2 : 1.0))
      : 1;
    if (windRestDamp > 0.001) {
      for (let i = 0; i < N; i++) {
        if (parentIdx[i] < 0) continue;
        const bs = bendStiff[i];
        const a = restAnchorBase * bs * bs * windRestDamp;
        posX[i] += (restX[i] - posX[i]) * a;
        posY[i] += (restY[i] - posY[i]) * a;
        posZ[i] += (restZ[i] - posZ[i]) * a;
      }
    }
  }

  // 4. Reconstruct velocity + update worldOffset.
  const invDt = 1 / dt;
  for (let i = 0; i < N; i++) {
    if (parentIdx[i] < 0 || i === grabbedNodeIdx) {
      velX[i] = 0; velY[i] = 0; velZ[i] = 0;
    } else {
      velX[i] = (posX[i] - prevX[i]) * invDt;
      velY[i] = (posY[i] - prevY[i]) * invDt;
      velZ[i] = (posZ[i] - prevZ[i]) * invDt;
    }
    worldX[i] = posX[i] - restX[i];
    worldY[i] = posY[i] - restY[i];
    worldZ[i] = posZ[i] - restZ[i];
    // NaN sentinel: if extreme params produced non-finite state, snap this
    // particle back to rest so the bad value doesn't propagate next frame.
    if (!(posX[i] === posX[i] && posY[i] === posY[i] && posZ[i] === posZ[i])) {
      posX[i] = restX[i]; posY[i] = restY[i]; posZ[i] = restZ[i];
      prevX[i] = posX[i]; prevY[i] = posY[i]; prevZ[i] = posZ[i];
      velX[i] = 0; velY[i] = 0; velZ[i] = 0;
      worldX[i] = 0; worldY[i] = 0; worldZ[i] = 0;
    }
  }

  // Fatigue: gradually drift the rest pose toward the current deformed pose.
  // Makes RMB grab-and-bend feel permanent — without it the branch springs
  // straight back when released.
  const fatigue = ph.fatigue ?? 0;
  if (fatigue > 0 && skRestX) {
    const k = Math.min(1, fatigue * dt);
    for (let i = 0; i < skRestX.length; i++) {
      skRestX[i] += (skPosX[i] - skRestX[i]) * k;
      skRestY[i] += (skPosY[i] - skRestY[i]) * k;
      skRestZ[i] += (skPosZ[i] - skRestZ[i]) * k;
    }
  }

  // Mirror SoA state back into skeleton[] objects so non-hot readers
  // (leaf/stem instance updates, picking, reframe) see the fresh pose.
  _skeletonSoAToObjects();
}

const _ubRestDir = new THREE.Vector3();
const _ubCurDir = new THREE.Vector3();
const _ubRotQ = new THREE.Quaternion();
const STATIC_EPS_SQ = 1e-8; // |worldOffset|² below which an edge counts as "at rest"
function updateBark() {
  if (!treeMesh || !barkRestPos || !barkRadialRest || skN === 0) return;
  const posAttr = treeMesh.geometry.attributes.position;
  const arr = posAttr.array;
  const nA = barkNodeA, nB = barkNodeB, nW = barkNodeW;
  // Use the geometry's actual vertex count, NOT nA.length. The bark-node
  // typed-array pools are grow-only, so when the user shrinks mesh sides /
  // smoothness via tubesOnly, nA.length stays at the previous larger size
  // while totalVerts drops. Iterating to nA.length reads stale node indices
  // and writes past the live buffer's bounds → "exploded" mesh that fixed
  // itself only after a full rebuild repopulated the pool to a matching size.
  const count = posAttr.count;
  // Hoist all SoA array refs into locals. JIT registers > object property chase.
  const pX = skPosX, pY = skPosY, pZ = skPosZ;
  const rX = skRestX, rY = skRestY, rZ = skRestZ;
  const oX = skWorldOffX, oY = skWorldOffY, oZ = skWorldOffZ;
  let lastA = -1, lastB = -1;
  let qx = 0, qy = 0, qz = 0, qw = 1;
  let edgeStatic = false;
  // Per-edge cache: rest dir (anchor for radial rotation) + current center
  // interpolation happens per vertex, but edge-scope state (the quat) is
  // hoisted so vertices sharing an edge reuse the same rotation.
  let aPx = 0, aPy = 0, aPz = 0, bPx = 0, bPy = 0, bPz = 0;
  for (let v = 0; v < count; v++) {
    const a = nA[v], b = nB[v], w = nW[v], iw = 1 - w;
    if (a !== lastA || b !== lastB) {
      const oax = oX[a], oay = oY[a], oaz = oZ[a];
      const obx = oX[b], oby = oY[b], obz = oZ[b];
      const ma = oax * oax + oay * oay + oaz * oaz;
      const mb = obx * obx + oby * oby + obz * obz;
      edgeStatic = (ma < STATIC_EPS_SQ) && (mb < STATIC_EPS_SQ);
      aPx = pX[a]; aPy = pY[a]; aPz = pZ[a];
      bPx = pX[b]; bPy = pY[b]; bPz = pZ[b];
      if (!edgeStatic) {
        const rdx = rX[b] - rX[a];
        const rdy = rY[b] - rY[a];
        const rdz = rZ[b] - rZ[a];
        const cdx = bPx - aPx;
        const cdy = bPy - aPy;
        const cdz = bPz - aPz;
        const rl2 = rdx * rdx + rdy * rdy + rdz * rdz;
        const cl2 = cdx * cdx + cdy * cdy + cdz * cdz;
        if (rl2 > 1e-12 && cl2 > 1e-12) {
          const rInv = 1 / Math.sqrt(rl2);
          const cInv = 1 / Math.sqrt(cl2);
          _ubRestDir.set(rdx * rInv, rdy * rInv, rdz * rInv);
          _ubCurDir.set(cdx * cInv, cdy * cInv, cdz * cInv);
          _ubRotQ.setFromUnitVectors(_ubRestDir, _ubCurDir);
        } else {
          _ubRotQ.set(0, 0, 0, 1);
        }
        qx = _ubRotQ.x; qy = _ubRotQ.y; qz = _ubRotQ.z; qw = _ubRotQ.w;
      }
      lastA = a; lastB = b;
    }
    const i3 = v * 3;
    if (edgeStatic) {
      arr[i3    ] = barkRestPos[i3    ];
      arr[i3 + 1] = barkRestPos[i3 + 1];
      arr[i3 + 2] = barkRestPos[i3 + 2];
      continue;
    }
    const rx = barkRadialRest[i3];
    const ry = barkRadialRest[i3 + 1];
    const rz = barkRadialRest[i3 + 2];
    const tx = 2 * (qy * rz - qz * ry);
    const ty = 2 * (qz * rx - qx * rz);
    const tz = 2 * (qx * ry - qy * rx);
    const vrx = rx + qw * tx + (qy * tz - qz * ty);
    const vry = ry + qw * ty + (qz * tx - qx * tz);
    const vrz = rz + qw * tz + (qx * ty - qy * tx);
    const cx = aPx * iw + bPx * w;
    const cy = aPy * iw + bPy * w;
    const cz = aPz * iw + bPz * w;
    arr[i3    ] = cx + vrx;
    arr[i3 + 1] = cy + vry;
    arr[i3 + 2] = cz + vrz;
  }
  posAttr.needsUpdate = true;
  _barkNeedsRestReset = true;
}

// Restore the bark vertex buffer to its rest pose. Called once when the wind
// system transitions from skeleton mode (CPU sim writing live positions) back
// to shader mode (TSL reads positions + adds wind disp). Skips the work when
// the buffer is already at rest.
let _barkNeedsRestReset = false;
function _resetBarkToRest() {
  _barkNeedsRestReset = false;
  if (!treeMesh || !barkRestPos) return;
  const posAttr = treeMesh.geometry.attributes.position;
  const arr = posAttr.array;
  const n = Math.min(arr.length, barkRestPos.length);
  for (let i = 0; i < n; i++) arr[i] = barkRestPos[i];
  posAttr.needsUpdate = true;
}

const _leafSimDummy = new THREE.Object3D();
const _zeroMat4 = new THREE.Matrix4().makeScale(0, 0, 0);
// Leaf base matrix is T(L.pos) * R(L.rx,ry,rz) * S(L.s) — built once by
// _foliagePhase. Each frame we only rewrite the translation block (bytes
// 12..14 within each 16-float instance) to T(L.pos + anchor.worldOffset).
// This replaces a full Object3D.updateMatrix + setMatrixAt (~50 ops) with
// three float writes per leaf.
function updateLeafInstances() {
  const skeletonLen = skN;
  // Hoist SoA typed-array refs into locals. Direct Float32Array indexing is
  // 3-4× faster per-leaf than skeleton[anchorIdx].worldOffset.x — on 200k
  // leaves at 60fps that's millions of ops saved per second during wind/grab.
  const oX = skWorldOffX, oY = skWorldOffY, oZ = skWorldOffZ;
  for (const [inst, data] of [[leafInstA, leafDataA], [leafInstB, leafDataB]]) {
    if (!inst || !data.length) continue;
    const arr = inst.instanceMatrix.array;
    let dirty = false;
    for (let i = 0; i < data.length; i++) {
      const L = data[i];
      const m = i * 16;
      const a = L.anchorIdx;
      // Bounds check — if anchor is stale (regen during animate), hide this leaf
      if (a >= skeletonLen) {
        if (!L._hidden) {
          // Zero the scale diagonal; translation can stay, the leaf vanishes.
          arr[m] = 0; arr[m + 5] = 0; arr[m + 10] = 0;
          L._hidden = true;
          L._atRest = false;
          dirty = true;
        }
        continue;
      }
      const offx = oX[a], offy = oY[a], offz = oZ[a];
      const offSq = offx * offx + offy * offy + offz * offz;
      // Fast-path: anchor hasn't moved since last frame AND we've already
      // written the resting translation — skip the write.
      if (offSq < STATIC_EPS_SQ && L._atRest && !L._hidden) continue;
      // If we previously hid this leaf, resurrect its R*S. Easiest path: set
      // the full matrix once via the Object3D dummy then fall back to the
      // translation-only fast path next frame.
      if (L._hidden) {
        _leafSimDummy.position.set(L.pos.x + offx, L.pos.y + offy, L.pos.z + offz);
        _leafSimDummy.rotation.set(L.rx, L.ry, L.rz);
        _leafSimDummy.scale.setScalar(L.s);
        _leafSimDummy.updateMatrix();
        inst.setMatrixAt(i, _leafSimDummy.matrix);
        L._hidden = false;
      } else {
        // Rotation + scale are baked; only translation moves with the anchor.
        arr[m + 12] = L.pos.x + offx;
        arr[m + 13] = L.pos.y + offy;
        arr[m + 14] = L.pos.z + offz;
      }
      L._atRest = offSq < STATIC_EPS_SQ;
      dirty = true;
    }
    if (dirty) inst.instanceMatrix.needsUpdate = true;
  }
}

const _stemDummy = new THREE.Object3D();
const _stemDir = new THREE.Vector3();
const _stemAxis = new THREE.Vector3(0, 1, 0);
const _stemQuat = new THREE.Quaternion();
// Stems: stemDir = L.pos - anchor.restPos is STATIC (confirmed by substituting
// anchor.pos = anchor.restPos + anchor.worldOffset). So stem orientation +
// scale never change once the tree is built. We bake the full T*R*S matrix
// once per _foliagePhase commit, and each frame just rewrite the translation
// to (anchor.restPos + anchor.worldOffset). Saves per-stem setFromUnitVectors,
// normalize, and updateMatrix calls every frame.
function buildStemBaseMatrices() {
  if (!stemInst) return;
  const skeletonLen = skN;
  const arr = stemInst.instanceMatrix.array;
  // SoA hoist — reads anchor rest position from skRestX/Y/Z instead of
  // chasing skeleton[a].restPos.x. Runs once per foliage build; still a win
  // on 200k-leaf trees + keeps the hot sim code path off the object graph.
  const rX = skRestX, rY = skRestY, rZ = skRestZ;
  let slotIdx = 0;
  for (const data of [leafDataA, leafDataB]) {
    for (let i = 0; i < data.length; i++, slotIdx++) {
      const L = data[i];
      const m = slotIdx * 16;
      const a = L.anchorIdx;
      if (a >= skeletonLen) {
        // Zero scale hides the stem; write identity elsewhere.
        arr[m] = 0; arr[m + 5] = 0; arr[m + 10] = 0;
        arr[m + 15] = 1;
        L._stemHidden = true;
        L._stemBaseX = 0; L._stemBaseY = 0; L._stemBaseZ = 0;
        continue;
      }
      // Stem base = anchor.restPos + per-leaf offset along the twig segment.
      const baseX = rX[a] + L.anchorOffX;
      const baseY = rY[a] + L.anchorOffY;
      const baseZ = rZ[a] + L.anchorOffZ;
      // Stem direction + length come from the explicit petiole vector stored
      // at scatter time — NOT from (leaf.pos − base). Leaf inset / droop /
      // facing / tilt rotate the blade but leave the petiole straight.
      const dx = L.stemVecX;
      const dy = L.stemVecY;
      const dz = L.stemVecZ;
      const segLen = Math.hypot(dx, dy, dz);
      if (segLen < 1e-4) {
        arr[m] = 0; arr[m + 5] = 0; arr[m + 10] = 0;
        arr[m + 15] = 1;
        L._stemHidden = true;
        L._stemBaseX = baseX; L._stemBaseY = baseY; L._stemBaseZ = baseZ;
        continue;
      }
      const visualLen = Math.max(0.005, segLen);
      const thick = Math.max(0.35, Math.min(1.8, L.s * 0.5)) * (P.leafStemThick ?? 1);
      // Inline TBN-style basis from petiole direction (stem-local +Y).
      // Replaces setFromUnitVectors → Matrix4.compose (~2µs) with direct
      // matrix writes (~0.2µs). On 1M-leaf trees: 2s → 0.2s for stem build.
      const sd = 1 / segLen;
      const dyN = dy * sd;
      // Pick a perp axis stable across the y-range. Identical to the
      // ax = |dy|>0.95 ? (1,0,0) : (0,1,0) trick used elsewhere.
      let pX, pY, pZ;
      if (dyN > 0.95 || dyN < -0.95) {
        // Bitangent ≈ (0,0,1) when stem is near vertical → use (1,0,0) tangent.
        pX = 1; pY = 0; pZ = 0;
      } else {
        pX = 0; pY = 1; pZ = 0;
      }
      // tangent = perp × stemDir, then bitangent = stemDir × tangent.
      const dxN = dx * sd, dzN = dz * sd;
      let tX = pY * dzN - pZ * dyN;
      let tY = pZ * dxN - pX * dzN;
      let tZ = pX * dyN - pY * dxN;
      const tLen = Math.sqrt(tX * tX + tY * tY + tZ * tZ) || 1;
      tX /= tLen; tY /= tLen; tZ /= tLen;
      const bX = dyN * tZ - dzN * tY;
      const bY = dzN * tX - dxN * tZ;
      const bZ = dxN * tY - dyN * tX;
      // M = [tangent*thick | stemDir*visualLen | bitangent*thick | translation]
      arr[m]      = tX * thick;     arr[m + 1]  = tY * thick;     arr[m + 2]  = tZ * thick;     arr[m + 3]  = 0;
      arr[m + 4]  = dxN * visualLen; arr[m + 5]  = dyN * visualLen; arr[m + 6]  = dzN * visualLen; arr[m + 7]  = 0;
      arr[m + 8]  = bX * thick;     arr[m + 9]  = bY * thick;     arr[m + 10] = bZ * thick;     arr[m + 11] = 0;
      arr[m + 12] = baseX;          arr[m + 13] = baseY;          arr[m + 14] = baseZ;          arr[m + 15] = 1;
      L._stemHidden = false;
      L._stemBaseX = baseX;
      L._stemBaseY = baseY;
      L._stemBaseZ = baseZ;
    }
  }
  stemInst.instanceMatrix.needsUpdate = true;
}

function updateStemInstances() {
  if (!stemInst) return;
  const skeletonLen = skN;
  const arr = stemInst.instanceMatrix.array;
  // SoA hoist — same win as updateLeafInstances.
  const oX = skWorldOffX, oY = skWorldOffY, oZ = skWorldOffZ;
  let slotIdx = 0;
  let dirty = false;
  for (const data of [leafDataA, leafDataB]) {
    for (let i = 0; i < data.length; i++, slotIdx++) {
      const L = data[i];
      if (L._stemHidden) continue;
      const a = L.anchorIdx;
      if (a >= skeletonLen) continue;
      const offx = oX[a], offy = oY[a], offz = oZ[a];
      const offSq = offx * offx + offy * offy + offz * offz;
      if (offSq < STATIC_EPS_SQ && L._stemRest) continue;
      const m = slotIdx * 16;
      arr[m + 12] = L._stemBaseX + offx;
      arr[m + 13] = L._stemBaseY + offy;
      arr[m + 14] = L._stemBaseZ + offz;
      L._stemRest = offSq < STATIC_EPS_SQ;
      dirty = true;
    }
  }
  if (dirty) stemInst.instanceMatrix.needsUpdate = true;
}

function simHasMotion() {
  // Reads SoA — no object chase. Early-exits on the first node with energy.
  const vx = skVelX, vz = skVelZ, wx = skWorldOffX, wz = skWorldOffZ;
  if (!vx) return false;
  const n = skN;
  let e = 0;
  for (let i = 0; i < n; i++) {
    e += vx[i] * vx[i] + vz[i] * vz[i] + wx[i] * wx[i] + wz[i] * wz[i];
    if (e > 0.0005) return true;
  }
  return false;
}
let reframeDebounce = null;

function reframeToTree() {
  if (!treeMesh) return;
  treeMesh.geometry.computeBoundingBox();
  const bbox = treeMesh.geometry.boundingBox.clone();
  const leafMargin = (P.leafSize || 1) + (P.leafSpread || 0);
  bbox.expandByScalar(leafMargin);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);
  const fovY = (camera.fov * Math.PI) / 180;
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect);
  const fitH = size.y / 2 / Math.tan(fovY / 2);
  const fitW = size.x / 2 / Math.tan(fovX / 2);
  const dist = Math.min(Math.max(fitH, fitW) * 1.55, controls.maxDistance);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); else dir.normalize();
  reframeAnim = {
    fromCam: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toCam: center.clone().addScaledVector(dir, dist),
    toTarget: center.clone(),
    t: 0,
    duration: 1.2,
  };
}

// Derive broadleaf-style levels + leaf params from the conifer schema.
// Called inside generateTree when treeType === 'conifer' so the shared
// tree-building engine produces a conical pine/spruce/cedar.
//
// **MERGES into P.levels[0]/[1] each regen** — only the conifer-managed
// keys (children/lenRatio/angle/taper/etc.) are overwritten. Any other
// per-level edits the user made (rollVar, distortion, custom curves,
// gnarliness overrides…) survive. To completely customize a conifer,
// switch treeType away from 'conifer' so this function stops running.
function applyConiferConfigToP() {
  const l1Patch = {
    children: P.cBranchCount,
    lenRatio: P.cBranchLen,
    angle: P.cBranchAngle,
    angleVar: 0.1,
    phyllotaxis: 'spiral',
    startPlacement: P.cBranchStart,
    endPlacement: 0.99,
    apicalDominance: P.cCrownTaper,
    apicalInverted: true,
    gravitropism: P.cBranchDroop,
    phototropism: 0,
    distortion: 0.06,
    // Slim attachment + cone taper — real conifer limbs read as needles.
    radiusRatio: P.cBranchRadiusRatio ?? 0.32,
    taper: P.cBranchTaper ?? 1.5,
  };
  const l2Patch = {
    children: P.cTwigCount,
    lenRatio: P.cTwigLen,
    angle: P.cTwigAngle,
    angleVar: 0.25,
    startPlacement: 0.35,
    endPlacement: 1,
    apicalDominance: 0.2,
    phototropism: 0,
    distortion: 0.1,
    radiusRatio: P.cTwigRadiusRatio ?? 0.28,
    taper: P.cTwigTaper ?? 1.4,
  };
  if (!Array.isArray(P.levels)) P.levels = [];
  // Ensure L1 and L2 exist; create from defaults if missing. Then overlay
  // the conifer-managed keys, leaving all other per-level edits intact.
  if (!P.levels[0]) P.levels[0] = makeDefaultLevel();
  if (!P.levels[1]) P.levels[1] = makeDefaultLevel();
  Object.assign(P.levels[0], l1Patch);
  Object.assign(P.levels[1], l2Patch);
  // Needle-like leaves
  P.leafSize = P.cNeedleLength;
  P.leavesPerTip = P.cNeedleDensity;
  P.leafChainSteps = P.cNeedleChain;
  P.leafFacing = P.cNeedleFacing;
  P.leafSpread = 0.18;
  P.leafSizeVar = 0.35;
  P.leafDroop = P.cNeedleDroop;
  // Conifer trunks are tall + slim — the broadleaf default of 0.5 tiles/m
  // makes the bark pattern read as fine noise. Coarser tiling spreads each
  // tile over more trunk surface so the plate / strip pattern is visible.
  if (P.barkTexScaleU == null || P.barkTexScaleU === 0.5) P.barkTexScaleU = 0.3;
  if (P.barkTexScaleV == null || P.barkTexScaleV === 0.5) P.barkTexScaleV = 0.3;
}

// Derive a bush shape — short trunk, primary stems fanning out (or rocketing
// up when bUpright > 0), pruning envelope sized to bSpread × bHeight.
// Called when treeType === 'bush'. All sizes are in meters — the sliders are
// the actual life-size dimensions of the finished bush.
function applyBushConfigToP() {
  const up = P.bUpright ?? 0;            // -1 droopy ↔ +1 upright
  const gnarl = P.bGnarl ?? 0.2;         // 0 clean ↔ 1 gnarled
  const thick = P.bThickness ?? 1.6;     // stem/branch thickness multiplier

  // Trunk = a short woody base. For upright bushes (lavender) it's a stub
  // and stems shoot up from soil; for spreading bushes (hydrangea) it's
  // larger so primary stems can be a sane multiple of trunk length and
  // still reach the canopy radius. trunkFrac never goes below 0.20 so the
  // lenRatio computation below never hits its cap on small bushes.
  const trunkFrac = THREE.MathUtils.lerp(0.32, 0.20, Math.max(0, up));
  P.trunkHeight   = Math.max(0.06, P.bHeight * trunkFrac);
  P.trunkSteps    = 5;
  P.trunkJitter   = 0.02;
  P.trunkCount    = 1;
  P.trunkScale    = 0.85;
  P.rootFlare     = 0.2;
  // baseR (actual trunk world radius) = P.baseRadius * (P.trunkHeight / 10)
  // downstream — a normalization for 10m reference trees. For a 0.3m bush
  // trunk this multiplier is 0.03, so we back-solve for baseRadius to land
  // on the desired world-meter trunk thickness. Target ~6mm trunk on a
  // 0.5m lavender, ~2cm on a 1.5m holly (real bush stems are slim).
  const targetTrunkR = (0.003 + P.bHeight * 0.007) * thick;
  P.baseRadius    = THREE.MathUtils.clamp(targetTrunkR * 10 / Math.max(0.05, P.trunkHeight), 0.05, 1.2);
  // tipRadius is consumed directly in world units (no trunkHeight rescale).
  P.tipRadius     = THREE.MathUtils.clamp((0.001 + P.bHeight * 0.002) * thick, 0.0015, 0.012);
  P.alloExp       = 2.2;
  P.minLen        = 0.03;
  P.branchThickness = 1.0;

  // Pruning envelope = the canopy ellipsoid sized DIRECTLY off bSpread
  // (diameter) and bHeight. bCompact > 1 tightens the envelope (denser
  // bush silhouette); bCompact ≤ 1 leaves it at full life-size diameter.
  // We never inflate the envelope past bSpread — that was the previous
  // bug that made bushes 30%+ wider than their declared spread.
  const compactDiv = Math.max(1.0, P.bCompact);
  P.pruneRadius   = (P.bSpread * 0.5) / compactDiv;
  P.pruneHeight   = (P.bHeight * 0.5) / compactDiv;
  // Vertically centered on the canopy — for upright bushes the canopy
  // covers the whole stem range; for spreading bushes it sits a bit lower.
  P.pruneCenterY  = P.bHeight * THREE.MathUtils.lerp(0.45, 0.55, (up + 1) * 0.5);
  if (P.pruneMode !== 'off') P.pruneMode = 'ellipsoid';

  // L0 lenRatio is multiplied by branchBaseLen (= 9m × globalScale) at
  // spawn time — NOT by trunkHeight. So lenRatio for a bush is tiny (a
  // 0.5m raw stem on a 1m bush is lenRatio ≈ 0.06). We size raw stem
  // length to slightly exceed the canopy diameter so the prune envelope
  // gets fully populated with stems before culling.
  const rawStemLen  = Math.max(P.bSpread, P.bHeight) * 0.7;
  const L0Len       = THREE.MathUtils.clamp(rawStemLen / 9.0, 0.04, 0.5);

  // Branch angle — upright bushes have near-vertical primaries (lavender
  // wand), spreading bushes flare out (hydrangea).
  const L0Angle     = THREE.MathUtils.lerp(1.25, 0.20, (up + 1) * 0.5);
  // Gravitropism — positive = downward droop (hydrangea), negative becomes
  // phototropism (upward) at the model level. We feed phototropism for
  // upright + gravitropism for drooping; both can't be simultaneously
  // strong on the same level so we pick one.
  const L0Gravity   = up < 0 ? Math.abs(up) * 0.12 : 0.005;
  const L0Photo     = up > 0 ? up * 0.12 : 0.0;
  // Clean stems for cultivated species (boxwood, lavender), gnarled for
  // woody (rosemary, holly).
  const distort     = THREE.MathUtils.lerp(0.10, 0.32, gnarl);
  const curveAmt    = THREE.MathUtils.lerp(0.18, 0.45, gnarl);

  P.levels = [
    {
      ...makeDefaultLevel(),
      children: P.bStems,
      lenRatio: L0Len,
      radiusRatio: 0.55,
      angle: L0Angle,
      angleVar: THREE.MathUtils.lerp(0.32, 0.14, Math.abs(up)),
      rollVar: 0.85,
      phyllotaxis: 'spiral',
      startPlacement: up > 0.5 ? 0.0 : 0.04,
      endPlacement: up > 0.5 ? 0.45 : 0.92,
      apicalDominance: up > 0 ? 0.05 : 0.18,
      apicalContinue: up > 0.6 ? 0.4 : 0.0,
      angleDecline: up < 0 ? -0.15 : 0.1,
      kinkSteps: 9,
      distortion: distort,
      distortionType: 'perlin',
      distortionFreq: 2.4,
      curveMode: up < 0 ? 'backCurve' : 'sCurve',
      curveAmount: curveAmt,
      curveBack: up < 0 ? 0.4 * Math.abs(up) : -0.1,
      segSplits: 0.08 * gnarl,
      splitAngle: 0.25,
      gravitropism: L0Gravity,
      phototropism: L0Photo,
      susceptibility: 1.2,
      densityPoints: up > 0.5 ? [1.0, 1.0, 0.9, 0.7, 0.4] : [0.6, 0.95, 1.0, 0.95, 0.7],
      lengthPoints:  up > 0.5 ? [1.0, 1.05, 1.0, 0.9, 0.7] : [0.85, 1.0, 1.05, 1.0, 0.85],
      randomnessPoints: [0.6, 0.85, 1.1, 1.35, 1.6],
    },
    {
      ...makeDefaultLevel(),
      children: P.bBranchiness,
      lenRatio: P.bTwigLen,
      radiusRatio: 0.55,
      angle: THREE.MathUtils.lerp(0.95, 0.55, Math.max(0, up)),
      angleVar: 0.32,
      rollVar: 0.9,
      startPlacement: 0.25,
      endPlacement: 1.0,
      apicalDominance: 0.15,
      kinkSteps: 6,
      distortion: distort * 0.9,
      distortionFreq: 3.0,
      curveMode: 'sCurve',
      curveAmount: curveAmt * 0.6,
      gravitropism: up < 0 ? 0.08 : 0.02,
      phototropism: up > 0 ? up * 0.04 : 0,
      densityPoints: [0.6, 0.95, 1.0, 0.95, 0.75],
      lengthPoints: [0.85, 1.0, 1.0, 0.95, 0.8],
    },
    {
      ...makeDefaultLevel(),
      children: Math.max(2, Math.floor(P.bBranchiness * 0.65)),
      lenRatio: 0.55,
      radiusRatio: 0.55,
      angle: 0.6,
      angleVar: 0.3,
      rollVar: 0.95,
      startPlacement: 0.35,
      endPlacement: 1.0,
      kinkSteps: 5,
      distortion: distort * 0.8,
      distortionFreq: 3.6,
      stochastic: 0.15,
      curveMode: up < 0 ? 'backCurve' : 'sCurve',
      curveAmount: 0.22,
      gravitropism: up < 0 ? 0.14 : 0.04,
      densityPoints: [0.7, 1.0, 1.0, 0.95, 0.8],
      lengthPoints: [0.95, 1.0, 1.0, 0.95, 0.85],
    },
  ];

  P.leafSize      = P.bLeafSize;
  P.leavesPerTip  = P.bLeafDensity;
  P.leafChainSteps = 4;
  P.leafSpread    = P.bLeafSpread;
  P.leafDroop     = P.bLeafDroop;
  P.leavesStart   = 0;
  P.leafSizeVar   = 0.35;
  // Season is preset-driven so each species can tint its own foliage —
  // boxwood/holly stay deep green (0), lavender/rosemary silver-green (~0.2).
  // Don't clobber the species-set value if one is provided; only fall back
  // to a default when the species hasn't specified one in this rebuild.
  if (P.season === undefined || P.season === null) P.season = 0.05;
}

// Module-scope scratch for _foliagePhase — created once, reused across all
// rebuilds. _foliagePhase is never re-entered, so sharing is safe.
const _fpQRand    = new THREE.Quaternion();
const _fpQDroop   = new THREE.Quaternion();
const _fpQFace    = new THREE.Quaternion();
const _fpQPitch   = new THREE.Quaternion();
const _fpQYaw     = new THREE.Quaternion();
const _fpEuler    = new THREE.Euler();
const _fpNodePos  = new THREE.Vector3();
const _fpTiltAxis = new THREE.Vector3();
const _fpTiltQ    = new THREE.Quaternion();
const _fpXAxis    = new THREE.Vector3(1, 0, 0);
const _fpYAxis    = new THREE.Vector3(0, 1, 0);
const _fpTwigDir  = new THREE.Vector3();
const _fpAux      = new THREE.Vector3();
const _fpB1       = new THREE.Vector3();
const _fpB2       = new THREE.Vector3();
const _fpStemDir  = new THREE.Vector3();
const _fpInsetOff = new THREE.Vector3();
const _fpQRoll    = new THREE.Quaternion();
const _fpInstCol  = new THREE.Color();
const _fpWhiteCol = new THREE.Color(1, 1, 1);
const _fpObj3D    = new THREE.Object3D();
const _fpEulerLeaf = new THREE.Euler();
// _fpQDroop never changes — set once.
_fpQDroop.setFromAxisAngle(_fpXAxis, Math.PI / 2);

// Grow-only pools of reusable leaf-entry objects. On a big tree the foliage
// phase allocates ~3 objects per leaf (Vector3 + jitter + entry); at 400k
// leaves that's 1.2M allocations per regen. Pooling lets every regen after
// the first reuse the same slots — zero allocs, no GC pressure during scrub.
// Slots are returned as-is (mutable); _foliagePhase overwrites every field
// on reuse so stale data can't leak through.
const _leafSlotPoolA = [];
const _leafSlotPoolB = [];
let _leafSlotCursorA = 0;
let _leafSlotCursorB = 0;
function _acquireLeafSlot(isA) {
  const pool = isA ? _leafSlotPoolA : _leafSlotPoolB;
  const idx = isA ? _leafSlotCursorA++ : _leafSlotCursorB++;
  if (idx < pool.length) return pool[idx];
  const slot = {
    pos: new THREE.Vector3(),
    anchorIdx: 0,
    // Stem base = anchor.restPos + (anchorOffX,Y,Z). Stems fan from a single
    // anchor node out to scattered leaves without this, because leaves are
    // placed along the twig segment, not at the segment's endpoint.
    anchorOffX: 0, anchorOffY: 0, anchorOffZ: 0,
    // Stem vector (base → tip), pre-computed from the petiole direction
    // × length BEFORE any leaf-inset / droop / facing perturbation is folded
    // into the leaf pose. Decouples stem geometry from leaf orientation so
    // the petiole always points along the designated petiole direction.
    stemVecX: 0, stemVecY: 0, stemVecZ: 0,
    rx: 0, ry: 0, rz: 0,
    s: 0, sFactor: 1,
    jitter: null,
  };
  pool.push(slot);
  return slot;
}
function _writeLeafSlot(slot, lfx, lfy, lfz, anchorIdx, rx, ry, rz, sz, sFactor, colorVar, nRng,
                        anchorOffX = 0, anchorOffY = 0, anchorOffZ = 0,
                        stemVecX = 0, stemVecY = 0, stemVecZ = 0) {
  // Reset RUNTIME flags attached to this slot by the previous regen's sim
  // loop (updateLeafInstances / updateStemInstances / buildStemBaseMatrices).
  // Without this, a reused slot can inherit `_atRest = true` or `_hidden`
  // from whatever leaf used it last, which makes the sim skip the fresh
  // matrix write → the new leaf appears at the old leaf's bent position or
  // stays invisible. Same for `_stemRest` / `_stemHidden` / `_stemBaseX/Y/Z`.
  slot._atRest = false;
  slot._hidden = false;
  slot._stemRest = false;
  slot._stemHidden = false;
  slot._stemBaseX = 0;
  slot._stemBaseY = 0;
  slot._stemBaseZ = 0;
  slot.pos.set(lfx, lfy, lfz);
  slot.anchorIdx = anchorIdx;
  slot.anchorOffX = anchorOffX;
  slot.anchorOffY = anchorOffY;
  slot.anchorOffZ = anchorOffZ;
  slot.stemVecX = stemVecX;
  slot.stemVecY = stemVecY;
  slot.stemVecZ = stemVecZ;
  slot.rx = rx; slot.ry = ry; slot.rz = rz;
  slot.s = sz; slot.sFactor = sFactor;
  if (colorVar > 0) {
    // Reuse the jitter sub-object when present — another allocation saved per
    // leaf on colorful trees.
    if (!slot.jitter) slot.jitter = { h: 0, s: 0, l: 0 };
    slot.jitter.h = (nRng() - 0.5) * colorVar * 0.5;
    slot.jitter.s = (nRng() - 0.5) * colorVar * 0.6;
    slot.jitter.l = (nRng() - 0.5) * colorVar * 0.4;
  } else {
    slot.jitter = null;
  }
}
// Shared foliage phase — builds leafDataA/B, leafInstA/B, stemInst, coneInst
// from tree-node state. Called by both the full rebuild and the leaves-only
// fast path, so layout stays consistent per seed.
// Direct typed-array leaf matrix builder. Inlines Euler-XYZ rotation + uniform
// scale + translation into a 16-float column-major 4×4 matrix per instance.
// Replaces Object3D.position.copy + rotation.set + scale.setScalar + updateMatrix
// + setMatrixAt (~2µs/leaf) with ~0.3µs/leaf direct memory writes. On a 1M-leaf
// tree this turns a 2-second loop into ~300ms.
function _fillLeafMatrixArray(arr, leafData) {
  const n = leafData.length;
  for (let i = 0; i < n; i++) {
    const L = leafData[i];
    const px = L.pos.x, py = L.pos.y, pz = L.pos.z;
    const rx = L.rx, ry = L.ry, rz = L.rz;
    const s  = L.s;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // R = Rx · Ry · Rz (three.js Euler 'XYZ' intrinsic). Column-major output.
    const r00 = cy * cz;
    const r01 = -cy * sz;
    const r02 = sy;
    const r10 = sx * sy * cz + cx * sz;
    const r11 = -sx * sy * sz + cx * cz;
    const r12 = -sx * cy;
    const r20 = -cx * sy * cz + sx * sz;
    const r21 = cx * sy * sz + sx * cz;
    const r22 = cx * cy;
    const m = i * 16;
    arr[m]      = r00 * s; arr[m + 1]  = r10 * s; arr[m + 2]  = r20 * s; arr[m + 3]  = 0;
    arr[m + 4]  = r01 * s; arr[m + 5]  = r11 * s; arr[m + 6]  = r21 * s; arr[m + 7]  = 0;
    arr[m + 8]  = r02 * s; arr[m + 9]  = r12 * s; arr[m + 10] = r22 * s; arr[m + 11] = 0;
    arr[m + 12] = px;      arr[m + 13] = py;      arr[m + 14] = pz;      arr[m + 15] = 1;
  }
}

// Direct typed-array leaf color builder. Replaces per-leaf Color.setHSL +
// Color.lerp + setColorAt (~1µs/leaf) with inlined HSL→RGB + 0.55 lerp toward
// white. Skips entirely when leafColorVar is 0 (caller guards via hasJitter).
const _LEAF_LERP_T = 0.55;
function _fillLeafColorArray(arr, leafData) {
  const n = leafData.length;
  for (let i = 0; i < n; i++) {
    const L = leafData[i];
    const j = L.jitter;
    const i3 = i * 3;
    if (!j) { arr[i3] = 1; arr[i3 + 1] = 1; arr[i3 + 2] = 1; continue; }
    let h = (j.h + 1) % 1; if (h < 0) h += 1;
    const sat = Math.max(0, Math.min(1, 0.5 + j.s));
    const lig = Math.max(0, Math.min(1, 0.5 + j.l));
    // HSL → RGB. Inlined version of three.js Color.setHSL.
    let r, g, b;
    if (sat === 0) {
      r = g = b = lig;
    } else {
      const p = lig <= 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
      const q = 2 * lig - p;
      r = _hue2rgb(q, p, h + 1 / 3);
      g = _hue2rgb(q, p, h);
      b = _hue2rgb(q, p, h - 1 / 3);
    }
    // Lerp toward white by 0.55 — matches the previous .lerp(_fpWhiteCol, 0.55) call.
    arr[i3]     = r + (1 - r) * _LEAF_LERP_T;
    arr[i3 + 1] = g + (1 - g) * _LEAF_LERP_T;
    arr[i3 + 2] = b + (1 - b) * _LEAF_LERP_T;
  }
}
function _hue2rgb(q, p, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return q + (p - q) * 6 * t;
  if (t < 1 / 2) return p;
  if (t < 2 / 3) return q + (p - q) * 6 * (2 / 3 - t);
  return q;
}

function _foliagePhase(treeNodes, tips, maxTreeY) {
  // Bulletproof inputs — any missing piece means no leaves this frame.
  if (!Array.isArray(treeNodes) || treeNodes.length === 0) return;
  if (!Array.isArray(tips)) tips = [];
  if (!Number.isFinite(maxTreeY) || maxTreeY <= 0) maxTreeY = 1;
  // Reset the pool cursors — every call to _foliagePhase rebuilds both lists
  // from scratch (they're cleared at the generateTree boundary), so cursors
  // start at 0 and the pool reuses its high-water slots.
  _leafSlotCursorA = 0;
  _leafSlotCursorB = 0;

  const seasonalDensity = seasonInfo(P.season ?? 0.2).density;
  const facing = P.leafFacing ?? 0;
  const leavesMinY = (P.leavesStart ?? 0) * maxTreeY;
  const leafMaxRadius = P.leafMaxRadius ?? 0.08;
  const stemAngle = Math.max(0, Math.min(1, P.leafStemAngle ?? 0.3));
  const phyllotaxis = P.leafPhyllotaxis ?? 'spiral';
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // 137.5° in radians
  const isConiferLeaves = P.treeType === 'conifer';
  // Stable per-tip index so the inner leaf-placement RNG can key off it
  // instead of the global random() stream. Keeps leaf positions put when
  // upstream random consumption shifts (e.g. after subdivision changes).
  let tipIdx = -1;
  // Lowest branchLevel a leaf is allowed to attach to. Without this gate the
  // walk-back keeps adding leaves up the chain and into PARENT levels (L3
  // tips spill leaves onto L2, L2 onto L1, etc.) — the canopy ends up with
  // foliage growing from major scaffolds instead of just the deepest twig
  // layer. Restricting to `tip.branchLevel` keeps leaves on the last level.
  for (const tip of tips) {
    tipIdx++;
    if (!tip || tip.pruned) continue;
    if (!tip.pos || !Number.isFinite(tip.pos.y)) continue;
    if (tip.pos.y < leavesMinY) continue;
    const tipLevel = tip.branchLevel;
    let cur = tip;
    const maxSteps = Math.min(32, Math.max(1, P.leafChainSteps | 0));
    for (let step = 0; step < maxSteps && cur && cur.parent; step++) {
      if (cur.pruned) break;
      if (cur.pos.y < leavesMinY) break;
      // Stop once we cross out of the tip's own branch level — leaves only
      // attach to the deepest (twig) chain. Conifers keep the legacy walk so
      // needles can fan from one step in.
      if (!isConiferLeaves && tipLevel !== undefined && cur.branchLevel !== tipLevel) break;
      // Skip leaves on twigs too thick to bear them (trunk/main branches).
      if (!isConiferLeaves && cur.radius > leafMaxRadius) { cur = cur.parent; continue; }
      // Uniform count across every chain step so leaves spread evenly along
      // the twig length. Branch fill multiplies per-step density. Uses
      // probabilistic rounding so the slider feels smooth all the way to 0
      // instead of clamping at 1-leaf-per-step until it suddenly snaps off.
      const branchFill = P.leafBranchFill ?? 1;
      const rawPerStep = (P.leavesPerTip * branchFill) / Math.max(1, P.leafChainSteps);
      const perStep = Math.floor(rawPerStep) + (random() < (rawPerStep - Math.floor(rawPerStep)) ? 1 : 0);
      const rawTip   = P.leavesPerTip * branchFill;
      const tipCount = Math.floor(rawTip) + (random() < (rawTip - Math.floor(rawTip)) ? 1 : 0);
      const baseCount = isConiferLeaves && step === 0 ? tipCount : perStep;
      const count = Math.max(0, Math.round(baseCount * seasonalDensity));
      const stemLen = P.leafStemLen ?? 0;
      const tilt = P.leafTilt ?? 0;
      const colorVar = P.leafColorVar ?? 0;

      // Precompute twig direction + perpendicular basis ONCE per node (shared
      // by all leaves at this step). Phyllotaxis theta is deterministic per j.
      _fpTwigDir.copy(cur.pos).sub(cur.parent.pos);
      const _tm = _fpTwigDir.length();
      if (_tm > 1e-5) _fpTwigDir.multiplyScalar(1 / _tm); else _fpTwigDir.set(0, 1, 0);
      _fpAux.set(Math.abs(_fpTwigDir.y) > 0.95 ? 1 : 0, Math.abs(_fpTwigDir.y) > 0.95 ? 0 : 1, 0);
      _fpB1.copy(_fpAux).addScaledVector(_fpTwigDir, -_fpAux.dot(_fpTwigDir)).normalize();
      _fpB2.copy(_fpTwigDir).cross(_fpB1);

      // Local RNG seeded from (seed, tipIdx, step) — stable regardless of
      // how many random draws happened elsewhere, so subdivision changes
      // elsewhere in the tree don't relocate leaves here.
      const nRng = _localRng(P.seed | 0, 0xF01EA6, tipIdx, step);
      // Random per-node phyllotaxis phase so adjacent twigs don't align.
      const thetaPhase = nRng() * Math.PI * 2;

      for (let j = 0; j < count; j++) {
        // Scatter leaves freely along the twig so placements don't read as a
        // strict grid. Reserve ~10% near each end so leaves don't bunch at
        // the node itself.
        let segT;
        if (isConiferLeaves && step === 0) segT = 0.25 + nRng() * 0.5;
        else segT = 0.08 + nRng() * 0.87;
        _fpNodePos.lerpVectors(cur.pos, cur.parent.pos, segT);

        const list = leafDataA;

        // Phyllotaxis sets a base theta, then we add ~40° of natural jitter
        // so leaves scatter around the twig instead of forming a rigid helix.
        let theta;
        switch (phyllotaxis) {
          case 'opposite':  theta = thetaPhase + (j % 2) * Math.PI; break;
          case 'alternate': theta = thetaPhase + j * Math.PI * 0.5; break;
          case 'random':    theta = nRng() * Math.PI * 2; break;
          case 'spiral':
          default:          theta = thetaPhase + j * GOLDEN_ANGLE; break;
        }
        theta += (nRng() - 0.5) * 0.7;
        const cosT = Math.cos(theta), sinT = Math.sin(theta);
        // Radial (outward from twig) direction at this theta.
        _fpStemDir.copy(_fpB1).multiplyScalar(cosT).addScaledVector(_fpB2, sinT);
        // Blend with twig-tip direction so the stem angles forward toward tip
        // instead of sticking straight out — real petioles lean outward.
        if (stemAngle > 0) {
          _fpStemDir.multiplyScalar(1 - stemAngle * 0.5).addScaledVector(_fpTwigDir, stemAngle * 0.5).normalize();
        }

        // Build leaf orientation: +Y (blade) along stem direction.
        _fpQRand.setFromUnitVectors(_fpYAxis, _fpStemDir);
        // Small roll around stem axis for natural variation.
        _fpQRoll.setFromAxisAngle(_fpStemDir, (nRng() - 0.5) * Math.PI * 0.6);
        _fpQRand.premultiply(_fpQRoll);

        if (P.leafDroop > 0) _fpQRand.slerp(_fpQDroop, P.leafDroop);
        if (facing > 0) {
          _fpQPitch.setFromAxisAngle(_fpXAxis, -Math.PI / 2 + (nRng() - 0.5) * 0.4);
          _fpQYaw.setFromAxisAngle(_fpYAxis, nRng() * Math.PI * 2);
          _fpQFace.copy(_fpQYaw).multiply(_fpQPitch);
          _fpQRand.slerp(_fpQFace, facing);
        }
        if (tilt > 0) {
          _fpTiltAxis.set(nRng() - 0.5, 0, nRng() - 0.5).normalize();
          _fpTiltQ.setFromAxisAngle(_fpTiltAxis, (nRng() - 0.5) * tilt * 0.9);
          _fpQRand.multiply(_fpTiltQ);
        }
        _fpEuler.setFromQuaternion(_fpQRand);
        const sFactor = (1 - P.leafSizeVar * 0.5 + nRng() * P.leafSizeVar);
        const sz = P.leafSize * sFactor;
        // Leaf base = point on twig surface + petiole length along stem dir.
        // Start at the twig radius so the base sits on the bark, not inside.
        const radialOffset = (cur.radius || 0) + stemLen;
        let ox = _fpStemDir.x * radialOffset;
        let oy = _fpStemDir.y * radialOffset;
        let oz = _fpStemDir.z * radialOffset;
        // Plane inset — shifts the leaf along its own +Y (blade) axis so
        // textures whose visible body doesn't start at the plane's edge can
        // be visually aligned to the stem tip. Negative pulls leaf toward
        // stem, positive pushes it outward.
        const inset = P.leafInset ?? 0;
        let insX = 0, insY = 0, insZ = 0;
        if (inset !== 0) {
          _fpInsetOff.set(0, inset * sz, 0).applyQuaternion(_fpQRand);
          insX = _fpInsetOff.x; insY = _fpInsetOff.y; insZ = _fpInsetOff.z;
        }
        const lfx = _fpNodePos.x + ox + insX;
        const lfy = _fpNodePos.y + oy + insY;
        const lfz = _fpNodePos.z + oz + insZ;
        if (lfy < 0.04) continue;
        // anchorOff = stem-base offset from anchor.restPos to its true point on
        // the twig segment (the leaf was scattered at a segT lerp, not at the
        // anchor node itself). stemVec = pure petiole vector along _fpStemDir,
        // independent of leafInset / droop / facing — keeps the petiole
        // straight regardless of how the blade rotates.
        const segOffX = _fpNodePos.x - cur.pos.x;
        const segOffY = _fpNodePos.y - cur.pos.y;
        const segOffZ = _fpNodePos.z - cur.pos.z;
        const slot = _acquireLeafSlot(list === leafDataA);
        _writeLeafSlot(slot, lfx, lfy, lfz, cur.idx,
          _fpEuler.x, _fpEuler.y, _fpEuler.z, sz, sFactor, colorVar, nRng,
          segOffX, segOffY, segOffZ,
          ox, oy, oz);
        list.push(slot);
      }
      cur = cur.parent;
    }
  }

  // Canopy dieback — cull leaves inside the crown's shaded interior.
  if ((P.dieback ?? 0) > 0 && (leafDataA.length + leafDataB.length) > 0) {
    const bbox = new THREE.Box3();
    for (const L of leafDataA) bbox.expandByPoint(L.pos);
    for (const L of leafDataB) bbox.expandByPoint(L.pos);
    if (!bbox.isEmpty()) {
      applyCanopyDieback(leafDataA, bbox);
      applyCanopyDieback(leafDataB, bbox);
    }
  }


  const isConifer = P.treeType === 'conifer';
  const useGeo  = isConifer ? activeNeedleGeo : leafGeo;
  const useMatA = isConifer ? needleMatA : leafMatA;
  leafInstA = new THREE.InstancedMesh(useGeo, useMatA, Math.max(leafDataA.length, 1));
  leafInstA.count = leafDataA.length;
  leafInstA.frustumCulled = false;
  leafInstA.castShadow = true;
  leafInstA.visible = leavesOn;
  scene.add(leafInstA);

  // Jitter is applied uniformly — every leaf in a given _foliagePhase call
  // either has a jitter object (colorVar > 0) or doesn't (colorVar == 0).
  const _anyJitter = (P.leafColorVar ?? 0) > 0;
  const hasJitterA = _anyJitter && leafDataA.length > 0;
  if (hasJitterA) leafInstA.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(leafDataA.length, 1) * 3), 3);
  // Direct typed-array matrix composition (~6-7× faster than Object3D path).
  _fillLeafMatrixArray(leafInstA.instanceMatrix.array, leafDataA);
  if (hasJitterA) _fillLeafColorArray(leafInstA.instanceColor.array, leafDataA);
  leafInstA.instanceMatrix.needsUpdate = true;
  if (hasJitterA && leafInstA.instanceColor) leafInstA.instanceColor.needsUpdate = true;

  if (P.treeType === 'conifer' && P.cConeCount > 0 && tips.length > 0) {
    const count = Math.min(P.cConeCount, tips.length);
    coneInst = new THREE.InstancedMesh(coneGeo, coneMat, count);
    coneInst.frustumCulled = false;
    const d2 = new THREE.Object3D();
    const hang = P.cConeHang;
    for (let i = 0; i < count; i++) {
      const tip = tips[Math.floor(random() * tips.length)];
      d2.position.set(
        tip.pos.x + (random() - 0.5) * 0.15,
        tip.pos.y - hang * 0.25,
        tip.pos.z + (random() - 0.5) * 0.15,
      );
      d2.rotation.set(
        (random() - 0.5) * 0.4 + (hang * 0.3 - 0.2),
        random() * Math.PI * 2,
        (random() - 0.5) * 0.4,
      );
      d2.scale.setScalar(P.cConeSize * (0.8 + random() * 0.4));
      d2.updateMatrix();
      coneInst.setMatrixAt(i, d2.matrix);
    }
    coneInst.instanceMatrix.needsUpdate = true;
    scene.add(coneInst);
  }
}

function rebuildLeavesOnly() {
  // Curl/profile params can change between calls; rebuild the shared leaf
  // mesh so the new instances pick it up.
  rebuildLeafGeo();
  generateTree({ leavesOnly: true });
}

// Fast-path for pure scale sliders (leafSize). Leaf layout (positions,
// rotations, anchors) is identical; only each leaf's scale changes. Skip the
// entire _foliagePhase: reuse the existing leafDataA/B arrays and just rewrite
// instance matrices with the new scale. ~30× faster than rebuildLeavesOnly
// during a drag.
const _rescaleObj = new THREE.Object3D();
function rescaleLeaves() {
  const size = P.leafSize;
  let any = false;
  const skLen = skN;
  const oX = skWorldOffX, oY = skWorldOffY, oZ = skWorldOffZ;
  for (const [inst, data] of [[leafInstA, leafDataA], [leafInstB, leafDataB]]) {
    if (!inst || !data.length) continue;
    for (let i = 0; i < data.length; i++) {
      const L = data[i];
      if (L.sFactor === undefined) return false; // cache missing — caller falls back
      L.s = size * L.sFactor;
      // Compose matrix with the leaf's current (static) anchor offset; leaves
      // don't move until sim runs again, so this mirrors rest pose.
      const a = L.anchorIdx;
      const ox = a < skLen ? oX[a] : 0;
      const oy = a < skLen ? oY[a] : 0;
      const oz = a < skLen ? oZ[a] : 0;
      _rescaleObj.position.set(L.pos.x + ox, L.pos.y + oy, L.pos.z + oz);
      _rescaleObj.rotation.set(L.rx, L.ry, L.rz);
      _rescaleObj.scale.setScalar(L.s);
      _rescaleObj.updateMatrix();
      inst.setMatrixAt(i, _rescaleObj.matrix);
      L._atRest = false; // force a sim-path rewrite next frame if motion resumes
    }
    inst.instanceMatrix.needsUpdate = true;
    any = true;
  }
  // Stem thickness is `L.s * 0.5` baked at build time, so leafSize changes
  // also need fresh stem matrices — otherwise stems stay at old thickness.
  if (any && stemInst) buildStemBaseMatrices();
  markRenderDirty(2);
  return any;
}

let _buildGen = 0;
// Split orphan queues. A leaves-only rebuild must not yank bark from an
// in-flight full rebuild (the user would see leaves alone with no trunk).
const _orphanBark = [];     // tree/wire/spline — evicted only by a full commit
const _orphanFoliage = [];  // leafInst/stem/cone — evicted by any commit
function _drainOrphanList(list) {
  while (list.length) {
    const m = list.shift();
    if (!m) continue;
    scene.remove(m);
    const origGeo = m.userData && m.userData._origGeo;
    // Skip disposing geometry when it's shared (e.g. wireframe overlay shares
    // treeMesh.geometry) — whichever mesh owns it frees it.
    if (!(m.userData && m.userData._sharedGeom)
        && m.geometry && m.geometry.dispose) m.geometry.dispose();
    if (origGeo && origGeo !== m.geometry && origGeo.dispose) origGeo.dispose();
  }
}

// Tubes-only fast path: re-extrude bark tubes using the cached chain graph
// and fold the new tube arrays into the existing pool. Tree topology,
// skeleton, leafData, vines, twigs, fruits, and stubs are all preserved —
// taper / profile / bark displace / buttress / react wood affect only the
// bark surface, so none of the topology state needs to change. Cuts a
// radius-curve drag's rebuild cost from ~full-pipeline to just the tube
// extrusion + a single pool-fill copy.
async function _tubesOnlyRebuild(myGen) {
  const profilePts = profileEditor ? profileEditor.points.slice() : null;
  const taperPts = taperSpline ? taperSpline.points.slice() : null;
  const displace = {
    amount: P.barkDisplace ?? 0,
    freq: P.barkDisplaceFreq ?? 3,
    mode: P.barkDisplaceMode ?? 'ridges',
    ridgeSharp: P.barkRidgeSharp ?? 0.5,
    verticalBias: P.barkVerticalBias ?? 0.7,
    knots: P.barkKnots ?? 0,
    knotScale: P.barkKnotScale ?? 2.0,
    detail: P.barkDetail ?? 0,
    detailFreq: P.barkDetailFreq ?? 12.0,
    buttressAmount: P.buttressAmount ?? 0,
    buttressHeight: P.buttressHeight ?? 1.5,
    buttressLobes: P.buttressLobes ?? 5,
    reactionWood: P.reactionWood ?? 0,
    radialSegs: P.barkRadialSegs ?? 16,
    tubularDensity: P.barkTubularDensity ?? 6,
  };
  let tubes = null;
  if (_treeWorkers.length > 0 && _treeWorkerReady && _cachedChainsSer) {
    tubes = await buildTubesViaPool(_cachedChainsSer, profilePts, taperPts, isScrubbing, displace);
    if (myGen !== _buildGen) return false; // stale
  }
  if (!tubes) {
    // Main-thread fallback — only works if _chainsRef is populated (i.e. the
    // last full build took the sync-fallback path, so chains are live TNode
    // arrays rather than transferable chainsSer).
    if (!_chainsRef || _chainsRef.length === 0) return false;
    tubes = _chainsRef.map(tubeFromChain).filter(Boolean);
  }
  const chainResults = tubes.filter(Boolean);
  if (chainResults.length === 0) return false;

  let totalVerts = 0, totalIdx = 0;
  for (const r of chainResults) { totalVerts += r.vertCount; totalIdx += r.index ? r.index.length : 0; }
  _ensureBarkPools(totalVerts, totalIdx);
  const _bP = _barkPosPool, _bN = _barkNormPool, _bU = _barkUvPool, _bI = _barkIndexPool, _bR = barkRadialRest;
  let _vOff = 0, _iOff = 0;
  // Track bark bounds inline — saves a full O(V) walk inside
  // BufferGeometry.computeBoundingBox() after the pool-fill.
  let _minX = Infinity, _minY = Infinity, _minZ = Infinity;
  let _maxX = -Infinity, _maxY = -Infinity, _maxZ = -Infinity;
  for (const r of chainResults) {
    const nv = r.vertCount;
    _bP.set(r.position, _vOff * 3);
    _bN.set(r.normal,   _vOff * 3);
    _bU.set(r.uv,       _vOff * 2);
    _bR.set(r.radialRest, _vOff * 3);
    barkNodeA.set(r.nodeA, _vOff);
    barkNodeB.set(r.nodeB, _vOff);
    barkNodeW.set(r.nodeW, _vOff);
    if (r.index) {
      const idx = r.index;
      for (let k = 0; k < idx.length; k++) _bI[_iOff + k] = idx[k] + _vOff;
      _iOff += idx.length;
    }
    // Inline min/max scan. Typed-array indexed reads are hot-cache since
    // r.position was just copied into _bP above; JIT vectorises this well.
    const pos = r.position;
    const n3 = nv * 3;
    for (let k = 0; k < n3; k += 3) {
      const x = pos[k], y = pos[k + 1], z = pos[k + 2];
      if (x < _minX) _minX = x; if (x > _maxX) _maxX = x;
      if (y < _minY) _minY = y; if (y > _maxY) _maxY = y;
      if (z < _minZ) _minZ = z; if (z > _maxZ) _maxZ = z;
    }
    _vOff += nv;
  }
  // Swap geometry on the existing treeMesh. Material, position-in-scene,
  // shadow flags, and everything else stays — just the BufferGeometry is new.
  const oldGeo = treeMesh.geometry;
  const treeGeo = new THREE.BufferGeometry();
  treeGeo.setAttribute('position', new THREE.BufferAttribute(_bP.subarray(0, totalVerts * 3), 3));
  treeGeo.setAttribute('normal',   new THREE.BufferAttribute(_bN.subarray(0, totalVerts * 3), 3));
  treeGeo.setAttribute('uv',       new THREE.BufferAttribute(_bU.subarray(0, totalVerts * 2), 2));
  treeGeo.setIndex(new THREE.BufferAttribute(_bI.subarray(0, totalIdx), 1));
  // Manual bounding-box + sphere from the inline scan. Skips the separate
  // O(V) computeBoundingBox / computeBoundingSphere walks three.js would do.
  _assignTreeBounds(treeGeo, _minX, _minY, _minZ, _maxX, _maxY, _maxZ);
  // Stale-check before commit: if a newer build superseded us during the
  // sync-fallback pool-fill above, drop this stale geometry on the floor.
  // (The worker path already guards earlier; this protects the rare case
  // where the worker bailed and the main-thread fallback ran instead.)
  if (myGen !== _buildGen) { treeGeo.dispose?.(); return false; }
  treeMesh.geometry = treeGeo;
  if (oldGeo && oldGeo.dispose) oldGeo.dispose();
  // Refresh the pristine rest pose. updateBark reads this every frame.
  barkRestPos.set(_bP.subarray(0, totalVerts * 3), 0);
  return true;
}

// Write bounding box + sphere from pre-computed min/max. Replaces two full
// O(V) walks (computeBoundingBox + computeBoundingSphere) when the caller
// already tracked bounds during pool-fill.
function _assignTreeBounds(geo, minX, minY, minZ, maxX, maxY, maxZ) {
  if (!Number.isFinite(minX)) {
    // Empty geometry — fall back to three.js's empty-box defaults.
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return;
  }
  if (!geo.boundingBox) geo.boundingBox = new THREE.Box3();
  geo.boundingBox.min.set(minX, minY, minZ);
  geo.boundingBox.max.set(maxX, maxY, maxZ);
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const hx = maxX - cx, hy = maxY - cy, hz = maxZ - cz;
  if (!geo.boundingSphere) geo.boundingSphere = new THREE.Sphere();
  geo.boundingSphere.center.set(cx, cy, cz);
  geo.boundingSphere.radius = Math.sqrt(hx * hx + hy * hy + hz * hz);
}
// Sanitize numeric params before each build — clamps NaN / out-of-range
// slider values to schema [min, max] so a degenerate input can't NaN-cascade
// into the skeleton walker.
function _sanitizeForBuild() {
  const sanitizeNum = (host, key, p) => {
    const v = host[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      host[key] = p.default;
      return;
    }
    if (typeof p.min === 'number' && v < p.min) host[key] = p.min;
    else if (typeof p.max === 'number' && v > p.max) host[key] = p.max;
  };
  // Top-level P
  for (const g of PARAM_SCHEMA) for (const p of g.params) {
    if (p.type === 'select' || typeof p.default !== 'number') continue;
    sanitizeNum(P, p.key, p);
  }
  // Per-level (mirrors what the walker reads)
  if (Array.isArray(P.levels)) {
    for (const L of P.levels) {
      if (!L) continue;
      for (const p of LEVEL_SCHEMA) {
        if (p.type === 'select' || typeof p.default !== 'number') continue;
        sanitizeNum(L, p.key, p);
      }
      // Required curve arrays must be arrays of >=2 finite numbers.
      const ensureCurve = (k, def) => {
        if (!Array.isArray(L[k]) || L[k].length < 2 || L[k].some((v) => !Number.isFinite(v))) {
          L[k] = def.slice();
        }
      };
      ensureCurve('densityPoints',   [0.75, 0.95, 1.0, 0.95, 0.7]);
      ensureCurve('lengthPoints',    [0.9, 1.0, 1.0, 0.9, 0.75]);
      ensureCurve('splitPoints',     [1, 1, 1, 1, 1]);
      ensureCurve('randomnessPoints',[1, 1, 1, 1, 1]);
      ensureCurve('startAnglePoints',[0, 0, 0, 0, 0]);
    }
  }
  // P.wind / P.physics / P.roots — clamp the few we care about for skeleton.
  if (P.wind) {
    for (const p of WIND_SCHEMA) sanitizeNum(P.wind, p.key, p);
  }
  if (P.physics) {
    for (const p of PHYSICS_SCHEMA) sanitizeNum(P.physics, p.key, p);
  }
  // Critical scalars buildTree divides by — never let them be 0.
  if (!(P.trunkSteps > 0)) P.trunkSteps = 22;
  if (!(P.trunkHeight > 0)) P.trunkHeight = 11;
  if (!(P.barkRadialSegs > 0)) P.barkRadialSegs = 16;
  if (!(P.barkTubularDensity > 0)) P.barkTubularDensity = 6;
}

async function generateTree(opts = {}) {
  const _mode = opts.leavesOnly ? 'Rebuilding foliage…'
              : opts.tubesOnly  ? 'Re-extruding tubes…'
              : 'Building tree…';
  beginBusy(_mode);
  const _gtT = []; // [label, t]
  const _gtMark = (label) => { _gtT.push([label, performance.now()]); };
  _gtMark('start');
  try {
  _sanitizeForBuild();
  const myGen = ++_buildGen;
  // Tubes-only fast path runs BEFORE the sculpt/orphan/clear logic because
  // nothing about the skeleton, leaves, or decoration meshes changes — we
  // only swap the bark BufferGeometry.
  const tubesOnlyEligible = !!opts.tubesOnly
    && treeMesh
    && Array.isArray(_cachedTreeNodes) && _cachedTreeNodes.length > 0
    && (_cachedChainsSer || (_chainsRef && _chainsRef.length > 0));
  if (tubesOnlyEligible) {
    const ok = await _tubesOnlyRebuild(myGen);
    if (myGen !== _buildGen) return;
    if (ok) {
      updateTreeInfo();
      refreshLODUI();
      markRenderDirty(3);
      return;
    }
    // Fall through to full rebuild if the fast path bailed for any reason.
  }
  // Regenerating drops the whole skeleton — any in-progress sculpt would be
  // stranded pointing at a dead pose. Bail out of sculpt mode silently so
  // the new tree starts fresh.
  if (_sculptActive && !opts.leavesOnly) exitSculptMode({ commit: false });
  // Full regen wipes the sculpted shape by construction. Clear the live
  // flag so subsequent slider edits don't get blocked.
  if (!opts.leavesOnly) {
    _sculptIsLive = false;
    _applySculptLiveClass();
  }
  // Clear any side-by-side LOD previews — their geometry is derived from the
  // old bark mesh and would be stale (and positioned relative to the old bbox).
  if (!opts.leavesOnly) clearLODPreviews();
  if (!opts.leavesOnly) clearFallingLeaves();
  // Fast path: skip buildTree + chains + tubes + skeleton and reuse the last
  // full build's cached tree state. Only the foliage (leaves + stems + cones)
  // is rebuilt. ~5-10× faster for leaf-param changes. Additional guards:
  //   • cache must be populated (non-null, non-empty)
  //   • skeleton must match the cache size so anchorIdx stays valid
  // Any mismatch falls through to a full rebuild.
  const leavesOnly = !!opts.leavesOnly
    && Array.isArray(_cachedTreeNodes) && _cachedTreeNodes.length > 0
    && Array.isArray(_cachedTips)
    && skeleton.length === _cachedTreeNodes.length;

  if (!leavesOnly) {
    random = mulberry32(P.seed);
    if (grabbedNodeIdx >= 0) {
      grabbedNodeIdx = -1;
      renderer.domElement.style.cursor = '';
    }
    if (P.treeType === 'conifer') applyConiferConfigToP();
    else if (P.treeType === 'bush') applyBushConfigToP();
    applyBarkMaterial();
  }
  // Skip foliage entirely during scrubs of tree-shape sliders. _foliagePhase
  // scatters 200k+ leaves and is the single biggest cost of a full rebuild on
  // a large tree (~80-200ms / drag tick). The drag-end rebuild from endScrub
  // runs the proper foliage pass at full quality. During the drag the user
  // sees a leafless silhouette — exactly what they want for tree-shape work.
  const _scrubFoliage = isScrubbing && !leavesOnly;
  if (!_scrubFoliage) applyLeafMaterial();

  // Move old meshes into a module-level orphan queue instead of disposing
  // immediately. They stay IN-SCENE while the new tree builds (possibly
  // awaiting the worker), so the user never sees a gap. Whichever call
  // successfully commits drains the queue — a shared queue (not call-locals)
  // means stale bailouts don't leak scene objects.
  if (!leavesOnly) {
    if (treeMesh)       _orphanBark.push(treeMesh);
    if (treeWireMesh)   _orphanBark.push(treeWireMesh);
    if (treeSplineMesh) _orphanBark.push(treeSplineMesh);
    if (treeSplineDots) _orphanBark.push(treeSplineDots);
    if (vineMesh)       _orphanBark.push(vineMesh);
    if (vineLeafInst)   _orphanBark.push(vineLeafInst);
    if (stubInst)       _orphanBark.push(stubInst);
    if (fruitInst)      _orphanBark.push(fruitInst);
    if (rootsMesh)      _orphanBark.push(rootsMesh);
    treeMesh = null; treeWireMesh = null; treeSplineMesh = null; treeSplineDots = null;
    vineMesh = null; vineLeafInst = null; stubInst = null; fruitInst = null;
    rootsMesh = null;
  }
  if (leafInstA) _orphanFoliage.push(leafInstA);
  if (leafInstB) _orphanFoliage.push(leafInstB);
  if (stemInst)  _orphanFoliage.push(stemInst);
  if (coneInst)  _orphanFoliage.push(coneInst);
  leafInstA = null; leafInstB = null; stemInst = null; coneInst = null;
  leafDataA.length = 0; leafDataB.length = 0;

  // Re-seed RNG deterministically for the foliage phase so the fast path
  // produces the same layout as a full rebuild at the same seed.
  if (leavesOnly) random = mulberry32(((P.seed ^ 0x5EED5EED) >>> 0) || 1);

  if (leavesOnly) {
    // Sync foliage rebuild using cached skeleton. Only drain FOLIAGE orphans
    // — if a full rebuild is in flight, its bark orphans must stay visible
    // until it commits. Otherwise the user sees new leaves over nothing.
    _foliagePhase(_cachedTreeNodes, _cachedTips, _cachedMaxTreeY);
    _drainOrphanList(_orphanFoliage);
    updateTreeInfo();
    markRenderDirty(3);
    return;
  }

  // --- Full-pipeline worker path ----------------------------------------
  // When the worker is ready we do tree build + chains + tubes in a single
  // roundtrip, off the main thread. Main thread just rehydrates a light TNode
  // proxy array so _foliagePhase / skeleton / wireframe can consume it.
  let treeNodes = null;
  let treeRoot = null;
  let chains = null;
  let chainResults = null;
  // Bake mode runs the self-organizing simulation on the main thread — skip
  // the worker path entirely so it doesn't overwrite our baked graph with a
  // parametric one.
  const useWorker = _treeWorkers.length > 0 && _treeWorkerReady;
  if (useWorker) {
    const profilePts = profileEditor ? profileEditor.points.slice() : null;
    const taperPts = taperSpline ? taperSpline.points.slice() : null;
    const displace = {
      amount: P.barkDisplace ?? 0,
      freq: P.barkDisplaceFreq ?? 3,
      mode: P.barkDisplaceMode ?? 'ridges',
      ridgeSharp: P.barkRidgeSharp ?? 0.5,
      verticalBias: P.barkVerticalBias ?? 0.7,
      knots: P.barkKnots ?? 0,
      knotScale: P.barkKnotScale ?? 2.0,
      detail: P.barkDetail ?? 0,
      detailFreq: P.barkDetailFreq ?? 12.0,
      // Buttress lobes at the trunk base + reaction-wood underside thickening.
      // Passed into the worker so the worker-built tubes match the main-fallback
      // — before, these sliders silently did nothing under the worker path.
      buttressAmount: P.buttressAmount ?? 0,
      buttressHeight: P.buttressHeight ?? 1.5,
      buttressLobes: P.buttressLobes ?? 5,
      reactionWood: P.reactionWood ?? 0,
      // Mesh subdivision — must be in BOTH the full-build payload and the
      // tubesOnly payload, otherwise the worker falls back to its hardcoded
      // defaults (16/6) and the slider visibly does nothing.
      radialSegs: P.barkRadialSegs ?? 16,
      tubularDensity: P.barkTubularDensity ?? 6,
    };
    const combined = await buildTreeAndTubesViaWorker(profilePts, taperPts, isScrubbing, displace);
    if (myGen !== _buildGen) return; // stale — newer build took over
    _gtMark('worker');
    if (combined) {
      const { nodes, chains: chainsOut } = rehydrateTreeFromSoA(combined.tree, combined.chains);
      treeNodes = nodes;
      treeRoot = nodes[0];
      chains = chainsOut;
      chainResults = combined.tubes.filter(Boolean);
      _cachedChainsSer = combined.chainsSer || null;
      _gtMark('rehydrate');
    }
  }
  // Sync fallback path — used when the worker is unavailable OR when it
  // failed (tree-build-error flows back as a null result above).
  if (!treeNodes) {
    treeNodes = [];
    treeRoot = buildTree(treeNodes);
    _gtMark('sync_buildTree');
    for (let i = 0; i < treeNodes.length; i++) treeNodes[i].idx = i;
    chains = buildChains(treeRoot);
    _gtMark('sync_buildChains');
    _cachedChainsSer = null;
  }
  if (!chainResults) {
    chainResults = chains.map(tubeFromChain).filter(Boolean);
    _gtMark('sync_tubes');
  }

  // Pool-fill the merged bark mesh in one pass. Each chain result already
  // carries final position / normal / uv / index / radialRest / nodeA/B/W as
  // typed arrays — we copy them contiguously into pre-sized pool buffers and
  // wrap a single BufferGeometry around subarrays. This replaces the old
  // pipeline's three redundant walks (mergeGeometries, barkNode flat rebuild,
  // dispose sweep) plus the post-skeleton barkRadialRest recompute.
  let totalVerts = 0, totalIdx = 0;
  for (const r of chainResults) { totalVerts += r.vertCount; totalIdx += r.index ? r.index.length : 0; }
  _ensureBarkPools(totalVerts, totalIdx);
  const _bP = _barkPosPool, _bN = _barkNormPool, _bU = _barkUvPool, _bI = _barkIndexPool, _bR = barkRadialRest;
  let _vOff = 0, _iOff = 0;
  // Track bounds inline — skips a second O(V) walk in computeBoundingBox.
  let _bMinX = Infinity, _bMinY = Infinity, _bMinZ = Infinity;
  let _bMaxX = -Infinity, _bMaxY = -Infinity, _bMaxZ = -Infinity;
  for (const r of chainResults) {
    const nv = r.vertCount;
    _bP.set(r.position, _vOff * 3);
    _bN.set(r.normal,   _vOff * 3);
    _bU.set(r.uv,       _vOff * 2);
    _bR.set(r.radialRest, _vOff * 3);
    barkNodeA.set(r.nodeA, _vOff);
    barkNodeB.set(r.nodeB, _vOff);
    barkNodeW.set(r.nodeW, _vOff);
    if (r.index) {
      const idx = r.index;
      for (let k = 0; k < idx.length; k++) _bI[_iOff + k] = idx[k] + _vOff;
      _iOff += idx.length;
    }
    const pos = r.position;
    const n3 = nv * 3;
    for (let k = 0; k < n3; k += 3) {
      const x = pos[k], y = pos[k + 1], z = pos[k + 2];
      if (x < _bMinX) _bMinX = x; if (x > _bMaxX) _bMaxX = x;
      if (y < _bMinY) _bMinY = y; if (y > _bMaxY) _bMaxY = y;
      if (z < _bMinZ) _bMinZ = z; if (z > _bMaxZ) _bMaxZ = z;
    }
    _vOff += nv;
  }
  // Bind the Mesh to live subarrays of the pool. The mesh position buffer
  // gets mutated each frame by updateBark() — that's intentional (CPU bark
  // deform). barkRestPos keeps the pristine rest pose for the deform math.
  const treeGeo = new THREE.BufferGeometry();
  treeGeo.setAttribute('position', new THREE.BufferAttribute(_bP.subarray(0, totalVerts * 3), 3));
  treeGeo.setAttribute('normal',   new THREE.BufferAttribute(_bN.subarray(0, totalVerts * 3), 3));
  treeGeo.setAttribute('uv',       new THREE.BufferAttribute(_bU.subarray(0, totalVerts * 2), 2));
  treeGeo.setIndex(new THREE.BufferAttribute(_bI.subarray(0, totalIdx), 1));
  _assignTreeBounds(treeGeo, _bMinX, _bMinY, _bMinZ, _bMaxX, _bMaxY, _bMaxZ);
  barkRestPos.set(_bP.subarray(0, totalVerts * 3), 0);
  _gtMark('poolfill');

  // Skeleton init — SoA-first. Old path walked N three times (pool-fill,
  // restLen/restDir walk, SoA copy). New path: one walk straight into SoA
  // (all immutable + mutable fields), one short walk for grandparent rest
  // direction, one mirror into skeleton[] objects for non-hot consumers.
  let _maxRootR = 0;
  for (const n of treeNodes) if ((n.radius || 0) > _maxRootR) _maxRootR = n.radius;
  if (_maxRootR < 1e-4) _maxRootR = 0.3;
  const N = treeNodes.length;
  // Skeleton[] object pool still exists for sculpt/grab/UI consumers that
  // read .pos/.restPos/.worldOffset through the old interface. Hot paths
  // (updateBark, stepSim) read SoA directly.
  while (_skeletonPool.length < N) {
    _skeletonPool.push({
      restPos: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      prevPos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      worldOffset: new THREE.Vector3(),
      restOffFromParent: new THREE.Vector3(),
      restParentDirGP: new THREE.Vector3(),
      hasRestParentDir: false,
      radius: 0, invMass: 0, bendStiff: 0, parentIdx: -1, restLen: 0,
    });
  }
  skeleton = _skeletonPool.length === N ? _skeletonPool : _skeletonPool.slice(0, N);

  _allocSkeletonSoA(N);
  // Single pass: every immutable + rest + mutable field straight into SoA.
  for (let i = 0; i < N; i++) {
    const n = treeNodes[i];
    const r = Math.max(n.radius || 0.04, 0.015);
    const rNorm = Math.min(1, r / _maxRootR);
    const px = n.pos.x, py = n.pos.y, pz = n.pos.z;
    skPosX[i]  = px; skPosY[i]  = py; skPosZ[i]  = pz;
    skPrevX[i] = px; skPrevY[i] = py; skPrevZ[i] = pz;
    skRestX[i] = px; skRestY[i] = py; skRestZ[i] = pz;
    // skVel*, skWorldOff* default to 0 from _allocSkeletonSoA's fresh arrays.
    skRadius[i] = r;
    // Bending stiffness per joint — beam theory (I ∝ r⁴) translated into a
    // per-iteration PBD projection factor. Sharp curve so trunk is rigid
    // while mid/thin branches visibly bend and twigs flex freely.
    skBendStiff[i] = Math.min(0.95, 0.3 + Math.pow(rNorm, 1.3) * 0.65);
    const parentIdx = n.parent ? n.parent.idx : -1;
    skParentIdx[i] = parentIdx;
    if (parentIdx < 0) {
      skInvMass[i] = 0;
      skRestLen[i] = 0;
      skRestOffX[i] = 0; skRestOffY[i] = 0; skRestOffZ[i] = 0;
    } else {
      // Mass ∝ r² so thin branches deflect far more under the same force.
      skInvMass[i] = 1 / (r * r + 0.005);
      const pp = treeNodes[parentIdx].pos;
      const dx = px - pp.x, dy = py - pp.y, dz = pz - pp.z;
      skRestLen[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      skRestOffX[i] = dx;
      skRestOffY[i] = dy;
      skRestOffZ[i] = dz;
    }
  }
  // Second pass: grandparent rest direction. Needs parent-of-parent filled.
  for (let i = 0; i < N; i++) {
    const p = skParentIdx[i];
    if (p < 0) { skHasParentDir[i] = 0; continue; }
    const gp = skParentIdx[p];
    if (gp < 0) { skHasParentDir[i] = 0; continue; }
    const dx = skRestX[p] - skRestX[gp];
    const dy = skRestY[p] - skRestY[gp];
    const dz = skRestZ[p] - skRestZ[gp];
    const rl2 = dx * dx + dy * dy + dz * dz;
    if (rl2 > 1e-12) {
      const inv = 1 / Math.sqrt(rl2);
      skRestParentDirX[i] = dx * inv;
      skRestParentDirY[i] = dy * inv;
      skRestParentDirZ[i] = dz * inv;
      skHasParentDir[i] = 1;
    } else {
      skHasParentDir[i] = 0;
    }
  }
  // Mirror SoA → skeleton[] objects for sculpt / grab / UI consumers.
  _skeletonSoAToObjectsFull();
  _simActive = false;
  // Fresh build starts from rest; boost damping briefly so wind eases in.
  _simSettleBoost = 2.0;

  // barkRadialRest was filled during the pool-copy loop above (the tube
  // builder emits it alongside position/nodeA/B/W). No second walk needed.

  _gtMark('skeleton');

  treeMesh = new THREE.Mesh(treeGeo, barkMat);
  treeMesh.castShadow = true;
  treeMesh.receiveShadow = true;
  treeMesh.frustumCulled = false;
  treeMesh.visible = !splineViewOn;
  scene.add(treeMesh);
  _gtMark('barkmesh');

  if (P.roots && P.roots.enabled && P.roots.rootCount > 0) {
    const trunkBaseR = (P.baseRadius ?? 0.35) * ((P.trunkHeight ?? 10) / 10);
    const rootsGeo = buildRootsGeometry({
      count: P.roots.rootCount | 0,
      spread: P.roots.rootSpread,
      length: P.roots.rootLength,
      depth: P.roots.rootDepth,
      baseRadius: P.roots.rootBaseR * trunkBaseR / 0.35,
      tipRadius: P.roots.rootTipR * trunkBaseR / 0.35,
      jitter: P.roots.rootJitter,
      rise: P.roots.rootRise,
      seed: ((P.seed | 0) ^ 0x12345) >>> 0,
    });
    if (rootsGeo) {
      // Use a vanilla MeshStandardMaterial — barkMat relies on per-vertex
      // node weights / barkRadialRest attributes the trunk builder emits,
      // which our tube geometry doesn't carry.
      if (!_rootsMat) {
        _rootsMat = new THREE.MeshStandardMaterial({
          map: barkAlbedo, normalMap: barkNormal,
          roughness: 0.95, metalness: 0,
        });
      }
      rootsMesh = new THREE.Mesh(rootsGeo, _rootsMat);
      rootsMesh.castShadow = true;
      rootsMesh.receiveShadow = true;
      rootsMesh.frustumCulled = false;
      rootsMesh.visible = !splineViewOn;
      rootsMesh.name = 'rootsMesh';
      scene.add(rootsMesh);
    }
  }

  if (!isScrubbing) {
    buildVines(chains);
    buildStubs(treeNodes);
  }
  _gtMark('decorations');

  _chainsRef = chains;
  if (meshViewOn && !splineViewOn) buildWireMesh();
  if (splineViewOn) buildSplineMesh();

  const tips = treeNodes.filter((n) => n.children.length === 0 && n.parent);
  let maxTreeY = 0;
  for (const n of treeNodes) if (n.pos.y > maxTreeY) maxTreeY = n.pos.y;
  _cachedTreeNodes = treeNodes;
  _cachedTips = tips;
  _cachedMaxTreeY = maxTreeY;
  _gtMark('tips');

  if (!isScrubbing) {
    buildFruits(tips);
  }

  if (!_scrubFoliage) {
    _foliagePhase(treeNodes, tips, maxTreeY);
    _gtMark('foliage');
  } else {
    // No leaves rebuilt this tick — orphaned ones are drained at commit.
    // Force a final-quality foliage rebuild on scrub release.
    _scrubHighestMode = 'full';
  }

  // Bounding box was already filled via _assignTreeBounds during pool-fill.
  // Reading it here costs nothing vs the old computeBoundingBox full walk.
  const bh = treeMesh.geometry.boundingBox.max.y - treeMesh.geometry.boundingBox.min.y;
  if (lastTreeHeight < 0) {
    // First build after page load — don't animate the camera; leave it at its initial pose.
    lastTreeHeight = bh;
  } else if (Math.abs(bh - lastTreeHeight) / Math.max(lastTreeHeight, 1) > 0.18) {
    if (reframeDebounce) clearTimeout(reframeDebounce);
    const targetH = bh;
    reframeDebounce = setTimeout(() => {
      reframeDebounce = null;
      reframeToTree();
      lastTreeHeight = targetH;
    }, 550);
  }

  applyTreeRotation();
  _drainOrphanList(_orphanBark); _drainOrphanList(_orphanFoliage);
  if (!isScrubbing) {
    updateTreeInfo();
    refreshLODUI();
  }
  markRenderDirty(3);
  _gtMark('commit');
  // Print phase breakdown once for any non-trivial build.
  if (typeof window !== 'undefined' && _gtT.length > 1 && (_gtT[_gtT.length-1][1] - _gtT[0][1]) > 50) {
    const out = [];
    for (let i = 1; i < _gtT.length; i++) out.push(`${_gtT[i][0]}=${Math.round(_gtT[i][1] - _gtT[i-1][1])}ms`);
    out.push(`TOTAL=${Math.round(_gtT[_gtT.length-1][1] - _gtT[0][1])}ms`);
    console.log('[gt]', out.join(' '));
    window._gtLastPhases = out;
  }
  } finally { endBusy(); }
}

// --- Sidebar UI ----------------------------------------------------------
const sidebarBody = document.getElementById('sidebar-body');
let genTimer = null;
let _genPending = false;
let _lastGenStart = 0;
// Tracks the weakest rebuild mode requested during the current debounce
// window. If any call asks for a full rebuild, we do a full rebuild — the
// tubes-only fast path is only used when EVERY pending call targets it.
// null = nothing pending; { tubesOnly: true } = tubes-only sufficient; {} = full.
let _pendingGenOpts = null;
// Throttled real-time regen. During slider drag we fire LEADING-edge (first
// move rebuilds immediately) and TRAILING-edge (final state captured), while
// in-between moves are coalesced into at most one rebuild per throttle window.
// This gives the tree a continuous live-preview feel instead of hitching on
// every mouse-move or stalling until the user pauses.
function debouncedGenerate(opts) {
  // Coalesce rebuild mode. Any non-tubes-only call upgrades the pending
  // mode to full. Tubes-only calls only stick if no full call is pending.
  const wantsTubes = !!(opts && opts.tubesOnly);
  if (wantsTubes) {
    if (!_pendingGenOpts) _pendingGenOpts = { tubesOnly: true };
  } else {
    _pendingGenOpts = {};
  }
  // Track the highest tier touched during an active scrub so endScrub can
  // pick the right final-quality rebuild instead of always upgrading to full.
  if (isScrubbing) {
    if (!wantsTubes) _scrubHighestMode = 'full';
    else if (_scrubHighestMode !== 'full') _scrubHighestMode = 'tubes';
  }
  // When a sculpt is live, silently block structural regens so a parameter
  // tweak doesn't wipe the sculpted shape. The user can hit Regenerate (R)
  // to explicitly reset. A single toast per 4s run reminds them what's up.
  if (_sculptIsLive && !_sculptActive) {
    const now = performance.now();
    if (now - _sculptBlockedToastAt > 4000) {
      _sculptBlockedToastAt = now;
      toast('Sculpt active — press R to reset the shape first', 'info', 2200);
    }
    // Still commit history so undo past the blocked edit works sensibly.
    commitHistorySoon();
    return;
  }
  const now = performance.now();
  // Lower rate while scrubbing (rebuild is expensive); snappier at rest.
  const minGap = isScrubbing ? 90 : 30;
  const since = now - _lastGenStart;
  clearTimeout(genTimer);
  // Swallow generateTree failures here so an unhandled rejection doesn't
  // leave _genPending wedged or spam the console — the previous tree stays
  // on screen and the next param change can try again.
  const runGen = () => {
    _genPending = false;
    const curOpts = _pendingGenOpts || {};
    _pendingGenOpts = null;
    try {
      const p = generateTree(curOpts);
      if (p && typeof p.catch === 'function') p.catch((err) => {
        console.warn('[generateTree] rebuild failed; keeping previous tree:', err);
      });
    } catch (err) {
      console.warn('[generateTree] rebuild failed; keeping previous tree:', err);
    }
  };
  if (since >= minGap && !_genPending) {
    _lastGenStart = now;
    _genPending = true;
    // Defer one frame so the current user input / render lands first.
    requestAnimationFrame(runGen);
  } else {
    const wait = Math.max(16, minGap - since);
    genTimer = setTimeout(() => {
      _lastGenStart = performance.now();
      _genPending = true;
      requestAnimationFrame(runGen);
    }, wait);
  }
  commitHistorySoon();
}

// Fast-path regen for foliage-only param changes (Leaves group). Reuses the
// cached tree skeleton so we skip buildTree + chains + tubes + mergeGeometries
// and only rewrite the leaf/stem/cone instances. ~5–10× faster during drag.
let _foliageTimer = null;
let _foliagePending = false;
let _lastFoliageStart = 0;
function debouncedRebuildFoliage() {
  const now = performance.now();
  const minGap = isScrubbing ? 45 : 16;
  const since = now - _lastFoliageStart;
  clearTimeout(_foliageTimer);
  if (since >= minGap && !_foliagePending) {
    _lastFoliageStart = now;
    _foliagePending = true;
    requestAnimationFrame(() => { _foliagePending = false; rebuildLeavesOnly(); });
  } else {
    const wait = Math.max(12, minGap - since);
    _foliageTimer = setTimeout(() => {
      _lastFoliageStart = performance.now();
      _foliagePending = true;
      requestAnimationFrame(() => { _foliagePending = false; rebuildLeavesOnly(); });
    }, wait);
  }
  commitHistorySoon();
}

// --- Parameter locks (for Shuffle) ---------------------------------------
// Set of schema keys that the user has locked. Shuffle skips these so the
// rest of the tree randomizes while locked sliders stay put.
const _paramLocks = new Set();

function _randInRange(p) {
  if (!p || p.type === 'select' || typeof p.min !== 'number' || typeof p.max !== 'number') return null;
  const steps = Math.max(1, Math.round((p.max - p.min) / p.step));
  const s = Math.floor(Math.random() * (steps + 1));
  return +(p.min + s * p.step).toFixed(6);
}

// Growth timelapse — steps P.growthPhase from 0.12 → 1 over ~4s, regen at
// every ~10% tick so the tree visibly grows. Triggered via Spotlight command.
let _growthAnimTimer = null;
function animateGrowth(durationMs = 4000) {
  if (_growthAnimTimer) { clearInterval(_growthAnimTimer); _growthAnimTimer = null; endBusy(); }
  beginBusy('Growing…');
  const start = performance.now();
  const steps = 10;
  let lastStep = -1;
  _growthAnimTimer = setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / durationMs);
    const step = Math.floor(t * steps);
    if (step !== lastStep) {
      lastStep = step;
      P.growthPhase = 0.12 + (t * 0.88);
      syncUI();
      generateTree();
    }
    if (t >= 1) {
      clearInterval(_growthAnimTimer);
      _growthAnimTimer = null;
      P.growthPhase = 1;
      syncUI();
      generateTree();
      commitHistorySoon();
      endBusy();
    }
  }, Math.max(30, durationMs / steps / 2));
  toast('Animating growth…', 'info', 1200);
}

// Auto-LOD: hide/show LOD0 + preview meshes based on camera distance to
// the tree center. Thresholds come from P.lodDist1/2/3.
const _lodAutoTarget = new THREE.Vector3();
function _updateAutoLOD() {
  if (!treeMesh || !treeMesh.geometry || !treeMesh.geometry.boundingBox) return;
  treeMesh.geometry.boundingBox.getCenter(_lodAutoTarget);
  _lodAutoTarget.add(treeMesh.position);
  const d = camera.position.distanceTo(_lodAutoTarget);
  const d1 = P.lodDist1 ?? 20;
  const d2 = P.lodDist2 ?? 60;
  const d3 = P.lodDist3 ?? 140;
  // Pick the slot whose threshold is closest without exceeding
  let chosen = 0; // 0 = LOD0, 1..3 = lodSlots indices
  if (d >= d1) chosen = 1;
  if (d >= d2) chosen = 2;
  if (d >= d3) chosen = 3;
  // Hide all first
  treeMesh.visible = chosen === 0 && !splineViewOn;
  for (let i = 0; i < lodSlots.length; i++) {
    const m = _lodPreviewMeshes.get(lodSlots[i].id);
    if (m) m.visible = (chosen - 1) === i;
  }
}

function shuffleParams() {
  for (const g of PARAM_SCHEMA)   for (const p of g.params) if (!_paramLocks.has(p.key)) { const v = _randInRange(p); if (v !== null) P[p.key] = v; }
  for (const g of CONIFER_SCHEMA) for (const p of g.params) if (!_paramLocks.has(p.key)) { const v = _randInRange(p); if (v !== null) P[p.key] = v; }
  for (const g of BUSH_SCHEMA)    for (const p of g.params) if (!_paramLocks.has(p.key)) { const v = _randInRange(p); if (v !== null) P[p.key] = v; }
  for (const p of WIND_SCHEMA)    if (!_paramLocks.has(p.key)) { const v = _randInRange(p); if (v !== null) P.wind[p.key] = v; }
  for (const p of PHYSICS_SCHEMA) if (!_paramLocks.has(p.key)) { const v = _randInRange(p); if (v !== null) P.physics[p.key] = v; }
  for (const L of P.levels) {
    for (const p of LEVEL_SCHEMA) if (!_paramLocks.has(p.key)) { const v = _randInRange(p); if (v !== null) L[p.key] = v; }
  }
  P.seed = Math.floor(Math.random() * 999999);
  syncUI();
  renderLevels();
  applyLeafMaterial();
  applyBarkMaterial();
  generateTree();
  commitHistorySoon();
}

// --- Undo / Redo ---------------------------------------------------------
const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 50;
let lastStateJSON = null;
let historyTimer = null;
let isRestoring = false;

function snapshotState() {
  return JSON.stringify({
    P,
    taper: taperSpline && taperSpline.points,
    length: lengthSpline && lengthSpline.points,
    profile: profileEditor && profileEditor.points,
  });
}

function commitHistorySoon() {
  if (isRestoring) return;
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = null;
    const cur = snapshotState();
    if (cur === lastStateJSON) return;
    if (lastStateJSON !== null) {
      undoStack.push(lastStateJSON);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
    }
    lastStateJSON = cur;
  }, 280);
}

function restoreStateJSON(json) {
  isRestoring = true;
  try {
    const s = JSON.parse(json);
    for (const k in s.P) {
      if (k === 'levels' || k === 'wind') continue;
      if (k in P) P[k] = s.P[k];
    }
    if (Array.isArray(s.P.levels)) P.levels = s.P.levels.map((x) => ({ ...x }));
    if (s.P.wind) Object.assign(P.wind, s.P.wind);
    if (Array.isArray(s.taper) && taperSpline) taperSpline.setPoints(s.taper);
    if (Array.isArray(s.length) && lengthSpline) lengthSpline.setPoints(s.length);
    if (Array.isArray(s.profile) && profileEditor) profileEditor.setPoints(s.profile);
    syncUI();
    renderLevels();
    applyLeafMaterial();
    applyBarkMaterial();
    generateTree();
    lastStateJSON = json;
  } finally {
    isRestoring = false;
  }
}

function undo() {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
    const cur = snapshotState();
    if (cur !== lastStateJSON && lastStateJSON !== null) {
      undoStack.push(lastStateJSON);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      lastStateJSON = cur;
    }
  }
  if (undoStack.length === 0) return;
  redoStack.push(snapshotState());
  const prev = undoStack.pop();
  restoreStateJSON(prev);
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshotState());
  const next = redoStack.pop();
  restoreStateJSON(next);
}

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const target = e.target;
  const editable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (editable && target.type !== 'checkbox' && target.type !== 'range') return;
  const k = e.key.toLowerCase();
  const modLabel = (navigator.platform.includes('Mac') ? '⌘' : 'Ctrl');
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (_sculptActive) { sculptUndo(); showShortcutPill(`${modLabel}+Z`, 'Sculpt undo'); }
    else { undo(); showShortcutPill(`${modLabel}+Z`, 'Undo'); }
  } else if ((k === 'z' && e.shiftKey) || k === 'y') {
    e.preventDefault();
    // Redo inside sculpt mode isn't meaningful (undo stack is linear per-release).
    if (_sculptActive) return;
    redo();
    showShortcutPill(k === 'y' ? `${modLabel}+Y` : `${modLabel}+Shift+Z`, 'Redo');
  }
});

// Preview mode — active while any scrubber is being dragged. Drops shadow-map
// updates and (optionally) lowers tube detail so regeneration feels instant.
// On drag end, flip back and do one more full-quality rebuild at the highest
// tier the drag touched — tubes-only drags keep the tubes-only fast path on
// release, topology drags upgrade to full.
let isScrubbing = false;
let scrubCount = 0;
// Highest rebuild tier requested during the current scrub gesture. Reset on
// beginScrub. null = nothing requested (safe default = full); 'tubes' = only
// tubes-only calls seen; 'full' = at least one full-tier call. Never
// downgrades from 'full' back to 'tubes'.
let _scrubHighestMode = null;
// Active scrubbers registry so a mid-drag DOM wipe (e.g. renderLevels on
// preset load) can force-release captured pointers instead of leaking
// scrubCount and pinning isScrubbing=true forever.
const _activeScrubbers = new Set();
let _scrubRestorePixelRatio = null;
function beginScrub() {
  scrubCount++;
  if (scrubCount === 1) {
    isScrubbing = true;
    _scrubHighestMode = null;
    renderer.shadowMap.autoUpdate = false;
    // High-DPI displays do 4× fragment work at pixelRatio=2. Drop to 1 during
    // scrub so the per-frame upload + shading cost doesn't compound with the
    // rebuild cost. Restored on endScrub.
    const pr = renderer.getPixelRatio();
    if (pr > 1) {
      _scrubRestorePixelRatio = pr;
      renderer.setPixelRatio(1);
    }
  }
}
function endScrub() {
  scrubCount = Math.max(0, scrubCount - 1);
  if (scrubCount === 0) {
    isScrubbing = false;
    renderer.shadowMap.autoUpdate = true;
    renderer.shadowMap.needsUpdate = true;
    if (_scrubRestorePixelRatio !== null) {
      renderer.setPixelRatio(_scrubRestorePixelRatio);
      _scrubRestorePixelRatio = null;
    }
    // One final-quality rebuild. Use the highest tier the drag touched —
    // pure tubes-only drags (radius curve / profile / bark displace /
    // buttress / react) stay on the fast path, anything topology-affecting
    // upgrades to full. Null = no debouncedGenerate calls during the
    // gesture (e.g. live-only material sliders like bark colour or leaf
    // tint) — skip the rebuild entirely; otherwise dragging a bark slider
    // re-runs leaf instancing on release and they appear to "respawn".
    const mode = _scrubHighestMode;
    _scrubHighestMode = null;
    if (mode !== null) {
      const finalOpts = mode === 'tubes' ? { tubesOnly: true } : {};
      debouncedGenerate(finalOpts);
    }
  }
}
// Force-terminate any in-flight drag. Call before nuking scrubber DOM so we
// don't leak captured pointers or the shadow-autoUpdate=false state.
function _forceEndAllScrubs() {
  if (_activeScrubbers.size === 0) return;
  for (const endFn of _activeScrubbers) {
    try { endFn(); } catch {}
  }
  _activeScrubbers.clear();
  // Belt + suspenders — if any endScrub call paths failed to decrement.
  if (scrubCount > 0) {
    scrubCount = 0;
    isScrubbing = false;
    renderer.shadowMap.autoUpdate = true;
    renderer.shadowMap.needsUpdate = true;
  }
}
function fmt(v, step) {
  if (Number.isInteger(step)) return String(Math.round(v));
  const digits = step < 0.01 ? 3 : step < 0.1 ? 2 : 1;
  return v.toFixed(digits);
}
function createSliderRow(p, getter, setter, onAfter, opts) {
  if (p.type === 'select') return createSelectRow(p, getter, setter, onAfter);
  if (p.type === 'thumbnails') return createThumbnailRow(p, getter, setter, onAfter);
  opts = opts || {};
  // noRegen: skip beginScrub/endScrub (which queues a full tree rebuild on
  // drag end) — for sliders that don't affect the tree (brush popover etc.)
  const beginS = opts.noRegen ? () => {} : beginScrub;
  const endS   = opts.noRegen ? () => {} : endScrub;
  // regenPath: true if this slider would trigger a full tree rebuild on
  // change. Used to visually lock shape-affecting sliders post-sculpt.
  const regenPath = !onAfter && !opts.noRegen;

  const row = document.createElement('div');
  row.className = 'scrubber-row';

  const scrubber = document.createElement('div');
  scrubber.className = 'scrubber';
  if (regenPath) scrubber.dataset.regen = 'true';
  scrubber.dataset.pkey = p.key;
  // Tooltip on the whole scrubber so hovering anywhere on the row triggers
  // it after the global 360 ms delay (handler at main.js:~15201).
  const desc = (typeof PARAM_DESCRIPTIONS !== 'undefined' && PARAM_DESCRIPTIONS[p.key]) || '';
  if (desc) scrubber.dataset.tooltip = desc;

  // Lock state is toggled via the right-click context menu (see showScrubberMenu).
  // Row tracks current lock state via dataset so CSS can surface a subtle badge.
  row.dataset.pkey = p.key;
  if (_paramLocks.has(p.key)) row.classList.add('locked');
  const track = document.createElement('div');
  track.className = 'scrubber-track';
  // Photoshop-style colour swatch behind the fill — shows the slider's
  // effect at a glance. `hue` is a static rainbow; `saturation`,
  // `brightness`, and `tint` reference `--swatch-hue` (deg) on the scrubber
  // so they update live as the matching hue slider changes. Bark/moss
  // group their hues — see _updateBarkSwatchHues, called at the end of
  // applyBarkMaterial.
  if (p.swatch === 'hue') {
    track.style.backgroundImage =
      'linear-gradient(to right,' +
      ' hsl(0,75%,50%) 0%,' +
      ' hsl(60,75%,50%) 16.66%,' +
      ' hsl(120,75%,50%) 33.33%,' +
      ' hsl(180,75%,50%) 50%,' +
      ' hsl(240,75%,50%) 66.66%,' +
      ' hsl(300,75%,50%) 83.33%,' +
      ' hsl(360,75%,50%) 100%)';
    scrubber.classList.add('swatch-hue');
  } else if (p.swatch === 'saturation') {
    track.style.backgroundImage =
      'linear-gradient(to right,' +
      ' hsl(var(--swatch-hue, 0), 0%, 50%),' +
      ' hsl(var(--swatch-hue, 0), 80%, 50%))';
    scrubber.classList.add('swatch-color');
  } else if (p.swatch === 'brightness' || p.swatch === 'lum') {
    track.style.backgroundImage =
      'linear-gradient(to right,' +
      ' #000,' +
      ' hsl(var(--swatch-hue, 0), 70%, 50%) 50%,' +
      ' #fff)';
    scrubber.classList.add('swatch-color');
  } else if (p.swatch === 'tint') {
    track.style.backgroundImage =
      'linear-gradient(to right,' +
      ' hsl(var(--swatch-hue, 0), 0%, 90%),' +
      ' hsl(var(--swatch-hue, 0), 75%, 55%))';
    scrubber.classList.add('swatch-color');
  }
  // Seed --swatch-hue at creation time so the gradient is correct on first
  // paint (before applyBarkMaterial has run / queried these scrubbers). On
  // subsequent live edits, _updateBarkSwatchHues keeps it in sync. Wrap in
  // try/catch in case P isn't declared yet (TDZ during initial paint).
  if (p.swatch === 'saturation' || p.swatch === 'brightness' || p.swatch === 'lum' || p.swatch === 'tint') {
    let huePct = 0;
    try {
      if (p.key.startsWith('bark')) huePct = (P.barkHue ?? 0.08) * 360;
      else if (p.key.startsWith('moss')) huePct = (P.mossHue ?? 0.3) * 360;
    } catch { /* P not in scope yet — fall back to 0 (red) */ }
    scrubber.style.setProperty('--swatch-hue', huePct.toFixed(1));
  }
  const fillEl = document.createElement('div');
  fillEl.className = 'scrubber-fill';
  track.appendChild(fillEl);
  scrubber.appendChild(track);

  const overlay = document.createElement('div');
  overlay.className = 'scrubber-overlay';
  const name = document.createElement('span');
  name.className = 'name'; name.textContent = p.label;
  const val = document.createElement('span');
  val.className = 'val'; val.textContent = fmt(getter(), p.step);
  overlay.append(name, val);
  scrubber.appendChild(overlay);

  // Mutable so _setRange can adjust (e.g. species switch retunes leafSize).
  let totalSteps = Math.max(1, Math.round((p.max - p.min) / p.step));
  let defaultStep = (p.default - p.min) / p.step;
  const THRESHOLD = 6;

  // Continuous (float) step — gives a smooth fill bar and fine emitted values
  // while the display text still rounds to the schema's step precision.
  let step = (getter() - p.min) / p.step;
  let dragging = false, pending = false;
  let dragStartX = 0, pendingPid = 0;

  // Performance caches — updated lazily so pointermove stays allocation-free:
  //   _lastText    : skip the textContent write when the formatted value
  //                  didn't change (happens a lot when multiple pointer
  //                  events map to the same displayed step).
  //   _lastMod     : skip classList.toggle + scrub-change dispatch unless
  //                  the modified state actually flipped.
  //   _cachedRect  : getBoundingClientRect() is a layout-forcing read; we
  //                  take it once at drag-start and reuse it until release
  //                  (pointer capture pins the scrubber to the cursor, so
  //                  the rect doesn't change during a drag).
  let _lastText = null;
  let _lastMod = null;
  let _cachedRect = null;

  function isModified() {
    return Math.abs(step - defaultStep) > 0.001;
  }

  // Returns the formatted text so the pointermove path can forward it to
  // the floating tooltip without calling fmt() twice per frame.
  const isSwatch = !!p.swatch;
  function applyStep(s, emit = true) {
    step = Math.max(0, Math.min(totalSteps, s));
    // Visually snap the fill bar to integer positions for integer-step
    // sliders (Trunk count, level Branch count, kinkSteps, etc.). Without
    // this the bar slides smoothly between 1 and 2 even though the value
    // can only be 1 or 2 — feels mushy.
    if (Number.isInteger(p.step)) step = Math.round(step);
    const pct = (step / totalSteps) * 100;
    fillEl.style.width = `${pct}%`;
    // Swatch sliders draw a pseudo-element thumb at --marker-x — see CSS
    // for `.swatch-hue::before` / `.swatch-color::before`.
    if (isSwatch) scrubber.style.setProperty('--marker-x', `${pct}%`);
    const rawV = p.min + step * p.step;
    // For integer-step sliders, snap the emitted value to match the
    // displayed integer. Otherwise the display rounds (showing '2') while
    // setter sends 1.9 — and consumers using `| 0` then truncate back to 1,
    // so the slider's 'shows 2 but actually 1' bug appears.
    const v = Number.isInteger(p.step) ? Math.round(rawV) : rawV;
    const text = fmt(v, p.step);
    if (text !== _lastText) { val.textContent = text; _lastText = text; }
    const mod = isModified();
    const modFlipped = (mod !== _lastMod);
    if (modFlipped) {
      scrubber.classList.toggle('modified', mod);
      _lastMod = mod;
    }
    if (emit) {
      setter(v);
      if (opts.noRegen) { if (onAfter) onAfter(v); }
      else if (onAfter) { onAfter(v); commitHistorySoon(); }
      else debouncedGenerate();
      // Dirty-dot listener only cares about the modified-state boundary,
      // so dispatching only on the flip saves a subtree query per frame.
      if (modFlipped) scrubber.dispatchEvent(new CustomEvent('scrub-change', { bubbles: true }));
    }
    return text;
  }

  // Map cursor X to step using a cached rect when dragging, fresh rect
  // otherwise (click-to-set, keyboard paths).
  function pxToStep(clientX) {
    const rect = _cachedRect || scrubber.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return pct * totalSteps;
  }

  applyStep(step, false);

  // rAF-coalesced drag: coalesce multiple pointermove events into a single
  // DOM update per frame. High-poll-rate mice (1kHz) + 60/120Hz displays
  // means pointer events can otherwise trigger 10-20× more DOM writes than
  // the display can show — all that work was wasted.
  let _rafId = 0;
  let _lastX = 0;
  const _flushDrag = () => {
    _rafId = 0;
    if (!dragging) return;
    const rect = _cachedRect;
    const pct = Math.max(0, Math.min(1, (_lastX - rect.left) / rect.width));
    const text = applyStep(pct * totalSteps);
    showScrubTip(_lastX, rect.top, text);
  };

  scrubber.addEventListener('pointerdown', (e) => {
    // Ctrl/⌘ + middle click = reset to schema default (system-wide on every
    // scrubber). Plain middle-click is left alone so it doesn't fire on
    // accidental clicks while panning the sidebar.
    if (e.button === 1 && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();  // suppress middle-click autoscroll
      const target = Math.round((p.default - p.min) / p.step);
      applyStep(target, true);
      return;
    }
    if (e.button > 0) return;
    dragStartX = e.clientX;
    pending = true;
    pendingPid = e.pointerId;
  });
  // Suppress the browser's middle-click autoscroll cursor — Chrome shows
  // it on mousedown even if pointerdown preventDefault'd, so we belt-and-
  // suspenders on the mousedown event too.
  scrubber.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  // auxclick fires after a successful middle-click; cancel it so any
  // ancestor handlers (e.g. row-level tooltip toggles) don't interpret
  // the reset as a separate click.
  scrubber.addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
  });

  scrubber.addEventListener('pointermove', (e) => {
    if (pending) {
      if (Math.abs(e.clientX - dragStartX) < THRESHOLD) return;
      pending = false;
      dragging = true;
      try { scrubber.setPointerCapture(pendingPid); } catch {}
      scrubber.classList.add('dragging');
      beginS();
      _cachedRect = scrubber.getBoundingClientRect();
      _activeScrubbers.add(forceEndDrag);
    }
    if (!dragging) return;
    _lastX = e.clientX;
    if (!_rafId) _rafId = requestAnimationFrame(_flushDrag);
  });

  scrubber.addEventListener('touchmove', (e) => {
    if (dragging) e.preventDefault();
  }, { passive: false });

  // Safety net: if the scrubber DOM is torn down mid-drag (preset load,
  // level rebuild), _forceEndAllScrubs() invokes this so scrubCount can't leak.
  const forceEndDrag = () => {
    if (!dragging) return;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
    _cachedRect = null;
    try { scrubber.releasePointerCapture?.(pendingPid); } catch {}
    pending = false;
    dragging = false;
    hideScrubTip();
    scrubber.classList.remove('dragging');
    endS();
  };
  const endDrag = (e) => {
    if (!dragging && pending && e && typeof e.clientX === 'number') {
      applyStep(pxToStep(e.clientX));
    }
    // Flush any pending rAF so the final value matches the release point
    // exactly (without this, releases between frames could drop the last
    // few pixels of drag input).
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; _flushDrag(); }
    _cachedRect = null;
    pending = false;
    hideScrubTip();
    if (!dragging) return;
    dragging = false;
    scrubber.classList.remove('dragging');
    endS();
    _activeScrubbers.delete(forceEndDrag);
  };
  scrubber.addEventListener('pointerup', endDrag);
  scrubber.addEventListener('pointercancel', endDrag);
  scrubber.addEventListener('lostpointercapture', endDrag);

  // Double-click = reset to schema default
  scrubber.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const target = Math.round((p.default - p.min) / p.step);
    applyStep(target, true);
  });

  // Right-click = context menu (Reset, Copy value, Paste, min/max)
  scrubber.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showScrubberMenu(e.clientX, e.clientY, {
      min: p.min, max: p.max,
      pkey: p.key,
      getValue: () => p.min + step * p.step,
      setValue: (v) => applyStep(Math.round((v - p.min) / p.step), true),
      reset:    () => applyStep(Math.round((p.default - p.min) / p.step), true),
    });
  });

  // Expose sync method for preset load / external updates (continuous)
  scrubber._applyValue = (v) => {
    applyStep((v - p.min) / p.step, false);
  };
  scrubber._resetToDefault = () => { applyStep(defaultStep, true); };
  scrubber._isModified = isModified;
  // Allow callers (e.g. applySpecies) to retune the slider range so the
  // current value sits in a comfortable middle of the track instead of
  // clipped against the left edge with millimeter precision.
  scrubber._setRange = (newMin, newMax) => {
    if (newMax <= newMin) return;
    p.min = newMin; p.max = newMax;
    totalSteps = Math.max(1, Math.round((p.max - p.min) / p.step));
    defaultStep = (p.default - p.min) / p.step;
    const currentVal = p.min + step * p.step; // remembered from previous range
    applyStep((Math.max(p.min, Math.min(p.max, currentVal)) - p.min) / p.step, false);
  };


  row.appendChild(scrubber);
  return row;
}

function createSelectRow(p, getter, setter, onAfter) {
  const row = document.createElement('div');
  row.className = 'row';
  if (!onAfter) row.dataset.regen = 'true';
  row.style.gridTemplateColumns = '110px 1fr';
  const desc = (typeof PARAM_DESCRIPTIONS !== 'undefined' && PARAM_DESCRIPTIONS[p.key]) || '';
  if (desc) row.dataset.tooltip = desc;
  const name = document.createElement('span');
  name.className = 'name'; name.textContent = p.label;
  const select = document.createElement('select');
  select.className = 'select';
  for (const opt of p.options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    select.appendChild(o);
  }
  select.value = getter() ?? p.default;
  select.addEventListener('change', (e) => {
    setter(e.target.value);
    if (onAfter) { onAfter(e.target.value); commitHistorySoon(); } else debouncedGenerate();
  });
  // Middle-click resets to schema default (system-wide convention).
  row.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  row.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (select.value === p.default) return;
    select.value = p.default;
    setter(p.default);
    if (onAfter) { onAfter(p.default); commitHistorySoon(); } else debouncedGenerate();
  });
  row.append(name, select);
  return row;
}

// Thumbnail-grid picker. Used by `barkStyle` — renders each preset as a
// 48² procedurally-generated bark texture with a label below. Cheaper than
// a Photoshop colour picker but does the same job: communicate the
// destination of the click before the click. Active option gets an accent
// ring + a subtle scale; hover lifts; press scales down for feedback.
function createThumbnailRow(p, getter, setter, onAfter) {
  const wrap = document.createElement('div');
  wrap.className = 'thumbnail-row';
  const grid = document.createElement('div');
  grid.className = 'thumbnail-grid';
  const items = new Map();
  let active = getter() ?? p.default;

  const setActive = (v) => {
    active = v;
    for (const [k, btn] of items) btn.classList.toggle('active', k === v);
  };

  for (const opt of p.options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumbnail';
    btn.dataset.value = opt;
    if (opt === active) btn.classList.add('active');
    // Render the thumbnail synchronously — at 48² it costs <2ms per
    // option and the cache hits forever after. Factory chosen by
    // p.thumbKind ('barkPreset' for full bark swatches, 'noise' for the
    // per-layer pattern picker greyscale).
    const factory = THUMBNAIL_FACTORIES[p.thumbKind] || THUMBNAIL_FACTORIES.barkPreset;
    let canvas = null;
    try { canvas = factory(opt, 48); } catch {}
    if (canvas) {
      canvas.classList.add('thumbnail-canvas');
      btn.appendChild(canvas);
    }
    const label = document.createElement('span');
    label.className = 'thumbnail-label';
    label.textContent = opt;
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      if (active === opt) return;  // no-op clicks don't push history
      setActive(opt);
      setter(opt);
      if (onAfter) { onAfter(opt); commitHistorySoon(); } else debouncedGenerate();
    });
    items.set(opt, btn);
    grid.appendChild(btn);
  }
  wrap.appendChild(grid);
  // Expose a setter so syncUI / preset-load paths can update the active
  // state when something else (e.g. species apply) changes the value.
  wrap.dataset.pkey = p.key;
  wrap._applyValue = setActive;
  // Middle-click anywhere in the row resets to the schema default —
  // matches the system-wide scrubber convention. Suppress autoscroll on
  // mousedown; auxclick handles the actual reset (so a stray drag
  // doesn't double-fire it).
  wrap.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  wrap.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (active === p.default) return;
    setActive(p.default);
    setter(p.default);
    if (onAfter) { onAfter(p.default); commitHistorySoon(); } else debouncedGenerate();
  });
  return wrap;
}

function makeSegmented(options, activeValue, onChange) {
  const seg = document.createElement('div');
  seg.className = 'segmented';
  const syncStyles = (val) => {
    for (const btn of seg.querySelectorAll('button')) {
      const active = btn.dataset.val === val;
      btn.style.background = active ? 'var(--w-12)' : 'transparent';
      btn.style.color = active ? '#fff' : 'var(--text-dim)';
      btn.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.2)' : 'none';
    }
  };
  for (const opt of options) {
    const b = document.createElement('button');
    b.textContent = opt.label;
    b.dataset.val = opt.value;
    b.className = 'segmented-btn';
    b.addEventListener('click', () => { onChange(opt.value); syncStyles(opt.value); });
    seg.appendChild(b);
  }
  syncStyles(activeValue);
  return seg;
}

// Theme + view-mode toggles live in the left-side floating toolbar (not duplicated here).
let meshViewOn = false;
function applyMeshView(on) {
  meshViewOn = on;
  if (on && !treeWireMesh) buildWireMesh();
  if (treeWireMesh) treeWireMesh.visible = on && !splineViewOn;
  // Wireframe overlay on every LOD preview follows the global toggle so
  // "mesh inspection" means the same thing on LOD0 and its derivatives.
  for (const w of _lodWireMeshes.values()) w.visible = on;
  _sculptSidebarUpdate?.();
}

let splineViewOn = false;
function applySplineView(on) {
  splineViewOn = on;
  if (on && !treeSplineMesh) buildSplineMesh();
  if (treeMesh) treeMesh.visible = !on;
  if (treeWireMesh) treeWireMesh.visible = meshViewOn && !on;
  if (treeSplineMesh) treeSplineMesh.visible = on;
  if (treeSplineDots) treeSplineDots.visible = on;
  _sculptSidebarUpdate?.();
}

let leavesOn = true;
function applyLeavesVisible(on) {
  leavesOn = on;
  if (leafInstA) leafInstA.visible = on;
  if (leafInstB) leafInstB.visible = on;
  if (stemInst) stemInst.visible = on;
  _sculptSidebarUpdate?.();
}

function applyTreeRotation() {
  const rad = ((P.rotation ?? 0) * Math.PI) / 180;
  // stemInst + coneInst were missing → leaf stems (broadleaf) and conifer cones
  // stayed in place while the rest of the tree rotated.
  for (const obj of [treeMesh, treeWireMesh, treeSplineMesh, leafInstA, leafInstB, stemInst, coneInst]) {
    if (obj) obj.rotation.y = rad;
  }
}

function buildWireMesh() {
  if (!treeMesh || treeWireMesh) return;
  // Share the treeMesh geometry by reference so every live vertex update
  // (grab / wind / skeleton sim) shows up on the wireframe too.
  treeWireMesh = new THREE.Mesh(treeMesh.geometry, treeWireMat);
  treeWireMesh.userData._sharedGeom = true;
  treeWireMesh.renderOrder = 1;
  treeWireMesh.rotation.y = ((P.rotation ?? 0) * Math.PI) / 180;
  treeWireMesh.position.copy(treeMesh.position);
  treeWireMesh.quaternion.copy(treeMesh.quaternion);
  treeWireMesh.scale.copy(treeMesh.scale);
  scene.add(treeWireMesh);
}

// Spline view — straight-line segments between consecutive skeleton nodes.
// We skip the Catmull-Rom sub-sampling so each line vertex maps to exactly
// one skeleton node, which means updateSplineMesh() can write current sim
// positions directly instead of re-solving the curve every frame.
let _splineNodeIdx = null; // Int32Array per line vertex → skeleton index
let _splineDotIdx  = null; // Int32Array per dot vertex → skeleton index
let treeSplineDots = null; // THREE.Points sibling showing a dot per joint
function buildSplineMesh() {
  if (!_chainsRef || treeSplineMesh) return;
  let totalSegs = 0;
  for (const chain of _chainsRef) if (chain.length >= 2) totalSegs += chain.length - 1;
  const positions = new Float32Array(totalSegs * 2 * 3);
  _splineNodeIdx = new Int32Array(totalSegs * 2);
  let v = 0;
  for (const chain of _chainsRef) {
    if (chain.length < 2) continue;
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i], b = chain[i + 1];
      positions[v * 3    ] = a.pos.x;
      positions[v * 3 + 1] = a.pos.y;
      positions[v * 3 + 2] = a.pos.z;
      _splineNodeIdx[v] = a.idx;
      v++;
      positions[v * 3    ] = b.pos.x;
      positions[v * 3 + 1] = b.pos.y;
      positions[v * 3 + 2] = b.pos.z;
      _splineNodeIdx[v] = b.idx;
      v++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  treeSplineMesh = new THREE.LineSegments(geo, treeSplineMat);
  treeSplineMesh.renderOrder = 2;
  treeSplineMesh.rotation.y = ((P.rotation ?? 0) * Math.PI) / 180;
  scene.add(treeSplineMesh);

  // Dots — one small sphere per skeleton node (joints + branching points).
  // InstancedMesh so all dots render in one draw call.
  const nSkel = skeleton.length;
  treeSplineDots = new THREE.InstancedMesh(treeSplineDotGeo, treeSplineDotMat, nSkel);
  treeSplineDots.frustumCulled = false;
  treeSplineDots.renderOrder = 3;
  treeSplineDots.rotation.y = treeSplineMesh.rotation.y;
  const _dotDummy = new THREE.Object3D();
  for (let i = 0; i < nSkel; i++) {
    const s = skeleton[i];
    _dotDummy.position.set(s.pos.x, s.pos.y, s.pos.z);
    _dotDummy.rotation.set(0, 0, 0);
    _dotDummy.scale.setScalar(1);
    _dotDummy.updateMatrix();
    treeSplineDots.setMatrixAt(i, _dotDummy.matrix);
  }
  treeSplineDots.instanceMatrix.needsUpdate = true;
  scene.add(treeSplineDots);
}

const _splineDotDummy = new THREE.Object3D();

// Push current sim positions into the spline line + dot meshes so they
// track drags + wind alongside the bark.
function updateSplineMesh() {
  if (!skeleton.length) return;
  const N = skeleton.length;
  if (treeSplineMesh && _splineNodeIdx) {
    const posAttr = treeSplineMesh.geometry.attributes.position;
    const arr = posAttr.array;
    for (let v = 0; v < _splineNodeIdx.length; v++) {
      const idx = _splineNodeIdx[v];
      if (idx < 0 || idx >= N) continue;
      const s = skeleton[idx];
      arr[v * 3    ] = s.pos.x;
      arr[v * 3 + 1] = s.pos.y;
      arr[v * 3 + 2] = s.pos.z;
    }
    posAttr.needsUpdate = true;
  }
  if (treeSplineDots) {
    const count = Math.min(treeSplineDots.count || 0, N);
    const hi = _hoveredNodeIdx, gi = grabbedNodeIdx;
    for (let i = 0; i < count; i++) {
      const s = skeleton[i];
      const scl = (i === hi || i === gi) ? 3.2 : 1; // pop the hovered/grabbed dot
      _splineDotDummy.position.set(s.pos.x, s.pos.y, s.pos.z);
      _splineDotDummy.scale.setScalar(scl);
      _splineDotDummy.updateMatrix();
      treeSplineDots.setMatrixAt(i, _splineDotDummy.matrix);
    }
    treeSplineDots.instanceMatrix.needsUpdate = true;
  }
}

// --- Lucide icons --------------------------------------------------------
const ICONS = {
  'tree-deciduous': '<path d="M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z"/><path d="M12 19v3"/>',
  'sparkles': '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M5 16l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/><path d="M19 14l.8 1.8L21.6 17l-1.8.8L19 19.6l-.8-1.8L16.4 17l1.8-.8z"/>',
  'tree-pine': '<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"/><path d="M12 22v-3"/>',
  'leaf': '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.8 2c1.2 1.5 2 3 2 5s-.5 4.5-1.5 6"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  'sprout': '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
  'dices': '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 14h.01"/><path d="M10 14h.01"/><circle cx="16.5" cy="15.5" r=".5" fill="currentColor" stroke="none"/>',
  'disc': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  'layers': '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  'ruler': '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
  'palette': '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  'globe': '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  'scissors': '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  'wind': '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
  'list-tree': '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
  'git-branch': '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  'spline': '<circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M5 17A12 12 0 0 1 17 5"/>',
  'trending-up': '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'image': '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  'save': '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  'bookmark': '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  'upload': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'camera': '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  'package': '<path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" x2="12" y1="22.08" y2="12"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  'settings': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  'box': '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  'hand': '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'chevron-left':  '<polyline points="15 18 9 12 15 6"/>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
  'chevron-down':  '<path d="M6 9l6 6 6-6"/>',
  'target':         '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  // Sculpt toolbar
  'mouse-pointer-2':'<path d="m9 11 6 6"/><path d="M4 4l4.5 15.5L11 14l5.5-2.5L4 4z"/>',
  'circle-dot':     '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  'rotate-ccw':     '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
  'rotate-cw':      '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  // Crown / leaf-creator toolbars
  'crosshair':      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  'dice-5':         '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="16" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="12" cy="12" r="1"/>',
  'clipboard':      '<rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/>',
  'clipboard-copy': '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  'eye':            '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':        '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>',
  'move':           '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/>',
  'grid':           '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  'sliders':        '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  'command':        '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>',
  // Leaf-creator-only glyphs (Lucide-style composites).
  'rotate-axis':    '<path d="M12 3v4"/><path d="M21 12a9 9 0 1 1-9-9"/><path d="m15 5 3 2-3 2"/>',
  'wireframe':      '<path d="M3 5h18v14H3z"/><path d="M3 12h18M12 5v14M3 5l18 14M21 5 3 19"/>',
};

function iconSvg(name, size = 14) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}
function iconEl(name, size = 14) {
  const span = document.createElement('span');
  span.className = 'sec-icon';
  span.innerHTML = iconSvg(name, size);
  return span;
}
function setSummary(summary, iconName, text) {
  summary.textContent = '';
  summary.appendChild(iconEl(iconName));
  const label = document.createElement('span');
  label.className = 'sec-label';
  label.textContent = text;
  summary.appendChild(label);
}

const GROUP_ICONS = {
  'Trunk': 'tree-pine',
  'Bark': 'layers',
  'Radius': 'ruler',
  'Leaves': 'leaf',
  'Leaf Material': 'palette',
  'Global': 'globe',
  'Pruning': 'scissors',
  'Crown': 'tree-pine',
  'Twigs': 'git-branch',
  'Needles': 'leaf',
  'Cones': 'package',
  'Bush Shape': 'sprout',
  'Bush Foliage': 'leaf',
};

// Tree Type toggle (top of sidebar) — Broadleaf / Conifer / Bush
let speciesSelect = null; // captured below; the type toggle refreshes its options
let _rebuildSpeciesBand = null;
// Per-species icon for the horizontal button band
const SPECIES_ICONS = {
  'Custom':  'sparkles',
  'Oak':     'tree-deciduous',
  'Maple':   'tree-deciduous',
  'Willow':  'tree-deciduous',
  'Birch':   'tree-deciduous',
  'Elm':     'tree-deciduous',
  'Cherry':  'tree-deciduous',
  'Palm':    'sprout',
  'Pine':    'tree-pine',
  'Spruce':  'tree-pine',
  'Fir':     'tree-pine',
  'Cedar':   'tree-pine',
  'Cypress': 'tree-pine',
  'Boxwood':  'sprout',
  'Lavender': 'sprout',
  'Hydrangea':'sprout',
  'Rosemary': 'sprout',
  'Holly':    'sprout',
};
function speciesIconName(k) {
  if (SPECIES_ICONS[k]) return SPECIES_ICONS[k];
  const sp = SPECIES?.[k];
  if (sp && sp.type === 'conifer') return 'tree-pine';
  if (sp && sp.type === 'bush') return 'sprout';
  return 'tree-deciduous';
}
// Per-species blurb shown under the species name in the dropdown — Latin
// genus + a 2-3 word silhouette / habit hint.
const SPECIES_INFO = {
  Custom:         { sub: 'Tabula rasa',           meta: 'Hand-tuned baseline' },
  // Broadleaf
  Oak:            { sub: 'Quercus',                meta: 'Spreading deciduous • 8–15 m' },
  Maple:          { sub: 'Acer',                   meta: 'Dense palmate canopy • 10–15 m' },
  Cherry:         { sub: 'Prunus',                 meta: 'Spring blossoms • 6–10 m' },
  Willow:         { sub: 'Salix babylonica',       meta: 'Weeping whips • 8–12 m' },
  Birch:          { sub: 'Betula',                 meta: 'Slim white trunk • 12–18 m' },
  Acacia:         { sub: 'Acacia',                 meta: 'Flat savanna crown • 6–12 m' },
  Olive:          { sub: 'Olea europaea',          meta: 'Twisted Mediterranean • 6–10 m' },
  Baobab:         { sub: 'Adansonia',              meta: 'Bottle trunk, sparse top • 5–25 m' },
  Palm:           { sub: 'Arecaceae',              meta: 'Crown of fronds • 8–20 m' },
  Aspen:          { sub: 'Populus tremuloides',    meta: 'Narrow columnar • 9–18 m' },
  Tupelo:         { sub: 'Nyssa sylvatica',        meta: 'Dense conical crown • 10–15 m' },
  Sassafras:      { sub: 'Sassafras albidum',      meta: 'Forky zigzag, mitten leaves • 8–12 m' },
  Lime:           { sub: 'Tilia (Linden)',         meta: 'Heart leaves, conical • 14–20 m' },
  Beech:          { sub: 'Fagus',                  meta: 'Smooth gray dome • 12–18 m' },
  PlaneTree:      { sub: 'Platanus × hispanica',   meta: 'Mottled bark, palmate • 14–20 m' },
  Ginkgo:         { sub: 'Ginkgo biloba',          meta: 'Fan leaves, golden autumn • 10–15 m' },
  LombardyPoplar: { sub: "Populus nigra 'Italica'", meta: 'Narrow exclamation point • 16–25 m' },
  JapaneseMaple:  { sub: 'Acer palmatum',          meta: 'Lacy ornamental, layered • 3–6 m' },
  Eucalyptus:     { sub: 'Eucalyptus',             meta: 'Tall sparse, lance leaves • 17–30 m' },
  // Conifers
  Pine:           { sub: 'Pinus',                  meta: 'Long needles, irregular • 14–20 m' },
  Spruce:         { sub: 'Picea',                  meta: 'Symmetrical pyramid • 16–22 m' },
  Cedar:          { sub: 'Cedrus',                 meta: 'Open spreading habit • 14–18 m' },
  Cypress:        { sub: 'Cupressus',              meta: 'Narrow column • 12–16 m' },
  Fir:            { sub: 'Abies',                  meta: 'Pyramid-perfect • 18–24 m' },
  Larch:          { sub: 'Larix',                  meta: 'Deciduous conifer • 14–18 m' },
  ScotsPine:      { sub: 'Pinus sylvestris',       meta: 'Umbrella crown on top • 13–18 m' },
  Hemlock:        { sub: 'Tsuga canadensis',       meta: 'Drooping graceful tips • 14–20 m' },
  Juniper:        { sub: 'Juniperus',              meta: 'Dense rounded shrub • 2–4 m' },
  Redwood:        { sub: 'Sequoia sempervirens',   meta: 'Massive narrow tower • 20–30 m' },
  Araucaria:      { sub: 'Monkey Puzzle',          meta: 'Tiered horizontal limbs • 14–20 m' },
  // Bushes
  Boxwood:        { sub: 'Buxus sempervirens',     meta: 'Clipped formal hedge • 0.8–2 m' },
  Lavender:       { sub: 'Lavandula',              meta: 'Upright aromatic sprays • 0.4–0.8 m' },
  Hydrangea:      { sub: 'Hydrangea',              meta: 'Bold mophead flowers • 1–2 m' },
  Rosemary:       { sub: 'Rosmarinus officinalis', meta: 'Aromatic woody stems • 0.6–1.2 m' },
  Holly:          { sub: 'Ilex aquifolium',        meta: 'Spiny evergreen leaves • 1.5–2.5 m' },
};
function speciesInfo(k) {
  return SPECIES_INFO[k] || { sub: '', meta: '' };
}
// Sticky container at the top — stays empty here; initSidebarSearch appends
// the Filter input. The class name is what that init function queries for.
{
  const wrap = document.createElement('div');
  wrap.className = 'tree-type-sticky';
  sidebarBody.appendChild(wrap);
}

// Type + Species picker — one non-sticky card. Tree-type segmented toggle
// up top (Broadleaf / Conifer / Bush), then a horizontal species scroll
// band with ◀ / ▶ chevrons below.
{
  const wrap = document.createElement('div');
  wrap.className = 'species-card';

  // --- Tree-type segmented toggle (first row inside the card).
  wrap.appendChild(makeSegmented(
    [
      { label: 'Broadleaf', value: 'broadleaf' },
      { label: 'Conifer',   value: 'conifer'   },
      { label: 'Bush',      value: 'bush'      },
    ],
    P.treeType,
    (v) => {
      // Preserve current species: 'Custom' stays 'Custom' (don't clobber
      // hand-tuned params); a named preset swaps to the sibling default
      // for the new type (Oak ↔ Pine ↔ Boxwood).
      const prevSpecies = speciesSelect?.value || 'Custom';
      P.treeType = v;
      applyTreeTypeVisibility();
      let targetSpecies;
      if (prevSpecies === 'Custom') {
        targetSpecies = 'Custom';
        generateTree();
      } else {
        targetSpecies = v === 'conifer' ? 'Pine'
                      : v === 'bush'    ? 'Boxwood'
                      :                   'Oak';
        applySpecies(targetSpecies);
      }
      if (_rebuildSpeciesBand) _rebuildSpeciesBand(targetSpecies);
    },
  ));

  speciesSelect = document.createElement('select');
  speciesSelect.style.display = 'none';
  speciesSelect.addEventListener('change', () => applySpecies(speciesSelect.value));
  wrap.appendChild(speciesSelect);

  // Apple-style data-rich dropdown — full-width trigger shows current species
  // (icon + name + Latin sub + habit meta); panel shows the same per row.
  const dd = document.createElement('div');
  dd.className = 'species-dd';
  dd.style.cssText = 'position:relative;width:100%;margin-top:8px;';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'species-dd-trigger';
  trigger.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);border-radius:10px;color:inherit;cursor:pointer;text-align:left;transition:background 120ms,border-color 120ms;';
  trigger.addEventListener('mouseenter', () => { trigger.style.background = 'rgba(255,255,255,0.07)'; });
  trigger.addEventListener('mouseleave', () => { trigger.style.background = panel.hidden ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.07)'; });

  const panel = document.createElement('div');
  panel.className = 'species-dd-panel';
  panel.hidden = true;
  // Portaled to body so the sidebar's overflow:hidden / clip doesn't trim it.
  panel.style.cssText = 'position:fixed;max-height:380px;overflow-y:auto;background:#1c1c1e;border:1px solid rgba(255,255,255,0.12);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.45);z-index:9999;padding:6px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.18) transparent;';
  // Inject a one-time <style> with WebKit scrollbar rules for a sleek
  // Apple-like overlay scrollbar — inline CSSText can't do pseudo-elements.
  if (!document.getElementById('species-dd-style')) {
    const s = document.createElement('style');
    s.id = 'species-dd-style';
    s.textContent = `
.species-dd-panel::-webkit-scrollbar { width: 6px; }
.species-dd-panel::-webkit-scrollbar-track { background: transparent; }
.species-dd-panel::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.14);
  border-radius: 3px;
  transition: background 120ms;
}
.species-dd-panel::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); }
.species-dd-panel::-webkit-scrollbar-corner { background: transparent; }
.species-dd-panel::-webkit-scrollbar-button,
.species-dd-panel::-webkit-scrollbar-button:vertical:start:decrement,
.species-dd-panel::-webkit-scrollbar-button:vertical:end:increment,
.species-dd-panel::-webkit-scrollbar-button:vertical:start:increment,
.species-dd-panel::-webkit-scrollbar-button:vertical:end:decrement {
  display: none;
  width: 0;
  height: 0;
}
`;
    document.head.appendChild(s);
  }
  // Stop bubbling so the document-level "click outside" handler doesn't fire.
  panel.addEventListener('click', (e) => e.stopPropagation());

  function positionPanel() {
    const r = trigger.getBoundingClientRect();
    panel.style.left = `${r.left}px`;
    panel.style.width = `${r.width}px`;
    // If there's not enough room below, flip above the trigger.
    const vh = window.innerHeight;
    const spaceBelow = vh - r.bottom;
    const panelMax = 380;
    if (spaceBelow < 220 && r.top > spaceBelow) {
      panel.style.top = '';
      panel.style.bottom = `${vh - r.top + 6}px`;
      panel.style.maxHeight = `${Math.min(panelMax, r.top - 16)}px`;
    } else {
      panel.style.bottom = '';
      panel.style.top = `${r.bottom + 6}px`;
      panel.style.maxHeight = `${Math.min(panelMax, spaceBelow - 16)}px`;
    }
  }

  function setTriggerContent(k) {
    const info = speciesInfo(k);
    trigger.innerHTML = `
      <span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:rgba(255,255,255,0.06);flex:0 0 34px;">${iconSvg(speciesIconName(k), 22)}</span>
      <span style="display:flex;flex-direction:column;flex:1;min-width:0;line-height:1.25;">
        <span style="font-size:14px;font-weight:600;letter-spacing:-0.01em;">${k}</span>
        <span style="font-size:11px;opacity:0.55;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${info.sub}</span>
      </span>
      <span style="opacity:0.5;flex:0 0 auto;transition:transform 160ms;${panel.hidden ? '' : 'transform:rotate(180deg);'}">${iconSvg('chevron-down', 14)}</span>
    `;
  }

  function makeRow(k, isActive) {
    const info = speciesInfo(k);
    // Split meta on " • " so we can render the height token as a pill on
    // its own line. Last segment matching /\d.*m$/ is the height.
    const parts = (info.meta || '').split(' • ').map((s) => s.trim()).filter(Boolean);
    let height = '';
    let habit = '';
    if (parts.length && /\d.*m$/.test(parts[parts.length - 1])) {
      height = parts.pop();
    }
    habit = parts.join(' • ');
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.name = k;
    row.style.cssText = `display:flex;align-items:flex-start;gap:10px;width:100%;padding:9px 10px;background:${isActive ? 'rgba(120,170,255,0.12)' : 'transparent'};border:none;border-radius:8px;color:inherit;cursor:pointer;text-align:left;`;
    row.innerHTML = `
      <span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:rgba(255,255,255,0.06);flex:0 0 34px;color:${isActive ? '#7aaaff' : 'inherit'};margin-top:2px;">${iconSvg(speciesIconName(k), 22)}</span>
      <span style="display:flex;flex-direction:column;flex:1;min-width:0;line-height:1.3;gap:2px;">
        <span style="font-size:13.5px;font-weight:${isActive ? '600' : '500'};letter-spacing:-0.01em;color:${isActive ? '#7aaaff' : 'inherit'};">${k}</span>
        <span style="font-size:11px;opacity:0.6;font-style:italic;">${info.sub}</span>
        ${habit ? `<span style="font-size:10.5px;opacity:0.4;">${habit}</span>` : ''}
        ${height ? `<span style="margin-top:3px;"><span style="display:inline-block;font-size:10px;font-weight:500;letter-spacing:0.02em;padding:2px 7px;border-radius:9px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.72);">${height}</span></span>` : ''}
      </span>
      ${isActive ? `<span style="color:#7aaaff;flex:0 0 auto;margin-top:9px;">${iconSvg('check', 14)}</span>` : ''}
    `;
    row.addEventListener('mouseenter', () => { if (!isActive) row.style.background = 'rgba(255,255,255,0.05)'; });
    row.addEventListener('mouseleave', () => { if (!isActive) row.style.background = 'transparent'; });
    row.addEventListener('click', () => {
      speciesSelect.value = k;
      panel.hidden = true;
      setTriggerContent(k);
      trigger.style.background = 'rgba(255,255,255,0.04)';
      applySpecies(k);
    });
    return row;
  }

  function openPanel() {
    // Re-render rows every open so the active highlight always tracks
    // speciesSelect.value (which can change via clicks elsewhere or
    // applySpecies mutating it).
    rebuildRows();
    panel.hidden = false;
    positionPanel();
    setTriggerContent(speciesSelect.value || 'Custom');
    // Scroll active row into view (next frame so layout has settled).
    requestAnimationFrame(() => {
      const active = panel.querySelector('[data-active="1"]');
      if (active) active.scrollIntoView({ block: 'nearest' });
    });
  }
  // Reposition on scroll/resize while open.
  window.addEventListener('scroll', () => { if (!panel.hidden) positionPanel(); }, true);
  window.addEventListener('resize', () => { if (!panel.hidden) positionPanel(); });
  function closePanel() {
    panel.hidden = true;
    setTriggerContent(speciesSelect.value || 'Custom');
    trigger.style.background = 'rgba(255,255,255,0.04)';
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.hidden) openPanel(); else closePanel();
  });
  // Click anywhere outside the dropdown closes it.
  document.addEventListener('click', () => { if (!panel.hidden) closePanel(); });
  // Esc to close.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closePanel(); });

  dd.appendChild(trigger);
  document.body.appendChild(panel); // portal — escapes sidebar overflow clip
  wrap.appendChild(dd);

  function currentKeys() {
    if (P.treeType === 'conifer') return CONIFER_KEYS;
    if (P.treeType === 'bush') return BUSH_KEYS;
    return BROADLEAF_KEYS;
  }
  function rebuildRows() {
    const keys = currentKeys();
    panel.innerHTML = '';
    for (const k of keys) {
      const isActive = k === speciesSelect.value;
      const row = makeRow(k, isActive);
      if (isActive) row.dataset.active = '1';
      panel.appendChild(row);
    }
  }
  function rebuild(desired) {
    const keys = currentKeys();
    const target = desired ?? speciesSelect.value ?? 'Custom';
    speciesSelect.innerHTML = '';
    for (const k of keys) {
      const opt = document.createElement('option');
      opt.value = k; opt.textContent = k;
      speciesSelect.appendChild(opt);
    }
    speciesSelect.value = keys.includes(target) ? target : 'Custom';
    setTriggerContent(speciesSelect.value);
    rebuildRows();
  }
  rebuild();
  _rebuildSpeciesBand = rebuild;
  sidebarBody.appendChild(wrap);
}

// Trunk Profile — collapsible card under the species dropdown (no longer
// inline). Closed by default so the top of the sidebar stays compact.
{
  const details = document.createElement('details');
  details.open = false;
  details.dataset.treeType = 'broadleaf,conifer,bush';
  const summary = document.createElement('summary');
  setSummary(summary, 'trending-up', 'Trunk Profile');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'trunk-profile';
  profileEditor = new ProfileEditor(wrap);
  // Profile shape only affects tube extrusion — tubesOnly fast path skips
  // tree rebuild / skeleton / foliage and just re-extrudes the bark.
  profileEditor.onChange = () => debouncedGenerate({ tubesOnly: true });
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}

// Roots — surface tendrils flaring from the trunk base.
{
  const details = document.createElement('details');
  details.open = false;
  details.dataset.treeType = 'broadleaf,conifer,bush';
  const summary = document.createElement('summary');
  setSummary(summary, 'git-branch', 'Roots');
  details.appendChild(summary);

  const toggleRow = document.createElement('div');
  toggleRow.className = 'slider-row toggle-row';
  const tLabel = document.createElement('label');
  tLabel.textContent = 'Enabled';
  const tInput = document.createElement('input');
  tInput.type = 'checkbox';
  tInput.checked = P.roots.enabled;
  tInput.addEventListener('change', () => {
    P.roots.enabled = tInput.checked;
    debouncedGenerate();
  });
  toggleRow.append(tLabel, tInput);
  details.appendChild(toggleRow);

  const ROOTS_SCHEMA = [
    { key: 'rootCount',  label: 'Count',       min: 0,    max: 16,  step: 1,    default: 6 },
    { key: 'rootSpread', label: 'Spread',      min: 0.2,  max: 5,   step: 0.05, default: 1.6 },
    { key: 'rootLength', label: 'Length',      min: 0.3,  max: 3,   step: 0.05, default: 1.4 },
    { key: 'rootDepth',  label: 'Depth',       min: 0,    max: 2,   step: 0.05, default: 0.6 },
    { key: 'rootBaseR',  label: 'Base radius', min: 0.02, max: 0.6, step: 0.01, default: 0.18 },
    { key: 'rootTipR',   label: 'Tip radius',  min: 0.005,max: 0.3, step: 0.005,default: 0.04 },
    { key: 'rootRise',   label: 'Arch rise',   min: 0,    max: 1,   step: 0.02, default: 0.25 },
    { key: 'rootJitter', label: 'Jitter',      min: 0,    max: 1,   step: 0.02, default: 0.4 },
  ];
  for (const p of ROOTS_SCHEMA) {
    const row = createSliderRow(p, () => P.roots[p.key], (v) => { P.roots[p.key] = v; }, () => debouncedGenerate());
    details.appendChild(row);
  }
  sidebarBody.appendChild(details);
}

function addSectionLabel(text, treeType, iconName) {
  const el = document.createElement('div');
  el.className = 'section-label';
  if (iconName) {
    el.appendChild(iconEl(iconName, 12));
    el.dataset.icon = iconName;          // read by the floating section rail
  }
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (treeType) el.dataset.treeType = treeType;
  sidebarBody.appendChild(el);
  return el;
}

// Active sidebar tab — initSidebarTabs writes to this so the two visibility
// filters (tree type + tab) can AND-compose without clobbering each other.
let _sbActiveTab = 'tree';
function applyTreeTypeVisibility() {
  for (const el of sidebarBody.querySelectorAll('[data-tree-type]')) {
    // Comma-separated list lets one card opt into multiple types
    // (e.g., 'broadleaf,conifer' = visible for both, hidden for bush).
    const allowed = el.dataset.treeType.split(',');
    const onType = allowed.includes(P.treeType);
    const tabAttr = el.dataset.tab;
    const onTab = !tabAttr || tabAttr === _sbActiveTab;
    el.style.display = (onType && onTab) ? '' : 'none';
  }
  if (typeof leafInstFall !== 'undefined' && leafInstFall) {
    leafInstFall.visible = P.treeType !== 'conifer';
  }
}

// Helpers: build a single PARAM_SCHEMA / CONIFER_SCHEMA group on demand so
// we can mix and match groups across multiple sections in a logical order.
function buildParamGroup(groupName, options = {}) {
  const group = PARAM_SCHEMA.find((g) => g.group === groupName);
  if (!group) return;
  const details = document.createElement('details');
  // Sidebar cards default closed for a calm initial state. Pass
  // { open: true } at the call site to force-open a specific card.
  details.open = options.open === true;
  const tt = options.treeType || group.treeType;
  if (tt) details.dataset.treeType = tt;
  const summary = document.createElement('summary');
  setSummary(summary, GROUP_ICONS[group.group] || 'box', options.label || group.group);
  details.appendChild(summary);
  const leavesOnlyScope = options.scope === 'leaves';
  for (const p of group.params) {
    if (p.hidden) continue;
    let onAfter = null;
    if (p.live) {
      onAfter = () => {
        if (p.key.startsWith('leaf') || p.key === 'season') applyLeafMaterial();
        if (p.key.startsWith('bark')) applyBarkMaterial();
        if (p.key.startsWith('vine')) applyVineMaterial();
        if (p.key.startsWith('stubs')) applyStubMaterial();
        if (p.key.startsWith('fruit')) applyFruitMaterial();
        if (p.key === 'rotation') applyTreeRotation();
      };
    } else if (p.rescale) {
      // Fastest path — just rewrites instance-matrix scale. Falls back to the
      // foliage rebuild if the cached sFactor is missing (fresh app load).
      onAfter = () => { if (!rescaleLeaves()) debouncedRebuildFoliage(); };
    } else if (leavesOnlyScope) {
      // Route to the foliage-only fast path — skips bark / skeleton rebuild.
      onAfter = () => { debouncedRebuildFoliage(); };
    } else if (p.tubesOnly) {
      // Tube-extrusion-only params (taper/profile/displace/buttress/react).
      // Skips buildTree / buildChains / skeleton / foliage; only re-extrudes
      // bark tubes. ~10× faster during a drag on large trees.
      onAfter = () => { debouncedGenerate({ tubesOnly: true }); };
    }
    const row = createSliderRow(p, () => P[p.key], (v) => { P[p.key] = v; }, onAfter);
    details.appendChild(row);
  }
  sidebarBody.appendChild(details);
}
function buildConiferGroup(groupName, options = {}) {
  const group = CONIFER_SCHEMA.find((g) => g.group === groupName);
  if (!group) return;
  const details = document.createElement('details');
  details.open = options.open === true;
  details.dataset.treeType = 'conifer';
  const summary = document.createElement('summary');
  setSummary(summary, GROUP_ICONS[group.group] || 'box', options.label || group.group);
  details.appendChild(summary);
  for (const p of group.params) {
    if (p.hidden) continue;
    const onAfter = p.live ? () => {
      if (p.key === 'cNeedleWidth' && leafInstA && leafInstB) {
        const newGeo = new THREE.PlaneGeometry(P.cNeedleWidth * 0.18, 1);
        // Only dispose the previous clone — never the module-level base.
        if (activeNeedleGeo && activeNeedleGeo !== needleGeo) activeNeedleGeo.dispose();
        activeNeedleGeo = newGeo;
        leafInstA.geometry = newGeo;
        leafInstB.geometry = newGeo;
      }
    } : null;
    const row = createSliderRow(p, () => P[p.key], (v) => { P[p.key] = v; }, onAfter);
    details.appendChild(row);
  }
  sidebarBody.appendChild(details);
}

function buildBushGroup(groupName, options = {}) {
  const group = BUSH_SCHEMA.find((g) => g.group === groupName);
  if (!group) return;
  const details = document.createElement('details');
  details.open = options.open === true;
  details.dataset.treeType = 'bush';
  const summary = document.createElement('summary');
  setSummary(summary, GROUP_ICONS[group.group] || 'sprout', options.label || group.group);
  details.appendChild(summary);
  for (const p of group.params) {
    if (p.hidden) continue;
    const row = createSliderRow(p, () => P[p.key], (v) => { P[p.key] = v; });
    details.appendChild(row);
  }
  sidebarBody.appendChild(details);
}

// ------------------------------------------------------------------------
// Sidebar layout — ordered to follow the tree-building workflow:
//   Shape → Branching → Foliage → Bark → Scene → Dynamics → Save
// Tree-type-specific sections (broadleaf vs conifer) are marked via
// data-treeType so applyTreeTypeVisibility() can hide the inactive set.
// ------------------------------------------------------------------------

// 1. Shape — trunk + overall proportions + radius/length curves
// Trunk stays visible in every tree type so the user can inspect / tune it.
// NOTE: bush mode still runs applyBushConfigToP on regen, which overrides
// trunk params from the bHeight/bCompact shortcuts — manual trunk edits in
// bush mode are re-derived on the next rebuild.
addSectionLabel('Shape', null, 'tree-deciduous');
// Trunk sliders are clobbered every regen on bush (applyBushConfigToP
// derives trunk from bHeight/bSpread/bCompact). Hiding the group on bush
// so users don't adjust sliders that silently do nothing.
buildParamGroup('Trunk', { treeType: 'broadleaf,conifer' });
buildParamGroup('Global', { treeType: 'broadleaf,conifer' });

// Radius / Length / Density spline editors finish off the Shape section.
// Length + Density open by default so the natural-taper defaults are
// immediately visible — discoverable presets + user can tweak right away.
{
  const details = document.createElement('details');
  details.open = false;
  details.dataset.treeType = 'broadleaf,conifer';
  const summary = document.createElement('summary');
  setSummary(summary, 'trending-up', 'Radius Curve');
  details.appendChild(summary);
  taperSpline = new SplineEditor(details, { baseLabel: 'BASE', tipLabel: 'TIP' });
  // Radius curve only affects trunk-chain tube extrusion — tubesOnly fast
  // path skips the whole tree rebuild / skeleton / foliage pipeline.
  taperSpline.onChange = () => debouncedGenerate({ tubesOnly: true });
  sidebarBody.appendChild(details);
}
{
  const details = document.createElement('details');
  details.open = false;
  details.dataset.treeType = 'broadleaf,conifer';
  const summary = document.createElement('summary');
  setSummary(summary, 'spline', 'Length by Depth');
  details.appendChild(summary);
  // Length by depth (L1 → deepest). Default ramp gives gentle self-similar
  // decay — first-order branches full, smaller as recursion deepens — which
  // matches Horton-Strahler length ratios observed in natural trees.
  // Near-identity default: per-level `lenRatio` already encodes Horton-
  // Strahler decay (R_L ≈ 1.5–2.5 across levels). Extra global ramp compounds
  // into over-reduction, so we only add a subtle extra taper here.
  lengthSpline = new SplineEditor(details, {
    points: [1.0, 0.98, 0.95, 0.9, 0.85],
    min: 0.2, max: 2.0, baseLabel: 'LVL 1', tipLabel: 'DEEP',
  });
  lengthSpline.onChange = debouncedGenerate;
  sidebarBody.appendChild(details);
}
// (Global Trunk Density card removed — L1's own densityPoints is the
//  canonical trunk-density control. Keeping both stacked multiplicatively
//  was confusing without adding capability.)

// 2. Branching — per-level branching (broadleaf) + pruning + attractors
addSectionLabel('Branching', 'broadleaf', 'git-branch');
const levelsWrapper = document.createElement('div');
levelsWrapper.id = 'levels-wrapper';
levelsWrapper.dataset.treeType = 'broadleaf';
sidebarBody.appendChild(levelsWrapper);

function renderLevels(opts) {
  // About to wipe scrubber DOM — make sure any in-flight drag gets cleaned up
  // so scrubCount / isScrubbing / pointer captures don't leak.
  _forceEndAllScrubs();
  // Preserve the user's open/closed state across rebuilds. Only LEVEL
  // cards participate — Twigs and any trailing conceptual-final card are
  // excluded so their state (which renders after the level loop ends)
  // doesn't leak into the level index mapping.
  // Callers can pass a pre-shifted snapshot; otherwise we capture from
  // the DOM right now, filtering out the non-level children.
  let prevOpen;
  if (opts && opts.openStates) {
    prevOpen = opts.openStates;
  } else {
    prevOpen = [];
    const nodes = levelsWrapper.querySelectorAll(':scope > details');
    for (const d of nodes) {
      const label = d.querySelector(':scope > summary .sec-label');
      const txt = label ? label.textContent : '';
      // Only capture actual "Level N" cards.
      if (/^Level\s+\d+/i.test(txt)) prevOpen.push(d.hasAttribute('open'));
    }
  }
  levelsWrapper.innerHTML = '';
  for (let i = 0; i < P.levels.length; i++) {
    const levelData = P.levels[i];
    const details = document.createElement('details');
    // Default closed for a calm initial state; re-renders honor whatever
    // the user had open before the mutation so editing one level doesn't
    // collapse the others.
    details.open = i < prevOpen.length ? prevOpen[i] : false;
    const summary = document.createElement('summary');
    summary.appendChild(iconEl('git-branch'));
    const title = document.createElement('span');
    title.className = 'sec-label';
    title.textContent = `Level ${i + 1}`;
    summary.appendChild(title);
    if (i > 0) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'level-copy';
      copyBtn.innerHTML = iconSvg('copy', 12);
      copyBtn.title = 'Copy from previous level';
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        P.levels[i] = { ...P.levels[i - 1] };
        renderLevels(); debouncedGenerate();
      });
      summary.appendChild(copyBtn);
    }
    if (P.levels.length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'level-remove';
      removeBtn.innerHTML = iconSvg('x', 12);
      removeBtn.title = 'Remove this level';
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        // Snapshot open/closed state of every Level card BEFORE the splice
        // so we can shift-drop the deleted index and hand a correctly
        // aligned array to renderLevels. Explicitly filter to "Level N"
        // cards so the trailing Twigs card (which is also a direct child
        // of levels-wrapper) doesn't pollute the index mapping.
        const openStates = [];
        const nodes = levelsWrapper.querySelectorAll(':scope > details');
        for (const d of nodes) {
          const label = d.querySelector(':scope > summary .sec-label');
          const txt = label ? label.textContent : '';
          if (/^Level\s+\d+/i.test(txt)) openStates.push(d.hasAttribute('open'));
        }
        openStates.splice(i, 1);
        P.levels.splice(i, 1);
        renderLevels({ openStates }); debouncedGenerate();
      });
      summary.appendChild(removeBtn);
    }
    details.appendChild(summary);
    // Logical sub-sections inside a level card
    // Groups ordered to minimize context-switching: the slider that most
    // directly pairs with each spline editor sits in the same group, so you
    // never have to jump up-and-down the sidebar to tune one visual aspect.
    const LEVEL_GROUPS = [
      { label: 'Count & density', keys: ['children'], splineKey: 'density' },
      { label: 'Length',          keys: ['lenRatio'], splineKey: 'length' },
      { label: 'Placement',       keys: ['startPlacement', 'endPlacement', 'phyllotaxis'] },
      { label: 'Apical control',  keys: ['apicalDominance', 'apicalContinue'] },
      { label: 'Angle',           keys: ['angle', 'angleVar', 'rollStart', 'rollVar', 'angleDecline'], splineKey: 'startAngle' },
      { label: 'Branch curve',    keys: ['kinkSteps', 'curveMode', 'curveAmount', 'curveBack'] },
      { label: 'Wiggle',          keys: ['distortion', 'distortionFreq', 'wobble', 'wobbleFreq'], splineKey: 'randomness' },
      { label: 'Forking',         keys: ['segSplits', 'splitAngle'], splineKey: 'split' },
      { label: 'Tropism',         keys: ['susceptibility'], panels: ['gravitropism'] },
      { label: 'Random',          keys: ['stochastic'] },
    ];
    const schemaByKey = new Map(LEVEL_SCHEMA.map((p) => [p.key, p]));
    const splineSpecs = {
      density:    { label: 'Density along parent',     field: 'densityPoints',    min: 0, max: 1, defaults: [0.75, 0.95, 1.0, 0.95, 0.7] },
      length:     { label: 'Length along parent',      field: 'lengthPoints',     min: 0, max: 2, defaults: [0.9, 1.0, 1.0, 0.9, 0.75] },
      split:      { label: 'Fork rate along branch',   field: 'splitPoints',      min: 0, max: 2, defaults: [1, 1, 1, 1, 1] },
      randomness: { label: 'Wiggle along branch',      field: 'randomnessPoints', min: 0, max: 2, defaults: [1, 1, 1, 1, 1] },
      startAngle: { label: 'Spawn angle along parent', field: 'startAnglePoints', min: -1.5, max: 1.5, defaults: [0, 0, 0, 0, 0] },
    };
    for (const g of LEVEL_GROUPS) {
      const members = g.keys.map((k) => schemaByKey.get(k)).filter(Boolean);
      const hasPanels = Array.isArray(g.panels) && g.panels.length > 0;
      const hasSpline = !!g.splineKey;
      if (!members.length && !hasPanels && !hasSpline) continue;
      const sub = document.createElement('div');
      sub.className = 'level-sub';
      const head = document.createElement('div');
      head.className = 'level-sub-head';
      head.textContent = g.label;
      sub.appendChild(head);
      for (const p of members) {
        const row = createSliderRow(p, () => levelData[p.key], (v) => { levelData[p.key] = v; });
        sub.appendChild(row);
      }
      if (hasPanels) {
        for (const key of g.panels) {
          new TropismPanel(sub, {
            label: key === 'phototropism' ? 'Phototropism' : 'Gravitropism',
            defaultDir: key === 'phototropism'
              ? () => [_sunDirX, _sunDirY, _sunDirZ]
              : [0, -1, 0],
            strengthMin: key === 'phototropism' ? 0 : -0.15,
            strengthMax: 0.15,
            strengthStep: 0.005,
            get: () => levelData[key],
            set: (obj) => { levelData[key] = obj; },
            onChange: () => { commitHistorySoon(); debouncedGenerate(); },
          });
        }
      }
      if (hasSpline) {
        const spec = splineSpecs[g.splineKey];
        if (spec) {
          if (!Array.isArray(levelData[spec.field]) || levelData[spec.field].length < 2) {
            levelData[spec.field] = spec.defaults.slice();
          }
          const editor = new SplineEditor(sub, {
            points: levelData[spec.field],
            min: spec.min, max: spec.max,
            baseLabel: 'BASE', tipLabel: 'TIP',
          });
          editor.onChange = () => {
            levelData[spec.field] = editor.points.slice();
            debouncedGenerate();
            commitHistorySoon();
          };
        }
      }
      details.appendChild(sub);
    }
    levelsWrapper.appendChild(details);
  }
  const add = document.createElement('button');
  add.className = 'level-add';
  add.textContent = '+ Add Level';
  add.addEventListener('click', () => {
    P.levels.push(makeDefaultLevel());
    renderLevels(); debouncedGenerate();
  });
  levelsWrapper.appendChild(add);

}
renderLevels();

// Pruning slider group goes in the Branching section.
// Hidden in bush mode: applyBushConfigToP forces an ellipsoid pruning envelope.
buildParamGroup('Pruning', { treeType: 'broadleaf,conifer' });

// Attractors — world-space points that pull branches toward them
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'target', 'Attractors');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad';
  const list = document.createElement('div');
  wrap.appendChild(list);

  const ATTRACTOR_PARAMS = [
    { key: 'x',        label: 'X',        min: -20, max: 20, step: 0.5, default: 0 },
    { key: 'y',        label: 'Y',        min: 0,   max: 25, step: 0.5, default: 10 },
    { key: 'z',        label: 'Z',        min: -20, max: 20, step: 0.5, default: 0 },
    { key: 'strength', label: 'Strength', min: 0,   max: 1,  step: 0.02, default: 0.5 },
  ];

  function renderAttractors() {
    list.innerHTML = '';
    // Auto-seeded crown attractors don't get individual cards (would flood UI
    // with 60 entries) — they're managed via the Seed/Clear buttons below.
    const seededCount = P.attractors.filter((a) => a.seeded).length;
    const manual = P.attractors.filter((a) => !a.seeded);
    if (manual.length === 0 && seededCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint-empty';
      empty.textContent = 'No attractors. Add one to bend branches toward a point.';
      list.appendChild(empty);
    }
    if (seededCount > 0) {
      const note = document.createElement('div');
      note.className = 'hint-empty';
      note.textContent = `${seededCount} crown-seed attractors active`;
      list.appendChild(note);
    }
    for (let i = 0; i < P.attractors.length; i++) {
      const a = P.attractors[i];
      if (a.seeded) continue;
      const card = document.createElement('div');
      card.className = 'attr-card';
      const header = document.createElement('div');
      header.className = 'attr-card-header';
      const title = document.createElement('span');
      title.textContent = `Attractor ${i + 1}`;
      title.className = 'attr-card-title';
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-x';
      removeBtn.innerHTML = iconSvg('x', 12);
      removeBtn.title = 'Remove attractor';
      removeBtn.addEventListener('click', () => {
        P.attractors.splice(i, 1);
        renderAttractors();
        syncAttractorGizmos();
        debouncedGenerate();
      });
      header.append(title, removeBtn);
      card.appendChild(header);
      for (const p of ATTRACTOR_PARAMS) {
        const row = createSliderRow(p, () => a[p.key], (v) => { a[p.key] = v; syncAttractorGizmos(); });
        card.appendChild(row);
      }
      list.appendChild(card);
    }
  }

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add Attractor';
  addBtn.className = 'level-add';
  addBtn.className = 'btn-full-mt';
  addBtn.addEventListener('click', () => {
    // Cap manual attractors at 6 (don't count auto-seeded crown attractors).
    const manualCount = P.attractors.filter((a) => !a.seeded).length;
    if (manualCount >= 6) return;
    P.attractors.push({ x: (Math.random() - 0.5) * 10, y: 8 + Math.random() * 5, z: (Math.random() - 0.5) * 10, strength: 0.5 });
    renderAttractors();
    syncAttractorGizmos();
    debouncedGenerate();
  });
  wrap.appendChild(addBtn);

  // Crown seeder — bulk-populate attractors in a shape so branches space-fill
  // the canopy organically (light-touch space colonization).
  const seedRow = document.createElement('div');
  seedRow.style.display = 'flex';
  seedRow.style.gap = '6px';
  seedRow.style.marginTop = '6px';
  const seedSphere = document.createElement('button');
  seedSphere.textContent = 'Seed crown (sphere)';
  seedSphere.className = 'btn-full-mt';
  seedSphere.style.flex = '1';
  const seedConical = document.createElement('button');
  seedConical.textContent = 'Cone';
  seedConical.className = 'btn-full-mt';
  seedConical.style.flex = '0 0 auto';
  const clearSeeded = document.createElement('button');
  clearSeeded.textContent = 'Clear seeded';
  clearSeeded.className = 'btn-full-mt';
  clearSeeded.style.flex = '0 0 auto';
  function _seedCrownAttractors(shape) {
    // Remove any prior seeded attractors so re-seeding is idempotent.
    P.attractors = P.attractors.filter((a) => !a.seeded);
    const count = 60;
    const trunkH = P.trunkHeight ?? 10;
    const cy = trunkH * 0.7;
    const radius = trunkH * 0.45;
    const seed = ((P.seed | 0) ^ 0xC707) >>> 0;
    let s = seed || 1;
    const rng = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < count; i++) {
      // Sample a point inside the chosen shape (cube-rejection for sphere).
      let x, y, z;
      let tries = 0;
      do {
        x = (rng() * 2 - 1);
        y = (rng() * 2 - 1);
        z = (rng() * 2 - 1);
        tries++;
        if (tries > 12) break;
      } while (x * x + y * y + z * z > 1);
      let px, py, pz;
      if (shape === 'cone') {
        // Cone: radius scales linearly from 1 (at bottom) → 0 (top)
        const t = (y + 1) * 0.5;            // 0 at bottom, 1 at top
        const rScale = 1 - t * 0.85;        // narrow but not zero at apex
        px = x * radius * rScale;
        py = cy + (y - 0.5) * trunkH * 0.5; // cone spans roughly upper half
        pz = z * radius * rScale;
      } else {
        // Sphere
        px = x * radius;
        py = cy + y * radius * 0.7;         // slightly flattened ellipsoid
        pz = z * radius;
      }
      P.attractors.push({
        x: px, y: py, z: pz,
        strength: 0.3,
        seeded: true,
      });
    }
    renderAttractors();
    syncAttractorGizmos();
    debouncedGenerate();
  }
  seedSphere.addEventListener('click', () => _seedCrownAttractors('sphere'));
  seedConical.addEventListener('click', () => _seedCrownAttractors('cone'));
  clearSeeded.addEventListener('click', () => {
    P.attractors = P.attractors.filter((a) => !a.seeded);
    renderAttractors();
    syncAttractorGizmos();
    debouncedGenerate();
  });
  seedRow.append(seedSphere, seedConical, clearSeeded);
  wrap.appendChild(seedRow);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
  renderAttractors();
  syncAttractorGizmos();
  _refreshAttractorUI = renderAttractors;
}

// 3. Conifer Shape — structural conifer params (hidden for broadleaf)
addSectionLabel('Conifer Shape', 'conifer', 'tree-pine');
buildConiferGroup('Crown');
buildConiferGroup('Twigs');

// 4. Foliage (broadleaf) — leaves, their material, texture swap
addSectionLabel('Foliage', 'broadleaf', 'leaf');
buildParamGroup('Leaves', { scope: 'leaves' });
buildParamGroup('Stems', { scope: 'leaves' });
buildParamGroup('Leaf Material');
{
  const details = document.createElement('details');
  details.open = false;
  details.dataset.treeType = 'broadleaf';
  const summary = document.createElement('summary');
  setSummary(summary, 'leaf', 'Leaf Shape');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad leaf-shape-pane';

  // Preview stack — 2D silhouette is the default (cheap, instant). A small
  // "3D" toggle in the top-right switches to an orbit-controlled WebGPU
  // preview. The 3D renderer is initialized lazily on first toggle so
  // users who never switch never pay the WebGPU context cost.
  const previewWrap = document.createElement('div');
  previewWrap.className = 'leaf-preview-wrap';
  previewWrap.style.position = 'relative';
  previewWrap.style.marginBottom = '10px';

  const preview = document.createElement('canvas');
  preview.width = 280; preview.height = 280;
  preview.className = 'leaf-preview';
  preview.style.width = '100%';
  preview.style.aspectRatio = '1 / 1';
  preview.style.display = 'block';
  preview.style.borderRadius = '12px';
  previewWrap.appendChild(preview);

  const preview3D = document.createElement('canvas');
  preview3D.className = 'leaf-preview-3d';
  preview3D.width = 280; preview3D.height = 280;
  preview3D.style.width = '100%';
  preview3D.style.aspectRatio = '1 / 1';
  preview3D.style.display = 'none';
  preview3D.style.borderRadius = '12px';
  preview3D.style.background = 'linear-gradient(180deg, rgba(90,110,80,0.22), rgba(30,40,30,0.35))';
  preview3D.style.cursor = 'grab';
  preview3D.style.touchAction = 'none';
  previewWrap.appendChild(preview3D);

  const viewToggle = document.createElement('button');
  viewToggle.type = 'button';
  viewToggle.className = 'leaf-view-toggle';
  viewToggle.textContent = '3D';
  viewToggle.title = 'Toggle 3D preview';
  viewToggle.style.cssText = [
    'position:absolute', 'bottom:8px', 'right:8px',
    'display:inline-flex', 'align-items:center', 'justify-content:center',
    'width:auto', 'min-width:0', 'line-height:1',
    'padding:3px 9px', 'font-size:10px', 'font-weight:600',
    'letter-spacing:0.5px', 'border-radius:999px',
    'background:rgba(20,24,20,0.65)', 'color:rgba(255,255,255,0.85)',
    'border:1px solid rgba(255,255,255,0.12)',
    'cursor:pointer', 'backdrop-filter:blur(6px)',
    'user-select:none', 'z-index:2',
  ].join(';');
  let is3D = false;
  viewToggle.addEventListener('click', () => {
    is3D = !is3D;
    viewToggle.textContent = is3D ? '2D' : '3D';
    viewToggle.classList.toggle('on', is3D);
    preview.style.display = is3D ? 'none' : 'block';
    preview3D.style.display = is3D ? 'block' : 'none';
    if (is3D) render3DPreview();
  });
  previewWrap.appendChild(viewToggle);

  wrap.appendChild(previewWrap);

  // Shape picker — Texture + procedural presets + Custom. Upload stays a
  // separate toolbar action (tb-upload) and simply sets P.leafShape there.
  const select = document.createElement('select');
  select.className = 'select select-full-mb';
  const SHAPE_OPTIONS = ['Texture', ...Object.keys(LEAF_PRESETS), 'Custom', 'Upload'];
  for (const name of SHAPE_OPTIONS) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name === 'Texture' ? 'Default PNG' : name === 'Upload' ? 'Uploaded PNG' : name;
    select.appendChild(o);
  }
  select.value = P.leafShape;
  wrap.appendChild(select);

  // Container for profile sliders — only shown for Custom.
  const customWrap = document.createElement('div');
  customWrap.className = 'leaf-custom';
  wrap.appendChild(customWrap);

  // Size sliders — scale the user's drawn silhouette's bbox in mesh units.
  const PROFILE_PARAMS_ALWAYS = [
    { key: 'aspect',    label: 'Width',  min: 0.06, max: 1.0, step: 0.01 },
    { key: 'length',    label: 'Length', min: 0.3,  max: 1.0, step: 0.01 },
    { key: 'veinCount', label: 'Veins',  min: 0,    max: 12,  step: 1    },
  ];
  const sliderRefs = [];
  const mkSlider = (parentEl, pd) => {
    const row = createSliderRow(
      { key: `__leaf_${pd.key}`, label: pd.label, min: pd.min, max: pd.max, step: pd.step, default: P.leafProfile[pd.key] },
      () => P.leafProfile[pd.key],
      (v) => { P.leafProfile[pd.key] = v; },
      () => { applyLeafShape(); renderPreview(); render3DPreview(); markRenderDirty(2); },
      { noRegen: true },
    );
    parentEl.appendChild(row);
    sliderRefs.push({ key: pd.key, row });
  };
  for (const pd of PROFILE_PARAMS_ALWAYS) mkSlider(customWrap, pd);

  // Silhouette drawer — the only shape editor inside Custom. Built lazily so
  // an unused Custom panel doesn't pay the canvas cost.
  const silhouetteWrap = document.createElement('div');
  silhouetteWrap.className = 'leaf-silhouette-wrap-outer';
  customWrap.appendChild(silhouetteWrap);
  let leafSilhouetteEditor = null;
  const ensureSilhouetteEditor = () => {
    if (leafSilhouetteEditor) return leafSilhouetteEditor;
    // Migrate legacy save data: if no silhouette is stored yet, seed from
    // the default oval so the user always has something to pull on.
    if (!Array.isArray(P.leafProfile.silhouette) || P.leafProfile.silhouette.length < 3) {
      P.leafProfile.silhouette = LeafSilhouetteEditor.defaultPoints();
    }
    leafSilhouetteEditor = new LeafSilhouetteEditor(silhouetteWrap, {
      points: P.leafProfile.silhouette,
    });
    leafSilhouetteEditor.onChange = () => {
      P.leafProfile.silhouette = leafSilhouetteEditor.points;
      applyLeafShape();
      renderPreview();
      render3DPreview();
      markRenderDirty(2);
    };
    return leafSilhouetteEditor;
  };

  // Color pickers for fill + veins. Apple-style circular swatches: the
  // visible swatch is a round div with the native `input[type="color"]`
  // overlaid invisibly on top, so clicking the swatch opens the OS picker.
  // Pattern mirrors `.lc-color-row` from the leaf-creator panel but uses
  // round swatches and a stacked label / value layout.
  const colorRow = document.createElement('div');
  colorRow.className = 'leaf-color-row';
  // Track refs so external state changes (species switch, snapshot restore,
  // history undo) can sync both the swatch background and input value back
  // to P.leafProfile. Without this, picking Cherry leaves the picker stuck
  // on the previous species' colour even though the live texture re-bakes.
  const _colorRefs = {};
  const mkColor = (label, key, fallback) => {
    const cell = document.createElement('label');
    cell.className = 'leaf-color';
    const sw = document.createElement('span');
    sw.className = 'leaf-color-sw';
    const initial = P.leafProfile[key] || fallback;
    sw.style.background = initial;
    const meta = document.createElement('span');
    meta.className = 'leaf-color-meta';
    const txt = document.createElement('span');
    txt.className = 'leaf-color-name';
    txt.textContent = label;
    const val = document.createElement('span');
    val.className = 'leaf-color-val';
    val.textContent = initial.toUpperCase();
    meta.append(txt, val);
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = initial;
    inp.addEventListener('input', () => {
      P.leafProfile[key] = inp.value;
      sw.style.background = inp.value;
      val.textContent = inp.value.toUpperCase();
      applyLeafShape();
      renderPreview();
      render3DPreview();
      markRenderDirty(2);
    });
    _colorRefs[key] = { inp, sw, val, fallback };
    cell.append(sw, meta, inp);
    return cell;
  };
  colorRow.append(mkColor('Fill', 'color', '#4a7a3a'), mkColor('Veins', 'veinColor', '#2f4a22'));
  const _syncLeafColorPickers = () => {
    for (const key of Object.keys(_colorRefs)) {
      const r = _colorRefs[key];
      const v = P.leafProfile[key] || r.fallback;
      r.inp.value = v;
      r.sw.style.background = v;
      r.val.textContent = v.toUpperCase();
    }
  };
  // Color picker is shared across every procedural shape (Oak, Maple, …,
  // Custom) — hidden only for Texture / Upload modes which bring their own
  // image. Attached to `wrap` (not `customWrap`) so it stays visible.
  wrap.appendChild(colorRow);

  // 3D bend sliders — midrib cup + apex curl. Geometric shape controls,
  // live-rebuild the leaf mesh.
  const mkBend = (label, key, min, max, step) => {
    return createSliderRow(
      { key: `__leaf_${key}`, label, min, max, step, default: P[key] },
      () => P[key],
      (v) => { P[key] = v; },
      () => { rebuildLeafGeo(); render3DPreview(); renderPreview(); markRenderDirty(2); },
      { noRegen: true },
    );
  };
  wrap.appendChild(mkBend('Midrib cup', 'leafMidribCurl', -0.4, 0.6, 0.01));
  wrap.appendChild(mkBend('Apex curl',  'leafApexCurl',   -0.4, 0.4, 0.01));

  const hint = document.createElement('div');
  hint.className = 'hint-sm-mt';
  hint.textContent = 'Pick a preset shape or switch to Custom to sculpt the silhouette. Uploaded PNGs still work from the left toolbar (📤 icon).';
  wrap.appendChild(hint);

  // Advanced Leaf Creator — opens a full-screen mode in the main scene with
  // the leaf framed up close, plus a docked panel for shape/material/texture.
  const advBtn = document.createElement('button');
  advBtn.type = 'button';
  advBtn.className = 'lc-open-btn';
  advBtn.innerHTML = iconSvg('leaf', 14) + '<span>Open Advanced Leaf Creator</span>';
  advBtn.addEventListener('click', () => {
    if (typeof openLeafCreator === 'function') openLeafCreator();
  });
  wrap.appendChild(advBtn);

  const renderPreview = () => {
    const shape = P.leafShape || 'Texture';
    const ctx = preview.getContext('2d');
    const S = 280;
    ctx.clearRect(0, 0, S, S);
    if (shape === 'Texture' || shape === 'Upload') {
      const map = (shape === 'Upload' ? (leafMatA.map && leafMatA.map !== leafMapA ? leafMatA.map : null) : leafMapA);
      const img = map && map.image;
      if (img && img.complete !== false) {
        try { ctx.drawImage(img, 0, 0, S, S); }
        catch { /* image not ready */ }
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(shape === 'Upload' ? 'Uploaded PNG' : 'Default PNG', S / 2, S / 2 + 4);
      }
      return;
    }
    const profile = shape === 'Custom'
      ? P.leafProfile
      : { ...P.leafProfile, ...LEAF_PRESETS[shape] };
    drawLeafToCanvas(ctx, profile, S, { preview: true });
  };

  // --- 3D leaf preview ---------------------------------------------------
  // Dedicated WebGPURenderer on its own canvas so we don't stall the main
  // render loop. Built lazily on first render to avoid paying the init
  // cost if the user never opens the Leaf Shape panel. Uses a fresh
  // MeshStandardMaterial (not the app's NodeMaterial) to skip TSL wind
  // displacement + bark-skin-style nodes in the preview scene.
  let preview3DState = null;
  let render3DQueued = false;
  const render3DPreview = () => {
    // Skip while 2D preview is active — no reason to spin up WebGPU or
    // render offscreen if the user isn't looking at it.
    if (!is3D) return;
    if (render3DQueued) return;
    render3DQueued = true;
    requestAnimationFrame(async () => {
      render3DQueued = false;
      const s = await ensurePreview3D();
      if (!s) return;
      // Double-sided plain material so bends are visible from either side.
      // Update albedo + normal each render so live slider edits reflect.
      const shape = P.leafShape || 'Texture';
      const usingProcedural = shape !== 'Texture' && shape !== 'Upload';
      s.mat.map = leafMatA.map || leafMapA;
      s.mat.normalMap = usingProcedural ? null : leafNormal;
      s.mat.bumpMap = usingProcedural ? (_proceduralLeafBumpTex || null) : null;
      s.mat.bumpScale = usingProcedural ? (P.leafBumpScale ?? 0.015) : 0;
      s.mat.color.setStyle(usingProcedural ? (P.leafProfile.color || '#4a7a3a') : '#ffffff');
      s.mat.needsUpdate = true;
      // Swap to the current leafGeo so bend / silhouette edits show.
      if (s.mesh.geometry !== leafGeo) s.mesh.geometry = leafGeo;
      try { await s.renderer.render(s.scene, s.camera); } catch {}
    });
  };
  const ensurePreview3D = async () => {
    if (preview3DState) return preview3DState;
    try {
      const r = new THREE.WebGPURenderer({ canvas: preview3D, antialias: true, alpha: true });
      await r.init();
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.setSize(preview3D.clientWidth || 280, preview3D.clientHeight || 280, false);
      const scene = new THREE.Scene();
      // Soft dual-tone hemi so both sides read well; punchy key + rim for form.
      const hemi = new THREE.HemisphereLight(0xeef4d8, 0x2a361f, 0.8);
      scene.add(hemi);
      const key  = new THREE.DirectionalLight(0xfff2d6, 2.2); key.position.set(2, 3, 2); scene.add(key);
      const rim  = new THREE.DirectionalLight(0xb6d0ff, 1.1); rim.position.set(-2, 1, -2); scene.add(rim);
      const fill = new THREE.DirectionalLight(0xffffff, 0.3); fill.position.set(0, -2, 2); scene.add(fill);
      // Pivot at leaf base (y=0). Leaf is built in +Y. Camera looks from front.
      const cam = new THREE.PerspectiveCamera(38, 1, 0.05, 20);
      cam.position.set(0.8, 0.55, 1.35);
      const target = new THREE.Vector3(0, 0.45, 0);
      cam.lookAt(target);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: leafMatA.map || leafMapA,
        normalMap: leafNormal,
        normalScale: new THREE.Vector2(0.25, 0.25),
        side: THREE.DoubleSide,
        roughness: 0.55,
        metalness: 0,
        alphaTest: 0.01,
      });
      const mesh = new THREE.Mesh(leafGeo, mat);
      scene.add(mesh);
      const ctl = new OrbitControls(cam, preview3D);
      ctl.target.copy(target);
      ctl.enableDamping = true;
      ctl.dampingFactor = 0.12;
      ctl.minDistance = 0.5;
      ctl.maxDistance = 4;
      ctl.enablePan = false;
      ctl.addEventListener('change', () => render3DPreview());
      // Keep damping alive for ~0.6s after last interaction so the motion
      // glides to a stop instead of snapping.
      let dampTicks = 0;
      const dampLoop = () => {
        if (dampTicks-- <= 0) return;
        ctl.update();
        render3DPreview();
        requestAnimationFrame(dampLoop);
      };
      ctl.addEventListener('start', () => {});
      ctl.addEventListener('end', () => { dampTicks = 36; requestAnimationFrame(dampLoop); });
      // Resize observer — react to sidebar width changes.
      const ro = new ResizeObserver(() => {
        const w = preview3D.clientWidth || 280, h = preview3D.clientHeight || 280;
        r.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        render3DPreview();
      });
      ro.observe(preview3D);
      preview3DState = { renderer: r, scene, camera: cam, mat, mesh, controls: ctl };
      return preview3DState;
    } catch (err) {
      console.warn('[leaf 3D preview] init failed, falling back to 2D thumbnail only:', err);
      preview3D.style.display = 'none';
      preview3DState = { fallback: true };
      return null;
    }
  };

  const syncCustom = () => {
    customWrap.style.display = P.leafShape === 'Custom' ? '' : 'none';
    colorRow.style.display = (P.leafShape === 'Texture' || P.leafShape === 'Upload') ? 'none' : '';
    // Custom always uses the silhouette drawer — build it the first time
    // Custom is opened, and keep it in sync with P.leafProfile.silhouette.
    if (P.leafShape === 'Custom') {
      P.leafProfile.mode = 'silhouette';
      ensureSilhouetteEditor();
      if (leafSilhouetteEditor) leafSilhouetteEditor.setPoints(P.leafProfile.silhouette);
    }
    for (const { key, row } of sliderRefs) {
      const scrub = row.querySelector('.scrubber');
      if (scrub && scrub._applyValue && key in P.leafProfile) {
        scrub._applyValue(P.leafProfile[key]);
      }
    }
  };

  select.addEventListener('change', () => {
    const prev = P.leafShape;
    P.leafShape = select.value;
    // Seed Custom's silhouette from whatever preset the user was looking at,
    // so the drawer opens on a leaf that matches what they just saw.
    if (P.leafShape === 'Custom' && prev !== 'Custom') {
      const preset = LEAF_PRESETS[prev];
      if (preset) {
        Object.assign(P.leafProfile, preset);
        if (Array.isArray(preset.silhouette)) {
          P.leafProfile.silhouette = preset.silhouette.map(p => ({ x: p.x, y: p.y }));
        } else {
          P.leafProfile.silhouette = _seedSilhouetteFromAnalytic({ ...P.leafProfile, ...preset, mode: 'analytic' });
        }
      } else if (!Array.isArray(P.leafProfile.silhouette) || P.leafProfile.silhouette.length < 3) {
        P.leafProfile.silhouette = _seedSilhouetteFromAnalytic({ ...P.leafProfile, mode: 'analytic' });
      }
      P.leafProfile.mode = 'silhouette';
    }
    if (P.leafShape === 'Upload') {
      toast('Click the leaf-upload button in the toolbar to load a PNG.', 'info', 2600);
    }
    syncCustom();
    applyLeafShape();
    renderPreview();
    render3DPreview();
    markRenderDirty(3);
    commitHistorySoon();
  });

  // Expose a refresh hook so species / upload changes can update this UI.
  _refreshLeafShapePanel = () => {
    select.value = P.leafShape;
    syncCustom();
    _syncLeafColorPickers();
    renderPreview();
    render3DPreview();
  };

  syncCustom();
  renderPreview();
  // Apply once so the first-load state is consistent with P.leafShape.
  applyLeafShape();

  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}

// --- Advanced Leaf Creator ------------------------------------------------
// A dedicated inspection + editing mode. Hides the tree and parks a single
// scaled-up leaf at origin so the user can orbit it freely and tune shape /
// material / texture with a docked panel. All edits write to the same P.* /
// material objects the tree leaves use, so closing the creator keeps the
// changes on the live tree without a "commit" step.
let _leafCreatorActive = false;
let _leafCreatorPreviewMesh = null;
let _leafCreatorPreviewMat = null;
let _leafCreatorStudioMesh = null;    // floor disc (studio backdrop)
let _leafCreatorGroup = null;
let _leafCreatorChromeEl = null;
let _leafCreatorPanelEl = null;
let _leafCreatorSavedState = null;
let _leafCreatorClipboard = null;      // in-memory last "Copy"
let _leafCreatorAutoSpin = false;
let _leafCreatorSpinRaf = null;
let _leafCreatorWindPreview = false;
let _leafCreatorEscHandler = null;
let _leafCreatorRefreshPanel = null;
let _leafCreatorRotateMode = false;
let _leafCreatorRotateHandlers = null;
// Preview-only geometry swap: 'leaf' (real procedural leaf), 'plane'
// (flat card for texture inspection), 'sphere' (wraps the atlas on a
// ball so tiling / alpha behavior reads at a glance).
let _leafCreatorPreviewShape = 'leaf';
let _leafCreatorPlaneGeo = null;
let _leafCreatorSphereGeo = null;
function _leafCreatorGetPreviewGeo() {
  switch (_leafCreatorPreviewShape) {
    case 'plane':
      if (!_leafCreatorPlaneGeo) {
        // Match the leaf's world footprint: ~1 unit tall, 0.7 wide, pivot at
        // the bottom so it sits on the studio floor like the leaf does.
        const g = new THREE.PlaneGeometry(0.7, 1.0, 1, 1);
        g.translate(0, 0.5, 0);
        _leafCreatorPlaneGeo = g;
      }
      return _leafCreatorPlaneGeo;
    case 'sphere':
      if (!_leafCreatorSphereGeo) {
        const g = new THREE.SphereGeometry(0.5, 48, 32);
        g.translate(0, 0.5, 0);
        _leafCreatorSphereGeo = g;
      }
      return _leafCreatorSphereGeo;
    case 'leaf':
    default:
      return leafGeo;
  }
}
function _leafCreatorSetPreviewShape(shape) {
  if (_leafCreatorPreviewShape === shape) return;
  _leafCreatorPreviewShape = shape;
  if (_leafCreatorPreviewMesh) {
    _leafCreatorPreviewMesh.geometry = _leafCreatorGetPreviewGeo();
    _leafCreatorApplyMagazinePose();
  }
  // Sphere reads better without alphaTest (no silhouette alpha to preserve).
  if (_leafCreatorPreviewMat) {
    _leafCreatorPreviewMat.alphaTest = shape === 'sphere' ? 0 : 0.01;
    _leafCreatorPreviewMat.transparent = shape !== 'sphere';
    _leafCreatorPreviewMat.needsUpdate = true;
  }
  markRenderDirty(3);
}
// Magazine pose — the leaf lies flat face-up with a slight 3/4 tilt and a
// touch of yaw so the silhouette reads as a photographed specimen instead
// of an architectural elevation. Floats a hair above the disc so the drop
// shadow has room to breathe.
function _leafCreatorApplyMagazinePose() {
  if (!_leafCreatorPreviewMesh) return;
  if (_leafCreatorPreviewShape === 'sphere') {
    _leafCreatorPreviewMesh.rotation.set(0, 0, 0);
    _leafCreatorPreviewMesh.position.set(0, 0, 0);
  } else {
    _leafCreatorPreviewMesh.rotation.set(-Math.PI / 2 + 0.18, 0.28, 0.07);
    _leafCreatorPreviewMesh.position.set(0, 0.15, 0);
  }
}

// Brief radial-gradient fade overlay — softens the mode switch so the
// sidebar slide-out + camera reframe doesn't feel abrupt. Auto-removes
// after its CSS animation finishes.
function _leafCreatorFadePulse() {
  const el = document.createElement('div');
  el.className = 'lc-fade';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

// Drag-to-rotate: disables OrbitControls, installs pointer handlers on the
// canvas that rotate the preview mesh around world Y (horizontal drag) and
// world X (vertical drag). Mirrors sketchfab-style turntable grab.
function _leafCreatorEnableRotate() {
  if (_leafCreatorRotateHandlers) return;
  if (!_leafCreatorPreviewMesh) return;
  controls.enabled = false;
  const canvas = renderer.domElement;
  canvas.style.cursor = 'grab';
  let dragging = false;
  let pid = -1;
  let lastX = 0, lastY = 0;
  const onDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    pid = e.pointerId;
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture?.(pid);
    canvas.style.cursor = 'grabbing';
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    // 0.006 rad/px ≈ ~0.34°/px — comfortable turntable speed.
    _leafCreatorPreviewMesh.rotation.y += dx * 0.008;
    _leafCreatorPreviewMesh.rotation.x += dy * 0.008;
    markRenderDirty(1);
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture?.(pid); } catch {}
    canvas.style.cursor = 'grab';
  };
  // Capture-phase so we win against OrbitControls even when controls.enabled
  // briefly flips back (defensive — we already disabled it).
  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointermove', onMove, true);
  canvas.addEventListener('pointerup', onUp, true);
  canvas.addEventListener('pointercancel', onUp, true);
  _leafCreatorRotateHandlers = { canvas, onDown, onMove, onUp };
}
function _leafCreatorDisableRotate() {
  if (!_leafCreatorRotateHandlers) return;
  const { canvas, onDown, onMove, onUp } = _leafCreatorRotateHandlers;
  canvas.removeEventListener('pointerdown', onDown, true);
  canvas.removeEventListener('pointermove', onMove, true);
  canvas.removeEventListener('pointerup', onUp, true);
  canvas.removeEventListener('pointercancel', onUp, true);
  canvas.style.cursor = '';
  _leafCreatorRotateHandlers = null;
  if (_leafCreatorActive) controls.enabled = true;
}

function _ensureLeafCreatorScene() {
  if (_leafCreatorGroup) return;
  const group = new THREE.Group();
  group.name = '__leafCreatorGroup';
  group.visible = false;

  // Soft studio floor — gives the leaf a subtle contact shadow + orientation
  // reference without pulling focus.
  const discGeo = new THREE.CircleGeometry(4.5, 96);
  const discMat = new THREE.MeshStandardMaterial({
    color: 0x0c1412, roughness: 1.0, metalness: 0,
    transparent: true, opacity: 0.6,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.01;
  disc.receiveShadow = true;
  group.add(disc);
  _leafCreatorStudioMesh = disc;

  // The leaf itself — uses a local MeshPhysicalMaterial (not the app's TSL
  // leaf NodeMaterial) so per-instance wind nodes don't run on a single
  // non-instanced mesh. MeshPhysical so transmission / sheen / clearcoat
  // edits render on the preview, not just on the tree.
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: leafMatA.map || leafMapA,
    normalMap: leafNormal,
    normalScale: new THREE.Vector2(0.25, 0.25),
    side: THREE.DoubleSide,
    roughness: 0.55,
    metalness: 0,
    alphaTest: 0.01,
    transparent: true,
    transmission: 0,
    thickness: 0.35,
    ior: 1.35,
    clearcoat: 0,
    clearcoatRoughness: 0.3,
    sheen: 0,
  });
  const mesh = new THREE.Mesh(leafGeo, mat);
  mesh.scale.setScalar(5);
  mesh.castShadow = true;
  group.add(mesh);

  scene.add(group);
  _leafCreatorGroup = group;
  _leafCreatorPreviewMesh = mesh;
  _leafCreatorPreviewMat = mat;
}

function _refreshLeafCreatorPreviewMat() {
  if (!_leafCreatorPreviewMat) return;
  const shape = P.leafShape || 'Texture';
  const usingProcedural = shape !== 'Texture' && shape !== 'Upload';
  const mat = _leafCreatorPreviewMat;

  // Mirror leafMatA's albedo + normal/bump choice so the preview tracks
  // whatever the shape-pipeline picked (procedural canvas, user upload, or
  // the bundled PNG). leafMatA is a NodeMaterial but its `.map` is a plain
  // Texture, which works on a MeshPhysicalMaterial directly.
  mat.map = leafMatA.map || leafMapA;
  mat.normalMap = usingProcedural ? null : (leafMatA.normalMap || leafNormal);
  mat.bumpMap = usingProcedural ? (_proceduralLeafBumpTex || null) : null;
  mat.bumpScale = usingProcedural ? (P.leafBumpScale ?? 0.015) : 0;

  // Full PBR mirror so every slider in the creator's Material section
  // affects the preview immediately — transmission, sheen, clearcoat etc.
  // Color: procedural modes pre-tint into the atlas, so the material color
  // stays white; texture/upload modes get the seasonal tint from leafMatA.
  if (usingProcedural) {
    mat.color.setStyle(P.leafProfile.color || '#4a7a3a');
  } else if (leafMatA.color) {
    mat.color.copy(leafMatA.color);
  } else {
    mat.color.setStyle('#ffffff');
  }
  mat.roughness = P.leafRoughness ?? 0.55;
  mat.transmission = P.leafTransmission ?? 0;
  mat.thickness = P.leafThickness ?? 0.35;
  mat.ior = P.leafIOR ?? 1.35;
  mat.clearcoat = P.leafClearcoat ?? 0;
  mat.clearcoatRoughness = P.leafClearcoatRough ?? 0.3;
  mat.sheen = P.leafSheen ?? 0;
  if (mat.sheen > 0 && mat.sheenColor) mat.sheenColor.copy(mat.color);
  const ns = P.leafNormalStrength ?? 0.25;
  mat.normalScale.set(ns, ns);

  mat.needsUpdate = true;
  // Only re-bind to the live leafGeo when the preview is showing the real
  // leaf shape — otherwise we'd clobber the user's selected preview geo
  // (flat card, sphere) every time applyLeafShape rebuilds leafGeo.
  if (_leafCreatorPreviewMesh && _leafCreatorPreviewShape === 'leaf' && _leafCreatorPreviewMesh.geometry !== leafGeo) {
    _leafCreatorPreviewMesh.geometry = leafGeo;
  }
  markRenderDirty(3);
}

function _leafCreatorAnimateSpin() {
  if (!_leafCreatorActive || !_leafCreatorAutoSpin) { _leafCreatorSpinRaf = null; return; }
  if (_leafCreatorPreviewMesh) {
    _leafCreatorPreviewMesh.rotation.y += 0.006;
    markRenderDirty(1);
  }
  _leafCreatorSpinRaf = requestAnimationFrame(_leafCreatorAnimateSpin);
}

function openLeafCreator() {
  if (_leafCreatorActive) return;
  _ensureLeafCreatorScene();

  _leafCreatorSavedState = {
    camPos: camera.position.clone(),
    camTgt: controls.target.clone(),
    minDist: controls.minDistance,
    maxDist: controls.maxDistance,
    maxPolar: controls.maxPolarAngle,
    windEnabled: P.wind.enabled,
    physicsOn,
    vis: {
      tree: !!(treeMesh && treeMesh.visible),
      wire: !!(treeWireMesh && treeWireMesh.visible),
      spline: !!(treeSplineMesh && treeSplineMesh.visible),
      splineDots: !!(treeSplineDots && treeSplineDots.visible),
      leafA: !!(leafInstA && leafInstA.visible),
      leafB: !!(leafInstB && leafInstB.visible),
      stem: !!(typeof stemInst !== 'undefined' && stemInst && stemInst.visible),
      cone: !!(typeof coneInst !== 'undefined' && coneInst && coneInst.visible),
      leafFall: !!(leafInstFall && leafInstFall.visible),
      person: !!(typeof personRefMesh !== 'undefined' && personRefMesh && personRefMesh.visible),
    },
    // Snapshot of leaf P.* keys so "Reset" and "Discard" can restore.
    p: _leafCreatorSnapshot(),
  };

  // Hide the tree. Keep cyclorama + environment so the leaf still reads with
  // the scene's ambient/hemi/IBL lighting.
  if (treeMesh) treeMesh.visible = false;
  if (treeWireMesh) treeWireMesh.visible = false;
  if (treeSplineMesh) treeSplineMesh.visible = false;
  if (treeSplineDots) treeSplineDots.visible = false;
  if (leafInstA) leafInstA.visible = false;
  if (leafInstB) leafInstB.visible = false;
  if (typeof stemInst !== 'undefined' && stemInst) stemInst.visible = false;
  if (typeof coneInst !== 'undefined' && coneInst) coneInst.visible = false;
  if (leafInstFall) leafInstFall.visible = false;
  if (typeof personRefMesh !== 'undefined' && personRefMesh) personRefMesh.visible = false;

  P.wind.enabled = false;
  physicsOn = false;

  _leafCreatorActive = true;
  document.body.classList.add('leaf-creator-mode');
  _leafCreatorGroup.visible = true;
  _leafCreatorApplyMagazinePose();
  _refreshLeafCreatorPreviewMat();

  // Magazine framing: leaf lying flat face-up, camera looks down from a
  // photography-style 3/4 angle. Scale-5 leaf ≈ 5 units long on the floor,
  // so the camera target sits around the leaf's visual midpoint.
  controls.minDistance = 1.0;
  controls.maxDistance = 20;
  controls.maxPolarAngle = Math.PI; // allow underside inspection
  reframeAnim = {
    fromCam: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toCam: new THREE.Vector3(3.4, 4.2, 4.6),
    toTarget: new THREE.Vector3(0, 0.55, -1.2),
    t: 0,
    duration: 1.1,
  };

  _leafCreatorFadePulse();
  _buildLeafCreatorChrome();
  _buildLeafCreatorPanel();

  _leafCreatorEscHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeLeafCreator(); }
  };
  window.addEventListener('keydown', _leafCreatorEscHandler);

  markRenderDirty(6);
  toast('Advanced Leaf Creator — orbit to inspect, tweak shape & material', 'info', 2000);
}

function closeLeafCreator() {
  if (!_leafCreatorActive) return;
  _leafCreatorActive = false;
  _leafCreatorAutoSpin = false;
  _leafCreatorRotateMode = false;
  _leafCreatorDisableRotate();
  if (_leafCreatorSpinRaf) { cancelAnimationFrame(_leafCreatorSpinRaf); _leafCreatorSpinRaf = null; }

  // Stagger exit: panel + chrome animate out first; body class (which drives
  // sidebar/toolbar slide-back) drops after a short delay so the two don't
  // visually overlap on the right edge.
  const panel = _leafCreatorPanelEl;
  const chrome = _leafCreatorChromeEl;
  if (panel) panel.classList.add('lc-exit');
  if (chrome) chrome.classList.add('lc-exit');
  _leafCreatorPanelEl = null;
  _leafCreatorChromeEl = null;
  _leafCreatorRefreshPanel = null;

  setTimeout(() => {
    document.body.classList.remove('leaf-creator-mode');
  }, 200);
  setTimeout(() => {
    panel?.remove();
    chrome?.remove();
  }, 360);

  if (_leafCreatorEscHandler) {
    window.removeEventListener('keydown', _leafCreatorEscHandler);
    _leafCreatorEscHandler = null;
  }

  _leafCreatorFadePulse();

  if (_leafCreatorGroup) _leafCreatorGroup.visible = false;

  const s = _leafCreatorSavedState;
  if (s) {
    if (treeMesh) treeMesh.visible = s.vis.tree;
    if (treeWireMesh) treeWireMesh.visible = s.vis.wire;
    if (treeSplineMesh) treeSplineMesh.visible = s.vis.spline;
    if (treeSplineDots) treeSplineDots.visible = s.vis.splineDots;
    if (leafInstA) leafInstA.visible = s.vis.leafA;
    if (leafInstB) leafInstB.visible = s.vis.leafB;
    if (typeof stemInst !== 'undefined' && stemInst) stemInst.visible = s.vis.stem;
    if (typeof coneInst !== 'undefined' && coneInst) coneInst.visible = s.vis.cone;
    if (leafInstFall) leafInstFall.visible = s.vis.leafFall;
    if (typeof personRefMesh !== 'undefined' && personRefMesh) personRefMesh.visible = s.vis.person;
    P.wind.enabled = s.windEnabled;
    physicsOn = s.physicsOn;
    controls.enabled = true;
    controls.minDistance = s.minDist;
    controls.maxDistance = s.maxDist;
    controls.maxPolarAngle = s.maxPolar;
    reframeAnim = {
      fromCam: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toCam: s.camPos.clone(),
      toTarget: s.camTgt.clone(),
      t: 0,
      duration: 1.1,
    };
  }
  _leafCreatorSavedState = null;

  // Make sure the sidebar's Leaf Shape preview reflects any changes made.
  _refreshLeafShapePanel?.();
  markRenderDirty(6);
}

// Keys the creator is allowed to reset / copy / paste. Central so randomize,
// reset, copy, paste all operate on the same set.
const _LC_KEYS = [
  'leafShape',
  'leafMidribCurl', 'leafApexCurl',
  'leafRoughness', 'leafTransmission', 'leafThickness', 'leafIOR',
  'leafNormalStrength', 'leafBumpScale',
  'leafHueShift', 'leafBackHue', 'leafBackLum', 'leafBackMix',
  'leafSheen', 'leafClearcoat', 'leafClearcoatRough',
];

function _leafCreatorSnapshot() {
  const o = {};
  for (const k of _LC_KEYS) o[k] = P[k];
  o.leafProfile = JSON.parse(JSON.stringify(P.leafProfile || {}));
  return o;
}
function _leafCreatorApplySnapshot(snap) {
  if (!snap) return;
  for (const k of _LC_KEYS) if (k in snap) P[k] = snap[k];
  if (snap.leafProfile) P.leafProfile = JSON.parse(JSON.stringify(snap.leafProfile));
  applyLeafShape();
  applyLeafMaterial();
  _refreshLeafCreatorPreviewMat();
  _refreshLeafShapePanel?.();
  _leafCreatorRefreshPanel?.();
  markRenderDirty(3);
}

function _buildLeafCreatorChrome() {
  if (_leafCreatorChromeEl) return _leafCreatorChromeEl;
  const bar = document.createElement('div');
  bar.id = 'leaf-creator-chrome';
  bar.innerHTML = `
    <div class="lc-bar-left">
      <span class="lc-bar-dot"></span>
      <span class="lc-bar-title">Leaf Creator</span>
      <span class="lc-bar-sub">inspect · shape · material · texture</span>
    </div>
    <div class="lc-bar-tools">
      <button type="button" class="lc-bar-btn" data-lc="rotate" title="Drag to rotate the leaf around its own axis">
        ${iconSvg('rotate-axis', 13)}
        <span>Rotate</span>
      </button>
      <button type="button" class="lc-bar-btn" data-lc="spin" title="Auto-rotate the leaf">
        ${iconSvg('rotate-cw', 13)}
        <span>Spin</span>
      </button>
      <button type="button" class="lc-bar-btn" data-lc="wind" title="Preview wind flutter">
        ${iconSvg('wind', 13)}
        <span>Wind</span>
      </button>
      <button type="button" class="lc-bar-btn" data-lc="wireframe" title="Show wireframe">
        ${iconSvg('wireframe', 13)}
        <span>Wire</span>
      </button>
      <button type="button" class="lc-bar-btn" data-lc="recenter" title="Recenter camera on the leaf">
        ${iconSvg('crosshair', 13)}
        <span>Recenter</span>
      </button>
      <span class="lc-bar-sep"></span>
      <button type="button" class="lc-bar-btn" data-lc="randomize" title="Randomize shape & material within sane bounds">
        ${iconSvg('dice-5', 13)}
        <span>Randomize</span>
      </button>
      <button type="button" class="lc-bar-btn" data-lc="copy" title="Copy leaf settings to clipboard (JSON)">
        ${iconSvg('clipboard-copy', 13)}
        <span>Copy</span>
      </button>
      <button type="button" class="lc-bar-btn" data-lc="paste" title="Paste leaf settings from clipboard (JSON)">
        ${iconSvg('clipboard', 13)}
        <span>Paste</span>
      </button>
      <button type="button" class="lc-bar-btn" data-lc="reset" title="Reset to the state when you opened the creator">
        ${iconSvg('rotate-ccw', 13)}
        <span>Reset</span>
      </button>
    </div>
    <div class="lc-bar-right">
      <button type="button" class="lc-bar-close" data-lc="close" title="Close (Esc)">
        ${iconSvg('x', 14)}
        <span>Done</span>
      </button>
    </div>
  `;
  canvasWrap.appendChild(bar);
  _leafCreatorChromeEl = bar;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lc]');
    if (!btn) return;
    const act = btn.dataset.lc;
    if (act === 'close') closeLeafCreator();
    else if (act === 'recenter') {
      _leafCreatorApplyMagazinePose();
      reframeAnim = {
        fromCam: camera.position.clone(),
        fromTarget: controls.target.clone(),
        toCam: new THREE.Vector3(3.4, 4.2, 4.6),
        toTarget: new THREE.Vector3(0, 0.55, -1.2),
        t: 0,
        duration: 0.7,
      };
    }
    else if (act === 'rotate') {
      _leafCreatorRotateMode = !_leafCreatorRotateMode;
      btn.classList.toggle('on', _leafCreatorRotateMode);
      if (_leafCreatorRotateMode) _leafCreatorEnableRotate();
      else _leafCreatorDisableRotate();
    }
    else if (act === 'wireframe') {
      if (!_leafCreatorPreviewMat) return;
      _leafCreatorPreviewMat.wireframe = !_leafCreatorPreviewMat.wireframe;
      btn.classList.toggle('on', _leafCreatorPreviewMat.wireframe);
      markRenderDirty(2);
    }
    else if (act === 'spin') {
      _leafCreatorAutoSpin = !_leafCreatorAutoSpin;
      btn.classList.toggle('on', _leafCreatorAutoSpin);
      if (_leafCreatorAutoSpin && !_leafCreatorSpinRaf) _leafCreatorAnimateSpin();
    }
    else if (act === 'wind') {
      _leafCreatorWindPreview = !_leafCreatorWindPreview;
      btn.classList.toggle('on', _leafCreatorWindPreview);
      // Brief sway: mesh is a single plane, the app's wind is per-instance
      // via instanceIndex so we can't reuse it here. Fake a soft rock on the
      // preview mesh's local Z rotation.
      if (_leafCreatorWindPreview) _leafCreatorWindAnim();
    }
    else if (act === 'randomize') _leafCreatorRandomize();
    else if (act === 'copy') _leafCreatorCopy();
    else if (act === 'paste') _leafCreatorPaste();
    else if (act === 'reset') {
      _leafCreatorApplySnapshot(_leafCreatorSavedState?.p);
      toast('Leaf reset', 'info', 1000);
    }
  });
  return bar;
}

let _leafCreatorWindT0 = 0;
function _leafCreatorWindAnim() {
  if (!_leafCreatorActive || !_leafCreatorWindPreview) return;
  if (!_leafCreatorPreviewMesh) return;
  const t = performance.now() / 1000;
  const w = P.wind?.strength ?? 0.08;
  const amp = 0.12 + w * 0.6;
  _leafCreatorPreviewMesh.rotation.z = Math.sin(t * 2.2) * amp + Math.sin(t * 3.7) * amp * 0.35;
  markRenderDirty(1);
  requestAnimationFrame(_leafCreatorWindAnim);
}

function _leafCreatorRandomize() {
  const r = (a, b) => a + Math.random() * (b - a);
  const shapes = Object.keys(LEAF_PRESETS);
  P.leafShape = shapes[(Math.random() * shapes.length) | 0];
  P.leafMidribCurl = r(-0.15, 0.45);
  P.leafApexCurl = r(-0.2, 0.3);
  P.leafRoughness = r(0.35, 0.85);
  P.leafTransmission = r(0.15, 0.7);
  P.leafThickness = r(0.15, 0.85);
  P.leafIOR = r(1.25, 1.55);
  P.leafNormalStrength = r(0.1, 0.55);
  P.leafBumpScale = r(0.005, 0.04);
  P.leafHueShift = r(-0.1, 0.1);
  P.leafBackHue = r(0.08, 0.2);
  P.leafBackLum = r(0.45, 0.85);
  P.leafBackMix = r(0.15, 0.55);
  P.leafSheen = r(0, 0.35);
  P.leafClearcoat = r(0, 0.25);
  P.leafClearcoatRough = r(0.1, 0.6);
  applyLeafShape();
  applyLeafMaterial();
  _refreshLeafCreatorPreviewMat();
  _refreshLeafShapePanel?.();
  _leafCreatorRefreshPanel?.();
  markRenderDirty(3);
  toast('Randomized', 'info', 900);
}

async function _leafCreatorCopy() {
  const snap = _leafCreatorSnapshot();
  const json = JSON.stringify(snap, null, 2);
  _leafCreatorClipboard = json;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(json);
    toast('Copied leaf JSON', 'success', 1100);
  } catch {
    toast('Copied (in-memory only)', 'info', 1100);
  }
}
async function _leafCreatorPaste() {
  let raw = null;
  try {
    if (navigator.clipboard?.readText) raw = await navigator.clipboard.readText();
  } catch {}
  if (!raw) raw = _leafCreatorClipboard;
  if (!raw) { toast('Nothing to paste', 'error', 1100); return; }
  try {
    const obj = JSON.parse(raw);
    _leafCreatorApplySnapshot(obj);
    toast('Pasted leaf settings', 'success', 1100);
  } catch {
    toast('Clipboard is not leaf JSON', 'error', 1300);
  }
}

function _buildLeafCreatorPanel() {
  if (_leafCreatorPanelEl) return _leafCreatorPanelEl;

  const panel = document.createElement('aside');
  panel.id = 'leaf-creator-panel';
  panel.innerHTML = `
    <header class="lc-panel-header">
      <div class="lc-panel-title">Leaf Studio</div>
      <div class="lc-panel-sub">changes apply live to the tree</div>
    </header>
    <div class="lc-panel-body"></div>
  `;
  document.body.appendChild(panel);
  _leafCreatorPanelEl = panel;
  const body = panel.querySelector('.lc-panel-body');

  const mkSection = (title, icon, { collapsed = false } = {}) => {
    const sec = document.createElement('section');
    sec.className = 'lc-section';
    if (collapsed) sec.classList.add('collapsed');
    const h = document.createElement('button');
    h.type = 'button';
    h.className = 'lc-section-head';
    h.innerHTML = `
      <span class="lc-section-icon">${icon || ''}</span>
      <span class="lc-section-title">${title}</span>
      <span class="lc-section-caret">${iconSvg('chevron-down', 12)}</span>
    `;
    const bodyEl = document.createElement('div');
    bodyEl.className = 'lc-section-body';
    sec.append(h, bodyEl);
    h.addEventListener('click', () => sec.classList.toggle('collapsed'));
    body.appendChild(sec);
    return bodyEl;
  };

  const onEdit = () => {
    // applyLeafShape rebuilds the silhouette + alpha mask. applyLeafMaterial
    // writes the PBR params (roughness / transmission / IOR / clearcoat /
    // sheen / back tint / hue shift) onto leafMatA + leafMatB — without it,
    // sliders in the Material section silently write P.* but nothing
    // renders the change.
    applyLeafShape();
    applyLeafMaterial();
    _refreshLeafCreatorPreviewMat();
    _refreshLeafShapePanel?.();
    markRenderDirty(3);
  };

  const mkSlider = (host, key, label, min, max, step) => {
    const row = createSliderRow(
      { key: `__lc_${key}`, label, min, max, step, default: P[key] },
      () => P[key],
      (v) => { P[key] = v; },
      onEdit,
      { noRegen: true },
    );
    host.appendChild(row);
    return row;
  };

  const mkProfileSlider = (host, key, label, min, max, step) => {
    const row = createSliderRow(
      { key: `__lc_prof_${key}`, label, min, max, step, default: P.leafProfile[key] },
      () => P.leafProfile[key],
      (v) => { P.leafProfile[key] = v; },
      onEdit,
      { noRegen: true },
    );
    host.appendChild(row);
    return row;
  };

  const mkColorRow = (host, label, getter, setter) => {
    const row = document.createElement('label');
    row.className = 'lc-color-row';
    const name = document.createElement('span');
    name.className = 'lc-row-label';
    name.textContent = label;
    const sw = document.createElement('span');
    sw.className = 'lc-color-sw';
    sw.style.background = getter();
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = getter();
    inp.addEventListener('input', () => {
      setter(inp.value);
      sw.style.background = inp.value;
      onEdit();
    });
    row.append(name, sw, inp);
    host.appendChild(row);
    return { row, sw, inp };
  };

  // ---- Shape section ----
  const shapeBody = mkSection('Shape',
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 C 7 7, 7 13, 12 22 C 17 13, 17 7, 12 2 Z"/></svg>');

  const shapeSelect = document.createElement('select');
  shapeSelect.className = 'lc-select';
  const SHAPES = ['Texture', ...Object.keys(LEAF_PRESETS), 'Custom', 'Upload'];
  for (const s of SHAPES) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s === 'Texture' ? 'Default PNG' : s === 'Upload' ? 'Uploaded PNG' : s;
    shapeSelect.appendChild(o);
  }
  shapeSelect.value = P.leafShape;
  shapeSelect.addEventListener('change', () => {
    const prev = P.leafShape;
    P.leafShape = shapeSelect.value;
    if (P.leafShape === 'Custom' && prev !== 'Custom') {
      const preset = LEAF_PRESETS[prev];
      if (preset) {
        Object.assign(P.leafProfile, preset);
        if (Array.isArray(preset.silhouette)) {
          P.leafProfile.silhouette = preset.silhouette.map(p => ({ x: p.x, y: p.y }));
        } else {
          P.leafProfile.silhouette = _seedSilhouetteFromAnalytic({ ...P.leafProfile, ...preset, mode: 'analytic' });
        }
      } else if (!Array.isArray(P.leafProfile.silhouette) || P.leafProfile.silhouette.length < 3) {
        P.leafProfile.silhouette = _seedSilhouetteFromAnalytic({ ...P.leafProfile, mode: 'analytic' });
      }
      P.leafProfile.mode = 'silhouette';
    }
    onEdit();
    rebuildProfileRows();
  });
  shapeBody.appendChild(shapeSelect);

  const profileHost = document.createElement('div');
  profileHost.className = 'lc-profile-rows';
  shapeBody.appendChild(profileHost);

  let lcSilhouetteEditor = null;

  const rebuildProfileRows = () => {
    profileHost.innerHTML = '';
    lcSilhouetteEditor = null;
    const isCustom = P.leafShape === 'Custom';
    const isProcedural = P.leafShape !== 'Texture' && P.leafShape !== 'Upload';
    if (isCustom) {
      P.leafProfile.mode = 'silhouette';
      if (!Array.isArray(P.leafProfile.silhouette) || P.leafProfile.silhouette.length < 3) {
        P.leafProfile.silhouette = LeafSilhouetteEditor.defaultPoints();
      }

      mkProfileSlider(profileHost, 'aspect',    'Width',  0.06, 1.0, 0.01);
      mkProfileSlider(profileHost, 'length',    'Length', 0.3,  1.0, 0.01);
      mkProfileSlider(profileHost, 'veinCount', 'Veins',  0,    12,  1);

      const silhouetteWrap = document.createElement('div');
      silhouetteWrap.className = 'lc-silhouette-wrap';
      profileHost.appendChild(silhouetteWrap);
      lcSilhouetteEditor = new LeafSilhouetteEditor(silhouetteWrap, {
        points: P.leafProfile.silhouette,
      });
      lcSilhouetteEditor.onChange = () => {
        P.leafProfile.silhouette = lcSilhouetteEditor.points;
        onEdit();
      };
    } else if (isProcedural) {
      const tip = document.createElement('div');
      tip.className = 'lc-hint';
      tip.textContent = 'Preset shape — switch to Custom to edit the silhouette, or upload a PNG.';
      profileHost.appendChild(tip);
    } else {
      const tip = document.createElement('div');
      tip.className = 'lc-hint';
      tip.textContent = P.leafShape === 'Upload' ? 'Using uploaded PNG. Replace via the Texture section below.' : 'Using the bundled PNG. Switch to a preset or Custom for procedural alpha.';
      profileHost.appendChild(tip);
    }
  };
  rebuildProfileRows();

  // ---- Bend section ----
  const bendBody = mkSection('Bend',
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 C 8 10, 16 10, 20 18"/><path d="M12 4v4"/></svg>');
  mkSlider(bendBody, 'leafMidribCurl', 'Midrib cup', -0.4, 0.6, 0.01);
  mkSlider(bendBody, 'leafApexCurl',   'Apex curl',  -0.4, 0.4, 0.01);

  // ---- Colors section ----
  const colorsBody = mkSection('Colors',
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18"/></svg>');

  const colorRows = document.createElement('div');
  colorRows.className = 'lc-color-rows';
  const fillRef = mkColorRow(colorRows, 'Fill',
    () => P.leafProfile.color || '#4a7a3a',
    (v) => { P.leafProfile.color = v; });
  const veinRef = mkColorRow(colorRows, 'Veins',
    () => P.leafProfile.veinColor || '#2f4a22',
    (v) => { P.leafProfile.veinColor = v; });
  // Manual leaf-color override — bypasses the seasonal palette and hue-shift
  // pipeline entirely. Pick any colour you want; the override checkbox below
  // toggles it on/off so the species' season tint is recoverable.
  const overrideRef = mkColorRow(colorRows, 'Override',
    () => P.leafColor || '#ffb7d5',
    (v) => { P.leafColor = v; });
  colorsBody.appendChild(colorRows);
  colorsBody.appendChild(mkCheckboxRow('Use override',
    () => !!P.leafColorOverride,
    (v) => { P.leafColorOverride = v; onEdit(); }));

  mkSlider(colorsBody, 'leafHueShift', 'Hue shift', -0.3, 0.3, 0.01);
  mkSlider(colorsBody, 'leafBackHue',  'Back hue',   0,   1,   0.01);
  mkSlider(colorsBody, 'leafBackLum',  'Back bright.', 0.2, 1, 0.02);
  mkSlider(colorsBody, 'leafBackMix',  'Back mix',   0,   1,   0.02);

  // ---- Material section ----
  const matBody = mkSection('Material',
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 18 0"/><path d="M3 12a9 9 0 0 0 18 0"/></svg>');
  mkSlider(matBody, 'leafRoughness',      'Roughness',    0, 1,    0.02);
  mkSlider(matBody, 'leafTransmission',   'Transmission', 0, 1,    0.02);
  mkSlider(matBody, 'leafThickness',      'Thickness',    0, 2,    0.05);
  mkSlider(matBody, 'leafIOR',            'IOR',          1.0, 2.0, 0.02);
  mkSlider(matBody, 'leafSheen',          'Sheen',        0, 1,    0.02);
  mkSlider(matBody, 'leafClearcoat',      'Waxy coat',    0, 1,    0.02);
  mkSlider(matBody, 'leafClearcoatRough', 'Coat rough.',  0, 1,    0.02);

  // ---- Normal / Bump section ----
  const bumpBody = mkSection('Normal & Bump',
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16l4-8 4 4 4-6 6 10"/></svg>',
    { collapsed: true });
  mkSlider(bumpBody, 'leafNormalStrength', 'Normal',    0, 1.5,  0.05);
  mkSlider(bumpBody, 'leafBumpScale',      'Vein bump', 0, 0.08, 0.002);

  // ---- Texture section ----
  const texBody = mkSection('Texture',
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5-7 7"/></svg>',
    { collapsed: true });

  const texRow = document.createElement('div');
  texRow.className = 'lc-tex-row';
  const texPreview = document.createElement('div');
  texPreview.className = 'lc-tex-preview';
  const refreshTexPreview = () => {
    const map = leafMatA.map || leafMapA;
    if (map && map.image && map.image.src) {
      texPreview.style.background = `#0e1410 center/contain no-repeat url("${map.image.src}")`;
    } else {
      texPreview.style.background = '#0e1410';
    }
  };
  refreshTexPreview();
  texRow.appendChild(texPreview);

  const texBtns = document.createElement('div');
  texBtns.className = 'lc-tex-btns';

  const uploadAlbedoBtn = document.createElement('button');
  uploadAlbedoBtn.type = 'button';
  uploadAlbedoBtn.className = 'lc-btn lc-btn-full';
  uploadAlbedoBtn.textContent = 'Upload albedo PNG';
  uploadAlbedoBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const tex = new THREE.Texture(img);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.needsUpdate = true;
          const isOriginal = (t) => t === leafMapA || t === leafMapB;
          for (const m of [leafMatA, leafMatB]) {
            if (m.map && !isOriginal(m.map) && m.map !== _proceduralLeafTex) m.map.dispose();
            _setLeafMapFor(m, tex);
          }
          P.leafShape = 'Upload';
          shapeSelect.value = 'Upload';
          rebuildProfileRows();
          onEdit();
          refreshTexPreview();
          toast('Leaf albedo replaced', 'success', 1100);
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });

  const uploadNormalBtn = document.createElement('button');
  uploadNormalBtn.type = 'button';
  uploadNormalBtn.className = 'lc-btn lc-btn-full';
  uploadNormalBtn.textContent = 'Upload normal map';
  uploadNormalBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const tex = new THREE.Texture(img);
          tex.colorSpace = THREE.NoColorSpace;
          tex.anisotropy = 8;
          tex.needsUpdate = true;
          for (const m of [leafMatA, leafMatB]) {
            if (m.normalMap && m.normalMap !== leafNormal) m.normalMap.dispose();
            m.normalMap = tex;
            m.needsUpdate = true;
          }
          onEdit();
          toast('Normal map replaced', 'success', 1100);
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });

  const restoreTexBtn = document.createElement('button');
  restoreTexBtn.type = 'button';
  restoreTexBtn.className = 'lc-btn lc-btn-full lc-btn-ghost';
  restoreTexBtn.textContent = 'Restore default PNG';
  restoreTexBtn.addEventListener('click', () => {
    P.leafShape = 'Texture';
    shapeSelect.value = 'Texture';
    for (const m of [leafMatA, leafMatB]) {
      if (m.normalMap && m.normalMap !== leafNormal) { m.normalMap.dispose?.(); m.normalMap = leafNormal; }
    }
    rebuildProfileRows();
    onEdit();
    refreshTexPreview();
  });

  texBtns.append(uploadAlbedoBtn, uploadNormalBtn, restoreTexBtn);
  texRow.appendChild(texBtns);
  texBody.appendChild(texRow);

  // ---- Mesh section (preview-only geometry swaps) ----
  // The preview mesh can project the leaf texture onto alternate carriers —
  // handy for inspecting the alpha atlas or seeing the lighting response on
  // a cleaner surface. "Leaf" is the real procedural mesh; "Flat card" and
  // "Sphere" are preview-only and don't affect the tree.
  const meshBody = mkSection('Mesh',
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L22 8 L22 16 L12 22 L2 16 L2 8 Z"/><path d="M12 2v20M2 8l20 8M22 8 2 16"/></svg>',
    { collapsed: true });

  const shapeTypeSelect = document.createElement('select');
  shapeTypeSelect.className = 'lc-select';
  for (const [v, label] of [['leaf', 'Procedural leaf'], ['plane', 'Flat card'], ['sphere', 'Sphere (texture wrap)']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    shapeTypeSelect.appendChild(o);
  }
  shapeTypeSelect.value = _leafCreatorPreviewShape;
  shapeTypeSelect.addEventListener('change', () => {
    _leafCreatorSetPreviewShape(shapeTypeSelect.value);
  });
  meshBody.appendChild(shapeTypeSelect);

  const wireRow = document.createElement('label');
  wireRow.className = 'lc-toggle-row';
  const wireName = document.createElement('span');
  wireName.className = 'lc-row-label';
  wireName.textContent = 'Wireframe';
  const wireCb = document.createElement('input');
  wireCb.type = 'checkbox';
  wireCb.checked = !!(_leafCreatorPreviewMat && _leafCreatorPreviewMat.wireframe);
  wireCb.addEventListener('change', () => {
    if (!_leafCreatorPreviewMat) return;
    _leafCreatorPreviewMat.wireframe = wireCb.checked;
    // Keep the chrome button in sync with the panel toggle.
    const btn = _leafCreatorChromeEl?.querySelector('[data-lc="wireframe"]');
    btn?.classList.toggle('on', wireCb.checked);
    markRenderDirty(2);
  });
  wireRow.append(wireName, wireCb);
  meshBody.appendChild(wireRow);

  const flatRow = document.createElement('label');
  flatRow.className = 'lc-toggle-row';
  const flatName = document.createElement('span');
  flatName.className = 'lc-row-label';
  flatName.textContent = 'Flat shading';
  const flatCb = document.createElement('input');
  flatCb.type = 'checkbox';
  flatCb.checked = !!(_leafCreatorPreviewMat && _leafCreatorPreviewMat.flatShading);
  flatCb.addEventListener('change', () => {
    if (!_leafCreatorPreviewMat) return;
    _leafCreatorPreviewMat.flatShading = flatCb.checked;
    _leafCreatorPreviewMat.needsUpdate = true;
    markRenderDirty(2);
  });
  flatRow.append(flatName, flatCb);
  meshBody.appendChild(flatRow);

  const hint = document.createElement('div');
  hint.className = 'lc-hint';
  hint.textContent = 'Flat card and Sphere are preview-only — the tree still renders the procedural leaf geometry.';
  meshBody.appendChild(hint);

  // ---- Studio section (backdrop + camera) ----
  const studioBody = mkSection('Studio',
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l3-6 3 2 4-8 3 4 5-5"/></svg>',
    { collapsed: true });

  const floorRow = document.createElement('label');
  floorRow.className = 'lc-toggle-row';
  const floorName = document.createElement('span');
  floorName.className = 'lc-row-label';
  floorName.textContent = 'Studio floor';
  const floorCb = document.createElement('input');
  floorCb.type = 'checkbox';
  floorCb.checked = true;
  floorCb.addEventListener('change', () => {
    if (_leafCreatorStudioMesh) _leafCreatorStudioMesh.visible = floorCb.checked;
    markRenderDirty(2);
  });
  floorRow.append(floorName, floorCb);
  studioBody.appendChild(floorRow);

  // Leaf display size (visual only — rescales the preview mesh, not P.leafSize)
  const sizeRow = createSliderRow(
    { key: '__lc_displaySize', label: 'Inspect size', min: 1.5, max: 10, step: 0.1, default: 5 },
    () => (_leafCreatorPreviewMesh?.scale?.x ?? 5),
    (v) => { if (_leafCreatorPreviewMesh) _leafCreatorPreviewMesh.scale.setScalar(v); markRenderDirty(2); },
    () => {},
    { noRegen: true },
  );
  studioBody.appendChild(sizeRow);

  _leafCreatorRefreshPanel = () => {
    shapeSelect.value = P.leafShape;
    rebuildProfileRows();
    // Refresh color swatches (snapshot restore etc.)
    fillRef.sw.style.background = P.leafProfile.color || '#4a7a3a';
    fillRef.inp.value = P.leafProfile.color || '#4a7a3a';
    veinRef.sw.style.background = P.leafProfile.veinColor || '#2f4a22';
    veinRef.inp.value = P.leafProfile.veinColor || '#2f4a22';
    refreshTexPreview();
    // Sync sliders inside the panel to their current P values.
    const scrubs = panel.querySelectorAll('.scrubber');
    scrubs.forEach((s) => {
      const key = (s.dataset.pkey || '').replace(/^__lc_(prof_)?/, '');
      if (!key) return;
      const src = s.dataset.pkey.startsWith('__lc_prof_') ? P.leafProfile : P;
      if (s._applyValue && key in src) s._applyValue(src[key]);
    });
  };

  return panel;
}

// 5. Conifer Foliage — needles + cones
addSectionLabel('Conifer Foliage', 'conifer', 'leaf');
buildConiferGroup('Needles');
buildConiferGroup('Cones');

// 5b. Bush — shape + foliage (shown only when treeType === 'bush')
addSectionLabel('Bush', 'bush', 'sprout');
buildBushGroup('Bush Shape');
buildBushGroup('Bush Foliage');

// 6. Bark — single consolidated card. All 30 controls inside, ordered
// Style → Pattern → Color → Surface → Mapping → Moss top-down.
addSectionLabel('Bark', null, 'layers');
buildParamGroup('Bark');

// 7. Scene — lighting preset
addSectionLabel('Scene', null, 'sun');
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'sun', 'Preset');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad';
  const select = document.createElement('select');
  select.className = 'select select-full';
  for (const name of Object.keys(LIGHTING_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = currentLighting;
  select.addEventListener('change', () => applyLighting(select.value));
  wrap.appendChild(select);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}
{
  // Backdrop — infinite ground vs. studio cyclorama
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'layers', 'Backdrop');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad';
  const select = document.createElement('select');
  select.className = 'select select-full';
  for (const [value, text] of [
    ['ground', 'Infinite ground'],
    ['cyclorama', 'Studio cyclorama'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = text;
    select.appendChild(opt);
  }
  select.value = sceneCfg.backdrop;
  select.addEventListener('change', () => { sceneCfg.backdrop = select.value; applyBackdrop(); });
  wrap.appendChild(select);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}
{
  // Camera — orbit pivot mode
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'camera', 'Camera');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad';
  const label = document.createElement('div');
  label.className = 'label-sm';
  label.textContent = 'Orbit around';
  const select = document.createElement('select');
  select.className = 'select select-full';
  for (const [value, text] of [
    ['target', 'Target (classic)'],
    ['cursor', 'Cursor (3D‑app style)'],
    ['center', 'Tree center'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = text;
    select.appendChild(opt);
  }
  select.value = sceneCfg.orbitPivot;
  select.addEventListener('change', () => { sceneCfg.orbitPivot = select.value; });
  const hint = document.createElement('div');
  hint.className = 'label-sm';
  hint.style.opacity = '0.7';
  hint.style.marginTop = '6px';
  hint.textContent = 'Cursor: pivots around what’s under the mouse at rotate start.';
  wrap.append(label, select, hint);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}
{
  // Environment / post-FX toggles
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'sun', 'Environment');
  details.appendChild(summary);
  const addToggle = (labelText, initial, onChange) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.gridTemplateColumns = '1fr auto';
    row.style.padding = '8px 20px';
    const lab = document.createElement('span');
    lab.className = 'name'; lab.textContent = labelText;
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.checked = !!initial;
    inp.addEventListener('change', () => onChange(inp.checked));
    row.append(lab, inp);
    details.appendChild(row);
    return inp;
  };
  addToggle('HDR Sky', sceneCfg.skyHdr, (v) => { sceneCfg.skyHdr = v; applySkyBackground(); });
  addToggle('SSAO', sceneCfg.ssaoOn, (v) => { sceneCfg.ssaoOn = v; updatePostPipeline(); });
  const ssaoRow = createSliderRow(
    { key: 'ssaoIntensity', label: 'SSAO strength', min: 0, max: 2, step: 0.05, default: 1.0, live: true },
    () => sceneCfg.ssaoIntensity,
    (v) => { sceneCfg.ssaoIntensity = v; if (uSsaoIntensity) uSsaoIntensity.value = v; },
    () => {},
  );
  details.appendChild(ssaoRow);
  addToggle('DOF (bokeh)', sceneCfg.dofOn, (v) => { sceneCfg.dofOn = v; updatePostPipeline(); });
  const dofFocusRow = createSliderRow(
    { key: 'dofFocus', label: 'Focus dist', min: 2, max: 50, step: 0.5, default: 12, live: true },
    () => sceneCfg.dofFocus,
    (v) => { sceneCfg.dofFocus = v; if (uDofFocus) uDofFocus.value = v; },
    () => {},
  );
  const dofApRow = createSliderRow(
    { key: 'dofAperture', label: 'Aperture', min: 0, max: 2, step: 0.02, default: 0.5, live: true },
    () => sceneCfg.dofAperture,
    (v) => { sceneCfg.dofAperture = v; if (uDofAperture) uDofAperture.value = v; },
    () => {},
  );
  details.appendChild(dofFocusRow);
  details.appendChild(dofApRow);
  sidebarBody.appendChild(details);
}

// 7b. App-level quality / overlay / capture controls. Scene-tab cards.
{
  // Quality preset — single dropdown that drives pixelRatio + shadow
  // quality + bloom in lockstep so users don't have to tune three sliders.
  // The individual sliders are still in the Settings card below for power
  // users who want overrides; this just gives a fast way to swing between
  // performance and visual fidelity.
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'sliders', 'Quality');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad';
  const label = document.createElement('div');
  label.className = 'label-sm';
  label.textContent = 'Preset';
  const select = document.createElement('select');
  select.className = 'select select-full';
  for (const [value, text] of [
    ['Performance', 'Performance — fastest'],
    ['Balanced',    'Balanced — default'],
    ['Quality',     'Quality — best looking'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = text;
    select.appendChild(opt);
  }
  select.value = P.settings.qualityPreset;
  function applyQualityPreset(name) {
    const presets = {
      Performance: { pixelRatio: 1,   shadowsEnabled: false, shadowQuality: 'Low',    bloomEnabled: false },
      Balanced:    { pixelRatio: Math.min(window.devicePixelRatio, 1.5), shadowsEnabled: true, shadowQuality: 'Medium', bloomEnabled: true  },
      Quality:     { pixelRatio: Math.min(window.devicePixelRatio, 2),   shadowsEnabled: true, shadowQuality: 'High',   bloomEnabled: true  },
    };
    const p = presets[name]; if (!p) return;
    P.settings.pixelRatio     = p.pixelRatio;
    P.settings.shadowsEnabled = p.shadowsEnabled;
    P.settings.shadowQuality  = p.shadowQuality;
    P.settings.bloomEnabled   = p.bloomEnabled;
    applyPixelRatio(p.pixelRatio);
    applyShadowsEnabled(p.shadowsEnabled);
    applyShadowQuality(p.shadowQuality);
    applyBloom(p.bloomEnabled, P.settings.bloomIntensity);
  }
  select.addEventListener('change', () => {
    P.settings.qualityPreset = select.value;
    applyQualityPreset(select.value);
  });
  wrap.append(label, select);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}
{
  // FPS / triangle counter overlay. The overlay element exists at
  // index.html:38 (#stats) and is populated by updateStats() every frame;
  // this just toggles its visibility.
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'activity', 'Stats overlay');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad';
  const row = document.createElement('label');
  row.className = 'row';
  row.style.cursor = 'pointer';
  row.style.gridTemplateColumns = '1fr auto';
  const lbl = document.createElement('span');
  lbl.className = 'name';
  lbl.textContent = 'Show fps / tri counter';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!P.settings.statsVisible;
  function applyStatsVis(on) {
    const el = document.getElementById('stats');
    if (el) el.style.display = on ? '' : 'none';
  }
  applyStatsVis(P.settings.statsVisible);
  cb.addEventListener('change', () => {
    P.settings.statsVisible = cb.checked;
    applyStatsVis(cb.checked);
  });
  row.append(lbl, cb);
  wrap.appendChild(row);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}
{
  // Auto-orbit — slow continuous Y-rotation around the orbit target.
  // Useful for hero shots and screen-recorded GIFs without having to
  // hand-drag the mouse. Cancels on user interaction (pointerdown on the
  // canvas via OrbitControls' 'start' event).
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'refresh-cw', 'Auto-orbit');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad';
  const row = document.createElement('label');
  row.className = 'row';
  row.style.cursor = 'pointer';
  row.style.gridTemplateColumns = '1fr auto';
  const lbl = document.createElement('span');
  lbl.className = 'name';
  lbl.textContent = 'Enable';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!P.settings.autoOrbit;
  cb.addEventListener('change', () => { P.settings.autoOrbit = cb.checked; });
  row.append(lbl, cb);
  wrap.appendChild(row);
  // Speed in deg/s.
  const speedRow = createSliderRow(
    { key: 'autoOrbitSpeed', label: 'Speed (°/s)', min: 1, max: 60, step: 0.5, default: 8, live: true },
    () => P.settings.autoOrbitSpeed,
    (v) => { P.settings.autoOrbitSpeed = v; },
    () => {},
    { noRegen: true },
  );
  wrap.appendChild(speedRow);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}

// 8. Dynamics — wind + PBD physics knobs
addSectionLabel('Dynamics', null, 'wind');
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'wind', 'Wind');
  details.appendChild(summary);
  const toggleRow = document.createElement('div');
  toggleRow.className = 'row';
  toggleRow.style.gridTemplateColumns = '1fr auto';
  toggleRow.style.padding = '8px 20px';
  const tLabel = document.createElement('span');
  tLabel.className = 'name'; tLabel.textContent = 'Enabled';
  const tInput = document.createElement('input');
  tInput.type = 'checkbox';
  tInput.checked = P.wind.enabled;
  tInput.addEventListener('change', () => {
    P.wind.enabled = tInput.checked;
    uWindEnable.value = tInput.checked ? 1 : 0;
  });
  toggleRow.append(tLabel, tInput);
  details.appendChild(toggleRow);
  for (const p of WIND_SCHEMA) {
    const row = createSliderRow(
      p,
      () => P.wind[p.key],
      (v) => {
        P.wind[p.key] = v;
        if (p.key === 'direction') {
          uWindDirX.value = Math.cos(v);
          uWindDirZ.value = Math.sin(v);
        } else if (p.uni) {
          p.uni.value = v;
        }
      },
      () => {},
    );
    details.appendChild(row);
  }
  sidebarBody.appendChild(details);
}
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'settings', 'Physics');
  details.appendChild(summary);
  for (const p of PHYSICS_SCHEMA) {
    const row = createSliderRow(
      p,
      () => P.physics[p.key],
      (v) => { P.physics[p.key] = v; },
      () => {},
    );
    details.appendChild(row);
  }
  sidebarBody.appendChild(details);
}

// 9. Settings — live renderer + post-FX + environment + debug controls
addSectionLabel('Settings', null, 'settings');

function mkCheckboxRow(label, get, set) {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = '1fr auto';
  row.style.padding = '8px 20px';
  const name = document.createElement('span');
  name.className = 'name'; name.textContent = label;
  const input = document.createElement('input');
  input.type = 'checkbox'; input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  row.append(name, input);
  return row;
}
function mkSelectRow(label, options, get, set) {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = '1fr 1fr';
  row.style.padding = '8px 20px';
  const name = document.createElement('span');
  name.className = 'name'; name.textContent = label;
  const sel = document.createElement('select');
  sel.className = 'select';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    sel.appendChild(opt);
  }
  sel.value = get();
  sel.addEventListener('change', () => set(sel.value));
  row.append(name, sel);
  return row;
}
function mkSliderRow(label, min, max, step, get, set) {
  const p = { key: label, label, min, max, step, default: get() };
  return createSliderRow(p, get, set, () => {});
}

// Renderer group — tone mapping, exposure, pixel ratio
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'settings', 'Renderer');
  details.appendChild(summary);
  details.appendChild(mkSliderRow('Exposure', 0.1, 3.0, 0.05,
    () => P.settings.exposure,
    (v) => { P.settings.exposure = v; applyExposure(v); }));
  details.appendChild(mkSelectRow('Tone Map', Object.keys(TONE_MAPPINGS),
    () => P.settings.toneMapping,
    (v) => { P.settings.toneMapping = v; applyToneMapping(v); }));
  details.appendChild(mkSliderRow('Pixel Ratio', 0.5, 2.0, 0.1,
    () => P.settings.pixelRatio,
    (v) => { P.settings.pixelRatio = v; debouncedApply('pixelRatio', () => applyPixelRatio(v), 220); }));
  sidebarBody.appendChild(details);
}

// Shadows group
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'sun', 'Shadows');
  details.appendChild(summary);
  details.appendChild(mkCheckboxRow('Enabled',
    () => P.settings.shadowsEnabled,
    (v) => { P.settings.shadowsEnabled = v; applyShadowsEnabled(v); }));
  details.appendChild(mkSelectRow('Quality', Object.keys(SHADOW_QUALITIES),
    () => P.settings.shadowQuality,
    (v) => { P.settings.shadowQuality = v; debouncedApply('shadowQuality', () => applyShadowQuality(v), 250); }));
  sidebarBody.appendChild(details);
}

// Post FX group
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'image', 'Post FX');
  details.appendChild(summary);
  details.appendChild(mkCheckboxRow('Bloom',
    () => P.settings.bloomEnabled,
    (v) => { P.settings.bloomEnabled = v; applyBloom(v, P.settings.bloomIntensity); }));
  details.appendChild(mkSliderRow('Bloom Int.', 0, 2.5, 0.05,
    () => P.settings.bloomIntensity,
    (v) => { P.settings.bloomIntensity = v; applyBloom(P.settings.bloomEnabled, v); }));
  sidebarBody.appendChild(details);
}

// Environment group — fog + HDRI intensity
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'globe', 'Environment');
  details.appendChild(summary);
  details.appendChild(mkCheckboxRow('Fog',
    () => P.settings.fogEnabled,
    (v) => { P.settings.fogEnabled = v; applyFog(v, P.settings.fogNear, P.settings.fogFar); }));
  details.appendChild(mkSliderRow('Fog Near', 0, 500, 5,
    () => P.settings.fogNear,
    (v) => { P.settings.fogNear = v; applyFog(P.settings.fogEnabled, v, P.settings.fogFar); }));
  details.appendChild(mkSliderRow('Fog Far', 0, 1000, 10,
    () => P.settings.fogFar,
    (v) => { P.settings.fogFar = v; applyFog(P.settings.fogEnabled, P.settings.fogNear, v); }));
  details.appendChild(mkSliderRow('Env Int.', 0, 3, 0.05,
    () => P.settings.envIntensity,
    (v) => { P.settings.envIntensity = v; applyEnvIntensity(v); }));
  sidebarBody.appendChild(details);
}

// Debug group
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'ruler', 'Debug');
  details.appendChild(summary);
  details.appendChild(mkCheckboxRow('Axes (XYZ)',
    () => P.settings.showAxes,
    (v) => { P.settings.showAxes = v; applyAxes(v); }));
  sidebarBody.appendChild(details);
}

// 10. Save — saved presets + mesh export + JSON
addSectionLabel('Save', null, 'save');

// Saved preset library
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'bookmark', 'Saved Presets');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad-sm';

  const list = document.createElement('div');
  list.className = 'preset-list';
  function refreshList() {
    list.innerHTML = '';
    const all = listPresets();
    const names = Object.keys(all).sort();
    if (names.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint-empty-2';
      empty.textContent = 'no saved presets yet';
      list.appendChild(empty);
      return;
    }
    for (const n of names) {
      const p = all[n];
      const item = document.createElement('div');
      item.className = 'preset-item';
      item.title = `Load "${n}"`;
      const img = document.createElement('img');
      if (p._thumb) img.src = p._thumb;
      else img.style.background = 'var(--accent-faint)';
      const label = document.createElement('span');
      label.className = 'pi-name'; label.textContent = n;
      const del = document.createElement('button');
      del.className = 'pi-del'; del.innerHTML = iconSvg('x', 12); del.title = 'Delete';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${n}"?`)) { deletePreset(n); refreshList(); toast('Preset deleted', 'success', 1400); }
      });
      item.append(img, label, del);
      item.addEventListener('click', () => { loadPreset(n); toast(`Loaded "${n}"`, 'success', 1600); });
      list.appendChild(item);
    }
  }
  refreshList();
  wrap.appendChild(list);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'preset name';
  nameInput.className = 'text-input-full';
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
  wrap.appendChild(nameInput);
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save current';
  saveBtn.className = 'mt-6';
  saveBtn.addEventListener('click', () => {
    const n = (nameInput.value || '').trim();
    if (!n) { toast('Enter a preset name', 'error'); return; }
    savePreset(n);
    nameInput.value = '';
    refreshList();
    toast(`Saved "${n}"`, 'success', 1600);
  });
  wrap.appendChild(saveBtn);

  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}

// Export Mesh (OBJ / STL)
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'download', 'Export Mesh');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-pad';
  const select = document.createElement('select');
  select.className = 'select select-full-mb';
  for (const [v, label] of [
    ['obj',  'OBJ (Wavefront)'],
    ['stl',  'STL'],
    ['glb',  'GLB (glTF binary)'],
    ['gltf', 'GLTF (json)'],
  ]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    select.appendChild(o);
  }
  const btn = document.createElement('button');
  btn.textContent = 'Download';
  btn.className = 'btn-full';
  btn.addEventListener('click', () => exportMesh(select.value));
  const hint = document.createElement('div');
  hint.className = 'hint-sm';
  hint.textContent = 'FBX has no native three.js exporter. Use GLB/GLTF for full mesh + scene.';
  wrap.append(select, btn, hint);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}

// LOD (level of detail) — summary stub. Full editor lives in the bottom
// drawer, toggled via the toolbar (layers icon).
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'layers', 'LOD');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'pane-col';

  const stub = document.createElement('div');
  stub.className = 'lod-stub';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn-full';
  openBtn.textContent = 'Open LOD editor…';
  openBtn.addEventListener('click', () => openLODDrawer());

  const hintLod = document.createElement('div');
  hintLod.className = 'hint-sm-mt';
  hintLod.textContent = 'Edit the full LOD chain, flags, and export in the bottom drawer (or click the layers icon in the toolbar).';

  const renderStub = () => {
    const baseTris = treeMesh ? _triCountOf(treeMesh.geometry) : 0;
    const active = lodSlots.filter((s) => _lodPreviewMeshes.has(s.id)).length;
    stub.innerHTML = `
      <div class="lod-stub-row"><span class="lod-stub-k">LOD0</span><span class="lod-stub-v mono">${baseTris ? baseTris.toLocaleString() + ' tris' : '—'}</span></div>
      <div class="lod-stub-row"><span class="lod-stub-k">Chain</span><span class="lod-stub-v">${lodSlots.length} slot${lodSlots.length === 1 ? '' : 's'} · <span class="lod-stub-active">${active} active</span></span></div>
    `;
  };
  _lodStubRender = renderStub;
  renderStub();

  wrap.append(stub, openBtn, hintLod);
  details.appendChild(wrap);
  sidebarBody.appendChild(details);
}

// Preset (JSON import/export)
{
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  setSummary(summary, 'copy', 'Preset');
  details.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.style.padding = '6px 14px 10px';
  const ta = document.createElement('textarea');
  ta.rows = 8;
  ta.className = 'mono-textarea';
  wrap.appendChild(ta);
  const btnRow = document.createElement('div');
  btnRow.className = 'row-gap-6';
  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export';
  exportBtn.className = 'btn-flex-sm';
  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-flex-sm';
  btnRow.append(exportBtn, applyBtn);
  wrap.appendChild(btnRow);
  details.appendChild(wrap);
  exportBtn.addEventListener('click', () => {
    const out = {
      ...P,
      levels: P.levels,
      wind: P.wind,
      taper: taperSpline.points,
      length: lengthSpline.points,
      profile: profileEditor.points,
    };
    ta.value = JSON.stringify(out, null, 2);
  });
  applyBtn.addEventListener('click', () => {
    try {
      const obj = JSON.parse(ta.value);
      for (const k in obj) {
        if (['taper', 'length', 'levels', 'profile', 'wind'].includes(k)) continue;
        if (k in P) P[k] = obj[k];
      }
      if (Array.isArray(obj.levels)) P.levels = obj.levels;
      if (Array.isArray(obj.taper)) taperSpline.setPoints(obj.taper);
      if (Array.isArray(obj.length)) lengthSpline.setPoints(obj.length);
      if (Array.isArray(obj.profile)) profileEditor.setPoints(obj.profile);
      if (obj.wind) {
        Object.assign(P.wind, obj.wind);
        uWindEnable.value = P.wind.enabled ? 1 : 0;
        uWindStrength.value = P.wind.strength;
        uWindFreq.value = P.wind.frequency;
        uWindDirX.value = Math.cos(P.wind.direction);
        uWindDirZ.value = Math.sin(P.wind.direction);
        uWindGust.value = P.wind.gust;
      }
      syncUI(); renderLevels(); applyLeafMaterial(); applyBarkMaterial(); generateTree();
      commitHistorySoon();
    } catch (e) { toast('Invalid JSON', 'error'); }
  });
  sidebarBody.appendChild(details);
}

function syncUI() {
  for (const el of sidebarBody.querySelectorAll('.scrubber[data-pkey]')) {
    const key = el.dataset.pkey;
    if (P[key] !== undefined && typeof el._applyValue === 'function') {
      el._applyValue(P[key]);
    }
  }
  // Thumbnail-grid rows track their value via a wrapper, not a scrubber.
  for (const el of sidebarBody.querySelectorAll('.thumbnail-row[data-pkey]')) {
    const key = el.dataset.pkey;
    if (P[key] !== undefined && typeof el._applyValue === 'function') {
      el._applyValue(P[key]);
    }
  }
}

// Regenerate handled via the toolbar button (tb-regen).

// --- Species presets ------------------------------------------------------
function applySpecies(name) {
  const spec = (name !== 'Custom' && SPECIES[name]) ? SPECIES[name] : null;
  if (!spec && name !== 'Custom') return; // unknown species — bail
  // Capture the current tree type BEFORE we reset schema defaults — Custom
  // honors the active type so picking Custom while in Bush/Conifer mode
  // produces a generic shrub/conifer instead of jumping back to broadleaf.
  const prevTreeType = P.treeType;
  // Cancel any in-flight foliage-only rebuild — its cache is about to become
  // stale, and we don't want it racing with the species change and commiting
  // leaves for the previous tree onto the new one.
  if (typeof _foliageTimer !== 'undefined' && _foliageTimer) { clearTimeout(_foliageTimer); _foliageTimer = null; }
  _cachedTreeNodes = null; _cachedTips = null; _cachedChainsSer = null;
  // Reset every schema to its defaults. For a named species we then overlay
  // its spec on top; for Custom we stop here — the schema defaults ARE the
  // custom baseline, so picking Custom visibly reverts any previous species'
  // tweaks back to a clean slate.
  for (const g of PARAM_SCHEMA)   for (const p of g.params) P[p.key] = p.default;
  for (const g of CONIFER_SCHEMA) for (const p of g.params) P[p.key] = p.default;
  for (const g of BUSH_SCHEMA)    for (const p of g.params) P[p.key] = p.default;
  // Internal toggles that aren't in any schema — reset to match first-load.
  P.leafFacing = 0;
  // Leaf bend params are conceptually species-level (Palm needs strong curl,
  // most broadleafs want subtle) but stored as per-tree state. Reset on
  // species change so a previous species' curl doesn't leak into the next
  // one; species presets that need stronger values overlay below.
  P.leafMidribCurl = 0.15;
  P.leafApexCurl = 0.08;
  P.attractors = [];
  // NOTE: P.leafShape and P.leafProfile are intentionally NOT reset here —
  // the user's chosen leaf shape (preset / Custom / Upload) persists across
  // species and tree-type switches. `applyLeafShape()` below re-applies it
  // to the new material.
  // Clear any per-species leafProfile colour overrides from a previous spec
  // so the next species falls back to the default green unless it sets them.
  if (P.leafProfile) {
    P.leafProfile.color = undefined;
    P.leafProfile.veinColor = undefined;
  }
  if (taperSpline)   taperSpline.setPoints([1, 1, 1, 1, 1]);
  if (lengthSpline)  lengthSpline.setPoints([1, 1, 1, 1, 1]);
  if (profileEditor) profileEditor.setPoints(new Array(12).fill(1));
  if (spec) {
    // Route spec.type → P.treeType (the schema stores the type under a
    // different key, so a plain `k in P` copy would silently drop it).
    if (spec.type) P.treeType = spec.type;
    // Per-species leaf Fill / Vein colour — flat keys on the spec routed
    // into P.leafProfile (which isn't itself a schema key).
    if (spec.leafFillColor && P.leafProfile) P.leafProfile.color     = spec.leafFillColor;
    if (spec.leafVeinColor && P.leafProfile) P.leafProfile.veinColor = spec.leafVeinColor;
    for (const k of Object.keys(spec)) {
      if (k === 'levels' || k === 'type' || k === 'leafFillColor' || k === 'leafVeinColor') continue;
      if (k in P) P[k] = spec[k];
    }
    if (Array.isArray(spec.levels)) P.levels = spec.levels.map((l) => ({ ...makeDefaultLevel(), ...l }));
  } else if (prevTreeType === 'bush') {
    // Custom while in bush mode = generic landscape shrub. The schema defaults
    // already populated P.b* with sensible values; just lock treeType + a
    // mild clean look. applyBushConfigToP() runs at generateTree() and turns
    // these into a full bush.
    P.treeType = 'bush';
    P.leafShape = 'Oval';
    P.leafPhyllotaxis = 'opposite';
    P.season = 0.1;
    P.gravityStrength = 0.15;
    P.gravityStiffness = 1.0;
    P.pruneMode = 'ellipsoid';
  } else if (prevTreeType === 'conifer') {
    // Custom while in conifer mode = generic conifer. applyConiferConfigToP
    // does the heavy lifting from CONIFER_SCHEMA defaults.
    P.treeType = 'conifer';
    P.pruneMode = 'off';
  } else {
    // Custom: showcase preset that exercises most of the app's capabilities.
    // Mature-character broadleaf: strong central leader, buttressed base, moss
    // on upper surfaces, reaction-wood under horizontal branches, twigs with
    // leaves on them, dual-sided leaf tint, light canopy dieback, a handful
    // of dead stubs, and hand-tuned density/length/split curves per level.
    Object.assign(P, {
      treeType: 'broadleaf',
      // Trunk character
      trunkHeight: 12, trunkScale: 1.05, tipRadius: 0.005, alloExp: 2.45, rootFlare: 0.55,
      trunkBow: 0.22, trunkLean: 0.08, trunkLeanDir: 25, trunkTwist: 0.06,
      barkDisplace: 0.35, barkDisplaceFreq: 3.2,
      buttressAmount: 0.45, buttressHeight: 2.0, buttressLobes: 5,
      reactionWood: 0.35,
      // Bark material — moss off by default; users can turn it on from the
      // Bark sliders if they want the aged-trunk look.
      barkHue: 0.08, barkTint: 0.32, barkRoughness: 0.9, barkNormalStrength: 1.2,
      barkTexScaleU: 2.5, barkTexScaleV: 2.2,
      mossAmount: 0, mossThreshold: 0.4, mossHue: 0.28, mossLum: 0.22,
      // Global silhouette
      globalScale: 1.0, shape: 'tend-flame', baseSize: 0.25, rotation: 12,
      // Foliage
      leafShape: 'Maple',
      leafSize: 0.18, leafSpread: 0.38, leafStemLen: 0,
      leavesPerTip: 38, leafChainSteps: 8, leavesStart: 0.15, season: 0.68,
      leafClusterSize: 3, leafClusterSpread: 0.55, leafMaxRadius: 0.14,
      leafPhyllotaxis: 'spiral', leafTilt: 0.3, leafColorVar: 0.12,
      leafRoughness: 0.55, leafTransmission: 0.55, leafThickness: 0.35,
      leafClearcoat: 0.3, leafClearcoatRough: 0.35,
      leafBackHue: 0.13, leafBackLum: 0.62, leafBackMix: 0.4,
      // Canopy shell + dead wood
      dieback: 0.15, diebackOuter: 0.55,
      stubsEnable: 'on', stubsChance: 0.22, stubsLength: 0.45, stubsTaper: 0.6,
      pruneMode: 'off',
    });
    P.levels = [
      { ...makeDefaultLevel(),
        children: 12, lenRatio: 0.52, angle: 0.98, angleVar: 0.28, rollVar: 0.85,
        startPlacement: 0.22, endPlacement: 1,
        apicalDominance: 0.25, apicalContinue: 0.55, angleDecline: -0.25,
        distortion: 0.22, distortionType: 'perlin', distortionFreq: 2.5,
        curveMode: 'sCurve', curveAmount: 0.35, curveBack: -0.22,
        segSplits: 0.25, splitAngle: 0.38, susceptibility: 1.5, gravitropism: 0.015,
        densityPoints: [0.4, 0.85, 1, 1, 0.9],
        lengthPoints: [0.55, 1, 1.08, 0.95, 0.55],
        splitPoints: [0.3, 0.8, 1, 0.85, 0.5],
      },
      { ...makeDefaultLevel(),
        children: 8, lenRatio: 0.62, angle: 0.72, angleVar: 0.22,
        startPlacement: 0.2, endPlacement: 1,
        apicalDominance: 0.15, apicalContinue: 0.3,
        distortion: 0.18, distortionType: 'perlin', distortionFreq: 2.8,
        curveMode: 'sCurve', curveAmount: 0.3, curveBack: -0.35,
        segSplits: 0.18, splitAngle: 0.32, gravitropism: 0.025, susceptibility: 1.6,
        densityPoints: [0.5, 0.9, 1, 0.95, 0.7],
        lengthPoints: [0.7, 1, 1.02, 0.9, 0.7],
        splitPoints: [0.4, 0.9, 1, 0.8, 0.4],
      },
      { ...makeDefaultLevel(),
        children: 6, lenRatio: 0.58, angle: 0.58,
        startPlacement: 0.25, endPlacement: 1,
        apicalContinue: 0.15,
        distortion: 0.15, stochastic: 0.18,
        curveMode: 'backCurve', curveAmount: 0.25, gravitropism: 0.03,
        densityPoints: [0.5, 0.9, 1, 0.95, 0.75],
        lengthPoints: [0.8, 1, 1, 0.9, 0.7],
      },
      { ...makeDefaultLevel(),
        children: 4, lenRatio: 0.48, angle: 0.48,
        startPlacement: 0.3, endPlacement: 1,
        distortion: 0.12, stochastic: 0.22, gravitropism: 0.035,
        densityPoints: [0.6, 0.9, 1, 0.95, 0.8],
        lengthPoints: [0.85, 1, 1, 0.95, 0.8],
      },
    ];
  }
  syncUI();
  renderLevels();
  applyLeafMaterial();
  applyBarkMaterial();
  applyLeafShape();
  _refreshLeafShapePanel?.();
  // Retune size sliders so the active species sits in a comfortable middle
  // of the track instead of jammed against the left edge of the absolute
  // schema range. Range = current value × 3 (with a sane absolute floor),
  // so a 0.07 leaf has a 0.02..0.21 slider, a 0.6 palm leaf has a
  // 0.02..1.8 slider, etc.
  const _retune = (key, baseFloor) => {
    const el = sidebarBody?.querySelector(`.scrubber[data-pkey="${key}"]`);
    if (el && typeof el._setRange === 'function') {
      const v = P[key];
      if (typeof v === 'number' && v > 0) {
        const max = Math.max(baseFloor, v * 3);
        el._setRange(0.005, max);
      }
    }
  };
  _retune('leafSize',     0.10);
  _retune('leafSpread',   0.30);
  _retune('leafMaxRadius', 0.10);
  // Collapse all sidebar cards on species change so the user starts from a
  // clean view of the new preset.
  const _sb = document.getElementById('sidebar-body');
  if (_sb) for (const d of _sb.querySelectorAll('details')) d.open = false;
  const p = generateTree();
  commitHistorySoon();
  return p;
}

// --- Screenshot + GLTF export --------------------------------------------
// Map known extensions to MIME + readable description for the Save As dialog.
const _SAVE_TYPES = {
  png:  { desc: 'PNG image',            mime: 'image/png' },
  jpg:  { desc: 'JPEG image',           mime: 'image/jpeg' },
  jpeg: { desc: 'JPEG image',           mime: 'image/jpeg' },
  obj:  { desc: 'Wavefront OBJ mesh',   mime: 'text/plain' },
  stl:  { desc: 'STL mesh',             mime: 'model/stl' },
  gltf: { desc: 'glTF (JSON)',          mime: 'application/json' },
  glb:  { desc: 'glTF binary',          mime: 'model/gltf-binary' },
  json: { desc: 'JSON',                 mime: 'application/json' },
  zip:  { desc: 'Zip archive',          mime: 'application/zip' },
};
// Remember the last save folder per file type so repeat exports skip the
// folder-hunt step. Kept per-category (image/mesh/data) because trees and
// screenshots usually go in different places.
const _saveDirHandles = { image: null, mesh: null, data: null };
function _saveCategory(ext) {
  if (['png', 'jpg', 'jpeg'].includes(ext)) return 'image';
  if (['obj', 'stl', 'gltf', 'glb'].includes(ext)) return 'mesh';
  return 'data';
}
async function downloadBlob(blob, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const info = _SAVE_TYPES[ext];
  // Native Save As dialog — asks the user where to put the file, remembers
  // the last-used folder per file kind. Chromium-only; Firefox/Safari fall
  // back to the default download folder via the anchor click below.
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const cat = _saveCategory(ext);
      const opts = {
        suggestedName: filename,
        startIn: _saveDirHandles[cat] || (cat === 'image' ? 'pictures' : 'downloads'),
      };
      if (info) {
        opts.types = [{
          description: info.desc,
          accept: { [info.mime]: [`.${ext}`] },
        }];
      }
      const handle = await window.showSaveFilePicker(opts);
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      // Cache the parent so the next export of this kind opens in the same spot.
      _saveDirHandles[cat] = handle;
      return;
    } catch (e) {
      // User cancelled the picker — don't fall through to auto-download.
      if (e && e.name === 'AbortError') return;
      // Any other failure falls through to the anchor click.
      console.warn('Save picker failed, falling back to anchor download:', e);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportScreenshot() {
  await withBusy('Saving screenshot…', async () => {
    await postProcessing.render();
    const canvas = renderer.domElement;
    await new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `tree-${P.seed}.png`);
        resolve();
      }, 'image/png');
    });
  });
}

// Reference-image overlay — shows a semi-transparent image over the canvas
// for tracing a real photograph. Upload via the Spotlight command. Opacity
// slider lives alongside the viewport controls once loaded.
let _refOverlayEl = null;
function _ensureRefOverlay() {
  if (_refOverlayEl) return _refOverlayEl;
  const wrap = document.getElementById('canvas-wrap');
  if (!wrap) return null;
  const img = document.createElement('img');
  img.id = 'ref-overlay';
  img.style.position = 'absolute';
  img.style.inset = '0';
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'contain';
  img.style.pointerEvents = 'none';
  img.style.opacity = '0.4';
  img.style.mixBlendMode = 'normal';
  img.style.zIndex = '5';
  img.hidden = true;
  wrap.appendChild(img);
  _refOverlayEl = img;
  return img;
}
function _uploadReferenceImage() {
  const el = _ensureRefOverlay();
  if (!el) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (el.src && el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
    el.src = URL.createObjectURL(f);
    el.hidden = false;
    toast(`Reference loaded — right-click canvas to adjust opacity`, 'info', 2200);
  });
  input.click();
}
function _clearReferenceImage() {
  if (!_refOverlayEl) return;
  if (_refOverlayEl.src && _refOverlayEl.src.startsWith('blob:')) URL.revokeObjectURL(_refOverlayEl.src);
  _refOverlayEl.hidden = true;
  _refOverlayEl.src = '';
  toast('Reference cleared', 'info', 1200);
}
function _setReferenceOpacity(v) {
  if (_refOverlayEl) _refOverlayEl.style.opacity = String(Math.max(0, Math.min(1, v)));
}

// Variation batch — reseeds the tree N times and saves a PNG for each.
// Useful for populating forest instance libraries.
async function exportVariationBatch(n = 8) {
  if (n < 1) return;
  await withBusy(`Exporting ${n} variations…`, async () => {
    toast(`Rendering ${n} variations…`, 'info', 1400);
    const originalSeed = P.seed;
    for (let i = 0; i < n; i++) {
      beginBusy(`Variation ${i + 1}/${n}…`);
      try {
        P.seed = Math.floor(Math.random() * 999999);
        await generateTree();
        // Let a couple of frames settle (settle boost decays + foliage commits)
        await new Promise((r) => setTimeout(r, 180));
        await postProcessing.render();
        const blob = await new Promise((resolve) => renderer.domElement.toBlob(resolve, 'image/png'));
        if (blob) downloadBlob(blob, `tree-var-${String(i + 1).padStart(2, '0')}-${P.seed}.png`);
        await new Promise((r) => setTimeout(r, 80));
      } finally { endBusy(); }
    }
    P.seed = originalSeed;
    syncUI();
    generateTree();
    toast(`Saved ${n} variations`, 'success', 1800);
  });
}

// --- Pipeline bakers (wind vertex colors, pivot painter UVs) -------------
// Game engines (UE/Unity/Godot) animate foliage in vertex shaders using data
// baked into the mesh, not CPU sim. Convention:
//   vertexColor.r = trunk sway weight (0 at root → 1 at tip, squared for natural falloff)
//   vertexColor.g = branch phase      (per-skeleton-node hash so branches sway out of sync)
//   vertexColor.b = leaf flutter weight (0 on bark, 1 on leaves)
//   vertexColor.a = stiffness         (radius-derived on bark, phase on leaves)
// Pivot painter UVs (leaves only):
//   uv1 = (anchorX, anchorY)          — leaf anchor point on the skeleton
//   uv2 = (anchorZ, bendWeight)       — anchorZ + per-leaf bend multiplier
function _hash01(i) {
  // Deterministic pseudo-random in [0,1) from an integer.
  const s = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function bakeBarkWindColors(geo) {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const col = new Float32Array(n * 4);
  // If the skeleton mapping isn't available (shouldn't happen in normal use),
  // fall back to zero colors — still a valid attribute, engines just get no wind.
  if (!barkNodeA || !barkNodeB || !barkNodeW || !skRestY || !skRadius) {
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    return geo;
  }
  // Normalize height and radius so weights land in [0,1].
  let yMin = Infinity, yMax = -Infinity, rMax = 0;
  for (let i = 0; i < skN; i++) {
    if (skRestY[i] < yMin) yMin = skRestY[i];
    if (skRestY[i] > yMax) yMax = skRestY[i];
    if (skRadius[i] > rMax) rMax = skRadius[i];
  }
  const ySpan = Math.max(0.01, yMax - yMin);
  const rNorm = Math.max(0.005, rMax);
  for (let v = 0; v < n; v++) {
    const a = barkNodeA[v], b = barkNodeB[v], w = barkNodeW[v];
    const y = (skRestY[a] * (1 - w) + skRestY[b] * w - yMin) / ySpan;
    const r = skRadius[a] * (1 - w) + skRadius[b] * w;
    const trunk = Math.max(0, Math.min(1, y));
    const phase = _hash01(a);
    const stiff = Math.min(1, r / rNorm);
    col[v * 4    ] = trunk * trunk;  // parabolic falloff — roots stiff, tips loose
    col[v * 4 + 1] = phase;
    col[v * 4 + 2] = 0;
    col[v * 4 + 3] = stiff;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  return geo;
}

// --- Export-safe material factories --------------------------------------
// NodeMaterial doesn't round-trip through GLTFExporter. For exports we clone
// the active textures into plain MeshStandardMaterial with distinct names so
// engines get proper material slots.
function makeExportBarkMaterial() {
  const m = new THREE.MeshStandardMaterial({
    map: barkAlbedo || null,
    normalMap: barkNormal || null,
    color: 0xffffff,
    roughness: P.barkRoughness ?? 0.95,
    metalness: 0,
    vertexColors: true,
  });
  m.name = 'tree_bark';
  return m;
}
function makeExportLeafMaterial(map, slot) {
  const m = new THREE.MeshStandardMaterial({
    map: map || null,
    normalMap: leafNormal || null,
    color: 0xffffff,
    roughness: P.leafRoughness ?? 0.65,
    metalness: 0,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    transparent: false,
    vertexColors: true,
  });
  m.name = `tree_leaf_${slot}`;
  return m;
}
function makeExportNeedleMaterial(slot) {
  const m = new THREE.MeshStandardMaterial({
    map: needleTex,
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0,
    alphaTest: 0.3,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  m.name = `tree_needle_${slot}`;
  return m;
}

// --- Rigged bark mesh for DCC-friendly exports ------------------------
// Produces a THREE.SkinnedMesh weighted to a THREE.Bone hierarchy that
// matches the runtime skeleton. glTF importers in Blender / Houdini /
// Cinema 4D see a proper armature + vertex groups, so the user can pose
// or animate the tree natively instead of re-rigging a static mesh.
function _buildRiggedBark({ bakeWind = true } = {}) {
  if (!treeMesh || !barkRestPos || !barkNodeA || skN <= 0) return null;
  // 1. Bone hierarchy — local position = joint rest pos relative to parent.
  const bones = new Array(skN);
  for (let i = 0; i < skN; i++) {
    const b = new THREE.Bone();
    b.name = `bone_${i}`;
    bones[i] = b;
  }
  let rootBone = null;
  for (let i = 0; i < skN; i++) {
    const p = skParentIdx[i];
    if (p >= 0) {
      bones[i].position.set(skRestX[i] - skRestX[p], skRestY[i] - skRestY[p], skRestZ[i] - skRestZ[p]);
      bones[p].add(bones[i]);
    } else {
      bones[i].position.set(skRestX[i], skRestY[i], skRestZ[i]);
      rootBone = bones[i];
    }
  }
  if (!rootBone) rootBone = bones[0];
  // 2. Bark geometry with rest-pose positions + skin attributes.
  const srcGeo = treeMesh.geometry;
  const geo = new THREE.BufferGeometry();
  // Live geometry count, NOT the pool size — pools are grow-only and would
  // pad the export with stale vertices.
  const vCount = srcGeo.attributes.position.count;
  // .slice() returns a copy of just the live vert range; the underlying pool
  // can be bigger after a mesh-detail shrink and would otherwise leak stale
  // verts into the export.
  geo.setAttribute('position', new THREE.BufferAttribute(barkRestPos.slice(0, vCount * 3), 3));
  if (srcGeo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(srcGeo.attributes.uv.array), 2));
  }
  if (srcGeo.index) {
    const srcIdx = srcGeo.index.array;
    const IdxCtor = (srcIdx.length > 65535 || vCount > 65535) ? Uint32Array : Uint16Array;
    geo.setIndex(new THREE.BufferAttribute(new IdxCtor(srcIdx), 1));
  }
  const skinIdx = new Uint16Array(vCount * 4);
  const skinWt  = new Float32Array(vCount * 4);
  const nA = Math.min(vCount, barkNodeA.length);
  for (let v = 0; v < nA; v++) {
    const a = barkNodeA[v], b = barkNodeB[v], w = barkNodeW[v];
    skinIdx[v * 4 + 0] = a;
    skinIdx[v * 4 + 1] = b;
    skinWt [v * 4 + 0] = 1 - w;
    skinWt [v * 4 + 1] = w;
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIdx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWt, 4));
  geo.computeVertexNormals();
  if (bakeWind) bakeBarkWindColors(geo);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  // 3. SkinnedMesh (material skinning is automatic under MeshStandardMaterial).
  const mat = makeExportBarkMaterial();
  const skinnedMesh = new THREE.SkinnedMesh(geo, mat);
  skinnedMesh.name = 'bark';
  return { skinnedMesh, rootBone, bones };
}

function buildExportGroup(opts = {}) {
  // Build a flat scene graph of the tree for exporters. Instanced leaves are
  // "baked" into a regular mesh per variant so the file stays self-contained.
  // Pipeline data (wind vertex colors, pivot UVs) is baked in by default so
  // DCC / engine importers can animate the mesh without CPU sim.
  const bakeWind  = opts.bakeWind  !== false;  // default true
  const bakePivot = opts.bakePivot !== false;  // default true
  const rigged    = !!opts.rigged;
  const group = new THREE.Group();
  group.name = `tree_${P.treeType}_${P.seed}`;
  if (treeMesh) {
    if (rigged) {
      const rig = _buildRiggedBark({ bakeWind });
      if (rig) {
        group.add(rig.skinnedMesh);
        group.add(rig.rootBone);
        // Force matrix world update so Skeleton can compute bind-pose inverses.
        group.updateMatrixWorld(true);
        const skel = new THREE.Skeleton(rig.bones);
        rig.skinnedMesh.bind(skel);
      } else {
        const barkGeo = treeMesh.geometry.clone();
        if (bakeWind) bakeBarkWindColors(barkGeo);
        const m = new THREE.Mesh(barkGeo, makeExportBarkMaterial());
        m.name = 'bark';
        group.add(m);
      }
    } else {
      const barkGeo = treeMesh.geometry.clone();
      if (bakeWind) bakeBarkWindColors(barkGeo);
      const m = new THREE.Mesh(barkGeo, makeExportBarkMaterial());
      m.name = 'bark';
      group.add(m);
    }
  }
  const isConifer = P.treeType === 'conifer';
  // Merge all leaves of each variant into ONE mesh with baked per-vertex
  // attributes. This is what engines want (one draw call per material) AND
  // drastically faster to serialize than thousands of child meshes.
  function bakeInstancesMerged(inst, data, name, slot) {
    if (!inst || inst.count === 0) return;
    const base = inst.geometry;
    const mat = isConifer ? makeExportNeedleMaterial(slot) : makeExportLeafMaterial(slot === 'a' ? leafMapA : leafMapB, slot);
    const posAttr = base.getAttribute('position');
    const normAttr = base.getAttribute('normal');
    const uvAttr = base.getAttribute('uv');
    const idxAttr = base.getIndex();
    const vpl = posAttr.count;
    const ipl = idxAttr ? idxAttr.count : posAttr.count;
    const total = inst.count;
    const outPos  = new Float32Array(vpl * total * 3);
    const outNorm = new Float32Array(vpl * total * 3);
    const outUV   = new Float32Array(vpl * total * 2);
    const outCol  = bakeWind  ? new Float32Array(vpl * total * 4) : null;
    const outUV1  = bakePivot ? new Float32Array(vpl * total * 2) : null;
    const outUV2  = bakePivot ? new Float32Array(vpl * total * 2) : null;
    const outIdx  = new Uint32Array(ipl * total);
    const m = new THREE.Matrix4();
    const nm = new THREE.Matrix3();
    const v = new THREE.Vector3();
    for (let i = 0; i < total; i++) {
      inst.getMatrixAt(i, m);
      nm.getNormalMatrix(m);
      const L = data[i];
      const anchor = (skRestX && L.anchorIdx < skN)
        ? { x: skRestX[L.anchorIdx], y: skRestY[L.anchorIdx], z: skRestZ[L.anchorIdx] }
        : { x: 0, y: 0, z: 0 };
      const branchPhase = _hash01(L.anchorIdx + 100);
      const leafPhase   = _hash01(L.anchorIdx);
      // Per-instance UV variant — pick one of 4 mirror transforms from a
      // deterministic per-leaf hash so the export's foliage doesn't look
      // like 1000 copies of the same leaf. Mirror-only (no 90° rotation)
      // keeps the stem-to-tip axis upright on the quad.
      const uvVariant = (_hash01(L.anchorIdx + 31 * (slot === 'a' ? 1 : 2)) * 4) | 0;
      const flipU = (uvVariant & 1) === 1;
      const flipV = (uvVariant & 2) === 2;
      const base0 = i * vpl;
      for (let j = 0; j < vpl; j++) {
        const vi = base0 + j;
        v.set(posAttr.getX(j), posAttr.getY(j), posAttr.getZ(j));
        v.applyMatrix4(m);
        outPos[vi * 3    ] = v.x;
        outPos[vi * 3 + 1] = v.y;
        outPos[vi * 3 + 2] = v.z;
        if (normAttr) {
          v.set(normAttr.getX(j), normAttr.getY(j), normAttr.getZ(j));
          v.applyMatrix3(nm).normalize();
          outNorm[vi * 3    ] = v.x;
          outNorm[vi * 3 + 1] = v.y;
          outNorm[vi * 3 + 2] = v.z;
        }
        if (uvAttr) {
          let u = uvAttr.getX(j);
          let vv = uvAttr.getY(j);
          if (flipU) u = 1 - u;
          if (flipV) vv = 1 - vv;
          outUV[vi * 2    ] = u;
          outUV[vi * 2 + 1] = vv;
        }
        if (outCol) {
          outCol[vi * 4    ] = 0;
          outCol[vi * 4 + 1] = branchPhase;
          outCol[vi * 4 + 2] = 1;
          outCol[vi * 4 + 3] = leafPhase;
        }
        if (outUV1) { outUV1[vi * 2] = anchor.x; outUV1[vi * 2 + 1] = anchor.y; }
        if (outUV2) { outUV2[vi * 2] = anchor.z; outUV2[vi * 2 + 1] = 1; }
      }
      for (let j = 0; j < ipl; j++) {
        outIdx[i * ipl + j] = (idxAttr ? idxAttr.getX(j) : j) + base0;
      }
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
    if (normAttr) merged.setAttribute('normal', new THREE.BufferAttribute(outNorm, 3));
    if (uvAttr)   merged.setAttribute('uv',     new THREE.BufferAttribute(outUV, 2));
    if (outCol)   merged.setAttribute('color',  new THREE.BufferAttribute(outCol, 4));
    if (outUV1)   merged.setAttribute('uv1',    new THREE.BufferAttribute(outUV1, 2));
    if (outUV2)   merged.setAttribute('uv2',    new THREE.BufferAttribute(outUV2, 2));
    merged.setIndex(new THREE.BufferAttribute(outIdx, 1));
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    group.add(mesh);
  }
  bakeInstancesMerged(leafInstA, leafDataA, isConifer ? 'needles-A' : 'leaves-A', 'a');
  bakeInstancesMerged(leafInstB, leafDataB, isConifer ? 'needles-B' : 'leaves-B', 'b');
  return group;
}

// Attach pipeline metadata to a group so engines see species, seed, and
// bounding info as glTF `extras`.
function attachPipelineMetadata(group) {
  treeMesh?.geometry.computeBoundingBox();
  const bb = treeMesh?.geometry.boundingBox;
  const barkTris = treeMesh ? _triCountOf(treeMesh.geometry) : 0;
  const leafCount = (leafInstA?.count || 0) + (leafInstB?.count || 0);
  group.userData = {
    ...group.userData,
    pipeline: {
      tool: 'webgpu-tree',
      schemaVersion: 1,
      treeType: P.treeType,
      seed: P.seed,
      species: document.querySelector('.species-btn.active')?.dataset.name || 'Custom',
      barkTriangleCount: barkTris,
      leafInstanceCount: leafCount,
      bounds: bb ? {
        min: [bb.min.x, bb.min.y, bb.min.z],
        max: [bb.max.x, bb.max.y, bb.max.z],
      } : null,
      windChannels: 'vertexColor RGBA = (trunkSway, branchPhase, leafFlutter, stiffness)',
      pivotChannels: 'uv1 = anchor.xy, uv2 = (anchor.z, bendWeight)',
    },
  };
}

function exportMesh(format) {
  const group = buildExportGroup();
  attachPipelineMetadata(group);
  if (format === 'obj') {
    const text = new OBJExporter().parse(group);
    downloadBlob(new Blob([text], { type: 'text/plain' }), `tree-${P.seed}.obj`);
  } else if (format === 'stl') {
    const text = new STLExporter().parse(group);
    downloadBlob(new Blob([text], { type: 'model/stl' }), `tree-${P.seed}.stl`);
  } else if (format === 'gltf' || format === 'glb') {
    const binary = format === 'glb';
    new GLTFExporter().parse(
      group,
      (result) => {
        const data = result instanceof ArrayBuffer ? result : JSON.stringify(result, null, 2);
        const blob = new Blob([data], {
          type: binary ? 'model/gltf-binary' : 'application/json',
        });
        downloadBlob(blob, `tree-${P.seed}.${binary ? 'glb' : 'gltf'}`);
      },
      (err) => toast('GLTF export failed: ' + err, 'error', 4000),
      { binary, includeCustomExtensions: true },
    );
  }
}

function exportGLTF() { exportMesh('glb'); }

// --- LOD generation + export -------------------------------------------
const _simplifier = new SimplifyModifier();
// Normalize the options argument. Accepts a plain ratio number (legacy call
// sites) or an options object { mode, ratio, tris, lockBorder, sloppy }.
function _normalizeSimplifyOpts(optsOrRatio) {
  if (typeof optsOrRatio === 'number') {
    return { mode: 'ratio', ratio: optsOrRatio, tris: 0, lockBorder: false, sloppy: false };
  }
  const o = optsOrRatio || {};
  return {
    mode: o.mode || (o.tris ? 'tris' : 'ratio'),
    ratio: o.ratio ?? 0.5,
    tris: o.tris ?? 0,
    lockBorder: !!o.lockBorder,
    sloppy: !!o.sloppy,
  };
}

function _resolveTargetIndexCount(srcIndexCount, opts) {
  if (opts.mode === 'tris') {
    return Math.max(12, opts.tris * 3);
  }
  return Math.max(12, Math.floor((srcIndexCount * opts.ratio) / 3) * 3);
}

// Meshoptimizer path — preserves tube topology on aggressive ratios where
// SimplifyModifier collapses thin branches into the trunk. Works on an
// indexed geometry; if the source isn't indexed we fall through to the
// legacy path so callers never get null.
function _simplifyWithMeshopt(srcGeo, opts) {
  if (!_meshoptReady || !MeshoptSimplifier) return null;
  const idx = srcGeo.index;
  const posAttr = srcGeo.getAttribute('position');
  if (!idx || !posAttr) return null;

  const indices = idx.array instanceof Uint32Array ? idx.array : new Uint32Array(idx.array);
  const positions = posAttr.array instanceof Float32Array ? posAttr.array : new Float32Array(posAttr.array);
  const targetIndexCount = _resolveTargetIndexCount(indices.length, opts);
  // Error budget: allow aggressive simplification to actually hit the target.
  // 1.0 = "whatever it takes". Meshopt still guards against total collapse
  // and we recompute normals afterward so visible quality holds up.
  const targetError = 1.0;

  let newIndices, err;
  try {
    if (opts.sloppy && typeof MeshoptSimplifier.simplifySloppy === 'function') {
      // Sloppy simplification ignores feature preservation and just aims at
      // the triangle target. Right choice for very aggressive LODs (<15%)
      // where quality-preserving simplification gives up and returns empty.
      [newIndices, err] = MeshoptSimplifier.simplifySloppy(
        indices, positions, 3, targetIndexCount, targetError,
      );
    } else {
      const flags = opts.lockBorder ? ['LockBorder'] : [];
      [newIndices, err] = MeshoptSimplifier.simplify(
        indices, positions, 3, targetIndexCount, targetError, flags,
      );
    }
  } catch (e) {
    console.warn('meshopt simplify failed:', e);
    return null;
  }
  if (!newIndices || newIndices.length < 12) return null;

  const out = new THREE.BufferGeometry();
  for (const name in srcGeo.attributes) {
    const src = srcGeo.attributes[name];
    out.setAttribute(
      name,
      new THREE.BufferAttribute(src.array.slice(), src.itemSize, src.normalized),
    );
  }
  out.setIndex(new THREE.BufferAttribute(newIndices, 1));
  // Normals for surviving vertices near collapse edges can drift; recompute
  // so the LOD shades cleanly instead of showing faceting artifacts.
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function simplifyGeometry(srcGeo, optsOrRatio) {
  const opts = _normalizeSimplifyOpts(optsOrRatio);
  if (opts.mode === 'ratio' && opts.ratio >= 1) return srcGeo.clone();
  const meshopt = _simplifyWithMeshopt(srcGeo, opts);
  if (meshopt) return meshopt;
  // Legacy fallback: SimplifyModifier. Used when meshopt hasn't loaded yet,
  // or on non-indexed source geometry. Sloppy / lockBorder flags have no
  // equivalent here — ratio-based decimation is the best it can do.
  const clone = srcGeo.clone();
  const posAttr = clone.getAttribute('position');
  if (!posAttr) return clone;
  const faces = clone.index ? clone.index.count / 3 : posAttr.count / 3;
  let keep;
  if (opts.mode === 'tris') keep = Math.max(4, opts.tris);
  else keep = Math.max(4, Math.floor(faces * opts.ratio));
  const remove = Math.max(0, Math.floor(faces - keep));
  try {
    return _simplifier.modify(clone, remove);
  } catch (e) {
    console.warn('Simplify failed:', e);
    return clone;
  }
}

// --- LOD previews ------------------------------------------------------
// State bindings are hoisted to the top of the file so the sidebar block
// built earlier can reference them without TDZ. Each active ratio spawns a
// simplified copy placed in a row to the right of the original tree so the
// user can eyeball quality side-by-side. Cleared when the tree regenerates.

function _triCountOf(geo) {
  const attr = geo.getAttribute('position');
  if (!attr) return 0;
  return Math.floor((geo.index ? geo.index.count : attr.count) / 3);
}

function _lodSpacing() {
  if (!treeMesh) return 4;
  // bbox is cached in generateTree but updateBark mutates positions in place,
  // so an old cached bbox can be slightly off — recompute defensively. Cheap.
  if (!treeMesh.geometry.boundingBox) treeMesh.geometry.computeBoundingBox();
  const bb = treeMesh.geometry.boundingBox;
  return Math.max(3, (bb.max.x - bb.min.x) + 1.5);
}

// Pack active LOD previews at consecutive x positions (1, 2, 3, …) to the
// right of the original. The slot order is driven by the user-editable
// `lodSlots` array so adding / removing / reordering stays predictable.
function _relayoutLODPreviews() {
  const spacing = _lodSpacing();
  // When LOD0 is hidden we pack the active slots starting at the origin so
  // the comparison row isn't pushed to the side with an empty column.
  const startSlot = _hideLOD0 ? 0 : 1;
  const activeSlots = lodSlots.filter((s) => _lodPreviewMeshes.has(s.id));
  activeSlots.forEach((s, i) => {
    const x = spacing * (startSlot + i);
    _lodPreviewMeshes.get(s.id)?.position.set(x, 0, 0);
    _lodWireMeshes.get(s.id)?.position.set(x, 0, 0);
  });
}

// Hide the original tree (and its leaves / wire / spline) so the row shows
// only simplified LODs side-by-side. Useful when comparing LOD1 / LOD2 / LOD3
// without the full-detail tree pulling the camera frame wide.
function applyHideLOD0(hide) {
  _hideLOD0 = !!hide;
  if (treeMesh) treeMesh.visible = !_hideLOD0;
  if (treeWireMesh) treeWireMesh.visible = meshViewOn && !splineViewOn && !_hideLOD0;
  if (treeSplineMesh) treeSplineMesh.visible = splineViewOn && !_hideLOD0;
  if (treeSplineDots)  treeSplineDots.visible = splineViewOn && !_hideLOD0;
  if (leafInstA) leafInstA.visible = leavesOn && !_hideLOD0;
  if (leafInstB) leafInstB.visible = leavesOn && !_hideLOD0;
  if (stemInst)  stemInst.visible  = leavesOn && !_hideLOD0;
  _relayoutLODPreviews();
  refreshLODUI();
  markRenderDirty(3);
}

// Frames the camera on a single LOD preview mesh so the user visually lands
// on the slot they just added. Reuses the same reframeAnim easing as the
// global reframe for a smooth tween.
function reframeToLODMesh(mesh) {
  if (!mesh || !mesh.geometry) return;
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bbox = mesh.geometry.boundingBox.clone().translate(mesh.position);
  const leafMargin = (P.leafSize || 1) + (P.leafSpread || 0);
  bbox.expandByScalar(leafMargin);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);
  const fovY = (camera.fov * Math.PI) / 180;
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect);
  const fitH = size.y / 2 / Math.tan(fovY / 2);
  const fitW = size.x / 2 / Math.tan(fovX / 2);
  const dist = Math.min(Math.max(fitH, fitW) * 1.6, controls.maxDistance);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); else dir.normalize();
  reframeAnim = {
    fromCam: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toCam: center.clone().addScaledVector(dir, dist),
    toTarget: center.clone(),
    t: 0,
    duration: 0.7,
  };
}

// Wireframe overlay shown on every LOD preview so the user can eyeball
// topology differences at a glance. Geometry is shared by reference with
// the shaded LOD mesh — no extra memory, always in sync.
const _lodWireMat = new THREE.MeshBasicMaterial({
  color: 0x88ddff,
  wireframe: true,
  transparent: true,
  opacity: 0.55,
  depthTest: true,
  depthWrite: false,
  toneMapped: false,
});

function clearLODPreviews() {
  for (const m of _lodWireMeshes.values()) scene.remove(m);
  _lodWireMeshes.clear();
  for (const m of _lodPreviewMeshes.values()) {
    scene.remove(m);
    if (m.geometry) m.geometry.dispose();
  }
  _lodPreviewMeshes.clear();
  _lodTriCounts.clear();
  refreshLODUI();
}

function _lodTargetLabel(slot) {
  if (slot.mode === 'tris') return `${slot.tris.toLocaleString()} tris`;
  return `${Math.round(slot.ratio * 100)}%`;
}

// If a slot's options change while it's active, we rebuild the preview
// in place rather than asking the user to toggle it off/on again.
function rebuildLODPreview(slotId) {
  if (!_lodPreviewMeshes.has(slotId)) return;
  const slot = lodSlots.find((s) => s.id === slotId);
  if (!slot) return;
  // Remove the old mesh + wire before building the new one so ordering /
  // packing stays consistent.
  const oldMesh = _lodPreviewMeshes.get(slotId);
  const oldWire = _lodWireMeshes.get(slotId);
  if (oldWire) { scene.remove(oldWire); _lodWireMeshes.delete(slotId); }
  if (oldMesh) { scene.remove(oldMesh); oldMesh.geometry?.dispose(); _lodPreviewMeshes.delete(slotId); }
  _lodTriCounts.delete(slotId);
  _addLODPreview(slot, /*reframe=*/ false);
}

function _addLODPreview(slot, reframe) {
  if (!treeMesh) return;
  const simp = simplifyGeometry(treeMesh.geometry, slot);
  const tris = _triCountOf(simp);
  if (tris === 0) {
    if (simp && simp.dispose) simp.dispose();
    toast(`LOD (${_lodTargetLabel(slot)}) simplified to empty — try sloppy mode or a larger target`, 'error', 2800);
    refreshLODUI();
    return;
  }
  const mesh = new THREE.Mesh(simp, barkMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Clone the live foliage InstancedMeshes as children so the LOD preview
  // isn't a bare winter silhouette. Child instances share the parent's
  // instanceMatrix buffer by reference, so wind sim / grab bends / sway
  // updates on the source meshes propagate here for free. Scene-graph
  // positioning (via `_relayoutLODPreviews`) keeps the tree + its foliage
  // moving together since the Mesh.position applies to children too.
  for (const src of [leafInstA, leafInstB, stemInst, coneInst]) {
    if (!src || src.count === 0) continue;
    const clone = new THREE.InstancedMesh(src.geometry, src.material, 1);
    clone.instanceMatrix = src.instanceMatrix;
    clone.count = src.count;
    clone.frustumCulled = false;
    clone.castShadow = src.castShadow;
    clone.receiveShadow = src.receiveShadow;
    if (src.instanceColor) clone.instanceColor = src.instanceColor;
    mesh.add(clone);
  }
  scene.add(mesh);
  _lodPreviewMeshes.set(slot.id, mesh);
  _lodTriCounts.set(slot.id, tris);
  // Mesh-inspection overlay: shares the simplified geometry by reference so
  // the wire and shaded view stay locked. Added after the shaded mesh so it
  // sorts on top under WebGPU's transparent pass.
  const wire = new THREE.Mesh(simp, _lodWireMat);
  wire.castShadow = false;
  wire.receiveShadow = false;
  // Off by default — only shows when the user toggles the wireframe button.
  wire.visible = meshViewOn;
  scene.add(wire);
  _lodWireMeshes.set(slot.id, wire);
  _relayoutLODPreviews();
  refreshLODUI();
  // `_relayoutLODPreviews` may shift the mesh to its packed x offset; reframe
  // AFTER that so the camera lands on the final position, not (0,0,0).
  if (reframe) reframeToLODMesh(mesh);
  markRenderDirty(3);
}

function toggleLODPreview(slotId) {
  if (!treeMesh) { toast('Generate a tree first', 'error', 1500); return; }
  if (_lodPreviewMeshes.has(slotId)) {
    const m = _lodPreviewMeshes.get(slotId);
    const w = _lodWireMeshes.get(slotId);
    if (w) { scene.remove(w); _lodWireMeshes.delete(slotId); }
    scene.remove(m);
    if (m.geometry) m.geometry.dispose();
    _lodPreviewMeshes.delete(slotId);
    _lodTriCounts.delete(slotId);
    _relayoutLODPreviews();
    refreshLODUI();
    markRenderDirty(3);
    return;
  }
  const slot = lodSlots.find((s) => s.id === slotId);
  if (!slot) return;
  toast('Building LOD preview…', 'info', 700);
  setTimeout(() => _addLODPreview(slot, /*reframe=*/ true), 20);
}

// --- LOD export modal --------------------------------------------------
// Reads the live `lodSlots` array so what's in the sidebar is what ships.
let _lodModalEl = null;
function _buildLODModal() {
  if (_lodModalEl) return _lodModalEl;
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-card" role="dialog" aria-label="Export LOD bundle">
      <header class="modal-header">
        <div class="modal-title">Export LOD bundle</div>
        <button class="modal-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="modal-body">
        <div class="modal-field">
          <label>LOD chain</label>
          <div class="lod-tech-data" id="lodmx-preview">
            <div class="lod-tech-row head"><span>LOD</span><span>Target</span><span>Tris</span></div>
          </div>
          <div class="modal-field-hint">Edit the chain in the sidebar LOD panel. Each slot here becomes one mesh in the exported glTF.</div>
        </div>
        <div class="modal-field">
          <label for="lodmx-filename">Filename</label>
          <input id="lodmx-filename" type="text" />
          <div class="modal-field-hint">Extension is appended automatically if missing.</div>
        </div>
        <div class="modal-field">
          <label for="lodmx-format">Format</label>
          <select id="lodmx-format" class="select">
            <option value="glb">Binary glTF (.glb) — single file</option>
            <option value="gltf">JSON glTF (.gltf) — human-readable</option>
          </select>
        </div>
        <div class="modal-section-title">Pipeline data</div>
        <label class="modal-toggle"><input type="checkbox" id="lodmx-rig"  checked /> Include armature (rigged LOD0 — imports with bones in Blender / Houdini / C4D)</label>
        <label class="modal-toggle"><input type="checkbox" id="lodmx-wind"  checked /> Bake wind vertex colors (R=trunk, G=phase, B=leaf, A=stiffness)</label>
        <label class="modal-toggle"><input type="checkbox" id="lodmx-pivot" checked /> Bake pivot-painter UVs (uv1=anchor.xy, uv2=anchor.z+bend)</label>
        <label class="modal-toggle"><input type="checkbox" id="lodmx-meta"  checked /> Embed metadata (species, seed, bounds, LOD targets) in glTF extras</label>
        <label class="modal-toggle"><input type="checkbox" id="lodmx-billboard" /> Add a billboard impostor as the final LOD (crossed quads)</label>
        <div class="modal-section-title">Advanced</div>
        <label class="modal-toggle"><input type="checkbox" id="lodmx-naming" checked /> Encode tri count + target in each LOD mesh name</label>
        <label class="modal-toggle"><input type="checkbox" id="lodmx-yield" checked /> Yield between LODs (keeps UI responsive for heavy trees)</label>
        <div class="modal-field-hint">
          FBX / USD / Alembic can't be written from the browser. Export glTF here, then convert in Blender:
          <em>File → Import → glTF 2.0</em>, then <em>File → Export → FBX / USD</em>.
        </div>
      </div>
      <footer class="modal-footer">
        <button class="modal-secondary" id="lodmx-cancel" type="button">Cancel</button>
        <button class="modal-primary"   id="lodmx-export" type="button">Export</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  _lodModalEl = overlay;

  const card     = overlay.querySelector('.modal-card');
  const closeBtn = overlay.querySelector('.modal-close');
  const cancel   = overlay.querySelector('#lodmx-cancel');
  const exportBtn= overlay.querySelector('#lodmx-export');
  const fileIn   = overlay.querySelector('#lodmx-filename');
  const formatIn = overlay.querySelector('#lodmx-format');
  const namingIn = overlay.querySelector('#lodmx-naming');
  const yieldIn  = overlay.querySelector('#lodmx-yield');
  const windIn   = overlay.querySelector('#lodmx-wind');
  const pivotIn  = overlay.querySelector('#lodmx-pivot');
  const metaIn   = overlay.querySelector('#lodmx-meta');
  const impIn    = overlay.querySelector('#lodmx-billboard');
  const rigIn    = overlay.querySelector('#lodmx-rig');
  const preview  = overlay.querySelector('#lodmx-preview');

  const renderPreview = () => {
    preview.innerHTML = '<div class="lod-tech-row head"><span>LOD</span><span>Target</span><span>Tris</span></div>';
    if (!treeMesh || !lodSlots.length) {
      const empty = document.createElement('div');
      empty.className = 'lod-tech-row';
      empty.innerHTML = '<span class="dim">—</span><span class="dim">—</span><span class="dim">—</span>';
      preview.appendChild(empty);
      exportBtn.disabled = true;
      return;
    }
    exportBtn.disabled = false;
    const baseTris = _triCountOf(treeMesh.geometry);
    // LOD0 baseline
    const base = document.createElement('div');
    base.className = 'lod-tech-row';
    base.innerHTML = `<span>LOD0</span><span class="dim">100%</span><span>${baseTris.toLocaleString()}</span>`;
    preview.appendChild(base);
    lodSlots.forEach((s, i) => {
      let tris;
      if (_lodTriCounts.has(s.id)) tris = _lodTriCounts.get(s.id);
      else if (s.mode === 'tris') tris = s.tris;
      else tris = Math.max(4, Math.floor(baseTris * s.ratio));
      const row = document.createElement('div');
      row.className = 'lod-tech-row';
      const flags = [];
      if (s.lockBorder) flags.push('border');
      if (s.sloppy) flags.push('sloppy');
      const flagTxt = flags.length ? ` <span class="dim">· ${flags.join(' · ')}</span>` : '';
      row.innerHTML = `<span>LOD${i + 1}</span><span>${_lodTargetLabel(s)}${flagTxt}</span><span>${tris.toLocaleString()}</span>`;
      preview.appendChild(row);
    });
  };

  const open = () => {
    if (!treeMesh) { toast('Generate a tree first', 'error', 1500); return; }
    fileIn.value = `tree-${P.seed}-LODs`;
    // Reset transient state that can leak across opens.
    exportBtn.disabled = false;
    renderPreview();
    overlay.hidden = false;
    setTimeout(() => fileIn.focus(), 0);
  };
  const hide = () => { overlay.hidden = true; };

  closeBtn.addEventListener('click', hide);
  cancel.addEventListener('click', hide);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
  card.addEventListener('click', (e) => e.stopPropagation());
  window.addEventListener('keydown', (e) => {
    if (!overlay.hidden && e.key === 'Escape') hide();
  });

  exportBtn.addEventListener('click', async () => {
    if (!lodSlots.length) { toast('No LOD slots — add at least one', 'error', 2000); return; }
    exportBtn.disabled = true;
    const fmt = formatIn.value;
    let name = fileIn.value.trim() || `tree-${P.seed}-LODs`;
    const ext = fmt === 'glb' ? '.glb' : '.gltf';
    if (!name.toLowerCase().endsWith(ext)) name += ext;
    // Snapshot the live slots so later edits don't race the export.
    const slots = lodSlots.map((s) => ({ ...s }));
    try {
      await exportLODBundle({
        slots,
        filename: name,
        format: fmt,
        encodeMeshName: namingIn.checked,
        yieldBetween: yieldIn.checked,
        bakeWind: windIn.checked,
        bakePivot: pivotIn.checked,
        embedMetadata: metaIn.checked,
        addBillboard: impIn.checked,
        rigged: rigIn?.checked ?? false,
      });
      hide();
    } finally {
      exportBtn.disabled = false;
    }
  });

  overlay._open = open;
  overlay._renderPreview = renderPreview;
  return overlay;
}
function openLODExportModal() { _buildLODModal()._open(); }

// --- Floating 3D tree labels -------------------------------------------
// Per-tree pill that floats above each visible mesh (LOD0 + active LOD
// previews). DOM-based, projected each frame from world space to screen.
const _treeLabels = new Map();                // key -> { el, mesh }
const _treeLabelProj = new THREE.Vector3();   // scratch vector for projection
const _treeLabelAnchor = new THREE.Vector3(); // scratch vector for anchor

function _isLODModeOpen() {
  return !!(_lodDrawerEl && _lodDrawerEl.classList.contains('open'));
}

function _reconcileTreeLabels() {
  const host = document.getElementById('tree-labels');
  if (!host) return;
  // Labels are a "LOD mode" affordance — only visible while the LOD drawer
  // is open. Otherwise tear every label down so the canvas stays clean.
  if (!_isLODModeOpen()) {
    for (const entry of _treeLabels.values()) entry.el.remove();
    _treeLabels.clear();
    return;
  }
  const wanted = new Set();
  const baseTris = treeMesh ? _triCountOf(treeMesh.geometry) : 0;

  const upsert = (key, mesh, className, innerHTML) => {
    wanted.add(key);
    let entry = _treeLabels.get(key);
    if (!entry) {
      const el = document.createElement('div');
      host.appendChild(el);
      entry = { el, mesh };
      _treeLabels.set(key, entry);
    }
    entry.el.className = className;
    entry.mesh = mesh;
    entry.el.innerHTML = innerHTML;
  };

  // LOD0 (original tree). Respect _hideLOD0 state.
  if (treeMesh && !_hideLOD0) {
    upsert(
      'lod0',
      treeMesh,
      'tree-label',
      `<span class="tl-tag">LOD0</span><span class="tl-tris">${baseTris.toLocaleString()} tris</span>`,
    );
  }
  // Each active LOD slot.
  lodSlots.forEach((slot, i) => {
    if (!_lodPreviewMeshes.has(slot.id)) return;
    const mesh = _lodPreviewMeshes.get(slot.id);
    const tris = _lodTriCounts.get(slot.id) ?? 0;
    const reduction = baseTris ? Math.round((1 - tris / baseTris) * 100) : 0;
    const target = slot.mode === 'tris'
      ? `${slot.tris.toLocaleString()} tris target`
      : `${Math.round(slot.ratio * 100)}%`;
    upsert(
      `slot-${slot.id}`,
      mesh,
      'tree-label lod',
      `<span class="tl-tag">LOD${i + 1}</span><span class="tl-tris">${tris.toLocaleString()}</span><span class="tl-dim">${target} · −${reduction}%</span>`,
    );
  });
  // Tear down labels whose source tree no longer exists.
  for (const [key, entry] of _treeLabels) {
    if (!wanted.has(key)) {
      entry.el.remove();
      _treeLabels.delete(key);
    }
  }
}

function _updateTreeLabelPositions() {
  if (_treeLabels.size === 0) return;
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  for (const entry of _treeLabels.values()) {
    const mesh = entry.mesh;
    if (!mesh || !mesh.visible || !mesh.geometry) {
      entry.el.classList.add('hidden');
      continue;
    }
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    // Anchor at the BOTTOM of the tree bbox — label sits under the trunk
    // (CSS offsets it 10px below the anchor).
    _treeLabelAnchor.set(
      (bb.min.x + bb.max.x) * 0.5,
      bb.min.y,
      (bb.min.z + bb.max.z) * 0.5,
    ).add(mesh.position);
    _treeLabelProj.copy(_treeLabelAnchor).project(camera);
    if (_treeLabelProj.z > 1) { entry.el.classList.add('hidden'); continue; }
    const x = (_treeLabelProj.x * 0.5 + 0.5) * w;
    const y = (1 - (_treeLabelProj.y * 0.5 + 0.5)) * h;
    entry.el.classList.remove('hidden');
    entry.el.style.left = `${x}px`;
    entry.el.style.top = `${y}px`;
  }
}

// --- LOD editor drawer (bottom of canvas) -------------------------------
// Horizontal slot-card chain. Built lazily on first open so cold-start
// cost stays on the user action, not on page load.
let _lodDrawerEl = null;
function _buildLODDrawer() {
  if (_lodDrawerEl) return _lodDrawerEl;
  const drawer = document.createElement('div');
  drawer.id = 'lod-drawer';
  drawer.innerHTML = `
    <header class="lod-drawer-head">
      <div class="lod-drawer-title">
        ${iconSvg('layers', 15)}
        <span>LOD editor</span>
        <span class="lod-drawer-base mono"></span>
        <button type="button" class="lod-drawer-hide0 lod-mini-btn" title="Hide / show the original LOD0 in the scene">
          ${iconSvg('eye', 12)}
        </button>
      </div>
      <button class="lod-drawer-close" type="button" aria-label="Close">✕</button>
    </header>
    <div class="lod-drawer-body">
      <div class="lod-chain"></div>
      <button type="button" class="lod-card-add">
        <span class="lod-card-add-plus">+</span>
        <span class="lod-card-add-label">Add LOD</span>
      </button>
    </div>
    <footer class="lod-drawer-foot">
      <div class="lod-drawer-summary"></div>
      <button type="button" class="lod-drawer-export">Export LODs…</button>
    </footer>
  `;
  canvasWrap.appendChild(drawer);
  _lodDrawerEl = drawer;

  const hide0Btn = drawer.querySelector('.lod-drawer-hide0');
  const closeBtn = drawer.querySelector('.lod-drawer-close');
  const baseTag  = drawer.querySelector('.lod-drawer-base');
  const chain    = drawer.querySelector('.lod-chain');
  const addBtn   = drawer.querySelector('.lod-card-add');
  const summary  = drawer.querySelector('.lod-drawer-summary');
  const exportBtn= drawer.querySelector('.lod-drawer-export');

  closeBtn.addEventListener('click', closeLODDrawer);
  exportBtn.addEventListener('click', openLODExportModal);
  hide0Btn.addEventListener('click', () => applyHideLOD0(!_hideLOD0));
  addBtn.addEventListener('click', () => {
    const last = lodSlots[lodSlots.length - 1];
    const next = last
      ? makeLodSlot({
          mode: last.mode,
          ratio: Math.max(0.02, (last.ratio ?? 0.5) * 0.5),
          tris: Math.max(100, Math.floor((last.tris ?? 2000) * 0.5)),
          sloppy: last.sloppy,
        })
      : makeLodSlot({ ratio: 0.5 });
    lodSlots.push(next);
    // Build and show the preview immediately so the new LOD lands in the
    // scene right next to the others. _addLODPreview fires refreshLODUI.
    _addLODPreview(next, /*reframe=*/ true);
  });

  const renderCards = () => {
    chain.innerHTML = '';
    const baseTris = treeMesh ? _triCountOf(treeMesh.geometry) : 0;
    baseTag.textContent = baseTris ? `LOD0: ${baseTris.toLocaleString()} tris` : 'LOD0: —';
    hide0Btn.classList.toggle('on', _hideLOD0);
    hide0Btn.title = _hideLOD0
      ? 'LOD0 hidden — click to show the original in the scene'
      : 'Hide the original LOD0 from the scene';

    lodSlots.forEach((slot, i) => {
      const card = document.createElement('div');
      const isActive = _lodPreviewMeshes.has(slot.id);
      card.className = 'lod-card-v2' + (isActive ? ' active' : '');

      // Head (label + per-card recalc + remove)
      const head = document.createElement('div');
      head.className = 'lod-card-head';
      const label = document.createElement('span');
      label.className = 'lod-card-label';
      label.textContent = `LOD${i + 1}`;

      const actions = document.createElement('div');
      actions.className = 'lod-card-actions';

      // Visibility toggle (eye icon) — shows / hides this LOD in the scene.
      const vis = document.createElement('button');
      vis.type = 'button';
      vis.className = 'lod-mini-btn' + (isActive ? ' on' : '');
      vis.title = isActive ? 'Hide this LOD from the scene' : 'Show this LOD in the scene';
      vis.innerHTML = isActive
        ? iconSvg('eye', 12)
        : iconSvg('eye-off', 12);
      vis.addEventListener('click', () => toggleLODPreview(slot.id));

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'lod-card-rm';
      rm.innerHTML = '✕';
      rm.title = 'Delete this LOD slot';
      rm.disabled = lodSlots.length <= 1;
      rm.addEventListener('click', () => {
        if (_lodPreviewMeshes.has(slot.id)) toggleLODPreview(slot.id);
        const idx = lodSlots.indexOf(slot);
        if (idx >= 0) lodSlots.splice(idx, 1);
        refreshLODUI();
      });
      actions.append(vis, rm);
      head.append(label, actions);

      // Mode + input row
      const target = document.createElement('div');
      target.className = 'lod-card-target';
      const mode = document.createElement('div');
      mode.className = 'lod-row-mode';
      const modePct = document.createElement('button');
      modePct.type = 'button'; modePct.textContent = '%';
      modePct.className = slot.mode === 'ratio' ? 'on' : '';
      modePct.title = 'Target as percentage of LOD0 triangles';
      const modeTris = document.createElement('button');
      modeTris.type = 'button'; modeTris.textContent = 'tris';
      modeTris.className = slot.mode === 'tris' ? 'on' : '';
      modeTris.title = 'Target absolute triangle count';
      modePct.addEventListener('click', () => {
        if (slot.mode === 'ratio') return;
        slot.mode = 'ratio';
        refreshLODUI();
        if (isActive) rebuildLODPreview(slot.id);
      });
      modeTris.addEventListener('click', () => {
        if (slot.mode === 'tris') return;
        slot.mode = 'tris';
        if (baseTris) slot.tris = Math.max(100, Math.floor(baseTris * (slot.ratio ?? 0.5)));
        refreshLODUI();
        if (isActive) rebuildLODPreview(slot.id);
      });
      mode.append(modePct, modeTris);

      const inputWrap = document.createElement('div');
      inputWrap.className = 'lod-row-input';
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'mono';
      if (slot.mode === 'ratio') {
        input.min = '1'; input.max = '100'; input.step = '1';
        input.value = Math.round(slot.ratio * 100);
      } else {
        input.min = '12'; input.step = '50';
        input.value = slot.tris;
      }
      const unit = document.createElement('span');
      unit.className = 'lod-row-unit';
      unit.textContent = slot.mode === 'ratio' ? '%' : 'tris';
      input.addEventListener('change', () => {
        if (slot.mode === 'ratio') {
          const v = Math.max(1, Math.min(100, parseFloat(input.value) || 50));
          slot.ratio = v / 100;
        } else {
          slot.tris = Math.max(12, Math.floor(parseFloat(input.value) || 1000));
        }
        refreshLODUI();
        if (isActive) rebuildLODPreview(slot.id);
      });
      inputWrap.append(input, unit);
      target.append(mode, inputWrap);

      // Flags
      const flags = document.createElement('div');
      flags.className = 'lod-card-flags';
      const mkFlag = (key, txt, title) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lod-flag' + (slot[key] ? ' on' : '');
        btn.textContent = txt;
        btn.title = title;
        btn.addEventListener('click', () => {
          slot[key] = !slot[key];
          refreshLODUI();
          if (isActive) rebuildLODPreview(slot.id);
        });
        return btn;
      };
      flags.append(
        mkFlag('lockBorder', 'Border', 'Preserve silhouette / open-edge vertices. Safer shape, costs tri budget.'),
        mkFlag('sloppy', 'Sloppy', 'Extreme feature-blind decimation. Use when the normal path collapses.'),
      );

      // Stat
      const stat = document.createElement('div');
      stat.className = 'lod-card-stat';
      if (isActive) {
        const tris = _lodTriCounts.get(slot.id) ?? 0;
        const reduction = baseTris ? Math.round((1 - tris / baseTris) * 100) : 0;
        stat.innerHTML = `<span class="mono">${tris.toLocaleString()}</span> <span class="dim">−${reduction}%</span>`;
      } else {
        let projected;
        if (slot.mode === 'tris') projected = slot.tris;
        else projected = baseTris ? Math.max(4, Math.floor(baseTris * slot.ratio)) : 0;
        stat.innerHTML = `<span class="mono dim">~${projected.toLocaleString()}</span>`;
      }

      // Rebuild button — re-runs simplification with current settings. If
      // the slot isn't visible yet, also builds + shows it.
      const rebuildBtn = document.createElement('button');
      rebuildBtn.type = 'button';
      rebuildBtn.className = 'lod-card-rebuild';
      rebuildBtn.title = isActive
        ? 'Re-run simplification on this LOD with current settings'
        : 'Build and show this LOD now';
      rebuildBtn.innerHTML = iconSvg('refresh-cw', 12) + '<span>Rebuild</span>';
      rebuildBtn.addEventListener('click', () => {
        if (_lodPreviewMeshes.has(slot.id)) rebuildLODPreview(slot.id);
        else _addLODPreview(slot, /*reframe=*/ true);
      });

      card.append(head, target, flags, stat, rebuildBtn);
      chain.appendChild(card);
    });

    const active = lodSlots.filter((s) => _lodPreviewMeshes.has(s.id)).length;
    summary.textContent = `${lodSlots.length} slot${lodSlots.length === 1 ? '' : 's'} · ${active} active`;
  };

  _lodCardsRender = renderCards;
  _lodTechRender = () => {}; // tech table folded into cards; no separate renderer
  renderCards();
  return drawer;
}

function openLODDrawer() {
  const d = _buildLODDrawer();
  d.classList.add('open');
  refreshLODUI(); // reconcile floating labels AFTER .open so they appear
  const tbLod = document.getElementById('tb-lod');
  if (tbLod) tbLod.classList.add('active');
}
function closeLODDrawer() {
  if (_lodDrawerEl) _lodDrawerEl.classList.remove('open');
  clearLODPreviews(); // evict side-by-side LOD meshes from scene
  refreshLODUI(); // tear floating labels down once we leave LOD mode
  const tbLod = document.getElementById('tb-lod');
  if (tbLod) tbLod.classList.remove('active');
}
function toggleLODDrawer() {
  if (_lodDrawerEl && _lodDrawerEl.classList.contains('open')) closeLODDrawer();
  else openLODDrawer();
}

// --- Help / info modal -------------------------------------------------
let _helpModalEl = null;
function _buildHelpModal() {
  if (_helpModalEl) return _helpModalEl;
  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl';
  const ico = {
    sparkles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>`,
    move: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/></svg>`,
    grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></svg>`,
    cmd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/></svg>`,
    keyboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>`,
    bulb: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
    leaf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>`,
    branch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="3" r="1.5"/><circle cx="18" cy="6" r="1.5"/><circle cx="12" cy="20" r="1.5"/><path d="M6 4.5v11a4 4 0 0 0 4 4h2"/><path d="M18 7.5v2a4 4 0 0 1-4 4h-2"/></svg>`,
    wind: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>`,
    box: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
    camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
    save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
    person: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M10 6 h4 v6 h-4 z M10 12 l-1 9 M14 12 l1 9"/></svg>`,
    physics: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`,
    upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>`,
    spline: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M5 17A12 12 0 0 1 17 5"/></svg>`,
  };

  const kbd = (...keys) => keys.map((k) => `<span class="kbd">${k}</span>`).join('');
  const kbdRow = (label, keysHTML) =>
    `<div class="help-kbd-row"><span>${label}</span><span class="help-kbd-keys">${keysHTML}</span></div>`;

  const overlay = document.createElement('div');
  overlay.className = 'modal help-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-card" role="dialog" aria-label="Help and controls">
      <header class="modal-header">
        <div class="modal-title">Help & controls</div>
        <button class="modal-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="modal-body">
        <div class="help-hero">
          <span class="help-hero-eyebrow">Windy Tree · WebGPU</span>
          <h2 class="help-hero-title">Design a tree, bend it in the wind.</h2>
          <p class="help-hero-sub">Pick a species, shape the geometry live with sliders, and sculpt real‑time branches with physics and wind. Everything renders on the GPU — editing is instant.</p>
        </div>

        <section class="help-section">
          <div class="help-section-head">
            <span class="help-section-badge">${ico.sparkles}</span>
            <div class="help-head-text">
              <h3 class="help-section-title">Start in three steps</h3>
              <span class="help-section-sub">The fastest path from blank canvas to a tree you like</span>
            </div>
          </div>
          <ol class="help-steps">
            <li class="help-step"><span class="help-step-n">1</span><div class="help-step-body"><strong>Pick a species.</strong> Open the <strong>Save</strong> panel in the sidebar or scroll to the species selector. Choose from broadleaves (Oak, Maple, Willow, Birch…), conifers (Pine, Spruce, Fir, Larch) or bushes. Or stay on <strong>Custom</strong> and build your own.</div></li>
            <li class="help-step"><span class="help-step-n">2</span><div class="help-step-body"><strong>Shape it.</strong> Drag any slider in the sidebar — <strong>Shape</strong>, <strong>Branching</strong>, <strong>Foliage</strong>, <strong>Bark</strong>, <strong>Scene</strong> — the tree rebuilds as you drag. Right‑click a slider to reset / copy / paste.</div></li>
            <li class="help-step"><span class="help-step-n">3</span><div class="help-step-body"><strong>Iterate.</strong> Press <span class="kbd">R</span> for a new seed, toggle <strong>Wind</strong> and <strong>Physics</strong>, right‑drag a branch to bend it. When you like the result, save a preset slot (it captures a thumbnail) or export.</div></li>
          </ol>
        </section>

        <section class="help-section">
          <div class="help-section-head">
            <span class="help-section-badge">${ico.move}</span>
            <div class="help-head-text">
              <h3 class="help-section-title">Canvas controls</h3>
              <span class="help-section-sub">Mouse and touch interactions on the 3D view</span>
            </div>
          </div>
          <div class="help-mouse-grid">
            <div class="help-mouse"><span class="help-mouse-key">L‑drag</span><span class="help-mouse-label">Orbit the camera around the tree</span></div>
            <div class="help-mouse"><span class="help-mouse-key">R‑drag</span><span class="help-mouse-label">Bend nearest branch (when <strong>Physics</strong> is on)</span></div>
            <div class="help-mouse"><span class="help-mouse-key">Wheel</span><span class="help-mouse-label">Zoom in and out</span></div>
            <div class="help-mouse"><span class="help-mouse-key">R‑click</span><span class="help-mouse-label">Canvas context menu (quick toggles, export)</span></div>
            <div class="help-mouse"><span class="help-mouse-key">Hover</span><span class="help-mouse-label">A halo appears on the nearest grab point (Physics on)</span></div>
            <div class="help-mouse"><span class="help-mouse-key">Dbl‑click</span><span class="help-mouse-label">Reset a slider to its default value</span></div>
          </div>
        </section>

        <section class="help-section">
          <div class="help-section-head">
            <span class="help-section-badge">${ico.grid}</span>
            <div class="help-head-text">
              <h3 class="help-section-title">Toolbar (left of the canvas)</h3>
              <span class="help-section-sub">Floating glass strip with the most common toggles</span>
            </div>
          </div>
          <div class="help-grid">
            <div class="help-card"><span class="help-card-ic">${ico.sun}</span><div><p class="help-card-title">Theme</p><p class="help-card-desc">Toggle light / dark lighting preset</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.box}</span><div><p class="help-card-title">Wireframe</p><p class="help-card-desc">See the raw mesh topology</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.spline}</span><div><p class="help-card-title">Spline view</p><p class="help-card-desc">Show the skeleton as control curves</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.leaf}</span><div><p class="help-card-title">Leaves</p><p class="help-card-desc">Hide / show the foliage instances</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.person}</span><div><p class="help-card-title">Scale reference</p><p class="help-card-desc">A 1.8 m human silhouette for scale</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.physics}</span><div><p class="help-card-title">Physics</p><p class="help-card-desc">Enable branch grab (right‑drag)</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.upload}</span><div><p class="help-card-title">Upload leaf</p><p class="help-card-desc">Replace the leaf texture with your own</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.copy}</span><div><p class="help-card-title">Copy preset</p><p class="help-card-desc">Copy the full parameter JSON to clipboard</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.camera}</span><div><p class="help-card-title">Screenshot</p><p class="help-card-desc">Save the canvas as a PNG</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.download}</span><div><p class="help-card-title">Export mesh</p><p class="help-card-desc">OBJ / STL / GLB / GLTF of the current tree</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.refresh}</span><div><p class="help-card-title">Regenerate</p><p class="help-card-desc">Build a new tree with a new random seed</p></div></div>
          </div>
        </section>

        <section class="help-section">
          <div class="help-section-head">
            <span class="help-section-badge">${ico.sliders}</span>
            <div class="help-head-text">
              <h3 class="help-section-title">Sidebar panels</h3>
              <span class="help-section-sub">Every parameter grouped by what it affects</span>
            </div>
          </div>
          <div class="help-grid">
            <div class="help-card"><span class="help-card-ic">${ico.branch}</span><div><p class="help-card-title">Shape</p><p class="help-card-desc">Trunk height, radius curve, taper, global scale</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.branch}</span><div><p class="help-card-title">Branching</p><p class="help-card-desc">Levels (add / copy / remove), angles, density, pruning</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.leaf}</span><div><p class="help-card-title">Foliage</p><p class="help-card-desc">Leaf size, color, roughness, density, cards per cluster</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.box}</span><div><p class="help-card-title">Bark</p><p class="help-card-desc">Texture, roughness, color tint, tiling</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.sun}</span><div><p class="help-card-title">Scene</p><p class="help-card-desc">Lights, HDRI, fog, camera presets, background</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.wind}</span><div><p class="help-card-title">Dynamics</p><p class="help-card-desc">Wind strength, frequency, direction, gusting</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.physics}</span><div><p class="help-card-title">Settings</p><p class="help-card-desc">Physics tuning, pick radius, attractors, undo/redo</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.layers}</span><div><p class="help-card-title">LOD</p><p class="help-card-desc">Preview and export simplified meshes (100/50/25/12%)</p></div></div>
            <div class="help-card"><span class="help-card-ic">${ico.save}</span><div><p class="help-card-title">Save</p><p class="help-card-desc">Preset slots with thumbnails · import / export JSON</p></div></div>
          </div>
        </section>

        <section class="help-section">
          <div class="help-section-head">
            <span class="help-section-badge">${ico.cmd}</span>
            <div class="help-head-text">
              <h3 class="help-section-title">Command palette</h3>
              <span class="help-section-sub">Press ${kbd(mod, 'K')} anywhere</span>
            </div>
          </div>
          <p style="font-size:12px;color:var(--text-soft);line-height:1.55;margin:0 0 10px;">Fuzzy‑search every parameter, species, and action in the app. Arrow keys navigate, <span class="kbd">↵</span> runs a command or focuses a slider you can scrub inline. Great for adjusting a value you can't find, or firing an action without hunting in the sidebar.</p>
          <div class="help-pill-row">
            <span class="help-pill accent">All sliders</span>
            <span class="help-pill">Species presets</span>
            <span class="help-pill">View toggles</span>
            <span class="help-pill">Undo / redo</span>
            <span class="help-pill">Theme</span>
            <span class="help-pill">Regenerate</span>
          </div>
        </section>

        <section class="help-section">
          <div class="help-section-head">
            <span class="help-section-badge">${ico.keyboard}</span>
            <div class="help-head-text">
              <h3 class="help-section-title">Keyboard shortcuts</h3>
              <span class="help-section-sub">Single‑tap toggles and ${isMac ? '⌘' : 'Ctrl'} combos</span>
            </div>
          </div>
          <div class="help-kbd-grid">
            ${kbdRow('Regenerate', kbd('R'))}
            ${kbdRow('Wireframe', kbd('W'))}
            ${kbdRow('Spline view', kbd('S'))}
            ${kbdRow('Leaves', kbd('L'))}
            ${kbdRow('Physics', kbd('P'))}
            ${kbdRow('Theme', kbd('T'))}
            ${kbdRow('Screenshot', kbd('⇧', 'P'))}
            ${kbdRow('Command palette', kbd(mod, 'K'))}
            ${kbdRow('Export mesh', kbd(mod, 'E'))}
            ${kbdRow('Upload leaf', kbd(mod, 'U'))}
            ${kbdRow('Copy preset', kbd(mod, '⇧', 'C'))}
            ${kbdRow('Undo', kbd(mod, 'Z'))}
            ${kbdRow('Redo', kbd(mod, '⇧', 'Z'))}
          </div>
        </section>

        <section class="help-section">
          <div class="help-section-head">
            <span class="help-section-badge">${ico.bulb}</span>
            <div class="help-head-text">
              <h3 class="help-section-title">Pro tips</h3>
              <span class="help-section-sub">Small things that make a big difference</span>
            </div>
          </div>
          <ul class="help-tip-list">
            <li class="help-tip"><span><strong>Save captures a thumbnail.</strong> Frame the tree how you want it to look in the slot before you save — the current view is baked into the preset card.</span></li>
            <li class="help-tip"><span><strong>Wind + Physics compound.</strong> Turn both on, right‑drag a branch, and let go while the wind is gusting — the sway blends with your push.</span></li>
            <li class="help-tip"><span><strong>Attractors guide growth.</strong> Add points in <strong>Settings</strong> and branches will bend toward them. Useful for directing a canopy away from a wall or toward light.</span></li>
            <li class="help-tip"><span><strong>Right‑click any slider</strong> for reset, copy, paste, set min, set max. Great for copying values between levels of the same branching tier.</span></li>
            <li class="help-tip"><span><strong>LOD bundle for engines.</strong> The LOD panel exports a single GLB with LOD0–3 baked in, ready to drop into Unity / Unreal / Three.js.</span></li>
            <li class="help-tip"><span><strong>Sidebar filter.</strong> Type in the sliders filter at the top to narrow down to parameters you're tuning — everything else collapses.</span></li>
          </ul>
        </section>
      </div>
      <div class="help-foot">
        <span>Press <span class="kbd">Esc</span> to close · built with <strong>three.webgpu</strong></span>
        <span><span class="kbd">⇧</span> + <span class="kbd">C</span> opens the command palette</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _helpModalEl = overlay;

  const closeBtn = overlay.querySelector('.modal-close');
  const hide = () => { overlay.hidden = true; };
  closeBtn.addEventListener('click', hide);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
  window.addEventListener('keydown', (e) => {
    if (!overlay.hidden && e.key === 'Escape') { hide(); e.stopPropagation(); }
  });

  overlay._open = () => { overlay.hidden = false; overlay.querySelector('.modal-body').scrollTop = 0; };
  return overlay;
}
function openHelpModal() { _buildHelpModal()._open(); }
document.getElementById('help-btn')?.addEventListener('click', openHelpModal);

// Render two perpendicular orthographic views of the current tree into a
// 2×1 atlas, then return a crossed-quad mesh that samples the atlas. This is
// the cheapest foliage LOD game engines accept (~8 tris total) and is what
// scattering tools use beyond ~100m render distance.
async function captureBillboardImpostor(size = 1024) {
  if (!treeMesh) throw new Error('no tree');
  treeMesh.geometry.computeBoundingBox();
  const bb = treeMesh.geometry.boundingBox;
  const center = new THREE.Vector3(); bb.getCenter(center);
  const bbSize = new THREE.Vector3(); bb.getSize(bbSize);
  // Pad ~5% so the silhouette isn't touching the frame edge.
  const halfW = Math.max(bbSize.x, bbSize.z) * 0.52;
  const halfH = bbSize.y * 0.52;
  const dist = Math.max(bbSize.x, bbSize.y, bbSize.z) * 3 + 1;

  // Save renderer + scene state BEFORE mutating anything so try/finally
  // always restores — a render throw would otherwise leave the main canvas
  // at snapshot size with no background until page reload.
  const oldSize = renderer.getSize(new THREE.Vector2());
  const oldBg = scene.background;
  const oldPixelRatio = renderer.getPixelRatio();

  const ortho = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, dist * 4);

  // Hide side-by-side LOD previews + wireframe overlays so only the main
  // tree renders into the atlas.
  const hidden = [];
  for (const m of _lodPreviewMeshes.values()) if (m.visible) { m.visible = false; hidden.push(m); }
  for (const m of _lodWireMeshes.values())    if (m.visible) { m.visible = false; hidden.push(m); }

  let atlas;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    scene.background = null;

    async function snap(camPos) {
      ortho.position.copy(camPos);
      ortho.lookAt(center);
      ortho.updateProjectionMatrix();
      // r184+ deprecated renderAsync; render() now awaits internally.
      await renderer.render(scene, ortho);
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      c.getContext('2d').drawImage(renderer.domElement, 0, 0, size, size);
      return c;
    }

    const frontCam = new THREE.Vector3(center.x,         center.y, center.z + dist);
    const sideCam  = new THREE.Vector3(center.x + dist,  center.y, center.z);
    const frontCanvas = await snap(frontCam);
    const sideCanvas  = await snap(sideCam);

    // Composite into a 2×1 atlas (front=left, side=right).
    atlas = document.createElement('canvas');
    atlas.width = size * 2; atlas.height = size;
    const ctx = atlas.getContext('2d');
    ctx.drawImage(frontCanvas, 0, 0);
    ctx.drawImage(sideCanvas, size, 0);
  } finally {
    renderer.setPixelRatio(oldPixelRatio);
    renderer.setSize(oldSize.x, oldSize.y, false);
    scene.background = oldBg;
    for (const m of hidden) m.visible = true;
    markRenderDirty(3);
  }

  // Build the crossed quad. Two perpendicular planes at the tree center,
  // each half the atlas. Four tris per plane; eight tris total.
  const w = halfW * 2, h = halfH * 2;
  const yCenter = center.y;
  const makePlane = (rotYdeg, uvMinX, uvMaxX) => {
    const g = new THREE.PlaneGeometry(w, h);
    // Shift so the plane's origin sits at the tree's world origin.
    g.translate(0, yCenter, 0);
    if (rotYdeg) g.rotateY(rotYdeg * Math.PI / 180);
    // Remap UVs to the atlas cell.
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      uv.setX(i, uvMinX + u * (uvMaxX - uvMinX));
    }
    uv.needsUpdate = true;
    return g;
  };
  const frontGeo = makePlane(0,  0,   0.5);
  const sideGeo  = makePlane(90, 0.5, 1.0);
  const atlasTex = new THREE.CanvasTexture(atlas);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 4;
  const impostorMat = new THREE.MeshBasicMaterial({
    map: atlasTex,
    transparent: true,
    alphaTest: 0.2,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  impostorMat.name = 'tree_billboard';
  const out = new THREE.Group();
  out.name = 'tree_billboard';
  out.add(new THREE.Mesh(frontGeo, impostorMat));
  out.add(new THREE.Mesh(sideGeo,  impostorMat));
  return out;
}

async function exportLODBundle({
  slots, filename, format, encodeMeshName, yieldBetween,
  bakeWind = true, bakePivot = true, embedMetadata = true, addBillboard = false,
  rigged = false,
}) {
  if (!treeMesh) { toast('No tree to export', 'error'); return; }
  const count = 1 + slots.length; // LOD0 + each slot
  beginBusy(`Building ${count} LODs…`);
  toast(`Building ${count} LODs…`, 'info', 1500);
  await new Promise((r) => setTimeout(r, 20));
  const group = new THREE.Group();
  group.name = `tree_${P.treeType}_${P.seed}_LODs`;
  // LOD0 is the full scene graph (bark + foliage, with pipeline bakes).
  // Rigged only applies to LOD0 — LOD1..N are simplified static geometry
  // since game-engine LOD chains don't need per-LOD skeletons.
  const lod0 = buildExportGroup({ bakeWind, bakePivot, rigged });
  const lod0Tris = _triCountOf(treeMesh.geometry);
  lod0.name = encodeMeshName
    ? `tree_LOD0_100pct_${lod0Tris}tris`
    : 'tree_LOD0';
  group.add(lod0);
  // Simplified bark for LOD1..N, all sharing the export bark material.
  const barkMatSrc = makeExportBarkMaterial();
  const exportedSlotInfo = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const simplified = simplifyGeometry(treeMesh.geometry, slot);
    if (bakeWind) bakeBarkWindColors(simplified);
    const mesh = new THREE.Mesh(simplified, barkMatSrc);
    const tris = _triCountOf(simplified);
    let tgtTag;
    if (slot.mode === 'tris') tgtTag = `${tris}tris`;
    else tgtTag = `${Math.round(slot.ratio * 100)}pct_${tris}tris`;
    mesh.name = encodeMeshName ? `tree_LOD${i + 1}_${tgtTag}` : `tree_LOD${i + 1}`;
    if (slot.lockBorder || slot.sloppy) {
      mesh.userData.simplifyFlags = {
        lockBorder: !!slot.lockBorder,
        sloppy: !!slot.sloppy,
      };
    }
    group.add(mesh);
    exportedSlotInfo.push({
      index: i + 1,
      mode: slot.mode,
      target: slot.mode === 'tris' ? slot.tris : slot.ratio,
      tris,
      lockBorder: !!slot.lockBorder,
      sloppy: !!slot.sloppy,
    });
    if (yieldBetween) await new Promise((r) => setTimeout(r, 10));
  }
  // Optional crossed-billboard impostor as the final LOD.
  if (addBillboard) {
    try {
      const imp = await captureBillboardImpostor(1024);
      imp.name = encodeMeshName ? `tree_LOD${slots.length + 1}_BILLBOARD` : 'tree_billboard';
      group.add(imp);
    } catch (err) {
      toast('Billboard capture failed: ' + (err?.message || err), 'error', 3500);
    }
  }
  if (embedMetadata) {
    attachPipelineMetadata(group);
    // Augment the group's extras with the LOD chain metadata so downstream
    // pipelines (Unity/Unreal importers, LOD inspectors) can read targets.
    group.userData.gltfExtras = group.userData.gltfExtras || {};
    group.userData.gltfExtras.lodChain = [
      { index: 0, tris: lod0Tris, target: 'original' },
      ...exportedSlotInfo,
    ];
  }
  const binary = format === 'glb';
  const disposeLODs = () => {
    group.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry !== treeMesh?.geometry) o.geometry.dispose();
    });
    barkMatSrc.dispose();
  };
  return new Promise((resolve) => {
    new GLTFExporter().parse(
      group,
      (result) => {
        const mime = binary ? 'model/gltf-binary' : 'model/gltf+json';
        const data = result instanceof ArrayBuffer ? result : JSON.stringify(result, null, 2);
        const blob = new Blob([data], { type: mime });
        downloadBlob(blob, filename);
        toast(`Exported ${count} LODs`, 'success');
        disposeLODs();
        endBusy();
        resolve();
      },
      (err) => {
        toast('LOD export failed: ' + err, 'error', 4000);
        disposeLODs();
        endBusy();
        resolve();
      },
      { binary },
    );
  });
}

// --- Saved preset library (localStorage slots) ---------------------------
const PRESET_STORAGE_KEY = 'webgpu-tree:presets';
function listPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '{}'); } catch { return {}; }
}
function capturePresetThumb(w = 160, h = 100) {
  try {
    const src = renderer.domElement;
    if (!src || !src.width || !src.height) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.6);
  } catch { return null; }
}
function savePreset(name) {
  const all = listPresets();
  all[name] = {
    ...P,
    levels: P.levels,
    taper: taperSpline.points,
    length: lengthSpline.points,
    profile: profileEditor.points,
    _thumb: capturePresetThumb(),
  };
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(all));
  } catch (e) {
    // Thumbs can blow localStorage's 5 MB budget — retry without them.
    for (const k of Object.keys(all)) delete all[k]._thumb;
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(all));
    toast('Preset saved (thumbnails dropped to fit storage)', 'error', 3000);
    return;
  }
}
function loadPreset(name) {
  const all = listPresets();
  const obj = all[name];
  if (!obj) return;
  for (const k in obj) {
    if (['taper', 'length', 'levels', 'profile'].includes(k)) continue;
    if (k in P) P[k] = obj[k];
  }
  if (Array.isArray(obj.levels)) P.levels = obj.levels;
  if (Array.isArray(obj.taper)) taperSpline.setPoints(obj.taper);
  if (Array.isArray(obj.length)) lengthSpline.setPoints(obj.length);
  if (Array.isArray(obj.profile)) profileEditor.setPoints(obj.profile);
  syncUI(); renderLevels(); applyLeafMaterial(); applyBarkMaterial(); generateTree();
  commitHistorySoon();
}
function deletePreset(name) {
  const all = listPresets();
  delete all[name];
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(all));
}

// ---------- Left toolbar wiring ----------
const SUN_SVG = iconSvg('sun', 15);
const MOON_SVG = iconSvg('moon', 15);

const tbTheme = document.getElementById('tb-theme');
const tbWire = document.getElementById('tb-wire');
const tbSpline = document.getElementById('tb-spline');
const tbUpload = document.getElementById('tb-upload');
const tbUploadInput = document.getElementById('tb-upload-input');
const tbExport = document.getElementById('tb-export');
const tbRegen = document.getElementById('tb-regen');

function syncThemeIcon() {
  // Show the icon for the OPPOSITE theme (click to switch)
  tbTheme.innerHTML = currentTheme === 'dark' ? SUN_SVG : MOON_SVG;
}
syncThemeIcon();

tbTheme.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  syncThemeIcon();
});

tbWire.addEventListener('click', () => {
  applyMeshView(!meshViewOn);
  tbWire.classList.toggle('active', meshViewOn);
});

tbSpline.addEventListener('click', () => {
  applySplineView(!splineViewOn);
  tbSpline.classList.toggle('active', splineViewOn);
});

const tbLeaves = document.getElementById('tb-leaves');
if (tbLeaves) {
  tbLeaves.classList.toggle('active', leavesOn);
  tbLeaves.addEventListener('click', () => {
    applyLeavesVisible(!leavesOn);
    tbLeaves.classList.toggle('active', leavesOn);
  });
}

const tbPhysics = document.getElementById('tb-physics');
if (tbPhysics) {
  tbPhysics.classList.toggle('active', physicsOn);
  tbPhysics.addEventListener('click', () => {
    physicsOn = !physicsOn;
    tbPhysics.classList.toggle('active', physicsOn);
    if (!physicsOn && grabbedNodeIdx >= 0) onGrabEnd(); // cancel any in-progress drag
  });
}

// Scale-reference human toggle — shows the 1.8 m silhouette next to the tree.
const tbPerson = document.getElementById('tb-person');
if (tbPerson && personRefMesh) {
  tbPerson.classList.toggle('active', personRefMesh.visible);
  tbPerson.addEventListener('click', () => {
    personRefMesh.visible = !personRefMesh.visible;
    tbPerson.classList.toggle('active', personRefMesh.visible);
  });
}

tbUpload.addEventListener('click', () => tbUploadInput.click());
tbUploadInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      const isOriginal = (t) => t === leafMapA || t === leafMapB;
      for (const m of [leafMatA, leafMatB]) {
        if (m.map && !isOriginal(m.map) && m.map !== _proceduralLeafTex) m.map.dispose();
        _setLeafMapFor(m, tex);
      }
      P.leafShape = 'Upload';
      _refreshLeafShapePanel?.();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

function flash(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 700);
}

tbExport.addEventListener('click', async () => {
  const out = {
    ...P,
    levels: P.levels,
    taper: taperSpline.points,
    length: lengthSpline.points,
    profile: profileEditor.points,
  };
  const json = JSON.stringify(out, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    flash(tbExport);
    toast('Preset JSON copied to clipboard', 'success');
  } catch {
    console.log(json);
    flash(tbExport);
    toast('Clipboard blocked — preset dumped to console', 'error', 3200);
  }
});

tbRegen.addEventListener('click', (e) => {
  if (e.shiftKey) {
    shuffleParams();
    flash(tbRegen);
    toast('Shuffled parameters (shift-click)', 'info', 1400);
    return;
  }
  P.seed = Math.floor(Math.random() * 999999);
  syncUI();
  generateTree();
  commitHistorySoon();
  flash(tbRegen);
});

const tbScreenshot = document.getElementById('tb-screenshot');
if (tbScreenshot) {
  tbScreenshot.addEventListener('click', async () => {
    await exportScreenshot();
    flash(tbScreenshot);
    toast('Screenshot saved', 'success');
  });
}
const tbGLTF = document.getElementById('tb-gltf');
if (tbGLTF) {
  tbGLTF.addEventListener('click', () => {
    exportGLTF();
    flash(tbGLTF);
    toast('Mesh export started', 'success');
  });
}
const tbLod = document.getElementById('tb-lod');
if (tbLod) {
  tbLod.addEventListener('click', () => {
    toggleLODDrawer();
    flash(tbLod);
  });
}
const tbEdit = document.getElementById('tb-edit');
if (tbEdit) {
  tbEdit.addEventListener('click', () => {
    if (_sculptActive) exitSculptMode({ commit: true });
    else requestEnterSculptMode();
    flash(tbEdit);
  });
}

// --- Falling leaves ------------------------------------------------------
const MAX_FALLING = 400;
leafInstFall = new THREE.InstancedMesh(leafGeo, leafMatA, MAX_FALLING);
leafInstFall.count = MAX_FALLING;
leafInstFall.frustumCulled = false;
scene.add(leafInstFall);

const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
for (let i = 0; i < MAX_FALLING; i++) leafInstFall.setMatrixAt(i, _zeroMat);
leafInstFall.instanceMatrix.needsUpdate = true;

const fallingActive = [];
const landedLeaves = []; // [{ index, pos, quat, scale, fading, fadeT }]
const freeIndices = [];
for (let i = MAX_FALLING - 1; i >= 0; i--) freeIndices.push(i);

function acquireSlot() {
  if (freeIndices.length) return freeIndices.pop();
  return -1;
}

const _dummy = new THREE.Object3D();

const _spawnEuler = new THREE.Euler();
function spawnFallingLeaf(strength = 1) {
  // Bounds-safe source selection
  const haveA = leafDataA.length > 0, haveB = leafDataB.length > 0;
  if (!haveA && !haveB) return;
  const src = (haveA && haveB) ? (Math.random() > 0.5 ? leafDataA : leafDataB)
            : (haveA ? leafDataA : leafDataB);
  const idx = acquireSlot();
  if (idx < 0) return;
  const L = src[Math.floor(Math.random() * src.length)];
  // Fields are long-lived (leaf lives across frames until it settles), so each
  // falling leaf genuinely needs its own Vector3/Quaternion — only the transient
  // offset vector and Euler are reused.
  const pos = new THREE.Vector3(
    L.pos.x + (Math.random() - 0.5) * 0.3,
    L.pos.y + (Math.random() - 0.5) * 0.2,
    L.pos.z + (Math.random() - 0.5) * 0.3,
  );
  const vel = new THREE.Vector3(
    (Math.random() - 0.5) * 0.7 * strength,
    -0.05 - Math.random() * 0.2,
    (Math.random() - 0.5) * 0.7 * strength,
  );
  const q = new THREE.Quaternion().setFromEuler(_spawnEuler.set(
    Math.random() * Math.PI * 2,
    Math.random() * Math.PI * 2,
    Math.random() * Math.PI * 2,
  ));
  const axis = new THREE.Vector3(
    Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5,
  ).normalize();
  fallingActive.push({
    index: idx, pos, vel, q,
    spinAxis: axis,
    spinRate: (Math.random() - 0.3) * 3.5,
    scale: L.s * (0.85 + Math.random() * 0.3),
    settling: false,
    settleQ: null,
  });
}

function clearFallingLeaves() {
  for (const f of fallingActive) {
    leafInstFall.setMatrixAt(f.index, _zeroMat);
    freeIndices.push(f.index);
  }
  for (const l of landedLeaves) {
    leafInstFall.setMatrixAt(l.index, _zeroMat);
    freeIndices.push(l.index);
  }
  fallingActive.length = 0;
  landedLeaves.length = 0;
  leafInstFall.instanceMatrix.needsUpdate = true;
}

// --- Animate -------------------------------------------------------------
const clock = new THREE.Timer();

// --- Scale overlay: map-style ruler -------------------------------------
const treeInfoEl = document.getElementById('tree-info');

// Pick a "nice" ruler length (0.5, 1, 2, 5, 10, 20, 50, 100 …) closest to targetMeters
function niceRulerMeters(target) {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const next = steps[i + 1] ?? s * 2;
    if (target < (s + next) * 0.5) return s;
  }
  return steps[steps.length - 1];
}

function updateTreeInfo() {
  // Scale ruler retired in favour of the 3D axis gizmo (#axis-gizmo). Kept
  // as a no-op so existing call sites stay valid; the element itself is
  // still in the DOM but never populated.
  if (treeInfoEl && treeInfoEl.innerHTML !== '') treeInfoEl.innerHTML = '';
}

// --- Bottom-left 3D axis gizmo -----------------------------------------
// Lightweight SVG widget that mirrors the camera orientation, like the
// XYZ indicator in Blender / Maya / Unity. Pure 2D; no extra render pass.
const axisGizmoEl = document.getElementById('axis-gizmo');
let _axisGizmoBuilt = false;
const _axisGizmoState = { tips: [], labels: {}, group: null };
function _buildAxisGizmo() {
  if (!axisGizmoEl || _axisGizmoBuilt) return;
  _axisGizmoBuilt = true;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '-32 -32 64 64');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  const g = document.createElementNS(svgNS, 'g');
  g.setAttribute('class', 'ag-stack');
  svg.appendChild(g);
  axisGizmoEl.appendChild(svg);
  // 6 axes: X+, X-, Y+, Y-, Z+, Z-. Stored with metadata for sort + render.
  const axes = [
    { axis: 0, sign: +1, color: '#ff5d6c', letter: 'X' },
    { axis: 0, sign: -1, color: '#ff5d6c', letter: 'X' },
    { axis: 1, sign: +1, color: '#7ce081', letter: 'Y' },
    { axis: 1, sign: -1, color: '#7ce081', letter: 'Y' },
    { axis: 2, sign: +1, color: '#5b9dff', letter: 'Z' },
    { axis: 2, sign: -1, color: '#5b9dff', letter: 'Z' },
  ];
  for (const a of axes) {
    const grp = document.createElementNS(svgNS, 'g');
    grp.setAttribute('class', 'ag-axis');
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '0');
    line.setAttribute('stroke', a.color);
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('pointer-events', 'none');
    grp.appendChild(line);
    // Larger transparent hit target so the tip catches clicks even when it
    // shrinks behind the visible disc.
    const hit = document.createElementNS(svgNS, 'circle');
    hit.setAttribute('r', '10');
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('class', 'ag-hit');
    hit.style.cursor = 'pointer';
    grp.appendChild(hit);
    const tip = document.createElementNS(svgNS, 'circle');
    tip.setAttribute('r', a.sign > 0 ? '7' : '5');
    tip.setAttribute('fill', a.sign > 0 ? a.color : 'transparent');
    tip.setAttribute('stroke', a.color);
    tip.setAttribute('stroke-width', '1.4');
    tip.setAttribute('pointer-events', 'none');
    grp.appendChild(tip);
    let label = null;
    if (a.sign > 0) {
      label = document.createElementNS(svgNS, 'text');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('font-size', '7.5');
      label.setAttribute('font-weight', '700');
      label.setAttribute('fill', '#0d0d10');
      label.setAttribute('font-family', 'ui-sans-serif, system-ui, sans-serif');
      label.setAttribute('pointer-events', 'none');
      label.textContent = a.letter;
      grp.appendChild(label);
    }
    // pointerdown (not click) so we win the race against any capture-phase
    // pointerdown listeners on the canvas / document.
    hit.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      _axisGizmoFlyTo(a.axis, a.sign);
    });
    g.appendChild(grp);
    _axisGizmoState.tips.push({ ...a, grp, line, tip, hit, label });
  }
  _axisGizmoState.group = g;
}

// Animate the camera to view the scene from the given axis direction.
// axisIdx: 0=X, 1=Y, 2=Z.  sign: +1 / -1.
function _axisGizmoFlyTo(axisIdx, sign) {
  const center = new THREE.Vector3();
  let fitDist;
  if (treeMesh && treeMesh.geometry) {
    // Always recompute — cached bbox can be stale after a rebuild and the
    // matrix-aware `_assignTreeBounds` path occasionally leaves degenerate
    // values that produce NaN distances.
    treeMesh.geometry.computeBoundingBox();
    const bbox = treeMesh.geometry.boundingBox;
    if (bbox && Number.isFinite(bbox.min.x) && Number.isFinite(bbox.max.x)) {
      bbox.getCenter(center);
      const size = new THREE.Vector3();
      bbox.getSize(size);
      fitDist = Math.max(size.x, size.y, size.z) * 1.9;
    }
  }
  if (!Number.isFinite(fitDist) || fitDist <= 0) {
    center.copy(controls.target);
    fitDist = Math.max(0.1, camera.position.distanceTo(controls.target));
  }
  const off = new THREE.Vector3();
  off.setComponent(axisIdx, sign * fitDist);
  // Top / bottom views: nudge slightly off-axis so OrbitControls doesn't lock
  // into the gimbal-singularity at exact ±Y.
  if (axisIdx === 1) off.z += 0.01 * sign;
  reframeAnim = {
    fromCam: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toCam: center.clone().add(off),
    toTarget: center.clone(),
    t: 0, duration: 0.7,
  };
}
const _axisV = new THREE.Vector3();
const _axisQ = new THREE.Quaternion();
function updateAxisGizmo() {
  if (!axisGizmoEl) return;
  if (!_axisGizmoBuilt) _buildAxisGizmo();
  // World→view rotation. Strip translation by using camera quaternion only.
  // Inverse camera quaternion takes world vectors to view space.
  _axisQ.copy(camera.quaternion).invert();
  const R = 22; // tip radius in viewBox units (viewBox is 64×64 around 0)
  const tips = _axisGizmoState.tips;
  for (const t of tips) {
    _axisV.set(0, 0, 0);
    _axisV.setComponent(t.axis, t.sign);
    _axisV.applyQuaternion(_axisQ);
    // SVG y is down; flip vector y so +Y world reads as up on screen.
    const x = _axisV.x * R;
    const y = -_axisV.y * R;
    t._x = x; t._y = y; t._z = _axisV.z;
    t.line.setAttribute('x2', x.toFixed(2));
    t.line.setAttribute('y2', y.toFixed(2));
    t.tip.setAttribute('cx', x.toFixed(2));
    t.tip.setAttribute('cy', y.toFixed(2));
    // Click hit-ring tracks the visible tip — without this, every hit ring
    // stays at the gizmo origin and only one axis catches clicks.
    if (t.hit) {
      t.hit.setAttribute('cx', x.toFixed(2));
      t.hit.setAttribute('cy', y.toFixed(2));
    }
    if (t.label) {
      t.label.setAttribute('x', x.toFixed(2));
      t.label.setAttribute('y', y.toFixed(2));
    }
    // Back-facing axes fade so the front ones read clearly.
    const back = _axisV.z < 0;
    t.grp.style.opacity = back ? '0.45' : '1';
  }
  // SVG draws in DOM order (no z-index); reappend tips in z-ascending order
  // so larger-z (closer to camera) renders on top of smaller-z.
  const sorted = tips.slice().sort((a, b) => a._z - b._z);
  const g = _axisGizmoState.group;
  for (const t of sorted) g.appendChild(t.grp);
}

// --- Stats overlay ------------------------------------------------------
const statsEl = document.getElementById('stats');
const stats = {
  lastUpdate: 0,
  frames: 0,
  fps: 0,
  accumDt: 0,
  // GPU frame time — rolling average of the last N rendered frames. Populated
  // from performance.now() around `await postProcessing.render()` in animate().
  // On a 60 Hz monitor rAF caps fps to 60, so wall-clock fps alone can't tell
  // you whether you have headroom. `gpuMs` is the real cost per render.
  gpuMs: 0,
  gpuMsMax: 0,
  gpuSamples: [],  // ring buffer of recent ms values
  gpuIdx: 0,
};
const GPU_SAMPLE_CAP = 30;
// Force a render every frame, even when the scene is idle — used to measure
// steady-state GPU cost. Toggled by the `F` hotkey.
let _forceRender = false;
function updateStats(dt) {
  if (!statsEl) return;
  stats.frames++;
  stats.accumDt += dt;
  if (stats.accumDt < 0.5) return;
  stats.fps = stats.frames / stats.accumDt;
  stats.frames = 0;
  stats.accumDt = 0;

  const info = renderer.info;
  const tris = info.render.triangles || 0;
  const lines = info.render.lines || 0;
  const calls = info.render.calls || 0;
  const geos = info.memory.geometries || 0;
  const tex = info.memory.textures || 0;
  const nodeCount = treeMesh ? (treeMesh.geometry.attributes.position.count) : 0;
  const leafCount = (leafInstA?.count || 0) + (leafInstB?.count || 0);
  const fallen = landedLeaves.length;

  const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  // GPU ms — average of the sample buffer, theoretical max fps from that.
  let gpuMsAvg = 0;
  if (stats.gpuSamples.length) {
    let sum = 0;
    for (const v of stats.gpuSamples) sum += v;
    gpuMsAvg = sum / stats.gpuSamples.length;
  }
  const theoryFps = gpuMsAvg > 0 ? Math.min(999, Math.floor(1000 / gpuMsAvg)) : 0;
  stats.gpuMs = gpuMsAvg;
  const gpuLine = gpuMsAvg > 0
    ? `${gpuMsAvg.toFixed(2)} ms <span class="dim">(~${theoryFps}fps${_forceRender ? '*' : ''})</span>`
    : '—';
  statsEl.innerHTML =
    `<div class="row"><span class="k">fps</span><span class="v">${stats.fps.toFixed(0)}</span></div>` +
    `<div class="row"><span class="k">gpu</span><span class="v">${gpuLine}</span></div>` +
    `<div class="row"><span class="k">tris</span><span class="v">${fmt(tris)}</span></div>` +
    `<div class="row"><span class="k">lines</span><span class="v">${fmt(lines)}</span></div>` +
    `<div class="row"><span class="k">calls</span><span class="v">${calls}</span></div>` +
    `<div class="row"><span class="k">geos</span><span class="v">${geos}</span></div>` +
    `<div class="row"><span class="k">tex</span><span class="v">${tex}</span></div>` +
    `<div class="row"><span class="k">verts</span><span class="v">${fmt(nodeCount)}</span></div>` +
    `<div class="row"><span class="k">leaves</span><span class="v">${fmt(leafCount)}</span></div>` +
    `<div class="row"><span class="k">fallen</span><span class="v">${fallen}</span></div>`;
}


const _animSpinQ = new THREE.Quaternion();
const _animXAxis = new THREE.Vector3(1, 0, 0);
const _animYAxis = new THREE.Vector3(0, 1, 0);
const _animQPitch = new THREE.Quaternion();
const _animQYaw = new THREE.Quaternion();

// --- Motion-gated render -------------------------------------------------
// We used to call postProcessing.render() every frame whether the scene
// changed or not. When the user isn't interacting and nothing is animating,
// those renders produce identical pixels at full GPU cost. Track frame
// dirtiness explicitly instead.
let _renderDirtyFrames = 4; // burn a few startup frames
function markRenderDirty(n = 2) {
  if (n > _renderDirtyFrames) _renderDirtyFrames = n;
}
// Any user input bumps dirty frames so orbit damping has time to settle.
['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'resize'].forEach((ev) => {
  window.addEventListener(ev, () => markRenderDirty(3), { passive: true });
});
// OrbitControls emits 'change' whenever the camera moved (including damping).
controls.addEventListener('change', () => markRenderDirty(2));

let _paused = document.hidden;
let _savedExposure = renderer.toneMappingExposure;
// Pause dim — tween the three-point scene lights (key/fill/rim/ambient)
// toward a fraction of their normal strength over ~0.4 s instead of an
// instant exposure cut. This lets the environment genuinely "dim" as if the
// scene lights drop, rather than just darkening the framebuffer.
const PAUSE_DIM = 0.22;
const PAUSE_FADE_SEC = 0.45;
let _pauseFade = 1;      // 1 = fully lit, 0 = fully dimmed
let _pauseTarget = 1;    // tween target
const _lightBase = {
  key: key?.intensity ?? 1,
  fill: fill?.intensity ?? 1,
  rim: rim?.intensity ?? 1,
  ambient: ambient?.intensity ?? 1,
};
function _applyLightDim(factor) {
  const k = Math.max(0, Math.min(1, factor));
  if (key)     key.intensity     = _lightBase.key     * k;
  if (fill)    fill.intensity    = _lightBase.fill    * k;
  if (rim)     rim.intensity     = _lightBase.rim     * k;
  if (ambient) ambient.intensity = _lightBase.ambient * (PAUSE_DIM + (1 - PAUSE_DIM) * k);
}
function tickPauseFade(dt) {
  if (_pauseFade === _pauseTarget) return;
  const rate = dt / PAUSE_FADE_SEC;
  if (_pauseFade < _pauseTarget) _pauseFade = Math.min(_pauseTarget, _pauseFade + rate);
  else                           _pauseFade = Math.max(_pauseTarget, _pauseFade - rate);
  _applyLightDim(PAUSE_DIM + (1 - PAUSE_DIM) * _pauseFade);
}

function setPaused(on) {
  const wasPaused = _paused;
  _paused = on;
  if (on) showPillPersistent('zZ', 'Paused', 'paused');
  else    hidePillPersistent();
  // Refresh light-base cache in case the lighting preset changed since last pause.
  if (on && !wasPaused) {
    _lightBase.key     = key?.intensity     ?? _lightBase.key;
    _lightBase.fill    = fill?.intensity    ?? _lightBase.fill;
    _lightBase.rim     = rim?.intensity     ?? _lightBase.rim;
    _lightBase.ambient = ambient?.intensity ?? _lightBase.ambient;
  }
  _pauseTarget = on ? 0 : 1;
}
let _animateErrStreak = 0;
async function animate() {
 try {
  // Keep the loop running through a pause fade. Once the fade has finished
  // and we're still paused, we truly halt until the user returns.
  if (_paused && _pauseFade === _pauseTarget) {
    requestAnimationFrame(animate);
    return;
  }
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.getElapsed();
  tickPauseFade(dt);

  // LOD auto-switch by camera distance — picks the cheapest LOD whose
  // threshold is ≤ distance, hides all others + LOD0 so only one renders.
  if (P.lodAutoSwitch === 'on' && treeMesh && _lodPreviewMeshes.size > 0) {
    _updateAutoLOD();
  }

  // Dynamic tree simulation: run while wind is on, during a grab, and until motion decays.
  // Skipped entirely during a slider scrub — the tree is being rebuilt every
  // ~90 ms, so running sim on soon-to-be-stale state just burns main-thread
  // time that rAF needs for the rebuild. Resumes on endScrub.
  // Wind mode 'shader' delegates idle wind to TSL — only spend the CPU budget
  // on sim when grabbing or when a previously-running sim is still settling.
  const windOn = P.wind.enabled;
  const grabbing = grabbedNodeIdx >= 0;
  const skeletonModeActive = (P.wind.mode === 'skeleton') || grabbing || _simActive;
  uBarkWindEnable.value = (windOn && !skeletonModeActive) ? 1 : 0;
  uWindEnable.value = windOn ? 1 : 0;
  if (!isScrubbing && skeleton.length && skeletonModeActive && (windOn || grabbing || _simActive)) {
    stepSim(dt, t);
    updateBark();
    updateLeafInstances();
    updateStemInstances();
    if (splineViewOn) updateSplineMesh();
    _simActive = grabbing || (P.wind.mode === 'skeleton' && windOn) || simHasMotion();
  } else if (_barkNeedsRestReset) {
    // Skeleton sim was running last frame and left bark mid-bend. Restore the
    // rest pose so the shader-only wind path starts from a clean buffer.
    _resetBarkToRest();
  }

  // Falling leaves — opt-in via P.leavesFallEnabled (default off).
  if (P.leavesFallEnabled && !isScrubbing && P.treeType !== 'conifer' && leafDataA.length + leafDataB.length > 0) {
    const spawnChance = _simActive ? 0.05 : 0.02;
    if (Math.random() < spawnChance) spawnFallingLeaf(0.6);
  }

  // Skip falling-leaf physics during scrub — any active falls are about to be
  // invalidated by the regen anyway, and the per-leaf matrix write churn adds
  // real cost when 40+ leaves are in flight.
  const hadFalling = !isScrubbing && fallingActive.length > 0;
  if (!isScrubbing) for (let i = fallingActive.length - 1; i >= 0; i--) {
    const f = fallingActive[i];
    if (!f.settling) {
      // Free-fall physics
      f.vel.y -= 0.35 * dt;
      f.vel.x += (Math.sin(t * 0.8 + f.pos.y * 0.5) * 0.9 - f.vel.x) * 0.02;
      f.vel.z += (Math.cos(t * 0.6 + f.pos.x * 0.5) * 0.9 - f.vel.z) * 0.02;
      f.pos.addScaledVector(f.vel, dt);
      // Tumbling spin around axis
      _animSpinQ.setFromAxisAngle(f.spinAxis, f.spinRate * dt);
      f.q.multiply(_animSpinQ);
      // Touchdown: begin settling
      if (f.pos.y < 0.04) {
        f.pos.y = 0.04;
        f.settling = true;
        f.vel.set(0, 0, 0);
        // Build rest quaternion as Ry(yaw) * Rx(-π/2 + jitter) so normal always points +Y
        const pitch = -Math.PI / 2 + (Math.random() - 0.5) * 0.1;
        const yaw = Math.random() * Math.PI * 2;
        _animQPitch.setFromAxisAngle(_animXAxis, pitch);
        _animQYaw.setFromAxisAngle(_animYAxis, yaw);
        f.settleQ = _animQYaw.clone().multiply(_animQPitch);
      }
    } else {
      // Slerp toward rest — smooth out the "land flat" transition
      f.q.slerp(f.settleQ, Math.min(1, dt * 12));
      if (f.q.angleTo(f.settleQ) < 0.04) {
        // Snap to perfectly flat and retire into landedLeaves
        _dummy.position.copy(f.pos);
        _dummy.quaternion.copy(f.settleQ);
        _dummy.scale.setScalar(f.scale);
        _dummy.updateMatrix();
        leafInstFall.setMatrixAt(f.index, _dummy.matrix);
        landedLeaves.push({
          index: f.index,
          pos: f.pos.clone(),
          quat: f.settleQ.clone(),
          scale: f.scale,
          fading: false,
          fadeT: 0,
        });
        fallingActive.splice(i, 1);
        continue;
      }
    }
    _dummy.position.copy(f.pos);
    _dummy.quaternion.copy(f.q);
    _dummy.scale.setScalar(f.scale);
    _dummy.updateMatrix();
    leafInstFall.setMatrixAt(f.index, _dummy.matrix);
  }

  // Enforce max fallen count: start fading oldest over the limit. Skip the
  // scan entirely when there can't possibly be overflow (landedLeaves is small).
  const maxFallen = Math.max(0, P.fallenMax ?? 120);
  const fadeTime = Math.max(0.1, P.fallenFade ?? 3);
  if (landedLeaves.length > maxFallen) {
    let needFading = 0;
    for (const l of landedLeaves) if (!l.fading) needFading++;
    let overflow = needFading - maxFallen;
    if (overflow > 0) {
      for (let i = 0; i < landedLeaves.length && overflow > 0; i++) {
        if (!landedLeaves[i].fading) {
          landedLeaves[i].fading = true;
          overflow--;
        }
      }
    }
  }

  let landedDirty = false;
  for (let i = landedLeaves.length - 1; i >= 0; i--) {
    const l = landedLeaves[i];
    if (!l.fading) continue;
    l.fadeT += dt / fadeTime;
    if (l.fadeT >= 1) {
      leafInstFall.setMatrixAt(l.index, _zeroMat);
      freeIndices.push(l.index);
      landedLeaves.splice(i, 1);
      landedDirty = true;
      continue;
    }
    const s = l.scale * (1 - l.fadeT);
    _dummy.position.copy(l.pos);
    _dummy.quaternion.copy(l.quat);
    _dummy.scale.setScalar(s);
    _dummy.updateMatrix();
    leafInstFall.setMatrixAt(l.index, _dummy.matrix);
    landedDirty = true;
  }

  if (hadFalling || landedDirty) leafInstFall.instanceMatrix.needsUpdate = true;

  if (reframeAnim) {
    reframeAnim.t += dt;
    const k = Math.min(1, reframeAnim.t / reframeAnim.duration);
    // Ease-in-out cubic: slow start, fast middle, slow stop — gentler
    // framing motion than a pure ease-out.
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(reframeAnim.fromCam, reframeAnim.toCam, e);
    controls.target.lerpVectors(reframeAnim.fromTarget, reframeAnim.toTarget, e);
    if (k >= 1) reframeAnim = null;
  }

  // Auto-orbit — rotate the camera around its orbit target on the world Y
  // axis at the user's chosen rate. Skipped during a reframe animation so
  // the lerp doesn't fight the rotation, and during pointer interaction so
  // the user can grab back control mid-orbit (OrbitControls handles that
  // by pausing controls.update() input — we just stop adding rotation).
  if (P.settings.autoOrbit && !reframeAnim && !grabbing) {
    const dps = P.settings.autoOrbitSpeed ?? 8;
    const ang = dps * (Math.PI / 180) * dt;
    const tgt = controls.target;
    const px = camera.position.x - tgt.x;
    const pz = camera.position.z - tgt.z;
    const c = Math.cos(ang), s = Math.sin(ang);
    camera.position.x = tgt.x + (px * c - pz * s);
    camera.position.z = tgt.z + (px * s + pz * c);
    markRenderDirty(2);
  }

  updateOrbitFloorClamp();
  controls.update();
  // Anything that mutates the visible scene this frame counts as motion.
  const sceneMoving = _simActive || hadFalling || landedDirty || !!reframeAnim;
  if (sceneMoving) markRenderDirty(2);
  if (_forceRender) markRenderDirty(1);
  if (_renderDirtyFrames > 0) {
    // Measure real GPU cost. `await` blocks until WebGPU's submission queue
    // drains, which is the closest approximation of per-frame GPU time we
    // can get without timestamp queries. Sample into a ring buffer so
    // updateStats() can show a smoothed ms value.
    const t0 = performance.now();
    await postProcessing.render();
    const ms = performance.now() - t0;
    stats.gpuSamples[stats.gpuIdx] = ms;
    stats.gpuIdx = (stats.gpuIdx + 1) % GPU_SAMPLE_CAP;
    if (ms > stats.gpuMsMax) stats.gpuMsMax = ms;
    _renderDirtyFrames--;
  }
  updateStats(dt);
  // Refresh the scale ruler + person silhouette as the user zooms. Gated on
  // camera-distance change so it's not thrashing the DOM every frame.
  _maybeUpdateScaleOverlay();
  // Floating per-tree stat labels: cheap DOM transform writes, must run
  // every frame so they stay locked to their meshes during orbit / reframe.
  _updateTreeLabelPositions();
  // 3D axis indicator (XYZ gizmo): refresh whenever the camera moved.
  if (sceneMoving || _renderDirtyFrames > 0 || !_axisGizmoBuilt) updateAxisGizmo();
  _animateErrStreak = 0;
 } catch (e) {
  // One bad frame shouldn't kill the whole app. Keep the loop going; if we
  // crash every frame for a stretch, bail so we don't spam the console.
  console.error('animate() error:', e);
  if (++_animateErrStreak > 30) { console.error('animate() crashing repeatedly — halting loop'); return; }
 }
 requestAnimationFrame(animate);
}

let _lastCamDist = -1;
function _maybeUpdateScaleOverlay() {
  const d = camera.position.distanceTo(controls.target);
  if (Math.abs(d - _lastCamDist) < 0.05) return;
  _lastCamDist = d;
  updateTreeInfo();
}

window.addEventListener('resize', () => {
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  if (w <= 0 || h <= 0) return; // skip while hidden/minimized — WebGPU rejects 0-size
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// Canvas resizes during the sculpt-mode sidebar collapse animation — keep
// the renderer in sync each step so the view doesn't squash mid-transition.
if (typeof ResizeObserver !== 'undefined') {
  let _canvasSize = { w: canvasWrap.clientWidth, h: canvasWrap.clientHeight };
  new ResizeObserver(() => {
    const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (w === _canvasSize.w && h === _canvasSize.h) return;
    _canvasSize.w = w; _canvasSize.h = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    markRenderDirty(2);
  }).observe(canvasWrap);
}

// Pause WebGPU render + sim when the tab/window is not visible.
// Reset the Clock on resume so the first frame's dt isn't the full blur duration.
// The animate loop self-schedules every frame even while paused (see top of
// animate()), so resuming only needs to clear `_paused` + reset the Timer.
// Calling requestAnimationFrame(animate) here would stack a second loop on
// top of the existing chain — every later frame would run animate twice,
// which divides dt across two stepSim calls and triggers infinite-velocity
// blow-ups in the velocity-reconstruction divide.
function resumeFromPause() {
  if (!_paused) return;
  setPaused(false);
  // Timer.getDelta() is a getter — only update()/reset() advance state. Reset
  // clears `_previousTime` so the next animate frame starts with a fresh dt
  // instead of inheriting the entire pause duration.
  clock.reset();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Any active drag must end here — pointerup fires on whichever window owns
    // focus, not ours, so without this the branch would stay pinned and snap
    // wildly when the user releases after refocus.
    if (grabbedNodeIdx >= 0) onGrabEnd();
    setPaused(true);
  } else {
    resumeFromPause();
  }
});
window.addEventListener('blur', () => {
  if (grabbedNodeIdx >= 0) onGrabEnd();
  setPaused(true);
});
window.addEventListener('focus', resumeFromPause);

applyLeafMaterial();
applyTreeTypeVisibility();

// --- Sidebar section rail (floating quick-nav pill) ----------------------
// Mirrors the visible top-level SECTIONS (`.section-label` dividers added
// via addSectionLabel — Shape / Foliage / Bark / Scene / etc.) as a column
// of icon buttons pinned to the right of the canvas. Click = scroll the
// sidebar to that section. Hover = floating label to the left of the icon.
let rebuildSectionRail = () => {};
(function initSectionRail() {
  const canvasWrap = document.getElementById('canvas-wrap');
  const sbBody = document.getElementById('sidebar-body');
  if (!canvasWrap || !sbBody) return;
  const rail = document.createElement('div');
  rail.id = 'section-rail';
  const inner = document.createElement('div');
  inner.className = 'section-rail-inner';
  rail.appendChild(inner);
  canvasWrap.appendChild(rail);

  let rafId = 0;
  rebuildSectionRail = function () {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      inner.textContent = '';
      for (const el of sbBody.querySelectorAll(':scope > .section-label')) {
        if (el.style.display === 'none') continue;
        // The label's first <span> is the .sec-icon wrapper (no text).
        // The text lives on a sibling span — :not(.sec-icon) picks it.
        const txt = el.querySelector(':scope > span:not(.sec-icon)')?.textContent?.trim();
        if (!txt) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'section-notch';
        btn.setAttribute('aria-label', txt);
        // Build a fresh icon via iconSvg — cloning the sidebar's .sec-icon
        // span doesn't render reliably outside the #sidebar scope (its CSS
        // sizing is scoped, and color inheritance breaks when the cloned
        // node lands in a different DOM subtree).
        const iconName = el.dataset.icon;
        if (iconName) {
          const ic = document.createElement('span');
          ic.className = 'section-notch-icon';
          ic.innerHTML = iconSvg(iconName, 16);
          btn.appendChild(ic);
        }
        const tip = document.createElement('span');
        tip.className = 'section-notch-tip';
        tip.textContent = txt;
        btn.appendChild(tip);
        btn.addEventListener('click', () => {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        inner.appendChild(btn);

        // Branching section: append a numbered sub-notch per level so the
        // user can jump straight to Level 1, 2, … from the rail.
        if (txt.toLowerCase() === 'branching') {
          const lw = document.getElementById('levels-wrapper');
          if (lw && lw.style.display !== 'none') {
            const levelCards = lw.querySelectorAll(':scope > details');
            let n = 0;
            for (const card of levelCards) {
              const label = card.querySelector(':scope > summary .sec-label');
              if (!label || !/^Level\s+\d+/i.test(label.textContent || '')) continue;
              n += 1;
              const num = n;
              const sub = document.createElement('button');
              sub.type = 'button';
              sub.className = 'section-notch section-notch-sub';
              sub.setAttribute('aria-label', `Level ${num}`);
              const lbl = document.createElement('span');
              lbl.className = 'section-notch-num';
              lbl.textContent = String(num);
              sub.appendChild(lbl);
              const stip = document.createElement('span');
              stip.className = 'section-notch-tip';
              stip.textContent = `Level ${num}`;
              sub.appendChild(stip);
              sub.addEventListener('click', () => {
                if (!card.hasAttribute('open')) card.setAttribute('open', '');
                card.scrollIntoView({ behavior: 'smooth', block: 'start' });
              });
              inner.appendChild(sub);
            }
          }
        }
      }
    });
  };
})();
// Wrap visibility updater so the rail rebuilds when sections appear/hide.
const _applyTreeTypeVisibilityOrig = applyTreeTypeVisibility;
applyTreeTypeVisibility = function () {
  _applyTreeTypeVisibilityOrig();
  rebuildSectionRail();
};
rebuildSectionRail();

// --- Details expand/collapse animation ----------------------------------
// Wraps each <details>'s non-summary children in `.d-body > .d-inner` so CSS
// can transition grid-template-rows from 0fr → 1fr. One-time per element.
function wrapDetailsForAnimation(root) {
  const list = root.querySelectorAll('details');
  for (const d of list) {
    if (d.querySelector(':scope > .d-body')) continue;
    const summary = d.querySelector(':scope > summary');
    const kids = [];
    for (const c of d.children) if (c !== summary) kids.push(c);
    if (!kids.length) continue;
    const body = document.createElement('div'); body.className = 'd-body';
    const inner = document.createElement('div'); inner.className = 'd-inner';
    for (const c of kids) inner.appendChild(c);
    body.appendChild(inner);
    d.appendChild(body);
  }
}
wrapDetailsForAnimation(document.getElementById('sidebar-body'));
// Rewrap on level changes (add/remove/copy rebuild the level cards).
const _renderLevelsOrig = renderLevels;
renderLevels = function (...args) {
  _renderLevelsOrig(...args);
  wrapDetailsForAnimation(document.getElementById('levels-wrapper'));
  // Section rail mirrors the level cards as numbered sub-notches under the
  // Branching icon, so it has to refresh whenever a level is added/removed.
  rebuildSectionRail();
};

// --- Custom select dropdown ---------------------------------------------
function enhanceSelect(nativeSelect) {
  if (nativeSelect.dataset.csEnhanced) return;
  nativeSelect.dataset.csEnhanced = '1';
  nativeSelect.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'cs-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cs-btn';
  const label = document.createElement('span'); label.className = 'cs-label';
  const caret = document.createElement('span'); caret.className = 'cs-caret';
  btn.append(label, caret);
  wrap.appendChild(btn);

  const panel = document.createElement('div');
  panel.className = 'cs-panel';
  panel.hidden = true;
  document.body.appendChild(panel);

  function syncLabel() {
    const opt = nativeSelect.options[nativeSelect.selectedIndex];
    label.textContent = opt ? opt.textContent : '';
  }
  function buildItems() {
    panel.innerHTML = '';
    const curVal = nativeSelect.value;
    for (const opt of nativeSelect.options) {
      const item = document.createElement('div');
      item.className = 'cs-item' + (opt.value === curVal ? ' active' : '');
      if (opt.disabled) item.classList.add('disabled');
      item.textContent = opt.textContent;
      item.addEventListener('click', () => {
        if (opt.disabled) return;
        nativeSelect.value = opt.value;
        nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        closeIt();
      });
      panel.appendChild(item);
    }
    syncLabel();
  }
  function position() {
    const r = btn.getBoundingClientRect();
    panel.style.left  = r.left + 'px';
    panel.style.top   = (r.bottom + 4) + 'px';
    panel.style.width = r.width + 'px';
  }
  function onDoc(e) { if (!panel.contains(e.target) && !wrap.contains(e.target)) closeIt(); }
  function onScroll(e) { if (!panel.contains(e.target)) closeIt(); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeIt(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...panel.querySelectorAll('.cs-item:not(.disabled)')];
      if (!items.length) return;
      let idx = items.findIndex((x) => x.classList.contains('focus'));
      idx = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (idx < 0) idx = 0;
      items.forEach((x, i) => x.classList.toggle('focus', i === idx));
      items[idx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const f = panel.querySelector('.cs-item.focus');
      if (f) f.click();
    }
  }
  let open = false;
  function openIt() {
    buildItems(); position();
    panel.hidden = false; wrap.classList.add('open'); open = true;
    setTimeout(() => {
      document.addEventListener('pointerdown', onDoc);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', position);
      document.addEventListener('keydown', onKey);
    }, 0);
  }
  function closeIt() {
    if (!open) return;
    open = false;
    panel.hidden = true; wrap.classList.remove('open');
    document.removeEventListener('pointerdown', onDoc);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('keydown', onKey);
  }
  btn.addEventListener('click', () => (open ? closeIt() : openIt()));

  const mo = new MutationObserver(() => { syncLabel(); if (open) buildItems(); });
  mo.observe(nativeSelect, { childList: true });
  nativeSelect.addEventListener('change', syncLabel);

  // Intercept programmatic `select.value = ...` so the label stays in sync.
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(nativeSelect, 'value', {
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); syncLabel(); if (open) buildItems(); },
    configurable: true,
  });

  nativeSelect.parentNode.insertBefore(wrap, nativeSelect.nextSibling);
  syncLabel();
}
function enhanceAllSelects(root = document) {
  root.querySelectorAll('select.select:not([data-cs-enhanced])').forEach(enhanceSelect);
}

// --- Custom tooltips (+ keyboard-shortcut chip) --------------------------
// Map of element id → { key: 'Ctrl+K', label: 'optional override' }.
// Tooltips that have a matching shortcut render the combo in a dim chip.
const TOOLTIP_SHORTCUTS = {
  'tb-regen':     { key: 'R' },
  'tb-wire':      { key: 'W' },
  'tb-spline':    { key: 'S' },
  'tb-leaves':    { key: 'L' },
  'tb-physics':   { key: 'P' },
  'tb-theme':     { key: 'T' },
  'tb-screenshot':{ key: 'Shift+P' },
  'tb-export':    { key: 'Ctrl+Shift+C' },
  'tb-gltf':      { key: 'Ctrl+E' },
  'tb-upload':    { key: 'Ctrl+U' },
};
const GLOBAL_SHORTCUTS = [
  { combo: 'Ctrl+K',       label: 'Command palette' },
  { combo: 'Ctrl+Z',       label: 'Undo' },
  { combo: 'Ctrl+Shift+Z', label: 'Redo' },
];

(function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tt';
  tip.hidden = true;
  document.body.appendChild(tip);

  function capture(el) {
    if (el.title) {
      el.dataset.tooltip = el.title;
      el.removeAttribute('title');
    }
  }
  document.querySelectorAll('[title]').forEach(capture);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        capture(n);
        if (n.querySelectorAll) n.querySelectorAll('[title]').forEach(capture);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  let showTimer = null, target = null;
  // Short window after a tooltip dismisses where the next one appears
  // instantly with no fade. Lets users sweep across a row of scrubbers
  // without waiting for each delay; reverts to slow path once they pause.
  let lastHideAt = 0;
  const INSTANT_WINDOW = 600;
  const SHOW_DELAY = 700;
  function render(el) {
    tip.innerHTML = '';
    const msg = document.createElement('span');
    msg.className = 'tt-msg';
    msg.textContent = el.dataset.tooltip;
    tip.appendChild(msg);
    const sc = el.id && TOOLTIP_SHORTCUTS[el.id];
    if (sc) {
      const chip = document.createElement('span');
      chip.className = 'tt-chip';
      chip.textContent = sc.key;
      tip.appendChild(chip);
    }
  }
  function position(el) {
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.right + 10;
    let top = r.top + (r.height - tr.height) / 2;
    if (left + tr.width > window.innerWidth - 8) left = r.left - tr.width - 10;
    if (top < 8) top = 8;
    if (top + tr.height > window.innerHeight - 8) top = window.innerHeight - 8 - tr.height;
    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';
  }
  function showFor(el, instant) {
    render(el);
    tip.classList.toggle('instant', !!instant);
    tip.hidden = false;
    requestAnimationFrame(() => { position(el); tip.classList.add('show'); });
  }
  function hide() {
    tip.classList.remove('show');
    lastHideAt = performance.now();
    setTimeout(() => { if (!tip.classList.contains('show')) tip.hidden = true; }, 140);
  }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-tooltip]');
    if (!el || el === target) return;
    target = el;
    clearTimeout(showTimer);
    // If the user just dismissed another tooltip a moment ago, treat this
    // as a continuous exploration — show immediately, no fade. Otherwise
    // fall back to the standard delay.
    const inWindow = (performance.now() - lastHideAt) < INSTANT_WINDOW;
    if (inWindow) showFor(el, true);
    else showTimer = setTimeout(() => showFor(el, false), SHOW_DELAY);
  });
  document.addEventListener('mouseout', (e) => {
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    clearTimeout(showTimer);
    target = null;
    hide();
  });
  document.addEventListener('pointerdown', () => {
    clearTimeout(showTimer);
    target = null;
    hide();
  });
})();

// --- Shortcut pill (top-center flash when a shortcut fires) ------------
const _skPill = (() => {
  const el = document.createElement('div');
  el.id = 'sk-pill';
  el.hidden = true;
  el.innerHTML = '<span class="sk-key"></span><span class="sk-label"></span>';
  document.body.appendChild(el);
  return el;
})();
const _skKey = _skPill.querySelector('.sk-key');
const _skLabel = _skPill.querySelector('.sk-label');
let _skTimer = null, _skHideTimer = null;
// --- Generic busy pill ---------------------------------------------------
// Shows a small label in the top-right of the canvas while any long-running
// calculation is active (tree gen, LOD simplify, export, variation batch,
// growth timelapse, …). Counter-based so nested calls don't flicker; 120 ms
// show-delay so sub-frame ops stay quiet.
const _busyStack = [];
let _busyEl = null;
let _busyShowTimer = 0;
let _busyHideTimer = 0;
function _ensureBusyEl() {
  if (_busyEl) return _busyEl;
  const host = document.getElementById('canvas-wrap') || document.body;
  const el = document.createElement('div');
  el.id = 'busy-pill';
  el.hidden = true;
  el.style.cssText = [
    'position:absolute', 'top:14px', 'left:50%', 'z-index:9',
    'display:flex', 'align-items:center', 'gap:8px',
    'padding:6px 12px 6px 10px',
    'background:rgba(18,18,22,0.82)', 'backdrop-filter:blur(8px)',
    '-webkit-backdrop-filter:blur(8px)',
    'border:1px solid rgba(255,255,255,0.08)',
    'border-radius:999px',
    'color:rgba(255,255,255,0.88)',
    'font:12px/1.2 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif',
    'letter-spacing:0.02em',
    'pointer-events:none',
    'opacity:0', 'transform:translate(-50%, -4px)',
    'transition:opacity 160ms ease, transform 160ms ease',
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = [
    'width:8px', 'height:8px', 'border-radius:50%',
    'background:#ffbf47',
    'box-shadow:0 0 8px rgba(255,191,71,0.55)',
    'animation:busyPulse 900ms ease-in-out infinite',
  ].join(';');
  const label = document.createElement('span');
  label.className = 'busy-label';
  el.append(dot, label);
  if (!document.getElementById('busy-pill-kf')) {
    const style = document.createElement('style');
    style.id = 'busy-pill-kf';
    style.textContent = '@keyframes busyPulse { 0%,100% { opacity:.35; transform:scale(.8); } 50% { opacity:1; transform:scale(1.15); } }';
    document.head.appendChild(style);
  }
  host.appendChild(el);
  _busyEl = el;
  return el;
}
function _updateBusyPill() {
  const el = _ensureBusyEl();
  if (!el) return;
  const active = _busyStack.length > 0;
  const label = active ? _busyStack[_busyStack.length - 1] : '';
  if (active) {
    el.querySelector('.busy-label').textContent = label;
    clearTimeout(_busyHideTimer);
    if (el.hidden) {
      clearTimeout(_busyShowTimer);
      _busyShowTimer = setTimeout(() => {
        el.hidden = false;
        requestAnimationFrame(() => {
          el.style.opacity = '1';
          el.style.transform = 'translate(-50%, 0)';
        });
      }, 120);
    }
  } else {
    clearTimeout(_busyShowTimer);
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%, -4px)';
    clearTimeout(_busyHideTimer);
    _busyHideTimer = setTimeout(() => { el.hidden = true; }, 180);
  }
}
function beginBusy(label) {
  _busyStack.push(label || 'Working…');
  _updateBusyPill();
}
function endBusy() {
  if (_busyStack.length) _busyStack.pop();
  _updateBusyPill();
}
// Wrap a promise so endBusy fires even on throw/return.
async function withBusy(label, fn) {
  beginBusy(label);
  try { return await fn(); } finally { endBusy(); }
}

function showShortcutPill(key, label) {
  if (_pillLocked) return; // don't clobber a persistent status (e.g. Paused)
  _skKey.textContent = key;
  _skLabel.textContent = label;
  _skPill.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => _skPill.classList.add('show')));
  clearTimeout(_skTimer); clearTimeout(_skHideTimer);
  _skTimer = setTimeout(() => {
    _skPill.classList.remove('show');
    _skHideTimer = setTimeout(() => { _skPill.hidden = true; }, 200);
  }, 900);
}

// Persistent variant — used for the "Paused" status while the tab is
// backgrounded. Survives shortcut flashes (they bail via _pillLocked).
// Optional `variant` adds a modifier class (e.g. 'paused' for yellow,
// viewport-centered styling).
let _pillLocked = false;
let _pillVariant = '';
function showPillPersistent(key, label, variant = '') {
  _pillLocked = true;
  clearTimeout(_skTimer); clearTimeout(_skHideTimer);
  _skKey.textContent = key;
  _skLabel.textContent = label;
  if (_pillVariant) _skPill.classList.remove(_pillVariant);
  _pillVariant = variant;
  if (variant) _skPill.classList.add(variant);
  _skPill.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => _skPill.classList.add('show')));
}
function hidePillPersistent() {
  _pillLocked = false;
  clearTimeout(_skTimer); clearTimeout(_skHideTimer);
  _skPill.classList.remove('show');
  if (_pillVariant) { _skPill.classList.remove(_pillVariant); _pillVariant = ''; }
  _skHideTimer = setTimeout(() => { _skPill.hidden = true; }, 200);
}

// --- Global keyboard shortcuts ------------------------------------------
(function initGlobalShortcuts() {
  function isTyping(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }
  function trigger(id, key, label) {
    const b = document.getElementById(id);
    if (b) b.click();
    showShortcutPill(key, label);
  }
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      const mod = (navigator.platform.includes('Mac') ? '⌘' : 'Ctrl');
      if (e.shiftKey && k === 'c') { e.preventDefault(); trigger('tb-export',     `${mod}+Shift+C`, 'Copy preset JSON'); return; }
      if (k === 'e') { e.preventDefault(); trigger('tb-gltf',       `${mod}+E`, 'Export mesh');  return; }
      if (k === 'u') { e.preventDefault(); trigger('tb-upload',     `${mod}+U`, 'Upload leaf texture'); return; }
      return;
    }
    if (e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.shiftKey && k === 'p') { e.preventDefault(); trigger('tb-screenshot', 'Shift+P', 'Screenshot'); return; }
    if (e.shiftKey) return;
    switch (k) {
      case 'r': e.preventDefault(); trigger('tb-regen',   'R', 'Regenerate'); break;
      case 'w': e.preventDefault(); trigger('tb-wire',    'W', 'Toggle wireframe'); break;
      case 's': e.preventDefault(); trigger('tb-spline',  'S', 'Toggle spline view'); break;
      case 'l': e.preventDefault(); trigger('tb-leaves',  'L', 'Toggle leaves'); break;
      case 'p': e.preventDefault(); trigger('tb-physics', 'P', 'Toggle physics'); break;
      case 't': e.preventDefault(); trigger('tb-theme',   'T', 'Toggle theme'); break;
      case 'f':
        // Force-render mode: render every frame so the `gpu` stat reflects
        // steady-state GPU cost (the dirty-frame gate otherwise masks idle).
        e.preventDefault();
        _forceRender = !_forceRender;
        stats.gpuSamples.length = 0;
        stats.gpuIdx = 0;
        stats.gpuMsMax = 0;
        showShortcutPill('F', _forceRender ? 'Force render ON' : 'Force render OFF');
        break;
    }
  });
})();

// Dismiss once the first tree resolves — with a safety-net timeout so the
// splash never traps the user if the build throws.
let _splashDismissed = false;
function _dismissOnce() { if (_splashDismissed) return; _splashDismissed = true; splashDismiss(); }

// Warm the pipeline cache before the splash dismisses. The first
// postProcessing.render() has to compile every NodeMaterial + every RenderPipeline
// pass (scene, bloom, AO, DOF, gizmo mix), often 500–1500 ms cold. Paying that
// cost with the splash still covering the canvas means the user's first visible
// frame is already warm. compileAsync primes the main pipeline; the first
// .render() completes post-FX compilation.
async function _precompilePipelines() {
  try {
    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(scene, camera);
      await renderer.compileAsync(gizmoScene, camera);
    }
    await postProcessing.render();
  } catch (e) {
    console.warn('[boot] precompile failed, first frame will pay compile cost:', e.message);
  }
}

// Apply the Custom showcase preset on first load so the initial tree matches
// what the user sees after picking another species and returning to Custom.
// Without this, the first tree renders from raw schema defaults only.
const _firstGrow = applySpecies('Custom');
if (_firstGrow && typeof _firstGrow.then === 'function') {
  _firstGrow
    .catch((err) => { console.error('[boot] first generateTree failed:', err); })
    .then(_precompilePipelines)
    .finally(() => { requestAnimationFrame(_dismissOnce); });
} else {
  _precompilePipelines().finally(() => { requestAnimationFrame(_dismissOnce); });
}
// Safety net: if precompile hangs or first build throws before precompile, the
// splash still dismisses at 3 s so the user isn't trapped.
setTimeout(_dismissOnce, 3000);

// --- Embed bridge: parent pages can drive species selection ---------------
// Used by the portfolio's tree.html showcase carousel to cycle species
// without reloading the iframe. Same-origin only; cross-origin parents are
// silently ignored.
window.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'set-species' && typeof data.species === 'string') {
    if (typeof applySpecies === 'function') applySpecies(data.species);
    if (typeof _rebuildSpeciesBand === 'function') _rebuildSpeciesBand(data.species);
  }
});
lastStateJSON = snapshotState();
// Enhance the native <select> elements AFTER the sidebar is fully built
enhanceAllSelects();
new MutationObserver(() => enhanceAllSelects()).observe(document.body, { childList: true, subtree: true });

// --- Card enhancer: dirty dot + reset button + persisted open state ----
(function initCardEnhancer() {
  const body = document.getElementById('sidebar-body');
  if (!body) return;
  const STATE_KEY = 'webgpu-tree:cardState';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch { return {}; } })();

  function cardKey(details) {
    const summary = details.querySelector(':scope > summary');
    const label = summary && summary.querySelector('.sec-label');
    return label ? label.textContent : '';
  }
  function updateDirty(details) {
    const dirty = details.querySelector('.scrubber.modified') !== null;
    details.classList.toggle('has-dirty', dirty);
  }
  function persist() {
    const state = {};
    for (const d of body.querySelectorAll('details')) {
      const k = cardKey(d);
      if (k) state[k] = d.open;
    }
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
  }
  const persistDebounced = (() => {
    let t = null;
    return () => { clearTimeout(t); t = setTimeout(persist, 150); };
  })();

  function enhance(details) {
    if (details.dataset.enhanced) return;
    // Skip level cards — they already have copy/remove summary buttons.
    if (details.closest('#levels-wrapper')) { details.dataset.enhanced = '1'; return; }
    details.dataset.enhanced = '1';
    const summary = details.querySelector(':scope > summary');
    if (!summary) return;
    const k = cardKey(details);
    // Cards always start collapsed on refresh — saved state is no longer
    // restored. (Save listener kept harmless but unused.)
    const dot = document.createElement('span');
    dot.className = 'sum-dot';
    dot.title = 'Some sliders in this section differ from defaults';
    summary.appendChild(dot);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'sum-reset';
    reset.title = 'Reset this section to defaults';
    reset.innerHTML = iconSvg('refresh-cw', 11);
    reset.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const scrubbers = details.querySelectorAll('.scrubber');
      let n = 0;
      for (const s of scrubbers) if (s._resetToDefault) { s._resetToDefault(); n++; }
      if (n > 0) toast(`Reset ${n} sliders${k ? ` in "${k}"` : ''}`, 'success', 1500);
    });
    summary.appendChild(reset);
    updateDirty(details);
  }

  function scan() { for (const d of body.querySelectorAll('details')) enhance(d); }
  scan();
  body.addEventListener('scrub-change', (e) => {
    const d = e.target && e.target.closest && e.target.closest('details');
    if (d) updateDirty(d);
  });
  body.addEventListener('toggle', () => persistDebounced(), true);
  new MutationObserver(scan).observe(body, { childList: true, subtree: true });
})();

// --- First-time welcome + sidebar warm-up -------------------------------
// Shown once per browser. A 1-line headline overlay tells the visitor
// what the app is and how to orbit. Trunk card auto-expands so a fresh
// landing isn't a wall of empty headers. Both run from a localStorage
// flag so returning users see their normal collapsed-card state.
(function initFirstTimeWelcome() {
  const FLAG = 'webgpu-tree:welcomed';
  let seen = false;
  try { seen = localStorage.getItem(FLAG) === '1'; } catch {}
  if (seen) return;

  // 1. Auto-expand the Trunk card so the first-time visitor sees real
  //    sliders the moment they look at the sidebar. Other cards stay
  //    collapsed for a calm initial state.
  const sbBody = document.getElementById('sidebar-body');
  if (sbBody) {
    for (const d of sbBody.querySelectorAll(':scope > details')) {
      const label = d.querySelector(':scope > summary .sec-label');
      if (label && label.textContent.trim() === 'Trunk') { d.open = true; break; }
    }
  }

  // 2. Headline overlay — top centre of the canvas, fades in/out, click
  //    to dismiss, auto-dismisses after 6 s. Marks the flag on dismiss
  //    so it never shows again on this browser.
  const canvasWrap = document.getElementById('canvas-wrap') || document.body;
  const banner = document.createElement('div');
  banner.id = 'welcome-banner';
  banner.innerHTML = `
    <div class="wb-title">Procedural tree generator</div>
    <div class="wb-sub">Drag to orbit · scroll to zoom · pick a species in the sidebar</div>
    <button type="button" class="wb-close" aria-label="Dismiss">×</button>
  `;
  canvasWrap.appendChild(banner);
  // Trigger the show transition next frame so the initial opacity:0
  // actually gets applied (no flash of fully-opaque banner).
  requestAnimationFrame(() => banner.classList.add('show'));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    try { localStorage.setItem(FLAG, '1'); } catch {}
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 600);
  };
  banner.querySelector('.wb-close').addEventListener('click', dismiss);
  banner.addEventListener('click', dismiss);
  setTimeout(dismiss, 6000);
})();

// --- Sidebar search -----------------------------------------------------
(function initSidebarSearch() {
  const body = document.getElementById('sidebar-body');
  if (!body) return;
  const sticky = body.querySelector('.tree-type-sticky');
  if (!sticky) return;
  const wrap = document.createElement('div');
  wrap.className = 'sb-search-wrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Filter sliders…';
  input.className = 'sb-search';
  input.autocomplete = 'off';
  input.spellcheck = false;
  wrap.appendChild(input);
  sticky.appendChild(wrap);

  let savedOpen = null;
  function apply(q) {
    q = q.trim().toLowerCase();
    if (!q) {
      for (const el of body.querySelectorAll('.sb-hidden')) el.classList.remove('sb-hidden');
      if (savedOpen) {
        for (const d of body.querySelectorAll('details')) {
          const key = d.querySelector(':scope > summary .sec-label')?.textContent;
          if (key && key in savedOpen) d.open = savedOpen[key];
        }
        savedOpen = null;
      }
      return;
    }
    if (!savedOpen) {
      savedOpen = {};
      for (const d of body.querySelectorAll('details')) {
        const key = d.querySelector(':scope > summary .sec-label')?.textContent;
        if (key) savedOpen[key] = d.open;
      }
    }
    for (const d of body.querySelectorAll('details')) {
      const title = (d.querySelector(':scope > summary .sec-label')?.textContent || '').toLowerCase();
      const titleHit = title.includes(q);
      let anyRowHit = false;
      for (const r of d.querySelectorAll('.scrubber-row, .row')) {
        const label = (r.querySelector('.name')?.textContent || '').toLowerCase();
        const hit = label.includes(q);
        r.classList.toggle('sb-hidden', !hit && !titleHit);
        if (hit) anyRowHit = true;
      }
      if (anyRowHit || titleHit) { d.classList.remove('sb-hidden'); d.open = true; }
      else d.classList.add('sb-hidden');
    }
  }
  // Fire on every keystroke — no debounce — so the list filters as the user
  // types. The filter is DOM-class toggles (no rebuild, no GPU work), so it's
  // cheap enough to run per keystroke on every slider in the sidebar.
  input.addEventListener('input', () => apply(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; apply(''); input.blur(); }
  });
})();

// --- Sidebar tabs: split Tree-shape controls from Scene / Settings ------
// Tree tab: anything that changes the tree's geometry (shape, branching,
// foliage, bark, curves, attractors, leaf texture).
// Scene tab: everything else — lighting, camera, wind, physics, renderer,
// post FX, LOD, presets, export.
(function initSidebarTabs() {
  const body = document.getElementById('sidebar-body');
  if (!body) return;
  // Anything not in SCENE_SECTIONS defaults to the Tree tab. Tracking scene
  // rather than tree means newly-added tree controls don't silently end up in
  // the wrong tab (the previous bug: Trunk / Global / Radius / Pruning / Level
  // / Crown / Twigs / Needles / Cones / Leaves / Leaf Material / Leaf Detail /
  // Bush Shape / Bush Foliage all leaked into Scene because they weren't in
  // the positive list).
  const SCENE_SECTIONS = new Set([
    'Renderer', 'Lighting', 'Post FX', 'Environment', 'Debug',
    'Settings', 'Scene', 'Camera',
    'Saved Presets', 'Preset', 'Export Mesh', 'LOD',
    'Physics', 'Shadows',
    // Section-label headers whose contents live in the Scene tab. Without
    // these the `.section-label` divs leaked into the Tree tab because
    // every non-<details> child was defaulted there.
    'Dynamics', 'Save',
  ]);

  const tabs = document.createElement('div');
  tabs.className = 'sb-tabs';
  tabs.innerHTML = `
    <button type="button" class="sb-tab on" data-tab="tree">Tree</button>
    <button type="button" class="sb-tab" data-tab="scene">Scene</button>
  `;
  // Insert at the very top — above the sticky search so it acts as a header.
  body.insertBefore(tabs, body.firstChild);

  function classify() {
    for (const el of body.children) {
      if (el.classList.contains('sb-tabs')) continue;
      if (el.classList.contains('tree-type-sticky')) continue;
      // Species/type picker is tree-only.
      if (el.classList.contains('species-card')) { el.dataset.tab = 'tree'; continue; }
      // Section-label divs (e.g. "Scene", "Dynamics", "Save") — classify by
      // text content against SCENE_SECTIONS so Scene-tab headers don't
      // leak into the Tree tab. Everything else non-<details> defaults to
      // tree as before.
      if (el.classList.contains('section-label')) {
        const text = el.querySelector('span')?.textContent?.trim()
          || el.textContent?.trim() || '';
        el.dataset.tab = SCENE_SECTIONS.has(text) ? 'scene' : 'tree';
        continue;
      }
      if (el.tagName !== 'DETAILS') { el.dataset.tab = 'tree'; continue; }
      const label =
        el.querySelector(':scope > summary .sec-label')?.textContent?.trim() ||
        el.querySelector(':scope > summary')?.textContent?.trim() || '';
      el.dataset.tab = SCENE_SECTIONS.has(label) ? 'scene' : 'tree';
    }
  }

  function applyTab(tab) {
    _sbActiveTab = tab;
    for (const btn of tabs.querySelectorAll('.sb-tab')) {
      btn.classList.toggle('on', btn.dataset.tab === tab);
    }
    for (const el of body.children) {
      if (el.classList.contains('sb-tabs')) continue;
      if (el.classList.contains('tree-type-sticky')) continue;
      if (!el.dataset.tab) continue;
      const onTab = el.dataset.tab === tab;
      const tt = el.dataset.treeType;
      const onType = !tt || tt.split(',').includes(P.treeType);
      el.style.display = (onTab && onType) ? '' : 'none';
    }
    body.scrollTop = 0;
    rebuildSectionRail();
  }

  tabs.querySelectorAll('.sb-tab').forEach((btn) => {
    btn.addEventListener('click', () => applyTab(btn.dataset.tab));
  });

  classify();
  applyTab('tree');

  // Any detail block appended later (e.g. hot-loaded panel) gets categorized
  // on insertion and hidden if the active tab doesn't want it.
  new MutationObserver((muts) => {
    let touched = false;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList?.contains('sb-tabs')) continue;
        if (n.classList?.contains('tree-type-sticky')) continue;
        touched = true;
      }
    }
    if (touched) { classify(); applyTab(activeTab); }
  }).observe(body, { childList: true });
})();

// --- Sticky stack height tracker ----------------------------------------
// `.sb-tabs` and `.tree-type-sticky` both pin at top:0, overlapping rather
// than stacking. The visible stack height is whichever one is taller (the
// higher-z-index `.tree-type-sticky` sits on top, but if `.sb-tabs` is
// taller it would poke out from behind). Use Math.max for safety.
(function initStickyStackTracker() {
  const body = document.getElementById('sidebar-body');
  if (!body) return;
  const measure = () => {
    let tabs = 0, top = 0;
    for (const el of body.children) {
      if (el.classList?.contains('sb-tabs')) tabs = el.offsetHeight;
      else if (el.classList?.contains('tree-type-sticky')) top = el.offsetHeight;
    }
    body.style.setProperty('--sb-sticky-h', Math.max(tabs, top) + 'px');
  };
  measure();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(measure);
    for (const el of body.children) {
      if (el.classList?.contains('sb-tabs') ||
          el.classList?.contains('tree-type-sticky')) {
        ro.observe(el);
      }
    }
  }
  new MutationObserver(measure).observe(body, { childList: true, subtree: true });
})();

animate();

// --- Rotating canvas tips (bottom-center hints) -------------------------
(function initCanvasTips() {
  const host = document.getElementById('canvas-tips');
  if (!host) return;
  const MOD = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  const kbd = (k) => `<span class="tip-kbd">${k}</span>`;
  const TIPS = [
    `Drag to orbit · scroll to zoom · ${kbd('MMB')} pan`,
    `${kbd('RMB')} on a branch to bend it · ${kbd('P')} toggle physics`,
    `${kbd('⇧')}+${kbd('C')} opens the command palette`,
    `Right-click a slider for reset / copy / paste`,
    `Double-click a slider to reset to default`,
    `${kbd(MOD)}+${kbd('Z')} undo · ${kbd(MOD)}+${kbd('Shift')}+${kbd('Z')} redo`,
    `${kbd('R')} regenerate · ${kbd('W')} wireframe · ${kbd('L')} leaves · ${kbd('T')} theme`,
    `${kbd('F')} force-render to see pure GPU ms (bypass the idle gate)`,
    `${kbd('Shift')}+${kbd('P')} screenshot · ${kbd(MOD)}+${kbd('E')} export mesh`,
    `Right-click the canvas for the scene menu`,
    `Save presets from the sidebar — thumbnails are captured on save`,
    `Try the LOD export to ship multi-detail .glb bundles`,
    `Switch tree type at the top — Broadleaf · Conifer · Bush`,
    `Drag the left edge of the sidebar to resize`,
    `Filter the sidebar with the search box at the top`,
  ];
  let idx = Math.floor(Math.random() * TIPS.length);
  function show(i) { host.innerHTML = TIPS[i]; }
  show(idx);
  setInterval(() => {
    host.classList.add('fade');
    setTimeout(() => {
      idx = (idx + 1) % TIPS.length;
      show(idx);
      host.classList.remove('fade');
    }, 360);
  }, 6500);
})();

// --- Toast notifications ------------------------------------------------
const _toastContainer = (() => {
  const el = document.createElement('div'); el.id = 'toasts'; document.body.appendChild(el); return el;
})();
function toast(msg, type = 'info', duration = 2400) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = document.createElement('span');
  ic.className = 'toast-ic';
  ic.innerHTML = type === 'error'
    ? iconSvg('scissors', 12)
    : type === 'success' ? iconSvg('disc', 12) : iconSvg('sprout', 12);
  const text = document.createElement('span');
  text.textContent = msg;
  el.append(ic, text);
  _toastContainer.appendChild(el);
  const t = setTimeout(() => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 220);
  }, duration);
  el.addEventListener('click', () => { clearTimeout(t); el.classList.add('hiding'); setTimeout(() => el.remove(), 220); });
}

// --- Scrub value tooltip ------------------------------------------------
// Plain instant text swap on value change. Earlier revisions did a
// split-flap "train sign" flip per update, but during fast drags the
// ~200ms animation smeared values together and felt laggy — so we just
// write textContent directly now.
const _scrubTip = (() => {
  const el = document.createElement('div');
  el.className = 'scrub-tip'; el.hidden = true;
  const inner = document.createElement('span');
  inner.className = 'scrub-tip-inner';
  el.appendChild(inner);
  document.body.appendChild(el);
  return el;
})();
function showScrubTip(x, y, text) {
  _scrubTip.style.left = x + 'px';
  _scrubTip.style.top  = y + 'px';
  _scrubTip.hidden = false;
  const inner = _scrubTip.firstElementChild;
  if (inner.textContent !== text) inner.textContent = text;
}
function hideScrubTip() {
  _scrubTip.hidden = true;
}

// --- Scrubber right-click context menu ----------------------------------
const _scMenu = (() => {
  const el = document.createElement('div'); el.className = 'sc-menu'; el.hidden = true; document.body.appendChild(el); return el;
})();
let _clipboardVal = null;
function showScrubberMenu(x, y, ctx) {
  _scMenu.innerHTML = '';
  const mk = (label, kbd, handler) => {
    const it = document.createElement('div'); it.className = 'sc-menu-item';
    const t = document.createElement('span'); t.textContent = label;
    const k = document.createElement('span'); k.className = 'sc-kbd'; k.textContent = kbd;
    it.append(t, k);
    it.addEventListener('click', () => { handler(); closeScrubberMenu(); });
    _scMenu.appendChild(it);
  };
  mk('Reset to default', '', () => ctx.reset());
  mk('Copy value',       '', () => { _clipboardVal = ctx.getValue(); toast('Value copied', 'success', 1400); });
  if (_clipboardVal !== null) mk('Paste value', '', () => ctx.setValue(_clipboardVal));
  const sep = document.createElement('div'); sep.className = 'sc-menu-sep'; _scMenu.appendChild(sep);
  mk('Set min', '', () => ctx.setValue(ctx.min));
  mk('Set max', '', () => ctx.setValue(ctx.max));
  if (ctx.pkey) {
    const sep2 = document.createElement('div'); sep2.className = 'sc-menu-sep'; _scMenu.appendChild(sep2);
    const locked = _paramLocks.has(ctx.pkey);
    mk(locked ? 'Unlock (Shuffle will change)' : 'Lock (Shuffle will skip)', '', () => {
      if (_paramLocks.has(ctx.pkey)) _paramLocks.delete(ctx.pkey);
      else _paramLocks.add(ctx.pkey);
      // Update any existing .scrubber-row marker for CSS state
      document.querySelectorAll(`.scrubber-row[data-pkey="${ctx.pkey}"]`).forEach((el) => {
        el.classList.toggle('locked', _paramLocks.has(ctx.pkey));
      });
    });
  }
  _scMenu.hidden = false;
  _scMenu.style.left = Math.min(x, window.innerWidth  - 180) + 'px';
  _scMenu.style.top  = Math.min(y, window.innerHeight - 180) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onScMenuOutside);
    document.addEventListener('keydown', onScMenuKey);
  }, 0);
}
function closeScrubberMenu() {
  _scMenu.hidden = true;
  document.removeEventListener('pointerdown', onScMenuOutside);
  document.removeEventListener('keydown', onScMenuKey);
}
function onScMenuOutside(e) { if (!_scMenu.contains(e.target)) closeScrubberMenu(); }
function onScMenuKey(e) { if (e.key === 'Escape') closeScrubberMenu(); }

// --- Canvas context menu (right-click on empty scene) ------------------
function showCanvasContextMenu(x, y) {
  const menu = _scMenu;
  menu.innerHTML = '';
  const modLabel = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';

  function item(label, kbd, iconName, run) {
    const it = document.createElement('div');
    it.className = 'sc-menu-item ctx-item';
    if (iconName) {
      const ic = document.createElement('span');
      ic.className = 'ctx-ic';
      ic.innerHTML = iconSvg(iconName, 13);
      it.appendChild(ic);
    }
    const t = document.createElement('span'); t.className = 'ctx-label'; t.textContent = label;
    it.appendChild(t);
    if (kbd) { const k = document.createElement('span'); k.className = 'sc-kbd'; k.textContent = kbd; it.appendChild(k); }
    it.addEventListener('click', () => { run(); closeScrubberMenu(); });
    menu.appendChild(it);
  }
  function sep() { const s = document.createElement('div'); s.className = 'sc-menu-sep'; menu.appendChild(s); }
  function click(id) { const b = document.getElementById(id); if (b) b.click(); }

  item('Regenerate',       'R',              'refresh-cw', () => click('tb-regen'));
  item('Reset camera',     '',               'disc',       () => {
    const home = document.querySelector('#cam-presets button[data-cam="home"]');
    if (home) home.click();
  });
  sep();
  item('Wireframe',        'W',              'box',        () => click('tb-wire'));
  item('Spline view',      'S',              'spline',     () => click('tb-spline'));
  item('Leaves',           'L',              'leaf',       () => click('tb-leaves'));
  item('Physics',          'P',              'hand',       () => click('tb-physics'));
  item('Theme',            'T',              'sun',        () => click('tb-theme'));
  sep();
  item('Screenshot',       'Shift+P',        'camera',     () => click('tb-screenshot'));
  item('Copy preset JSON', `${modLabel}+Shift+C`, 'copy',   () => click('tb-export'));
  item('Export mesh',      `${modLabel}+E`,  'download',   () => click('tb-gltf'));
  item('Upload leaf',      `${modLabel}+U`,  'upload',     () => click('tb-upload'));
  sep();
  item('Undo',             `${modLabel}+Z`,        'refresh-cw', () => undo());
  item('Redo',             `${modLabel}+Shift+Z`,  'refresh-cw', () => redo());
  sep();
  item('Command palette…', `${modLabel}+K`,  'sparkles',   () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: !navigator.platform.includes('Mac'), metaKey: navigator.platform.includes('Mac') }));
  });

  menu.hidden = false;
  // Clamp to viewport
  const mw = 240, mh = menu.offsetHeight || 360;
  menu.style.left = Math.min(x, window.innerWidth  - mw - 8) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
  menu.style.minWidth = mw + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onScMenuOutside);
    document.addEventListener('keydown', onScMenuKey);
  }, 0);
}

// --- Grab hover halo (shows nearest-node pickpoint when physics is on) -
const _grabHalo = document.getElementById('grab-halo');
const _haloProj = new THREE.Vector3();
let _hoveredNodeIdx = -1;
function _setHoveredNode(idx) {
  if (idx === _hoveredNodeIdx) return;
  _hoveredNodeIdx = idx;
  // Kick the spline-dot matrices so the hovered dot is visibly larger even
  // when the sim is idle. Cheap — writes N mat4s (N = skeleton length).
  if (treeSplineDots) updateSplineMesh();
}
function updateGrabHalo(clientX, clientY) {
  if (!_grabHalo) return;
  // Hide the nearest-joint halo in sculpt+brush mode — the orange brush
  // ring is the only cursor indicator we want there.
  if ((_sculptActive && _brushMode) || !physicsOn || grabbedNodeIdx >= 0 || !treeMesh || !skeleton.length) {
    _grabHalo.hidden = true; _grabHalo.classList.remove('show');
    _setHoveredNode(-1);
    if (renderer.domElement.style.cursor === 'grab') renderer.domElement.style.cursor = '';
    return;
  }
  const radius = P.physics?.grabPickRadius ?? 60;
  const idx = pickNearestNodeScreen(clientX, clientY, radius);
  if (idx < 0) {
    _grabHalo.classList.remove('show'); _grabHalo.hidden = true;
    _setHoveredNode(-1);
    if (renderer.domElement.style.cursor === 'grab') renderer.domElement.style.cursor = '';
    return;
  }
  _setHoveredNode(idx);
  if (renderer.domElement.style.cursor !== 'grabbing') renderer.domElement.style.cursor = 'grab';
  const s = skeleton[idx];
  _haloProj.set(s.pos.x + s.worldOffset.x, s.pos.y + s.worldOffset.y, s.pos.z + s.worldOffset.z);
  treeMesh.updateMatrixWorld();
  _haloProj.applyMatrix4(treeMesh.matrixWorld);
  _haloProj.project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  const sx = (_haloProj.x + 1) * 0.5 * rect.width + rect.left;
  const sy = (1 - _haloProj.y) * 0.5 * rect.height + rect.top;
  _grabHalo.style.left = sx + 'px';
  _grabHalo.style.top  = sy + 'px';
  _grabHalo.hidden = false;
  _grabHalo.classList.add('show');
}
// rAF-coalesce the halo update: on a 144 Hz mouse the pointermove → full
// skeleton projection was running every pixel. One update per rendered frame
// is plenty.
let _haloPending = false;
let _haloLastX = 0, _haloLastY = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) return;
  _haloLastX = e.clientX;
  _haloLastY = e.clientY;
  if (_haloPending) return;
  _haloPending = true;
  requestAnimationFrame(() => {
    _haloPending = false;
    updateGrabHalo(_haloLastX, _haloLastY);
  });
});
renderer.domElement.addEventListener('pointerleave', () => {
  if (_grabHalo) { _grabHalo.classList.remove('show'); _grabHalo.hidden = true; }
});

// --- Camera presets gizmo -----------------------------------------------
(function initCamPresets() {
  const host = document.getElementById('cam-presets');
  if (!host) return;
  function goTo(name) {
    if (!treeMesh) return;
    treeMesh.geometry.computeBoundingBox();
    const bbox = treeMesh.geometry.boundingBox.clone();
    const center = new THREE.Vector3(); bbox.getCenter(center);
    const size = new THREE.Vector3();  bbox.getSize(size);
    const fit = Math.max(size.x, size.y, size.z) * 1.9;
    let cam = new THREE.Vector3();
    switch (name) {
      case 'front': cam.set(center.x, center.y, center.z + fit); break;
      case 'back':  cam.set(center.x, center.y, center.z - fit); break;
      case 'left':  cam.set(center.x - fit, center.y, center.z); break;
      case 'right': cam.set(center.x + fit, center.y, center.z); break;
      case 'top':   cam.set(center.x, center.y + fit, center.z + 0.01); break;
      case 'home': default: cam.set(center.x + fit * 0.5, center.y + size.y * 0.3, center.z + fit * 0.85); break;
    }
    reframeAnim = {
      fromCam: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toCam: cam,
      toTarget: center.clone(),
      t: 0, duration: 0.9,
    };
  }
  for (const b of host.querySelectorAll('button[data-cam]')) {
    b.addEventListener('click', () => goTo(b.dataset.cam));
  }
})();

// --- Sidebar resize handle ----------------------------------------------
(function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;
  const saved = parseInt(localStorage.getItem('webgpu-tree:sidebarW') || '0', 10);
  if (saved >= 240 && saved <= 720) sidebar.style.width = saved + 'px';
  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Dragging handle right = shrink sidebar, left = grow. Sidebar is on the right of viewport.
    const w = Math.max(240, Math.min(720, startW - (e.clientX - startX)));
    sidebar.style.width = w + 'px';
    // Keep canvas renderer sized
    const ev = new Event('resize'); window.dispatchEvent(ev);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    handle.releasePointerCapture?.(e.pointerId);
    localStorage.setItem('webgpu-tree:sidebarW', sidebar.getBoundingClientRect().width);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
})();

// --- Spotlight (Cmd/Ctrl+K command bar) ---------------------------------
(function initSpotlight() {
  const overlay   = document.getElementById('spotlight');
  if (!overlay) return;
  const input     = overlay.querySelector('.sp-input');
  const resultsEl = overlay.querySelector('.sp-results');

  function fmtVal(v, step) {
    const digits = step < 0.01 ? 3 : step < 0.1 ? 2 : 1;
    return (+v).toFixed(digits);
  }

  function applyParamLiveOnAfter(key) {
    if (key === 'rotation') { applyTreeRotation(); return true; }
    if (key.startsWith('leaf') || key === 'season') { applyLeafMaterial(); return true; }
    if (key.startsWith('bark')) { applyBarkMaterial(); return true; }
    return false;
  }

  function setTreeTypeCmd(v) {
    const prevSpecies = speciesSelect?.value || 'Custom';
    P.treeType = v;
    applyTreeTypeVisibility();
    let targetSpecies;
    if (prevSpecies === 'Custom') {
      targetSpecies = 'Custom';
      generateTree();
    } else {
      targetSpecies = v === 'conifer' ? 'Pine'
                    : v === 'bush'    ? 'Boxwood'
                    :                   'Oak';
      applySpecies(targetSpecies);
    }
    if (_rebuildSpeciesBand) _rebuildSpeciesBand(targetSpecies);
  }

  function buildCommands() {
    const out = [];
    const pushParam = (p, getter, setter, group) => {
      if (p.type === 'select') return;
      if (p.hidden) return;
      out.push({
        kind: 'param',
        title: p.label,
        group,
        keywords: `${group} ${p.label}`.toLowerCase(),
        min: p.min, max: p.max, step: p.step,
        get: getter, set: setter,
      });
    };
    for (const g of PARAM_SCHEMA) for (const p of g.params) pushParam(
      p,
      () => P[p.key],
      (v) => {
        P[p.key] = v;
        if (p.live) { applyParamLiveOnAfter(p.key); commitHistorySoon(); }
        else debouncedGenerate();
      },
      g.group,
    );
    for (const g of CONIFER_SCHEMA) for (const p of g.params) pushParam(
      p,
      () => P[p.key],
      (v) => { P[p.key] = v; debouncedGenerate(); },
      g.group,
    );
    for (const g of BUSH_SCHEMA) for (const p of g.params) pushParam(
      p,
      () => P[p.key],
      (v) => { P[p.key] = v; debouncedGenerate(); },
      g.group,
    );
    for (const p of WIND_SCHEMA) pushParam(
      p,
      () => P.wind[p.key],
      (v) => {
        P.wind[p.key] = v;
        if (p.key === 'direction') { uWindDirX.value = Math.cos(v); uWindDirZ.value = Math.sin(v); }
        else if (p.uni) p.uni.value = v;
        commitHistorySoon();
      },
      'Wind',
    );
    for (const p of PHYSICS_SCHEMA) pushParam(
      p,
      () => P.physics[p.key],
      (v) => { P.physics[p.key] = v; commitHistorySoon(); },
      'Physics',
    );
    for (let li = 0; li < P.levels.length; li++) {
      for (const p of LEVEL_SCHEMA) {
        if (p.type === 'select') continue;
        const lvl = P.levels[li];
        pushParam(p, () => lvl[p.key], (v) => { lvl[p.key] = v; debouncedGenerate(); }, `Level ${li + 1}`);
      }
    }

    const act = (title, group, fn) => out.push({
      kind: 'action', title, group,
      keywords: `${group} ${title}`.toLowerCase(),
      run: fn,
    });

    act('Regenerate (new seed)', 'Tree', () => { P.seed = Math.floor(Math.random() * 999999); generateTree(); commitHistorySoon(); });
    act('Animate growth (0 → 1)', 'Tree', () => { animateGrowth(); });
    act('Export 8 variations (PNG)', 'Tree', () => { exportVariationBatch(8); });
    act('Reference image: upload', 'View', () => { _uploadReferenceImage(); });
    act('Reference image: clear',  'View', () => { _clearReferenceImage(); });
    act('Shuffle parameters (skip locks)', 'Tree', () => { shuffleParams(); toast('Shuffled parameters', 'info', 1400); });
    act('Clear all parameter locks', 'Tree', () => { _paramLocks.clear(); document.querySelectorAll('.scrubber-row.locked').forEach((el) => el.classList.remove('locked')); toast('Locks cleared', 'info', 1200); });
    act('Undo', 'Edit', undo);
    act('Redo', 'Edit', redo);
    act('Toggle wireframe',  'View', () => { applyMeshView(!meshViewOn);    if (typeof tbWire    !== 'undefined' && tbWire)    tbWire.classList.toggle('active', meshViewOn); });
    act('Toggle spline view','View', () => { applySplineView(!splineViewOn);if (typeof tbSpline  !== 'undefined' && tbSpline)  tbSpline.classList.toggle('active', splineViewOn); });
    act('Toggle leaves',     'View', () => { applyLeavesVisible(!leavesOn); if (typeof tbLeaves  !== 'undefined' && tbLeaves)  tbLeaves.classList.toggle('active', leavesOn); });
    act('Toggle physics',    'View', () => { physicsOn = !physicsOn;        if (typeof tbPhysics !== 'undefined' && tbPhysics) tbPhysics.classList.toggle('active', physicsOn); });
    act('Toggle theme',      'View', () => { applyTheme(currentTheme === 'dark' ? 'light' : 'dark'); syncThemeIcon(); });
    act('Set type: Broadleaf', 'Tree', () => setTreeTypeCmd('broadleaf'));
    act('Set type: Conifer',   'Tree', () => setTreeTypeCmd('conifer'));
    act('Set type: Bush',      'Tree', () => setTreeTypeCmd('bush'));
    for (const k of BROADLEAF_KEYS) if (k !== 'Custom') act(`Species: ${k}`, 'Species', () => { setTreeTypeCmd('broadleaf'); applySpecies(k); });
    for (const k of CONIFER_KEYS)   if (k !== 'Custom') act(`Species: ${k}`, 'Species', () => { setTreeTypeCmd('conifer');   applySpecies(k); });
    for (const k of BUSH_KEYS)      if (k !== 'Custom') act(`Species: ${k}`, 'Species', () => { setTreeTypeCmd('bush');      applySpecies(k); });
    return out;
  }

  let commands = [];
  let filtered = [];
  let cursor = 0;

  function filter(query) {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 80);
    const parts = q.split(/\s+/);
    const scored = [];
    for (const c of commands) {
      let ok = true;
      for (const pt of parts) {
        if (!c.keywords.includes(pt)) { ok = false; break; }
      }
      if (!ok) continue;
      // Prefer title-match > group-match
      const titleLc = c.title.toLowerCase();
      let score = 0;
      for (const pt of parts) if (titleLc.includes(pt)) score += 2;
      if (titleLc.startsWith(parts[0])) score += 3;
      scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 80).map((x) => x.c);
  }

  function render() {
    resultsEl.innerHTML = '';
    const q = input.value.trim();
    // No query → collapse the results area entirely (just the bar visible).
    if (!q) {
      resultsEl.classList.add('sp-empty-state');
      return;
    }
    resultsEl.classList.remove('sp-empty-state');
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'sp-empty';
      empty.textContent = 'No matches';
      resultsEl.appendChild(empty);
      return;
    }
    filtered.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'sp-row' + (i === cursor ? ' active' : '');
      const group = document.createElement('span');
      group.className = 'sp-group'; group.textContent = c.group;
      const title = document.createElement('span');
      title.className = 'sp-title'; title.textContent = c.title;
      row.append(group, title);

      if (c.kind === 'param') {
        const current = +c.get();
        const val = document.createElement('span');
        val.className = 'sp-val';
        val.textContent = fmtVal(current, c.step);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'sp-slider';
        slider.min = c.min; slider.max = c.max; slider.step = c.step;
        slider.value = current;
        slider.addEventListener('input', () => {
          const v = parseFloat(slider.value);
          c.set(v);
          val.textContent = fmtVal(v, c.step);
        });
        // Clicking the slider shouldn't blur the input or close the panel
        slider.addEventListener('pointerdown', (e) => e.stopPropagation());
        slider.addEventListener('click',       (e) => e.stopPropagation());
        row.append(slider, val);
      }

      row.addEventListener('click', (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('sp-slider')) return;
        cursor = i;
        highlight();
        if (c.kind === 'action') { c.run(); close(); }
        else input.focus();
      });
      resultsEl.appendChild(row);
    });
  }

  function highlight() {
    const rows = resultsEl.querySelectorAll('.sp-row');
    rows.forEach((r, i) => r.classList.toggle('active', i === cursor));
    const r = rows[cursor];
    if (r) r.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    commands = buildCommands();
    filtered = filter('');
    cursor = 0;
    input.value = '';
    overlay.hidden = false;
    render();
    requestAnimationFrame(() => input.focus());
  }

  function close() {
    overlay.hidden = true;
    input.blur();
  }

  input.addEventListener('input', () => {
    filtered = filter(input.value);
    cursor = 0;
    render();
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length) { cursor = Math.min(filtered.length - 1, cursor + 1); highlight(); }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length) { cursor = Math.max(0, cursor - 1); highlight(); }
      return;
    }
    if (e.key === 'Enter') {
      const c = filtered[cursor];
      if (!c) return;
      e.preventDefault();
      if (c.kind === 'action') { c.run(); close(); return; }
      // For param: focus its inline slider so arrow keys nudge the value
      const activeSlider = resultsEl.querySelector('.sp-row.active .sp-slider');
      if (activeSlider) activeSlider.focus();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  window.addEventListener('keydown', (e) => {
    // Shift+C opens the command palette. Ignored when focused in an input
    // so the user can still type capital C into fields.
    const t = e.target;
    const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'C' || e.key === 'c')) {
      if (editable) return;
      e.preventDefault();
      const wasHidden = overlay.hidden;
      if (wasHidden) open(); else close();
      if (wasHidden) showShortcutPill('⇧+C', 'Command palette');
    }
  });
})();

// (Stress-test hook removed — see git history at b9d2... for the
// implementation. It froze the renderer because applySpecies itself fires
// async generateTree() builds that stack with the test's own builds, and
// the worker pool can only serve one full rebuild at a time. The
// _sanitizeForBuild() pre-pass and refSteps clamp deliver the real
// bulletproofing benefit those tests were meant to validate.)
