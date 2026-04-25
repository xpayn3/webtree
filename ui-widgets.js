// Canvas-based UI widgets. Pure DOM/Canvas — no tree-state dependencies.

// --- Linear spline widget -----------------------------------------------
export class SplineEditor {
  constructor(container, { points = [1,1,1,1,1], min = 0.1, max = 2.5, baseLabel = 'BASE', tipLabel = 'TIP' } = {}) {
    // Internal rep: { x: 0..1, y: value in [min,max] } array, kept sorted by x.
    // Legacy input (plain numeric array, uniformly spaced) auto-converts.
    this.min = min;
    this.max = max;
    this.baseLabel = baseLabel;
    this.tipLabel = tipLabel;
    this.onChange = null;
    this.dragIdx = -1;
    this._setLegacyPoints(points);
    const wrap = document.createElement('div');
    wrap.style.padding = '6px 14px 10px';
    const canvas = document.createElement('canvas');
    canvas.width = 272; canvas.height = 100;
    canvas.className = 'spline-canvas';
    wrap.appendChild(canvas);
    // Preset dropdown: pick a named curve shape — covers all the common
    // natural profiles (taper, dome, bowl, s-curve) so users don't have to
    // drag every control point. Normalized 0..1 profiles remapped into this
    // editor's [min, max] range.
    const SPLINE_PRESETS = {
      Flat:      [0.5,  0.5,  0.5,  0.5,  0.5],
      'Taper ↓': [1.0,  0.85, 0.65, 0.4,  0.15],
      'Taper ↑': [0.15, 0.4,  0.65, 0.85, 1.0],
      Dome:      [0.2,  0.7,  1.0,  0.7,  0.2],
      Bowl:      [1.0,  0.6,  0.3,  0.6,  1.0],
      'S-curve': [0.1,  0.35, 0.65, 0.9,  1.0],
      Skew:      [0.9,  1.0,  0.8,  0.5,  0.2],
      Bell:      [0.3,  0.8,  1.0,  0.8,  0.3],
    };
    const presetSelect = document.createElement('select');
    // `.select` hooks into the existing sidebar custom-dropdown styling +
    // enhanceSelect MutationObserver. Extra class scopes width/margin tweaks.
    presetSelect.className = 'select spline-preset-select';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Preset…';
    placeholder.selected = true;
    presetSelect.appendChild(placeholder);
    for (const name of Object.keys(SPLINE_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      presetSelect.appendChild(opt);
    }
    presetSelect.addEventListener('change', () => {
      const name = presetSelect.value;
      if (!name) return;
      const shape = SPLINE_PRESETS[name];
      // Presets always reset to 5 evenly-spaced knots so the curve matches
      // the preset exactly regardless of the current point count.
      this._pts = shape.map((v, i) => ({
        x: shape.length > 1 ? i / (shape.length - 1) : 0,
        y: this.min + v * (this.max - this.min),
      }));
      this.draw(); this.onChange && this.onChange();
      presetSelect.value = '';
    });
    wrap.appendChild(presetSelect);
    container.appendChild(wrap);
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.style.cursor = 'crosshair';
    this.draw();
  }
  // Houdini-style knot radius in CSS pixels.
  static get HIT_R() { return 8; }
  // Serialize back to the legacy uniform-numeric array so downstream code
  // (.sample() callers, save/load) keep working with any point count.
  get points() {
    // Resample the curve at the original spacing (5 knots) so external
    // readers (save file) see a consistent short array.
    const N = 5;
    const out = new Array(N);
    for (let i = 0; i < N; i++) out[i] = this.sample(N > 1 ? i / (N - 1) : 0);
    return out;
  }
  _setLegacyPoints(pts) {
    // Accept either a numeric array (legacy, uniform spacing) or an array of
    // {x, y} objects. Always normalize to this._pts = [{x, y}].
    if (!Array.isArray(pts) || pts.length === 0) { this._pts = [{ x: 0, y: this.min }, { x: 1, y: this.min }]; return; }
    if (typeof pts[0] === 'number') {
      this._pts = pts.map((v, i) => ({
        x: pts.length > 1 ? i / (pts.length - 1) : 0,
        y: Math.max(this.min, Math.min(this.max, v)),
      }));
    } else {
      this._pts = pts.map(p => ({
        x: Math.max(0, Math.min(1, p.x)),
        y: Math.max(this.min, Math.min(this.max, p.y)),
      }));
    }
    this._pts.sort((a, b) => a.x - b.x);
  }
  setPoints(pts) { this._setLegacyPoints(pts); this.draw(); }
  _pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width * this.canvas.width;
    const py = (e.clientY - rect.top)  / rect.height * this.canvas.height;
    const w = this.canvas.width, h = this.canvas.height;
    let best = -1, bestD = SplineEditor.HIT_R * SplineEditor.HIT_R;
    for (let i = 0; i < this._pts.length; i++) {
      const p = this._pts[i];
      const x = p.x * w;
      const y = h - ((p.y - this.min) / (this.max - this.min)) * h;
      const dx = x - px, dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD) { bestD = d2; best = i; }
    }
    return best;
  }
  _posFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const yNorm = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    return { x: xNorm, y: this.min + yNorm * (this.max - this.min) };
  }
  _update(e) {
    if (this.dragIdx < 0) return;
    const { x, y } = this._posFromEvent(e);
    const p = this._pts[this.dragIdx];
    // Endpoints keep their x pinned to 0/1 (first/last); mid-points can slide.
    if (this.dragIdx === 0) p.x = 0;
    else if (this.dragIdx === this._pts.length - 1) p.x = 1;
    else p.x = x;
    p.y = y;
    // Keep array sorted; re-find moved knot's new index.
    this._pts.sort((a, b) => a.x - b.x);
    this.dragIdx = this._pts.indexOf(p);
    this.draw(); this.onChange && this.onChange();
  }
  _down(e) {
    // Shift/Alt/right-click on an existing knot removes it (keep ≥ 2).
    if ((e.shiftKey || e.altKey || e.button === 2) && this._pts.length > 2) {
      const hit = this._pick(e);
      if (hit > 0 && hit < this._pts.length - 1) { // never delete endpoints
        this._pts.splice(hit, 1);
        this.draw(); this.onChange && this.onChange();
        e.preventDefault();
        return;
      }
    }
    // Click near a knot → drag it. Click on empty canvas → add a new knot.
    let idx = this._pick(e);
    if (idx < 0) {
      const { x, y } = this._posFromEvent(e);
      this._pts.push({ x, y });
      this._pts.sort((a, b) => a.x - b.x);
      idx = this._pts.findIndex(p => p.x === x && p.y === y);
      this.onChange && this.onChange();
    }
    this.dragIdx = idx;
    this.canvas.setPointerCapture(e.pointerId);
    this._update(e);
  }
  _move(e) {
    if (this.dragIdx >= 0) { this._update(e); return; }
    // Cursor hint: pointer over a knot → grab, over empty → crosshair.
    const hit = this._pick(e);
    this.canvas.style.cursor = hit >= 0 ? (e.shiftKey ? 'not-allowed' : 'grab') : 'crosshair';
  }
  _up(e) { if (this.dragIdx >= 0) this.canvas.releasePointerCapture?.(e.pointerId); this.dragIdx = -1; }
  sample(t) {
    const pts = this._pts;
    const n = pts.length;
    if (n === 0) return this.min;
    if (n === 1) return pts[0].y;
    const x = Math.max(0, Math.min(1, t));
    if (x <= pts[0].x) return pts[0].y;
    if (x >= pts[n - 1].x) return pts[n - 1].y;
    // Find segment.
    let i1 = 0;
    for (let i = 1; i < n; i++) { if (pts[i].x >= x) { i1 = i - 1; break; } }
    const i2 = Math.min(n - 1, i1 + 1);
    const i0 = Math.max(0, i1 - 1);
    const i3 = Math.min(n - 1, i2 + 1);
    const p0 = pts[i0].y, p1 = pts[i1].y, p2 = pts[i2].y, p3 = pts[i3].y;
    const span = Math.max(1e-6, pts[i2].x - pts[i1].x);
    const u = (x - pts[i1].x) / span;
    // Catmull–Rom cubic between p1 and p2 using p0/p3 as tangents.
    const a = 2 * p1;
    const b = p2 - p0;
    const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const d = -p0 + 3 * p1 - 3 * p2 + p3;
    return 0.5 * (a + b * u + c * u * u + d * u * u * u);
  }
  draw() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 1; i < 4; i++) {
      const y = (i / 4) * h;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    const yOne = h - ((1 - this.min) / (this.max - this.min)) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, yOne); ctx.lineTo(w, yOne); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const t = i / 120;
      const v = this.sample(t);
      const x = t * w;
      const y = h - ((v - this.min) / (this.max - this.min)) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (let i = 0; i < this._pts.length; i++) {
      const p = this._pts[i];
      const x = p.x * w;
      const y = h - ((p.y - this.min) / (this.max - this.min)) * h;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#3a6ad8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '9px system-ui';
    ctx.fillText(this.baseLabel, 4, h - 4);
    ctx.textAlign = 'right'; ctx.fillText(this.tipLabel, w - 4, h - 4);
    ctx.textAlign = 'left';
  }
}

// Tropism normalization — accepts both legacy scalar (back-compat with species
// presets) and the new Houdini-style object form authored via TropismPanel.
// Scalar: gravitropism pulled straight down, phototropism pulled toward sun.
// Object: explicit direction + falloff curve along branch + by-level multiplier.
const _TROPISM_DEFAULTS = {
  gravity: { dirX: 0,  dirY: -1, dirZ: 0 },
  photo:   { dirX: 0,  dirY:  1, dirZ: 0 },
};
export function normalizeTropism(v, kind) {
  const def = _TROPISM_DEFAULTS[kind];
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

export function sampleFalloffArr(arr, t) {
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

// --- Tropism panel (Houdini-style: enable + vec3 + strength + falloff + mod) -
// Reusable panel for direction+magnitude+falloff controls. Used for per-level
// gravitropism / phototropism. Writes the full object form back to the model;
// normalizeTropism() in the grower handles legacy scalar values.
export class TropismPanel {
  constructor(container, {
    label = 'Tropism',
    strengthMin = -0.15, strengthMax = 0.15, strengthStep = 0.005,
    defaultDir = [0, 1, 0],
    get,             // () => current object (or scalar — will be upgraded on first edit)
    set,             // (obj) => void
    onChange,        // fired after any edit
  } = {}) {
    this.get = get; this.set = set; this.onChange = onChange;
    this.defaultDir = defaultDir;
    this.strengthMin = strengthMin;
    this.strengthMax = strengthMax;
    this.strengthStep = strengthStep;

    const root = document.createElement('div');
    root.className = 'tropism-panel';

    // Header: enable + label
    const head = document.createElement('div');
    head.className = 'tp-head';
    const en = document.createElement('label');
    en.className = 'tp-en';
    const enBox = document.createElement('input');
    enBox.type = 'checkbox';
    const enTxt = document.createElement('span');
    enTxt.textContent = 'Enable';
    en.append(enBox, enTxt);
    const title = document.createElement('span');
    title.className = 'tp-title';
    title.textContent = label;
    head.append(title, en);
    root.appendChild(head);

    // Direction vec3
    const vecRow = document.createElement('div');
    vecRow.className = 'tp-row tp-vec';
    const vecLabel = document.createElement('span');
    vecLabel.className = 'tp-label';
    vecLabel.textContent = 'Direction';
    const vecInputs = document.createElement('div');
    vecInputs.className = 'tp-vec-inputs';
    const dirInputs = ['x', 'y', 'z'].map((axis) => {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '0.1';
      inp.className = 'tp-num';
      inp.dataset.axis = axis;
      vecInputs.appendChild(inp);
      return inp;
    });
    vecRow.append(vecLabel, vecInputs);
    root.appendChild(vecRow);

    // Strength (numeric + fill bar — matches screenshot's combined scrubber)
    const strRow = document.createElement('div');
    strRow.className = 'tp-row tp-strength';
    const strLabel = document.createElement('span');
    strLabel.className = 'tp-label';
    strLabel.textContent = 'Strength';
    const strNum = document.createElement('input');
    strNum.type = 'number';
    strNum.step = String(strengthStep);
    strNum.className = 'tp-num tp-str-num';
    const strTrack = document.createElement('div');
    strTrack.className = 'tp-str-track';
    const strFill = document.createElement('div');
    strFill.className = 'tp-str-fill';
    const strThumb = document.createElement('div');
    strThumb.className = 'tp-str-thumb';
    strTrack.append(strFill, strThumb);
    strRow.append(strLabel, strNum, strTrack);
    root.appendChild(strRow);

    // Falloff ramp
    const foWrap = document.createElement('div');
    foWrap.className = 'tp-row tp-falloff';
    const foLabel = document.createElement('span');
    foLabel.className = 'tp-label';
    foLabel.textContent = 'Falloff';
    const foCanvas = document.createElement('canvas');
    foCanvas.className = 'tp-ramp';
    foCanvas.width = 260; foCanvas.height = 54;
    foWrap.append(foLabel, foCanvas);
    root.appendChild(foWrap);

    // byLevel modifier
    const modRow = document.createElement('div');
    modRow.className = 'tp-row tp-mod';
    const modLbl = document.createElement('label');
    modLbl.className = 'tp-en';
    const modBox = document.createElement('input');
    modBox.type = 'checkbox';
    const modTxt = document.createElement('span');
    modTxt.textContent = 'Multiply by branch level';
    modLbl.append(modBox, modTxt);
    modRow.appendChild(modLbl);
    root.appendChild(modRow);

    container.appendChild(root);

    this.root = root;
    this.enBox = enBox;
    this.dirInputs = dirInputs;
    this.strNum = strNum;
    this.strTrack = strTrack;
    this.strFill = strFill;
    this.strThumb = strThumb;
    this.foCanvas = foCanvas;
    this.foCtx = foCanvas.getContext('2d');
    this.modBox = modBox;
    this.dragFalloffIdx = -1;
    this.strDragging = false;

    // Wiring
    enBox.addEventListener('change', () => {
      this._mutate((o) => { o.enabled = enBox.checked; });
    });
    modBox.addEventListener('change', () => {
      this._mutate((o) => { o.byLevel = modBox.checked; });
    });
    for (const inp of dirInputs) {
      inp.addEventListener('change', () => {
        const x = parseFloat(dirInputs[0].value) || 0;
        const y = parseFloat(dirInputs[1].value) || 0;
        const z = parseFloat(dirInputs[2].value) || 0;
        this._mutate((o) => { o.dirX = x; o.dirY = y; o.dirZ = z; });
      });
    }
    strNum.addEventListener('change', () => {
      const v = parseFloat(strNum.value);
      if (!Number.isFinite(v)) return;
      const clamped = Math.max(this.strengthMin, Math.min(this.strengthMax, v));
      this._mutate((o) => { o.strength = clamped; });
    });

    // Strength drag
    const strTHRESH = 6;
    let strPending = false, strStartX = 0, strPid = 0;
    const strPxToVal = (clientX) => {
      const r = strTrack.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return this.strengthMin + pct * (this.strengthMax - this.strengthMin);
    };
    strTrack.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      strPending = true; strStartX = e.clientX; strPid = e.pointerId;
    });
    strTrack.addEventListener('pointermove', (e) => {
      if (strPending && Math.abs(e.clientX - strStartX) >= strTHRESH) {
        strPending = false; this.strDragging = true;
        try { strTrack.setPointerCapture(strPid); } catch {}
        beginScrub && beginScrub();
      }
      if (!this.strDragging) return;
      e.preventDefault();
      const v = Math.round(strPxToVal(e.clientX) / strengthStep) * strengthStep;
      this._mutate((o) => { o.strength = v; });
    });
    const strEnd = () => {
      strPending = false;
      if (this.strDragging) { this.strDragging = false; endScrub && endScrub(); }
    };
    strTrack.addEventListener('pointerup', strEnd);
    strTrack.addEventListener('pointercancel', strEnd);

    // Falloff drag
    foCanvas.addEventListener('pointerdown', (e) => this._foDown(e));
    foCanvas.addEventListener('pointermove', (e) => this._foMove(e));
    foCanvas.addEventListener('pointerup',   (e) => this._foUp(e));
    foCanvas.addEventListener('pointercancel', (e) => this._foUp(e));

    // Double-click ramp = reset to flat 1.0
    foCanvas.addEventListener('dblclick', () => {
      this._mutate((o) => { o.falloff = [1, 1, 1, 1, 1]; });
    });

    this.sync();
  }

  _currentObj() {
    const raw = this.get();
    const dd = typeof this.defaultDir === 'function' ? this.defaultDir() : this.defaultDir;
    const kind = dd[1] < 0 ? 'gravity' : 'photo';
    const n = normalizeTropism(raw, kind);
    // Always hand back an owned object so mutations are safe. For legacy scalar
    // phototropism (_useSun=true) we capture the current sun direction so the
    // panel reflects actual grower behavior at the moment of conversion.
    return {
      enabled: n.enabled,
      dirX: n._useSun ? dd[0] : n.dirX,
      dirY: n._useSun ? dd[1] : n.dirY,
      dirZ: n._useSun ? dd[2] : n.dirZ,
      strength: n.strength,
      falloff: n.falloff ? n.falloff.slice() : [1, 1, 1, 1, 1],
      byLevel: n.byLevel,
    };
  }

  _mutate(fn) {
    const obj = this._currentObj();
    fn(obj);
    this.set(obj);
    this.sync();
    this.onChange && this.onChange();
  }

  sync() {
    const o = this._currentObj();
    this.enBox.checked = o.enabled;
    this.root.classList.toggle('disabled', !o.enabled);
    this.dirInputs[0].value = Number(o.dirX.toFixed(3));
    this.dirInputs[1].value = Number(o.dirY.toFixed(3));
    this.dirInputs[2].value = Number(o.dirZ.toFixed(3));
    this.strNum.value = Number(o.strength.toFixed(3));
    const pct = (o.strength - this.strengthMin) / (this.strengthMax - this.strengthMin);
    const clampedPct = Math.max(0, Math.min(1, pct));
    this.strFill.style.width = (clampedPct * 100) + '%';
    this.strThumb.style.left = (clampedPct * 100) + '%';
    this.modBox.checked = o.byLevel;
    this._drawFalloff(o.falloff);
  }

  _foPickIdx(e) {
    const rect = this.foCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const obj = this._currentObj();
    const n = obj.falloff.length;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const px = i / (n - 1);
      const d = Math.abs(px - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  _foUpdate(e) {
    const rect = this.foCanvas.getBoundingClientRect();
    const y = 1 - (e.clientY - rect.top) / rect.height;
    const v = Math.max(0, Math.min(1.5, y * 1.5));
    this._mutate((o) => { o.falloff[this.dragFalloffIdx] = v; });
  }
  _foDown(e) {
    this.foCanvas.setPointerCapture(e.pointerId);
    this.dragFalloffIdx = this._foPickIdx(e);
    this._foUpdate(e);
  }
  _foMove(e) { if (this.dragFalloffIdx >= 0) this._foUpdate(e); }
  _foUp(e) {
    if (this.dragFalloffIdx >= 0) this.foCanvas.releasePointerCapture?.(e.pointerId);
    this.dragFalloffIdx = -1;
  }

  _drawFalloff(pts) {
    const ctx = this.foCtx;
    const w = this.foCanvas.width, h = this.foCanvas.height;
    ctx.clearRect(0, 0, w, h);
    // y=1 guideline
    const yOne = h - (1 / 1.5) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, yOne); ctx.lineTo(w, yOne); ctx.stroke();
    ctx.setLineDash([]);
    // Filled curve
    ctx.fillStyle = 'rgba(128, 179, 255,0.14)';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      const v = sampleFalloffArr(pts, t);
      const x = t * w;
      const y = h - Math.max(0, Math.min(1.5, v)) / 1.5 * h;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    // Stroke curve
    ctx.strokeStyle = '#9fc0ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      const v = sampleFalloffArr(pts, t);
      const x = t * w;
      const y = h - Math.max(0, Math.min(1.5, v)) / 1.5 * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Handles
    for (let i = 0; i < pts.length; i++) {
      const t = i / (pts.length - 1);
      const v = pts[i];
      const x = t * w;
      const y = h - Math.max(0, Math.min(1.5, v)) / 1.5 * h;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#3a6ad8'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
}

// --- Circular profile editor --------------------------------------------
export class ProfileEditor {
  constructor(container, { points = Array(12).fill(1), min = 0.35, max = 1.65 } = {}) {
    this.points = points.slice();
    this.min = min;
    this.max = max;
    this.onChange = null;
    this.dragIdx = -1;
    this.cssW = 0; this.cssH = 0;

    const wrap = document.createElement('div');
    wrap.style.padding = '6px 0 10px';
    const canvas = document.createElement('canvas');
    // Square aspect ratio keeps the circle a circle at any sidebar width —
    // the pixel buffer is kept in sync with the rendered size by _resizeCanvas.
    canvas.className = 'profile-canvas';
    wrap.appendChild(canvas);
    const reset = document.createElement('button');
    reset.textContent = 'Circle';
    reset.type = 'button';
    reset.className = 'spline-reset-btn';
    wrap.appendChild(reset);
    reset.addEventListener('click', () => {
      for (let i = 0; i < this.points.length; i++) this.points[i] = 1.0;
      this.draw(); this.onChange && this.onChange();
    });
    container.appendChild(wrap);
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    // Sync the pixel buffer to the element's CSS size on every layout change
    // so the drawing never gets stretched by CSS scaling.
    this._resizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resizeCanvas());
      this._ro.observe(canvas);
    }
  }
  setPoints(pts) { this.points = pts.slice(); this.draw(); }
  _resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.cssW && h === this.cssH) return;
    this.cssW = w; this.cssH = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width  = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  _baseRadius() {
    return Math.min(this.cssW, this.cssH) * 0.32;
  }
  _pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const mx = e.clientX - rect.left - cx;
    const my = e.clientY - rect.top - cy;
    const ang = Math.atan2(my, mx);
    const norm = (ang + Math.PI * 2) % (Math.PI * 2);
    const n = this.points.length;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const dd = Math.min(Math.abs(a - norm), Math.PI * 2 - Math.abs(a - norm));
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return best;
  }
  _update(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const mx = e.clientX - rect.left - cx;
    const my = e.clientY - rect.top - cy;
    const dist = Math.sqrt(mx * mx + my * my);
    const baseR = this._baseRadius();
    const v = Math.max(this.min, Math.min(this.max, dist / baseR));
    this.points[this.dragIdx] = v;
    this.draw(); this.onChange && this.onChange();
  }
  _down(e) { this.canvas.setPointerCapture(e.pointerId); this.dragIdx = this._pick(e); this._update(e); }
  _move(e) { if (this.dragIdx >= 0) this._update(e); }
  _up(e) { if (this.dragIdx >= 0) this.canvas.releasePointerCapture?.(e.pointerId); this.dragIdx = -1; }

  // Closed Catmull-Rom interpolation by angle
  sample(angle) {
    const n = this.points.length;
    const norm = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const f = (norm / (Math.PI * 2)) * n;
    const i1 = Math.floor(f) % n;
    const i2 = (i1 + 1) % n;
    const i0 = (i1 - 1 + n) % n;
    const i3 = (i2 + 1) % n;
    const u = f - Math.floor(f);
    const p0 = this.points[i0], p1 = this.points[i1], p2 = this.points[i2], p3 = this.points[i3];
    const a = 2 * p1;
    const b = p2 - p0;
    const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const d = -p0 + 3 * p1 - 3 * p2 + p3;
    return 0.5 * (a + b * u + c * u * u + d * u * u * u);
  }

  draw() {
    const { ctx } = this;
    const w = this.cssW, h = this.cssH;
    if (w === 0 || h === 0) return;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const baseR = this._baseRadius();

    // Concentric reference circles
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let r = baseR * 0.5; r <= baseR * this.max * 1.05; r += baseR * 0.25) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    // Dashed reference (unity)
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(cx, cy, baseR, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // Radial spokes
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    for (let i = 0; i < this.points.length; i++) {
      const a = (i / this.points.length) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * baseR * this.max, cy + Math.sin(a) * baseR * this.max);
      ctx.stroke();
    }

    // Closed curve
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const samples = 140;
    for (let i = 0; i <= samples; i++) {
      const a = (i / samples) * Math.PI * 2;
      const r = this.sample(a) * baseR;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Control points — filled accent blue, no stroke
    ctx.fillStyle = '#80b3ff';
    for (let i = 0; i < this.points.length; i++) {
      const a = (i / this.points.length) * Math.PI * 2;
      const r = this.points[i] * baseR;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    // Center dot
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill();
  }
}

// --- Leaf silhouette editor ---------------------------------------------
// Free-form closed-polygon editor for sculpting a leaf outline. Stem anchors
// the bottom (y=0), tip the top (y=1), midrib at x=0.5. Drag a handle to move
// it; double-click an edge to insert a handle; right-click a handle to remove
// it; Mirror button reflects the right half onto the left half.
export class LeafSilhouetteEditor {
  constructor(container, { points } = {}) {
    this.pts = (points && points.length >= 3)
      ? points.map(p => ({ x: p.x, y: p.y }))
      : LeafSilhouetteEditor.defaultPoints();
    this.onChange = null;
    this.dragIdx = -1;
    this.cssW = 0; this.cssH = 0;
    const wrap = document.createElement('div');
    wrap.className = 'leaf-silhouette-wrap';
    wrap.style.cssText = 'padding:6px 12px 8px;';
    const canvas = document.createElement('canvas');
    canvas.className = 'leaf-silhouette-canvas';
    canvas.style.cssText = 'width:100%;aspect-ratio:1/1.15;display:block;background:rgba(0,0,0,0.25);border-radius:6px;cursor:crosshair;touch-action:none;';
    wrap.appendChild(canvas);

    const ops = document.createElement('div');
    ops.style.cssText = 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;';
    const mkBtn = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.className = 'spline-reset-btn';
      b.style.cssText = 'flex:1;min-width:56px;';
      b.addEventListener('click', fn);
      return b;
    };
    const mirrorBtn = mkBtn('Mirror', 'Reflect the right half onto the left (symmetrize)', () => {
      this.mirror();
      this.draw();
      this.onChange && this.onChange();
    });
    const flipBtn = mkBtn('Flip', 'Flip the silhouette left↔right', () => {
      this.pts = this.pts.map(p => ({ x: 1 - p.x, y: p.y })).reverse();
      this.draw();
      this.onChange && this.onChange();
    });
    const smoothBtn = mkBtn('Smooth', 'Average neighbors to soften sharp kinks', () => {
      const n = this.pts.length;
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = this.pts[(i - 1 + n) % n];
        const b = this.pts[i];
        const c = this.pts[(i + 1) % n];
        out[i] = { x: (a.x + b.x * 2 + c.x) / 4, y: (a.y + b.y * 2 + c.y) / 4 };
      }
      this.pts = out;
      this.draw();
      this.onChange && this.onChange();
    });
    const resetBtn = mkBtn('Reset', 'Reset to default oval', () => {
      this.pts = LeafSilhouetteEditor.defaultPoints();
      this.draw();
      this.onChange && this.onChange();
    });
    ops.append(mirrorBtn, flipBtn, smoothBtn, resetBtn);
    wrap.appendChild(ops);

    const hint = document.createElement('div');
    hint.className = 'hint-sm-mt';
    hint.style.cssText = 'font-size:10px;opacity:0.55;margin-top:4px;';
    hint.textContent = 'Drag handles · double-click edge to add · right-click handle to remove';
    wrap.appendChild(hint);

    container.appendChild(wrap);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup',   (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('dblclick',     (e) => this._dblclick(e));
    canvas.addEventListener('contextmenu',  (e) => this._rightclick(e));
    this._resizeCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resizeCanvas());
      this._ro.observe(canvas);
    }
  }
  static defaultPoints() {
    return [
      { x: 0.50, y: 0.00 }, { x: 0.58, y: 0.08 }, { x: 0.72, y: 0.25 },
      { x: 0.80, y: 0.50 }, { x: 0.70, y: 0.78 }, { x: 0.56, y: 0.94 },
      { x: 0.50, y: 1.00 }, { x: 0.44, y: 0.94 }, { x: 0.30, y: 0.78 },
      { x: 0.20, y: 0.50 }, { x: 0.28, y: 0.25 }, { x: 0.42, y: 0.08 },
    ];
  }
  get points() { return this.pts.map(p => ({ x: p.x, y: p.y })); }
  setPoints(pts) {
    if (Array.isArray(pts) && pts.length >= 3 && typeof pts[0] === 'object') {
      this.pts = pts.map(p => ({
        x: Math.max(0, Math.min(1, p.x)),
        y: Math.max(0, Math.min(1, p.y)),
      }));
    } else {
      this.pts = LeafSilhouetteEditor.defaultPoints();
    }
    this.draw();
  }
  _resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.cssW && h === this.cssH) return;
    this.cssW = w; this.cssH = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width  = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  _inset() {
    const pad = 10;
    const size = Math.min(this.cssW, this.cssH) - pad * 2;
    return { size, ox: (this.cssW - size) / 2, oy: (this.cssH - size) / 2 };
  }
  _toCanvas(p) {
    const { size, ox, oy } = this._inset();
    return { x: ox + p.x * size, y: oy + (1 - p.y) * size };
  }
  _fromCanvas(cx, cy) {
    const { size, ox, oy } = this._inset();
    return {
      x: Math.max(0, Math.min(1, (cx - ox) / size)),
      y: Math.max(0, Math.min(1, 1 - (cy - oy) / size)),
    };
  }
  _pickHandle(mx, my, rad = 10) {
    let best = -1, bestD = rad * rad;
    for (let i = 0; i < this.pts.length; i++) {
      const c = this._toCanvas(this.pts[i]);
      const dx = c.x - mx, dy = c.y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD) { bestD = d2; best = i; }
    }
    return best;
  }
  _evLocal(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
  }
  _down(e) {
    if (e.button === 2) return;
    const { mx, my } = this._evLocal(e);
    const idx = this._pickHandle(mx, my);
    if (idx < 0) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.dragIdx = idx;
    e.preventDefault();
  }
  _move(e) {
    if (this.dragIdx < 0) return;
    const { mx, my } = this._evLocal(e);
    const p = this._fromCanvas(mx, my);
    this.pts[this.dragIdx] = p;
    this.draw();
    this.onChange && this.onChange();
  }
  _up(e) {
    if (this.dragIdx < 0) return;
    this.canvas.releasePointerCapture?.(e.pointerId);
    this.dragIdx = -1;
  }
  _dblclick(e) {
    const { mx, my } = this._evLocal(e);
    const n = this.pts.length;
    let bestSeg = 0, bestD = Infinity, bestU = 0;
    for (let i = 0; i < n; i++) {
      const a = this._toCanvas(this.pts[i]);
      const b = this._toCanvas(this.pts[(i + 1) % n]);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      let u = ((mx - a.x) * dx + (my - a.y) * dy) / len2;
      u = Math.max(0, Math.min(1, u));
      const px = a.x + dx * u, py = a.y + dy * u;
      const d2 = (px - mx) ** 2 + (py - my) ** 2;
      if (d2 < bestD) { bestD = d2; bestSeg = i; bestU = u; }
    }
    if (bestD > 900) return;
    const a = this.pts[bestSeg];
    const b = this.pts[(bestSeg + 1) % n];
    const np = { x: a.x + (b.x - a.x) * bestU, y: a.y + (b.y - a.y) * bestU };
    this.pts.splice(bestSeg + 1, 0, np);
    this.draw();
    this.onChange && this.onChange();
  }
  _rightclick(e) {
    e.preventDefault();
    if (this.pts.length <= 4) return;
    const { mx, my } = this._evLocal(e);
    const idx = this._pickHandle(mx, my, 12);
    if (idx < 0) return;
    this.pts.splice(idx, 1);
    this.draw();
    this.onChange && this.onChange();
  }
  mirror() {
    // Reflect the right half (x > 0.5) onto the left. Midline points stay
    // anchors. Re-ordered by angle around the centroid so the polygon
    // traversal stays coherent after the symmetrize.
    const EPS = 1e-3;
    const right = this.pts.filter(p => p.x >= 0.5 - EPS).map(p => ({ x: p.x, y: p.y }));
    const mirrored = right
      .filter(p => p.x > 0.5 + EPS)
      .map(p => ({ x: 1 - p.x, y: p.y }));
    const all = [...right, ...mirrored];
    if (all.length < 3) return;
    const cy = all.reduce((s, p) => s + p.y, 0) / all.length;
    all.sort((a, b) =>
      Math.atan2(a.y - cy, a.x - 0.5) - Math.atan2(b.y - cy, b.x - 0.5)
    );
    this.pts = all;
  }
  _sampleCurve(samplesPerSeg = 8) {
    const pts = this.pts;
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
  draw() {
    const { ctx } = this;
    const w = this.cssW, h = this.cssH;
    if (w === 0 || h === 0) return;
    ctx.clearRect(0, 0, w, h);
    const { size, ox, oy } = this._inset();

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(ox + size / 2, oy); ctx.lineTo(ox + size / 2, oy + size);
    ctx.moveTo(ox, oy + size); ctx.lineTo(ox + size, oy + size);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TIP', ox + size / 2, oy + 9);
    ctx.fillText('STEM', ox + size / 2, oy + size - 3);

    const curve = this._sampleCurve(10);
    ctx.beginPath();
    for (let i = 0; i <= curve.length; i++) {
      const p = curve[i % curve.length];
      const c = this._toCanvas(p);
      if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(120, 200, 120, 0.12)';
    ctx.fill();
    ctx.strokeStyle = '#9bd19b';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    for (let i = 0; i < this.pts.length; i++) {
      const c = this._toCanvas(this.pts[i]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#80b3ff';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.stroke();
    }
  }
}

let taperSpline = null;
let lengthSpline = null;
let profileEditor = null;
