// MODIFIED 2026-10-01 by David Riehl (fork of https://github.com/Ttl/js_2d_fields, GPL v3):
// added the |H| Field and Current J views (buildMqsTraces, buildCoaxTraces, H field lines,
// waveguide H arrows, outline shapes), E / H field arrows on every field view and the
// Poynting vector (power flow view and ⊙ markers).
// See FORK_CHANGES.md for the full list of changes.

import { makeStreamlineTraceFromConductors } from './streamlines.js';
import { computeSParamsSingleEnded, computeSParamsDiffAuto, sParamTodB,
         isSelfReferenced, sparamsForPoint, usableSweepPoints } from './sparameters.js';
import { isComplement, svgRingPath, shapeContains } from './shapes.js';

// Lazy Plotly access - allows app to function while Plotly is loading
const getPlotly = () => window.Plotly;

let showMesh = false;
let currentView = "geometry";
let zMin = null;
let zMax = null;
// Store actual data range (before any user scaling)
let actualDataMin = null;
let actualDataMax = null;

// Geometry view zoom constants
const SIGNAL_CONDUCTOR_VIEW_FRACTION = 1/3;  // Signal conductors take up this fraction of X-axis view

// Frozen trace state
let frozenResultsData = null;   // Deep copy of frequencySweepResults
let frozenSParamData = null;    // { results: deepCopy, length, zRef }

// Plotly default color cycle (colorway)
const PLOTLY_COLORS = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
];

// Globals imported from app.js
let getSolver = () => null;
let getFrequencySweepResults = () => null;
let getInputValue = () => NaN;

// Function to set globals from app.js
function setGlobals(globals) {
    getSolver = globals.getSolver || (() => null);
    getFrequencySweepResults = globals.getFrequencySweepResults || (() => null);
    getInputValue = globals.getInputValue || (() => NaN);
}

// Helper to access globals
const get = {
    solver: () => getSolver(),
    frequencySweepResults: () => getFrequencySweepResults(),
    inputValue: (id) => getInputValue(id)
};

function contourScaledB(min, max, n) {
    let eMin = Math.max(Math.max(1, max*1e-2), min);
    eMin = Math.log10(Math.max(eMin, 0.1));
    let eMax = Math.log10(Math.max(eMin + 0.1, Math.max(max, 0.1)));
    eMax = Math.max(eMin + 0.1, eMax);
    const logStep = n === 0 ? 1 : Math.abs((eMax - eMin)) / n;
    return [eMin, eMax, logStep];
}

// Closed rectangular loop as an SVG path, in mm. Two of these in one path with the evenodd
// fill rule give a rectangular ring, the frame drawn around an enclosed medium's domain.
function rectLoopPath(x0, y0, x1, y1) {
    const m = (v) => v * 1000;
    return `M ${m(x0)},${m(y0)} L ${m(x1)},${m(y0)} L ${m(x1)},${m(y1)} L ${m(x0)},${m(y1)} Z`;
}

// Opaque conductor fills (+ yellow plating edges), drawn above the field. Shared by the geometry
// view and the field views so conductors look identical and the field views don't show heatmap/
// contour bleed inside the PEC (the resampled field is identically zero in the conductor interior,
// this just masks the zsmooth/contour interpolation that spills the steep boundary field inward).
function conductorFillShapes(solver, maxY) {
    const out = [];
    const FILL = 'rgba(217, 119, 6, 1.0)';
    const EDGE = { color: 'rgba(0, 0, 0, 0.5)', width: 1 };
    const GOLD = { color: 'rgba(255, 215, 0, 1.0)', width: 3 };

    // Enclosing metal walls of a source-free medium (rectangular waveguide). They are not
    // conductors in `solver.conductors`, physically they live in the boundary conditions,
    // with no meshed thickness, so without this the geometry view would render a bare
    // rectangle of dielectric with nothing to show it is a waveguide. Drawn as a ring
    // (outer loop + inner loop, evenodd) exactly like the coax shield.
    const w = solver.enclosure_walls;
    if (w) {
        const t = w.thickness;
        out.push({
            type: 'path',
            path: rectLoopPath(w.x_min - t, w.y_min - t, w.x_max + t, w.y_max + t) + ' ' +
                  rectLoopPath(w.x_min, w.y_min, w.x_max, w.y_max),
            fillrule: 'evenodd', fillcolor: FILL, line: EDGE, layer: 'above',
        });
        // Plating covers the whole inner surface (one continuous wall, no separate faces),
        // so the indicator is an outline of that surface rather than per-face lines.
        if (solver.plating) {
            out.push({
                type: 'path', path: rectLoopPath(w.x_min, w.y_min, w.x_max, w.y_max),
                fillcolor: 'rgba(0,0,0,0)', line: GOLD, layer: 'above',
            });
        }
    }
    for (const cond of (solver.conductors || [])) {
        const sh = cond.shape;
        if (sh) {
            // A round conductor is drawn with Plotly's ellipse shape. The enclosing
            // shield is an annulus, which needs an SVG path because Plotly's shape path
            // grammar has no arc command (M/L/H/V/Q/C/T/S/Z only), svgRingPath emits
            // two polygonal loops filled with the evenodd rule.
            const cx = sh.cx * 1000, cy = sh.cy * 1000, r = sh.r * 1000;
            if (isComplement(sh)) {
                out.push({
                    type: 'path', path: svgRingPath(cx, cy, r, cond.x_max * 1000),
                    fillrule: 'evenodd', fillcolor: FILL, line: EDGE, layer: 'above',
                });
            } else {
                out.push({
                    type: 'circle', xref: 'x', yref: 'y',
                    x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r,
                    fillcolor: FILL, line: EDGE, layer: 'above',
                });
            }
            // Plating covers the whole circumference (a circle has no separate faces),
            // so the indicator is a gold outline rather than per-face lines.
            if (cond.plating) {
                out.push({
                    type: 'circle', xref: 'x', yref: 'y',
                    x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r,
                    fillcolor: 'rgba(0,0,0,0)', line: GOLD, layer: 'above',
                });
            }
            continue;
        }
        if (cond.y_min > maxY) continue;
        const yMax = Math.min(cond.y_max, maxY);
        out.push({
            type: 'rect',
            x0: cond.x_min * 1000, y0: cond.y_min * 1000,
            x1: cond.x_max * 1000, y1: yMax * 1000,
            fillcolor: 'rgba(217, 119, 6, 1.0)',
            line: { color: 'rgba(0, 0, 0, 0.5)', width: 1 },
            layer: 'above'
        });
        if (cond.plating) {   // yellow lines on plated edges
            const x0 = cond.x_min * 1000, x1 = cond.x_max * 1000, y0 = cond.y_min * 1000, y1 = yMax * 1000;
            const plateLine = { color: 'rgba(255, 215, 0, 1.0)', width: 3 };
            if (cond.plating.top) out.push({ type: 'line', x0, y0: y1, x1, y1: y1, line: plateLine, layer: 'above' });
            if (cond.plating.bottom) out.push({ type: 'line', x0, y0: y0, x1, y1: y0, line: plateLine, layer: 'above' });
            if (cond.plating.sides) {
                out.push({ type: 'line', x0: x0, y0: y0, x1: x0, y1: y1, line: plateLine, layer: 'above' });
                out.push({ type: 'line', x0: x1, y0: y0, x1: x1, y1: y1, line: plateLine, layer: 'above' });
            }
        }
    }
    return out;
}

// Dielectric rect shapes, colored by ε_r (air ≈1 → white/transparent, higher ε_r → green
// shades). Shared by the geometry view (opaque, below the contours) and the Modes tab
// (faint, above the field heatmap) so the two tabs use the same color mapping.
function dielectricFillShapes(solver, maxY, { alpha = 0.8, airAlpha = alpha, layer = 'below',
    lineColor = 'rgba(128, 128, 128, 0.3)' } = {}) {
    const out = [];
    for (const diel of (solver.dielectrics || [])) {
        if (!diel.shape && diel.y_min > maxY) continue;
        const yMax = Math.min(diel.y_max, maxY);
        const er = diel.epsilon_r;
        let fillcolor;
        if (er <= 1.01) {
            fillcolor = `rgba(255, 255, 255, ${airAlpha})`;
        } else {
            const intensity = Math.min(255, 100 + (er - 1) * 30);
            fillcolor = `rgba(100, ${intensity}, 100, ${alpha})`;
        }
        const sh = diel.shape;
        if (sh && !isComplement(sh)) {
            const cx = sh.cx * 1000, cy = sh.cy * 1000, r = sh.r * 1000;
            out.push({
                type: 'circle', xref: 'x', yref: 'y',
                x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r,
                fillcolor, line: { color: lineColor, width: 0.5 }, layer
            });
            continue;
        }
        out.push({
            type: 'rect',
            x0: diel.x_min * 1000, y0: diel.y_min * 1000,
            x1: diel.x_max * 1000, y1: yMax * 1000,
            fillcolor, line: { color: lineColor, width: 0.5 }, layer
        });
    }
    return out;
}

// Focused view (mm) around the signal conductors: the signal cluster fills `fraction` of
// the x-axis; with a top ground the full stack height is shown, otherwise the conductors
// sit in the bottom `fraction` of the view. Shared by the geometry tab's initial zoom and
// the Modes tab so both frame the structure identically. Returns null when there are no
// signal conductors to frame (caller picks its own fallback).
function computeGeometryView(solver, maxY, fraction = SIGNAL_CONDUCTOR_VIEW_FRACTION) {
    const signal = solver.conductors.filter(c => c.is_signal);
    const grounds = solver.conductors.filter(c => !c.is_signal);
    if (!signal.length) {
        // A source-free enclosed medium (rectangular waveguide) has no signal cluster to
        // centre on, the structure is the domain. Frame the whole cross-section walls
        // included with a margin. Without this the caller falls back to Plotly autoscale,
        // which ignores shapes and so leaves the guide off-centre in a default range.
        const w = solver.enclosure_walls;
        if (!w) return null;
        const outer = w.thickness;
        const pad = 0.10 * Math.max(w.x_max - w.x_min, w.y_max - w.y_min);
        return {
            xRange: [(w.x_min - outer - pad) * 1000, (w.x_max + outer + pad) * 1000],
            yRange: [(w.y_min - outer - pad) * 1000, (w.y_max + outer + pad) * 1000],
        };
    }
    const xl = Math.min(...signal.map(c => c.x_min));
    const xr = Math.max(...signal.map(c => c.x_max));
    const center = (xl + xr) / 2;
    const viewWidth = (xr - xl) / fraction;
    const xRange = [(center - viewWidth / 2) * 1000, (center + viewWidth / 2) * 1000];

    const bottomY = grounds.length ? Math.min(...grounds.map(g => g.y_min)) : 0;
    const hasTopGround = grounds.some(c => c.y_max >= maxY * 0.9);
    let yRange;
    if (hasTopGround) {
        yRange = [bottomY * 1000, maxY * 1000];
    } else {
        const topOfConductors = Math.max(...solver.conductors.map(c => c.y_max));
        const viewHeight = (topOfConductors - bottomY) / fraction;
        yRange = [bottomY * 1000, (bottomY + viewHeight) * 1000];
    }
    return { xRange, yRange };
}

// The log-spaced |E| contour-LINE trace (lines only, no fill), shared by the geometry overlay and
// the |E| field view so their contours are identical. z = log10(|E|) with log-spaced levels keeps
// the lines evenly spaced instead of crowding at the singular trace corners. Named "E-field
// contours" so setScaleRange can rescale it live in either view.
function efieldContourTrace(xMM, yMM, zData, eMin, eMax, n) {
    const limits = contourScaledB(eMin, eMax, n);
    return {
        type: "contour",
        x: xMM, y: yMM,
        z: zData.map(row => row.map(v => Math.log10(Math.max(v, 1e-3)))),
        contours: { showlines: true, coloring: "none", start: limits[0], end: limits[1], size: limits[2] },
        line: { smoothing: 1.3, width: 1, color: "rgba(0, 0, 0, 0.4)" },
        showscale: false,
        name: "E-field contours",
        hoverinfo: "skip"
    };
}

// Export functions to get/set scale range for current view
function getScaleRange() {
    return { min: zMin, max: zMax, view: currentView };
}

// ---- H field / current density views ------------------------------------------------
// The data comes from an extra eddy-current solve in the worker (TriBackend.mqsFieldAt),
// requested on demand through window.requestMqsField when one of these views is shown.
// Each result is tagged with the key it was requested for (solve generation, mode,
// frequency), a view whose key does not match asks again.
let mqsField = null;
let mqsPending = null;
let mqsGen = 0;

function fieldPlotFreq() {
    const f = get.inputValue('plot-field-freq');
    return f > 0 ? f : 1e9;
}

function mqsModeIndex() {
    return isDifferentialMode() ? getSelectedModeIndex() : 0;
}

function mqsKey() {
    return `${mqsGen}|${mqsModeIndex()}|${fieldPlotFreq()}`;
}

// A new solve invalidates the cached field (called by app_solver at solve start).
function clearMqsField() {
    mqsField = null;
    mqsPending = null;
    mqsGen++;
}

function setMqsField(data, key) {
    mqsField = { ...(data || { ok: false, reason: 'No data returned.' }), key };
    if (mqsPending === key) mqsPending = null;
}

function getFieldDisplayOptions() {
    const disp = document.getElementById('plot-field-display');
    const scale = document.getElementById('plot-field-scale');
    const phase = parseFloat(document.getElementById('plot-field-phase')?.value);
    return {
        instantaneous: disp ? disp.value === 'inst' : false,
        phaseDeg: Number.isFinite(phase) ? phase : 0,
        log: scale ? scale.value !== 'linear' : true,
    };
}

function formatFreq(f) {
    if (f >= 1e9) return `${+(f / 1e9).toPrecision(4)} GHz`;
    if (f >= 1e6) return `${+(f / 1e6).toPrecision(4)} MHz`;
    if (f >= 1e3) return `${+(f / 1e3).toPrecision(4)} kHz`;
    return `${+f.toPrecision(4)} Hz`;
}

function formatLength(m) {
    if (m >= 1e-3) return `${+(m * 1e3).toPrecision(3)} mm`;
    return `${+(m * 1e6).toPrecision(3)} µm`;
}

// Conductor and dielectric outlines only. The H and J views show the field inside the
// metal, so the opaque conductor fills of the other views would hide exactly that.
function outlineShapes(solver, maxY) {
    const cond = conductorFillShapes(solver, maxY).map(s => ({
        ...s,
        fillcolor: 'rgba(0,0,0,0)',
        line: s.line && s.line.color === 'rgba(255, 215, 0, 1.0)'
            ? s.line : { color: 'rgba(255, 255, 255, 0.55)', width: 1 },
    }));
    const diel = dielectricFillShapes(solver, maxY, {
        alpha: 0, airAlpha: 0, layer: 'above', lineColor: 'rgba(200, 200, 200, 0.3)' });
    return [...diel, ...cond];
}

// Colorbar ticks for a log10 color axis: decades, or 1-2-5 steps when the range spans
// less than two decades, labelled with the actual values.
function logTicks(zmin, zmax) {
    let vals = [];
    for (let k = Math.ceil(zmin); k <= Math.floor(zmax); k++) vals.push(k);
    if (vals.length < 2) {
        vals = [];
        for (let k = Math.floor(zmin) - 1; k <= Math.ceil(zmax); k++)
            for (const m of [1, 2, 5]) { const v = k + Math.log10(m); if (v >= zmin && v <= zmax) vals.push(v); }
    }
    if (vals.length < 2) return {};
    return { tickvals: vals, ticktext: vals.map(v => (10 ** v).toPrecision(1).replace(/\.0+e/, 'e')) };
}

// ---- shared color scales (Plotly's definitions), used where colors are computed here ----
const COLORSCALES = {
    Viridis: [[0, '#440154'], [0.0627, '#48186a'], [0.1255, '#472d7b'], [0.1882, '#424086'],
        [0.2510, '#3b528b'], [0.3137, '#33638d'], [0.3765, '#2c728e'], [0.4392, '#26828e'],
        [0.5020, '#21918c'], [0.5647, '#1fa088'], [0.6275, '#28ae80'], [0.6902, '#3fbc73'],
        [0.7529, '#5ec962'], [0.8157, '#84d44b'], [0.8784, '#addc30'], [0.9412, '#d8e219'], [1, '#fde725']],
    Hot: [[0, 'rgb(0,0,0)'], [0.3, 'rgb(230,0,0)'], [0.6, 'rgb(255,210,0)'], [1, 'rgb(255,255,255)']],
    Electric: [[0, 'rgb(0,0,0)'], [0.15, 'rgb(30,0,100)'], [0.4, 'rgb(120,0,100)'], [0.6, 'rgb(160,90,0)'],
        [0.8, 'rgb(230,200,0)'], [1, 'rgb(255,250,220)']],
    RdBu: [[0, 'rgb(5,10,172)'], [0.35, 'rgb(106,137,247)'], [0.5, 'rgb(190,190,190)'],
        [0.6, 'rgb(220,170,132)'], [0.7, 'rgb(230,145,90)'], [1, 'rgb(178,10,28)']],
};
function parseColor(c) {
    if (c[0] === '#') return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    return c.match(/\d+/g).slice(0, 3).map(Number);
}
// Color of t ∈ [0, 1] on a scale, quantized to 256 levels (adjacent equal colors merge).
function colorAt(scale, t) {
    const st = COLORSCALES[scale];
    t = Math.round(Math.min(1, Math.max(0, t)) * 255) / 255;
    for (let i = 1; i < st.length; i++) {
        if (t <= st[i][0]) {
            const f = (t - st[i - 1][0]) / (st[i][0] - st[i - 1][0] || 1);
            const a = parseColor(st[i - 1][1]), b = parseColor(st[i][1]);
            return `rgb(${a.map((v, k) => Math.round(v + f * (b[k] - v))).join(',')})`;
        }
    }
    return st[st.length - 1][1];
}

// Arrows of the instantaneous transverse H on a coarse grid (waveguide).
function quiverTrace(r, cp, sp, n) {
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    const ny = r.y.length, nx = r.x.length;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!Number.isFinite(r.H[j][i]) || Number.isFinite(r.J[j][i])) continue;   // interior only
        xlo = Math.min(xlo, r.x[i]); xhi = Math.max(xhi, r.x[i]);
        ylo = Math.min(ylo, r.y[j]); yhi = Math.max(yhi, r.y[j]);
    }
    const W = xhi - xlo, Hh = yhi - ylo;
    const nc = Math.max(4, Math.round(n * Math.sqrt(W / Hh))), nr = Math.max(3, Math.round(n * Math.sqrt(Hh / W)));
    const nearest = (arr, v) => { let k = 0; for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[k] - v)) k = i; return k; };
    const pts = [];
    let vmax = 0;
    for (let a = 0; a < nr; a++) for (let c = 0; c < nc; c++) {
        const x = xlo + W * (c + 0.5) / nc, y = ylo + Hh * (a + 0.5) / nr;
        const i = nearest(r.x, x), j = nearest(r.y, y);
        const hx = r.Hxr[j][i] * cp - r.Hxi[j][i] * sp, hy = r.Hyr[j][i] * cp - r.Hyi[j][i] * sp;
        pts.push([x, y, hx, hy]);
        vmax = Math.max(vmax, Math.hypot(hx, hy));
    }
    const X = [], Y = [];
    const Lmax = 0.85 * Math.min(W / nc, Hh / nr);
    for (const [x, y, hx, hy] of pts) {
        const m = Math.hypot(hx, hy);
        if (!(vmax > 0) || m < 0.02 * vmax) continue;
        const L = Lmax * m / vmax, ux = hx / m, uy = hy / m;
        const x0 = x - 0.5 * L * ux, y0 = y - 0.5 * L * uy, x1 = x + 0.5 * L * ux, y1 = y + 0.5 * L * uy;
        const hl = 0.3 * L, c30 = Math.cos(Math.PI / 7), s30 = Math.sin(Math.PI / 7);
        const bx = -ux, by = -uy;
        X.push(x0, x1, null, x1, x1 + hl * (bx * c30 - by * s30), null, x1, x1 + hl * (bx * c30 + by * s30), null);
        Y.push(y0, y1, null, y1, y1 + hl * (by * c30 + bx * s30), null, y1, y1 + hl * (by * c30 - bx * s30), null);
    }
    return {
        type: 'scatter', mode: 'lines', x: X.map(v => (v === null ? null : v * 1000)),
        y: Y.map(v => (v === null ? null : v * 1000)),
        line: { color: 'rgba(255, 255, 255, 0.75)', width: 1.2 },
        hoverinfo: 'skip', showlegend: false, name: 'H field arrows',
    };
}

// ---- E / H arrows ------------------------------------------------------------------
// Arrows of the instantaneous transverse E and / or H at phase ωt on a regular lattice
// over the visible range (re-sampled on zoom / pan). Direction from the instantaneous
// vector; length from the peak magnitude on a log scale over two decades (the field is
// singular at conductor corners, a linear length would hide almost every arrow) times
// the instantaneous fraction, so arrows shrink and flip as ωt runs.
const ARROW_COLORS = { E: 'rgba(70, 150, 255, 0.95)', H: 'rgba(255, 60, 60, 0.95)', S: 'rgba(255, 255, 255, 0.9)' };

function getArrowOptions() {
    const m = document.getElementById('plot-arrows')?.value || '';
    const n = parseInt(document.getElementById('plot-arrow-density')?.value);
    return { E: m.includes('E'), H: m.includes('H'), S: m.includes('S'),
             density: Number.isFinite(n) && n >= 4 ? Math.min(n, 80) : 24 };
}

// The H / J field for the current mode and frequency, requested if missing.
function ensureMqsField() {
    const key = mqsKey();
    if (mqsField && mqsField.key === key) return mqsField.ok ? mqsField : null;
    if (mqsPending !== key && window.requestMqsField) {
        mqsPending = key;
        window.requestMqsField(mqsModeIndex(), fieldPlotFreq(), key);
    }
    return null;
}

function nearestIndex(arr, v) {
    const n = arr.length;
    if (v <= arr[0]) return 0;
    if (v >= arr[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid; }
    return (v - arr[lo] < arr[hi] - v) ? lo : hi;
}

// Phasor sampler on a rectilinear grid (nearest node): (x, y) [m] → {xr, xi, yr, yi} | null.
function gridPhasor(xs, ys, Xr, Xi, Yr, Yi) {
    const x0 = xs[0], x1 = xs[xs.length - 1], y0 = ys[0], y1 = ys[ys.length - 1];
    return (x, y) => {
        if (x < x0 || x > x1 || y < y0 || y > y1) return null;
        const i = nearestIndex(xs, x), j = nearestIndex(ys, y);
        const xr = Xr[j] && Xr[j][i], yr = Yr[j] && Yr[j][i];
        if (!Number.isFinite(xr) || !Number.isFinite(yr)) return null;
        return { xr, xi: Xi ? Xi[j][i] || 0 : 0, yr, yi: Yi ? Yi[j][i] || 0 : 0 };
    };
}

// Coax (radial result): Hφ from the rings, E_r = (η0/√εr)·Hφ in the dielectric.
function coaxPhasor(f, which) {
    const rings = f.rings, ETA0 = 376.730313668;
    return (x, y) => {
        const dx = x - f.cx, dy = y - f.cy, r = Math.hypot(dx, dy);
        if (!(r > 0) || r > rings[rings.length - 1].r1) return null;
        let lo = 0, hi = rings.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (rings[mid].r1 < r) lo = mid + 1; else hi = mid; }
        const g = rings[lo];
        const c = dx / r, sn = dy / r;
        if (which === 'H') return { xr: -g.Hr * sn, xi: -g.Hi * sn, yr: g.Hr * c, yi: g.Hi * c };
        if (g.Jr !== null) return null;   // E only in the dielectric
        const k = ETA0 / Math.sqrt(f.er || 1);
        return { xr: k * g.Hr * c, xi: k * g.Hi * c, yr: k * g.Hr * sn, yi: k * g.Hi * sn };
    };
}

function eSampler(solver, f) {
    if (f && f.kind === 'wg' && f.Exr) return gridPhasor(f.x, f.y, f.Exr, null, f.Eyr, null);
    if (f && f.kind === 'radial') return coaxPhasor(f, 'E');
    const { Ex, Ey } = getFields();
    if (!Ex || !Ey || !solver.x || !solver.y) return null;
    return gridPhasor(solver.x, solver.y, Ex, null, Ey, null);
}

function hSampler(f) {
    if (!f) return null;
    if (f.kind === 'radial') return coaxPhasor(f, 'H');
    return gridPhasor(f.x, f.y, f.Hxr, f.Hxi, f.Hyr, f.Hyi);
}

// Arrow polylines (mm) for the visible ranges xr, yr (mm). Returns { E: {x, y}, H: {x, y} }.
function buildArrowData(solver, xr, yr) {
    const opt = getArrowOptions();
    const out = {};
    if (!opt.E && !opt.H && !opt.S) return out;
    const needH = opt.H || opt.S, needE = opt.E || opt.S;
    const f = needH ? ensureMqsField() : (mqsField && mqsField.key === mqsKey() && mqsField.ok ? mqsField : null);
    const samp = { E: needE ? eSampler(solver, f) : null, H: needH ? hSampler(f) : null };
    const ph = getFieldDisplayOptions().phaseDeg * Math.PI / 180, cp = Math.cos(ph), sp = Math.sin(ph);
    const W = xr[1] - xr[0], Hh = yr[1] - yr[0];
    if (!(W > 0 && Hh > 0)) return out;
    const nc = opt.density, nr = Math.max(2, Math.round(nc * Hh / W));
    const pts = [];
    for (let a = 0; a < nr; a++) for (let c = 0; c < nc; c++)
        pts.push([xr[0] + W * (c + 0.5) / nc, yr[0] + Hh * (a + 0.5) / nr]);
    const vals = {};
    // E is zero inside metal; the static field grid can carry small difference values
    // there, so E arrows are masked by the conductor geometry.
    const conds = solver.conductors || [];
    const inMetal = (x, y) => conds.some(c => shapeContains(c, x, y, 0));
    for (const k of ['E', 'H']) {
        if (!samp[k]) continue;
        vals[k] = pts.map(([x, y]) => (k === 'E' && inMetal(x / 1000, y / 1000)) ? null : samp[k](x / 1000, y / 1000));
    }
    // Power flows along +z: if the time-average E × H* of the sampled fields points the
    // other way (the static E and the MQS H are normalized independently), flip E.
    if (vals.E && vals.H) {
        let sz = 0;
        vals.E.forEach((e, k) => {
            const h = vals.H[k];
            if (e && h) sz += (e.xr * h.yr + e.xi * h.yi) - (e.yr * h.xr + e.yi * h.xi);
        });
        if (sz < 0) vals.E = vals.E.map(e => e && { xr: -e.xr, xi: -e.xi, yr: -e.yr, yi: -e.yi });
    }
    // Poynting vector: the time average ½·Re(E × H*) points along z (out of the page
    // for power flowing towards the viewer), drawn as ⊙ sized by its magnitude on the
    // same two-decade log scale as the arrows.
    if (opt.S && vals.E && vals.H) {
        const sz = vals.E.map((e, k) => {
            const h = vals.H[k];
            return (e && h) ? 0.5 * ((e.xr * h.yr + e.xi * h.yi) - (e.yr * h.xr + e.yi * h.xi)) : 0;
        });
        const sorted = sz.filter(v => v > 0).sort((p, q) => p - q);
        const X = [], Y = [], S = [];
        if (sorted.length) {
            const ref = sorted[Math.min(sorted.length - 1, Math.floor(0.98 * sorted.length))];
            sz.forEach((v, idx) => {
                if (!(v > 1e-2 * ref)) return;
                const g = Math.min(1, Math.max(0, Math.log10(v / ref) / 2 + 1));
                X.push(pts[idx][0]); Y.push(pts[idx][1]); S.push(4 + 10 * g);
            });
        }
        out.S = { x: X, y: Y, size: S };
    }
    if (!opt.E) delete vals.E;
    if (!opt.H) delete vals.H;
    const Lcell = 0.9 * Math.min(W / nc, Hh / nr);
    for (const k of Object.keys(vals)) {
        const mags = vals[k].map(v => (v ? Math.sqrt(v.xr * v.xr + v.xi * v.xi + v.yr * v.yr + v.yi * v.yi) : 0));
        const sorted = mags.filter(m => m > 0).sort((p, q) => p - q);
        if (!sorted.length) { out[k] = { x: [], y: [] }; continue; }
        const ref = sorted[Math.min(sorted.length - 1, Math.floor(0.98 * sorted.length))];
        const X = [], Y = [];
        vals[k].forEach((v, idx) => {
            const m = mags[idx];
            if (!v || !(m > 1e-3 * ref)) return;
            const ix = v.xr * cp - v.xi * sp, iy = v.yr * cp - v.yi * sp;
            const im = Math.hypot(ix, iy);
            if (!(im > 1e-3 * m)) return;
            const g = Math.min(1, Math.max(0, (Math.log10(m / ref) + 2) / 2));
            const L = Lcell * (0.3 + 0.7 * g) * Math.min(1, im / m);
            if (L < 0.08 * Lcell) return;
            const ux = ix / im, uy = iy / im;
            const [x, y] = pts[idx];
            const xa = x - 0.5 * L * ux, ya = y - 0.5 * L * uy, xb = x + 0.5 * L * ux, yb = y + 0.5 * L * uy;
            const hl = 0.35 * L, ca = Math.cos(Math.PI / 7), sa = Math.sin(Math.PI / 7);
            X.push(xa, xb, null, xb, xb + hl * (-ux * ca + uy * sa), null, xb, xb + hl * (-ux * ca - uy * sa), null);
            Y.push(ya, yb, null, yb, yb + hl * (-uy * ca - ux * sa), null, yb, yb + hl * (-uy * ca + ux * sa), null);
        });
        out[k] = { x: X, y: Y };
    }
    return out;
}

// Placeholder traces, filled by updateArrows() once the axis ranges are known.
function arrowPlaceholders() {
    const opt = getArrowOptions();
    const t = [];
    for (const k of ['E', 'H']) {
        if (!opt[k]) continue;
        t.push({ type: 'scatter', mode: 'lines', x: [], y: [], name: `${k} arrows`,
            line: { color: ARROW_COLORS[k], width: 1.4 }, hoverinfo: 'skip', showlegend: true });
    }
    if (opt.S) {
        t.push({ type: 'scatter', mode: 'markers', x: [], y: [], name: 'S power flow (⊙ out of page)',
            marker: { symbol: 'circle-open-dot', size: [], color: ARROW_COLORS.S, line: { width: 1.3 } },
            hoverinfo: 'skip', showlegend: true });
    }
    return t;
}

// Re-sample the arrows for the current axis ranges.
function updateArrows() {
    const container = document.getElementById('sim_canvas');
    const solver = get.solver();
    const Plotly = getPlotly();
    if (!container || !container.data || !solver || !Plotly || !solver.solution_valid) return;
    const idx = [];
    container.data.forEach((t, k) => {
        if (t.name === 'E arrows' || t.name === 'H arrows' || (t.name || '').startsWith('S power flow')) idx.push(k);
    });
    if (!idx.length) return;
    const fl = container._fullLayout || container.layout;
    const xr = fl.xaxis && fl.xaxis.range, yr = fl.yaxis && fl.yaxis.range;
    if (!xr || !yr) return;
    const d = buildArrowData(solver, [Math.min(...xr), Math.max(...xr)], [Math.min(...yr), Math.max(...yr)]);
    const xs = [], ys = [];
    for (const k of idx) {
        const w = container.data[k].name[0];
        xs.push((d[w] && d[w].x) || []); ys.push((d[w] && d[w].y) || []);
    }
    Plotly.restyle(container, { x: xs, y: ys }, idx);
    const sIdx = idx.find(k => container.data[k].name.startsWith('S power flow'));
    if (sIdx !== undefined) Plotly.restyle(container, { 'marker.size': [(d.S && d.S.size) || []] }, [sIdx]);
}

// ---- Power flow view: time-average Poynting vector S_z = ½·Re(E × H*)·ẑ ----------------
// Normalized to 1 W transmitted power (∫S_z dA = 1 W), so every line type reads the same:
// W/mm² per watt. E and H come from separately normalized calculations (static E, MQS
// or closed-form H), so the field product is only used for its shape and sign, and the
// normalization fixes the scale. Also reports the share of the power flowing inside
// dielectrics with εr > 1 (the rest flows in air), which is what pulls ε_eff below εr.
function dielectricAt(solver, x, y) {
    let er = 1;
    for (const d of (solver.dielectrics || [])) {
        if (shapeContains(d, x, y, 0)) er = d.epsilon_r;
    }
    return er;
}

function buildPowerTraces(f, solver, view) {
    const opt = getFieldDisplayOptions();
    const unit = 'W/mm²';
    let traces = [], shapes = [], lo = Infinity, hi = -Infinity;
    let total = 0, inDiel = 0;
    let xMM, yMM;
    if (f.kind === 'radial') {
        const k = 376.730313668 / Math.sqrt(f.er || 1);
        const sv = f.rings.map(g => (g.Jr === null ? 0.5 * k * (g.Hr * g.Hr + g.Hi * g.Hi) : null));
        f.rings.forEach((g, i) => { if (sv[i] !== null) total += sv[i] * Math.PI * (g.r1 * g.r1 - g.r0 * g.r0); });
        const vals = sv.map(v => (v === null ? null : v / total * 1e-6));
        const r = buildCoaxTraces({ ...f, _values: vals, _unit: unit }, false, view, 0);
        r.title = `Power flow S_z (time average) per 1 W transmitted · ${formatFreq(f.f)}`;
        return r;
    }
    const xs = f.x, ys = f.y, nx = xs.length, ny = ys.length;
    const E = eSampler(solver, f);
    if (!E) return null;
    const conds = solver.conductors || [];
    const Sz = [];
    for (let j = 0; j < ny; j++) {
        const row = new Array(nx);
        for (let i = 0; i < nx; i++) {
            const x = xs[i], y = ys[j];
            const hx = f.Hxr[j][i], hy = f.Hyr[j][i];
            if (!Number.isFinite(hx) || !Number.isFinite(hy) || Number.isFinite(f.J[j][i])
                || conds.some(c => shapeContains(c, x, y, 0))) { row[i] = null; continue; }
            const e = E(x, y);
            if (!e) { row[i] = null; continue; }
            row[i] = 0.5 * ((e.xr * hy + e.xi * f.Hyi[j][i]) - (e.yr * hx + e.yi * f.Hxi[j][i]));
        }
        Sz.push(row);
    }
    // Node areas (half the distance to each neighbour), then normalize to +1 W.
    const dx = Array.from(xs, (v, i) => 0.5 * ((xs[Math.min(nx - 1, i + 1)] - xs[Math.max(0, i - 1)])));
    const dy = Array.from(ys, (v, j) => 0.5 * ((ys[Math.min(ny - 1, j + 1)] - ys[Math.max(0, j - 1)])));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const v = Sz[j][i];
        if (v === null) continue;
        const p = v * dx[i] * dy[j];
        total += p;
        if (dielectricAt(solver, xs[i], ys[j]) > 1.01) inDiel += p;
    }
    if (!(Math.abs(total) > 0)) return null;
    const raw = Sz.map(row => row.map(v => (v === null ? null : v / total * 1e-6)));   // W/mm² per W
    const useLog = opt.log;
    const z = useLog ? raw.map(row => row.map(v => (v === null || v <= 0 ? null : Math.log10(v)))) : raw;
    for (const row of z) for (const v of row) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    let zmin = useLog ? Math.max(lo, hi - 4) : 0, zmax = hi;
    if (!useLog) {
        const a = [];
        for (const row of raw) for (const v of row) if (v !== null && v > 0) a.push(v);
        a.sort((p, q) => p - q);
        if (a.length) zmax = a[Math.min(a.length - 1, Math.floor(0.99 * a.length))];
    }
    const dataMin = zmin, dataMax = zmax;
    const override = window.getStoredScale ? window.getStoredScale(view) : null;
    if (override) { zmin = override.min; zmax = override.max; }
    const colorbar = { title: { text: useLog ? `log₁₀ ${unit}` : unit }, len: 0.8 };
    if (useLog) Object.assign(colorbar, logTicks(zmin, zmax));
    xMM = Array.from(xs, v => v * 1000); yMM = Array.from(ys, v => v * 1000);
    traces.push({ type: 'heatmap', zsmooth: 'best', x: xMM, y: yMM, z, zmin, zmax, customdata: raw,
        colorscale: 'Electric', colorbar,
        hovertemplate: `x: %{x:.4f} mm<br>y: %{y:.4f} mm<br>S_z: %{customdata:.3e} ${unit} per W<extra></extra>` });
    const share = inDiel / total;
    const anyAir = (solver.dielectrics || []).some(d => d.epsilon_r <= 1.01) || share < 0.999;
    const shareTxt = (share > 0.001 && anyAir) ? ` · ${(100 * share).toFixed(1)} % in the dielectric` : '';
    const per = f.kind === 'wg' ? `, ${f.mode}` : (f.differential ? (f.mode === 'even' ? ', even mode' : ', odd mode') : '');
    const title = `Power flow S_z (time average) per 1 W${per} · ${formatFreq(f.f)}${shareTxt}`;
    return { traces, shapes, zMin: zmin, zMax: zmax, dataMin, dataMax, title, xMM, yMM };
}

// Coax: the field depends on the radius only, so it is drawn as filled concentric rings
// (exactly round at any zoom, skin layers included) instead of a rectilinear heatmap.
function buildCoaxTraces(r, isH, view, nFieldLines) {
    const opt = getFieldDisplayOptions();
    const ph = opt.phaseDeg * Math.PI / 180, cp = Math.cos(ph), sp = Math.sin(ph);
    const isS = !!r._values;   // power flow view: values precomputed by buildPowerTraces
    const vals = isS ? r._values : r.rings.map(g => {
        if (isH) return opt.instantaneous ? Math.abs(g.Hr * cp - g.Hi * sp) : Math.hypot(g.Hr, g.Hi);
        if (g.Jr === null) return null;
        return (opt.instantaneous ? (g.Jr * cp - g.Ji * sp) : Math.hypot(g.Jr, g.Ji)) * 1e-6;
    });
    const signed = !isS && !isH && opt.instantaneous;
    const useLog = opt.log && !signed;
    const z = vals.map(v => (v === null ? null : (useLog ? Math.log10(Math.max(v, 1e-30)) : v)));
    let lo = Infinity, hi = -Infinity, absMax = 0;
    z.forEach(v => { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    vals.forEach(v => { if (v !== null) absMax = Math.max(absMax, Math.abs(v)); });
    let zmin, zmax;
    if (signed) { zmin = -absMax; zmax = absMax; }
    else if (useLog) { zmax = hi; zmin = Math.max(lo, hi - (isH ? 3 : 4)); }
    else { zmin = 0; zmax = absMax; }
    const dataMin = zmin, dataMax = zmax;
    const override = window.getStoredScale ? window.getStoredScale(view) : null;
    if (override) { zmin = override.min; zmax = override.max; }
    const scale = isS ? 'Electric' : (signed ? 'RdBu' : (isH ? 'Viridis' : 'Hot'));

    // Ring shapes, merging neighbours of identical (quantized) color. Within each
    // contiguous layer the rings are painted from the outside in, each one filled all
    // the way down to the layer's inner radius: every ring lies on top of the previous
    // one, so there are no anti-aliasing seams between adjacent rings.
    const shapes = [];
    const cxm = r.cx * 1000, cym = r.cy * 1000;
    const groups = [];
    let grp = null;
    r.rings.forEach((g, k) => {
        const v = z[k];
        if (v === null) { grp = null; return; }
        const color = colorAt(scale, (v - zmin) / ((zmax - zmin) || 1));
        if (!grp || Math.abs(grp.r1 - g.r0) > 1e-15) { grp = { r0: g.r0, r1: g.r1, rings: [] }; groups.push(grp); }
        const last = grp.rings[grp.rings.length - 1];
        if (last && last.color === color) last.r1 = g.r1;
        else grp.rings.push({ r0: g.r0, r1: g.r1, color });
        grp.r1 = g.r1;
    });
    for (const gp of groups) {
        for (let k = gp.rings.length - 1; k >= 0; k--) {
            const rg = gp.rings[k];
            shapes.push({ type: 'path', path: svgRingPath(cxm, cym, gp.r0 * 1000, rg.r1 * 1000, 360),
                fillcolor: rg.color, fillrule: 'evenodd', line: { width: 0, color: 'rgba(0,0,0,0)' }, layer: 'between' });
        }
    }
    // H field lines: concentric circles at evenly spaced values of A ∝ ln(b/r).
    if (isH && nFieldLines > 0) {
        for (let k = 1; k <= nFieldLines; k++) {
            const rr = r.b * Math.pow(r.a / r.b, k / (nFieldLines + 1)) * 1000;
            shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: cxm - rr, y0: cym - rr, x1: cxm + rr, y1: cym + rr,
                line: { color: 'rgba(255, 255, 255, 0.55)', width: 1 }, fillcolor: 'rgba(0,0,0,0)', layer: 'above' });
        }
    }
    const unit = isS ? 'W/mm²' : (isH ? 'A/m' : 'A/mm²');
    const qty = isS ? 'S_z' : (isH ? '|H|' : (signed ? 'Jz' : '|Jz|'));
    const colorbar = { title: { text: useLog ? `log₁₀ ${unit}` : unit }, len: 0.8 };
    if (useLog) Object.assign(colorbar, logTicks(zmin, zmax));
    const R = (r.b + r.tShield) * 1000;
    // Hover probes along the +x radius (one per ring), the colorbar, and the axis extent.
    const probes = r.rings.map((g, k) => ({ x: cxm + 500 * (g.r0 + g.r1), v: vals[k] })).filter(p => p.v !== null);
    const traces = [
        { type: 'scatter', mode: 'markers', x: [-R, R], y: [-R, R], marker: { size: 0, opacity: 0 },
          hoverinfo: 'skip', showlegend: false },
        { type: 'scatter', mode: 'markers', x: probes.map(p => p.x), y: probes.map(() => cym),
          customdata: probes.map(p => p.v), marker: { size: 6, color: 'rgba(0,0,0,0)' }, showlegend: false,
          hovertemplate: `r: %{x:.4f} mm<br>${qty}: %{customdata:.3e} ${unit}<extra></extra>` },
        { type: 'scatter', mode: 'markers', x: [cxm], y: [cym], hoverinfo: 'skip', showlegend: false,
          marker: { size: 0.1, opacity: 0, color: [zmin], cmin: zmin, cmax: zmax,
                    colorscale: COLORSCALES[scale], showscale: true, colorbar } },
    ];
    const at = opt.instantaneous ? `, ωt = ${opt.phaseDeg}°` : ' (peak)';
    const title = `${qty}${at} for 1 A · ${formatFreq(r.f)} · δ = ${formatLength(r.delta)}`;
    return { traces, shapes, zMin: zmin, zMax: zmax, dataMin, dataMax, title, xMM: [-R, R], yMM: [-R, R] };
}

// Traces for the |H| / Jz views from a field result. Returns { traces, zMin, zMax,
// dataMin, dataMax, title }. Magnitudes are peak phasor amplitudes for a 1 A line current.
function buildMqsTraces(r, isH, view, nFieldLines) {
    const opt = getFieldDisplayOptions();
    const xMM = Array.from(r.x, v => v * 1000);
    const yMM = Array.from(r.y, v => v * 1000);
    const ph = opt.phaseDeg * Math.PI / 180, cp = Math.cos(ph), sp = Math.sin(ph);
    const ny = r.y.length, nx = r.x.length;
    // Raw values in display units: A/m for H, A/mm² for J.
    const raw = [];
    for (let j = 0; j < ny; j++) {
        const row = new Array(nx);
        for (let i = 0; i < nx; i++) {
            let v;
            if (isH) {
                if (opt.instantaneous) {
                    const hx = r.Hxr[j][i] * cp - r.Hxi[j][i] * sp;
                    const hy = r.Hyr[j][i] * cp - r.Hyi[j][i] * sp;
                    // The waveguide also has a longitudinal Hz.
                    const hz = r.Hzr ? r.Hzr[j][i] * cp - r.Hzi[j][i] * sp : 0;
                    v = Math.sqrt(hx * hx + hy * hy + hz * hz);
                } else v = r.H[j][i];
            } else if (opt.instantaneous && r.Jtr) {
                // Waveguide wall current has a longitudinal and a perimeter component:
                // magnitude of the instantaneous current vector.
                const jz = r.Jr[j][i] * cp - r.Ji[j][i] * sp;
                const jt = r.Jtr[j][i] * cp - r.Jti[j][i] * sp;
                v = Math.hypot(jz, jt) * 1e-6;
            } else {
                v = opt.instantaneous ? (r.Jr[j][i] * cp - r.Ji[j][i] * sp) * 1e-6 : r.J[j][i] * 1e-6;
            }
            row[i] = Number.isFinite(v) ? v : null;
        }
        raw.push(row);
    }
    const signed = !isH && opt.instantaneous && !r.Jtr;
    const useLog = opt.log && !signed;
    let z = raw;
    if (useLog) z = raw.map(row => row.map(v => (v === null ? null : Math.log10(Math.max(v, 1e-30)))));
    let lo = Infinity, hi = -Infinity, absMax = 0;
    for (const row of z) for (const v of row) {
        if (v === null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    for (const row of raw) for (const v of row) if (v !== null && Math.abs(v) > absMax) absMax = Math.abs(v);
    // Linear scales default to the 99th percentile of |value|: the field is singular at
    // the conductor corners, and a full-range linear scale would leave everything
    // else at the bottom of the color map.
    const p99 = (() => {
        const a = [];
        for (const row of raw) for (const v of row) if (v !== null && v !== 0) a.push(Math.abs(v));
        if (!a.length) return absMax;
        a.sort((p, q) => p - q);
        return a[Math.min(a.length - 1, Math.floor(0.99 * a.length))] || absMax;
    })();
    let zmin, zmax;
    if (signed) { zmin = -p99; zmax = p99; }
    else if (useLog) { zmax = hi; zmin = Math.max(lo, hi - (isH ? 3 : 4)); }
    else { zmin = 0; zmax = p99; }
    const dataMin = zmin, dataMax = zmax;
    const override = window.getStoredScale ? window.getStoredScale(view) : null;
    if (override) { zmin = override.min; zmax = override.max; }

    const unit = isH ? 'A/m' : 'A/mm²';
    const qty = isH ? '|H|' : (signed ? 'Jz' : (r.Jtr ? '|J|' : '|Jz|'));
    const colorbar = { title: { text: useLog ? `log₁₀ ${unit}` : unit }, len: 0.8 };
    if (useLog) Object.assign(colorbar, logTicks(zmin, zmax));
    const traces = [{
        type: 'heatmap', zsmooth: 'best',
        x: xMM, y: yMM, z, zmin, zmax,
        customdata: raw,
        colorscale: signed ? 'RdBu' : (isH ? 'Viridis' : 'Hot'),
        // Plotly's RdBu runs blue → red with increasing z: positive current (the signal
        // direction) is red, return current blue.
        reversescale: false,
        colorbar,
        hovertemplate: `x: %{x:.4f} mm<br>y: %{y:.4f} mm<br>${qty}: %{customdata:.3e} ${unit}<extra></extra>`,
    }];
    if (isH && nFieldLines > 0 && r.kind === 'wg' && !getArrowOptions().H) {
        // Waveguide: the transverse H is not divergence-free in the cross-section (its
        // sources are ∂Hz/∂z), so it has no potential to draw contours of. Arrows of the
        // instantaneous transverse field instead.
        traces.push(quiverTrace(r, cp, sp, nFieldLines));
    }
    if (isH && nFieldLines > 0 && r.Ar) {
        // H field lines = contour lines of the instantaneous vector potential
        // Re{A·e^(jωt)} (ωt from the phase setting, 0 by default). The levels are spread
        // evenly over the range A takes in the dielectric, so the line density is
        // proportional to |H| and the lines close around each current. Inside the
        // metal only the levels that A reaches there are drawn (the skin layer).
        const A = [];
        let aLo = Infinity, aHi = -Infinity;
        for (let j = 0; j < ny; j++) {
            const row = new Array(nx);
            for (let i = 0; i < nx; i++) {
                const v = r.Ar[j][i] * cp - r.Ai[j][i] * sp;
                if (!Number.isFinite(v)) { row[i] = null; continue; }
                row[i] = v;
                if (!Number.isFinite(r.J[j][i])) {   // dielectric point
                    if (v < aLo) aLo = v;
                    if (v > aHi) aHi = v;
                }
            }
            A.push(row);
        }
        if (aHi > aLo) {
            const step = (aHi - aLo) / (nFieldLines + 1);
            traces.push({
                type: 'contour', x: xMM, y: yMM, z: A,
                contours: { coloring: 'none', showlines: true,
                    start: aLo + step, end: aHi - step * 0.999, size: step },
                line: { smoothing: 1.0, width: 1, color: 'rgba(255, 255, 255, 0.55)' },
                showscale: false, hoverinfo: 'skip',
                name: 'H field lines',
            });
        }
    }
    const per = r.per || (r.differential ? '1 A per trace' : '1 A');
    const modeLabel = r.differential ? (r.mode === 'even' ? ', even mode' : ', odd mode')
        : (r.kind === 'wg' ? `, ${r.mode}` : '');
    const at = opt.instantaneous ? `, ωt = ${opt.phaseDeg}°` : ' (peak)';
    const title = `${qty}${at} for ${per}${modeLabel} · ${formatFreq(r.f)} · δ = ${formatLength(r.delta)}`;
    return { traces, zMin: zmin, zMax: zmax, dataMin, dataMax, title, xMM, yMM };
}

// Get actual data range (before any user scaling)
function getActualDataRange() {
    return { min: actualDataMin, max: actualDataMax };
}

function setScaleRange(min, max) {
    zMin = min;
    zMax = max;

    const container = document.getElementById('sim_canvas');
    const Plotly = getPlotly();
    if (!container || !container.data || !Plotly) return;

    const n = getPlotOptions().contours;

    // The shared log-spaced "E-field contours" line trace appears in BOTH the geometry overlay
    // and the |E| field view — rescale its log levels identically wherever it is.
    const cIdx = container.data.findIndex(t => t.type === 'contour' && t.name === 'E-field contours');
    if (cIdx !== -1 && n > 0) {
        const limits = contourScaledB(min, max, n);
        Plotly.restyle(container, {
            'contours.start': limits[0], 'contours.end': limits[1], 'contours.size': limits[2]
        }, [cIdx]);
    }

    // Field views also carry the color in a heatmap (|E|) or a linear contour (potential) — update
    // its zmin/zmax (and linear levels for the potential contour). The geometry view has no such trace.
    if (currentView !== "geometry") {
        const hIdx = container.data.findIndex(t =>
            t.type === 'heatmap' || (t.type === 'contour' && t.name !== 'E-field contours'));
        if (hIdx !== -1) {
            const restyle = { zmin: min, zmax: max };
            if (container.data[hIdx].type === 'contour' && n > 0) {
                restyle['contours.start'] = min;
                restyle['contours.end'] = max;
                restyle['contours.size'] = (max - min) / n;
            }
            Plotly.restyle(container, restyle, [hIdx]);
        }
    }
}

function draw(resetZoom = false) {
    const solver = get.solver();
    const Plotly = getPlotly();
    if (!solver || !Plotly) return;

    const container = document.getElementById('sim_canvas');
    const plotOptions = getPlotOptions();

    // Preserve current view state if plot exists (unless resetZoom is requested)
    let currentXRange = null;
    let currentYRange = null;
    if (!resetZoom && container && container.layout && container.layout.xaxis) {
        currentXRange = container.layout.xaxis.range;
        currentYRange = container.layout.yaxis.range;
    }

    let zData = [];
    let title = "";
    let colorscale = "Viridis";
    let zTitle = "";
    let shapes = [];
    let xMM, yMM, nx, ny, nyDisplay;
    let mqsView = null;   // set by the H / J views

    // View selection
    if (currentView === "geometry") {
        title = "Transmission Line Geometry";

        // Determine display bounds using actual domain extent
        const maxY = Math.max(
            solver.dielectrics.reduce((max, d) => Math.max(max, d.y_max), 0),
            solver.conductors.reduce((max, c) => Math.max(max, c.y_max), 0)
        );

        // Calculate intelligent zoom ranges for initial view (only if no current view exists)
        if (!currentXRange || resetZoom) {
            const view = computeGeometryView(solver, maxY);
            if (view) { currentXRange = view.xRange; currentYRange = view.yRange; }
        }

        // Dielectrics (opaque, below the field contours) + conductors above.
        shapes.push(...dielectricFillShapes(solver, maxY));
        shapes.push(...conductorFillShapes(solver, maxY));

        // If solution available, overlay E-field contours
        if (solver.solution_valid && solver.mesh_generated) {
            nx = solver.x.length;
            ny = solver.y.length;

            // Limit display Y
            const yArr = Array.from(solver.y);
            const maxYIdx = yArr.findIndex(y => y > maxY);
            nyDisplay = maxYIdx > 0 ? maxYIdx : ny;

            xMM = Array.from(solver.x, v => v * 1000);
            yMM = yArr.slice(0, nyDisplay).map(v => v * 1000);

            // Compute E-field magnitude
            const { Ex, Ey } = getFields();
            if (Ex && Ey && Ex.length >= nyDisplay) {
                for (let i = 0; i < nyDisplay; i++) {
                    const row = [];
                    if (Ex[i] && Ey[i]) {
                        for (let j = 0; j < nx; j++) {
                            row.push(Math.hypot(Ex[i][j], Ey[i][j]));
                        }
                    }
                    zData.push(row);
                }
            }
            if (zData.length > 0) {
                const flatZ = zData.flat();
                zMin = Math.min(...flatZ);
                zMax = Math.max(...flatZ);
                // Store actual data range for geometry view
                actualDataMin = zMin;
                actualDataMax = zMax;
            }
        } else {
            // No solution - just axis scaling
            xMM = [0, solver.w * 2000];
            yMM = [0, maxY * 1000];
        }
    }

    else if ((currentView === "potential" || currentView === "potential_odd" || currentView === "potential_even") && solver.solution_valid) {
        // Ensure mesh exists for field visualization
        if (!solver.mesh_generated) {
            solver.ensure_mesh();
        }

        nx = solver.x.length;
        ny = solver.y.length;

        // Limit display Y to domain extent
        const yArr = Array.from(solver.y);
        const maxY = yArr[ny - 1];
        const maxYIdx = yArr.findIndex(y => y > maxY);
        nyDisplay = maxYIdx > 0 ? maxYIdx : ny;

        xMM = Array.from(solver.x, v => v * 1000);
        yMM = yArr.slice(0, nyDisplay).map(v => v * 1000);

        let modeLabel = "";
        if (currentView === "potential_odd") {
            modeLabel = " (Odd Mode)";
        } else if (currentView === "potential_even") {
            modeLabel = " (Even Mode)";
        }
        title = `Electric Potential${modeLabel} (V)`;
        zTitle = "Volts";

        const V = getPotential();
        if (V && V.length >= nyDisplay) {
            for (let i = 0; i < nyDisplay; i++) {
                zData.push(Array.from(V[i].slice(0, nx)));
            }
        }
        const flatZ = zData.flat();
        zMin = Math.min(...flatZ);
        zMax = Math.max(...flatZ);
        // Store actual data range for potential view
        actualDataMin = zMin;
        actualDataMax = zMax;
    }

    else if ((currentView === "efield" || currentView === "efield_odd" || currentView === "efield_even") && solver.solution_valid) {
        // Ensure mesh exists for field visualization
        if (!solver.mesh_generated) {
            solver.ensure_mesh();
        }

        nx = solver.x.length;
        ny = solver.y.length;

        // Limit display Y to actual domain extent
        const yArr = Array.from(solver.y);
        const maxY = yArr[ny - 1];
        const maxYIdx = yArr.findIndex(y => y > maxY);
        nyDisplay = maxYIdx > 0 ? maxYIdx : ny;

        xMM = Array.from(solver.x, v => v * 1000);
        yMM = yArr.slice(0, nyDisplay).map(v => v * 1000);

        let modeLabel = "";
        if (currentView === "efield_odd") {
            modeLabel = " (Odd Mode)";
        } else if (currentView === "efield_even") {
            modeLabel = " (Even Mode)";
        }
        title = `|E| Field Magnitude${modeLabel} (V/m)`;
        zTitle = "V/m";

        const { Ex, Ey } = getFields();
        if (Ex && Ey && Ex.length >= nyDisplay) {
            for (let i = 0; i < nyDisplay; i++) {
                const row = [];
                if (Ex[i] && Ey[i]) {
                    for (let j = 0; j < nx; j++) {
                        row.push(Math.hypot(Ex[i][j], Ey[i][j]));
                    }
                }
                zData.push(row);
            }
        }
        const flatZ = zData.flat();
        zMin = Math.min(...flatZ);
        zMax = Math.max(...flatZ);
        // Store actual data range for efield view
        actualDataMin = zMin;
        actualDataMax = zMax;
        // Mask the conductor interior (field is 0 inside the PEC) so the heatmap/contour bleed
        // across the boundary is hidden, like the geometry view.
        shapes.push(...conductorFillShapes(solver, yArr[nyDisplay - 1]));
    }

    else if ((currentView === "hfield" || currentView === "jfield" || currentView === "sfield") && solver.solution_valid) {
        const isH = currentView === "hfield";
        const isS = currentView === "sfield";
        const key = mqsKey();
        const yArr = Array.from(solver.y || []);
        xMM = Array.from(solver.x || [0, 1e-3], v => v * 1000);
        yMM = yArr.map(v => v * 1000);
        const maxY = yArr.length ? yArr[yArr.length - 1] : 0;
        if (!mqsField || mqsField.key !== key) {
            title = `Computing ${isS ? 'power flow' : (isH ? 'H field' : 'current density')} at ${formatFreq(fieldPlotFreq())}…`;
            if (mqsPending !== key && window.requestMqsField) {
                mqsPending = key;
                window.requestMqsField(mqsModeIndex(), fieldPlotFreq(), key);
            }
        } else if (!mqsField.ok) {
            title = `${isS ? 'Power flow' : (isH ? 'H field' : 'Current density')} not available (see log)`;
        } else {
            // Field lines in the H view: the Streamlines count, 20 when left empty
            // (an explicit 0 turns them off).
            const slRaw = (document.getElementById('plot-streamlines')?.value || '').trim();
            const nLines = slRaw === '' ? 20 : Math.max(0, parseInt(slRaw) || 0);
            mqsView = isS ? buildPowerTraces(mqsField, solver, currentView)
                : mqsField.kind === 'radial'
                ? buildCoaxTraces(mqsField, isH, currentView, nLines)
                : buildMqsTraces(mqsField, isH, currentView, nLines);
            if (!mqsView) title = 'Power flow not available (no E field)';
            title = mqsView.title;
            xMM = mqsView.xMM; yMM = mqsView.yMM;
            zMin = mqsView.zMin; zMax = mqsView.zMax;
            actualDataMin = mqsView.dataMin; actualDataMax = mqsView.dataMax;
        }
        if (mqsView && mqsView.shapes) shapes.push(...mqsView.shapes);
        shapes.push(...outlineShapes(solver, maxY));
    }

    else {
        title = "No Data Available";
        // Create minimal dummy data
        xMM = [0, (solver.w || 1) * 2000];
        yMM = [0, (solver.h || 1) * 1000];
    }

    // Save original mesh coordinates for mesh overlay before interpolation
    let xMM_mesh = xMM;
    let yMM_mesh = yMM;
    let nx_mesh = nx;
    let nyDisplay_mesh = nyDisplay;

    // Main field trace
    let traces = [];

    if (currentView === "geometry" && zData.length > 0) {
        const { Ex, Ey } = getFields();

        let eMax = Math.max(...zData.flat());
        let eMin = Math.min(...zData.flat());

        // Check if there's a user-defined scale override
        if (window.getStoredScale) {
            const override = window.getStoredScale(currentView);
            if (override) {
                eMin = override.min;
                eMax = override.max;
            }
        }

        const n = plotOptions.contours;

        // Add E-field contours if requested (shared with the |E| field view)
        if (n > 0) {
            traces.push(efieldContourTrace(xMM, yMM, zData, eMin, eMax, n));
        }

        // Add streamlines if requested via plot options
        if (plotOptions.streamlines > 0) {
            const modeIndex = getSelectedModeIndex();
            const mode = modeIndex === 1 ? 'even' : 'odd';

            traces.push(
                makeStreamlineTraceFromConductors(
                    Ex,
                    Ey,
                    solver.x,
                    solver.y,
                    solver.conductors,
                    plotOptions.streamlines,
                    mode
                )
            );
        }

    } else if (currentView === "geometry") {
        // Geometry only. Invisible scatter for axis scaling
        traces.push({
            type: "scatter",
            x: xMM,
            y: yMM,
            mode: "markers",
            marker: { size: 0, opacity: 0 },
            showlegend: false,
            hoverinfo: "skip"
        });
    } else if (mqsView) {
        traces.push(...mqsView.traces);
    } else if (currentView === "hfield" || currentView === "jfield" || currentView === "sfield") {
        // Waiting for (or missing) H / J data: invisible scatter keeps the axes.
        traces.push({
            type: "scatter", x: xMM, y: yMM, mode: "markers",
            marker: { size: 0, opacity: 0 }, showlegend: false, hoverinfo: "skip"
        });
    } else if (zData.length > 0) {
        // Field views. Heatmap with optional contour lines.

        // Check if there's a user-defined scale override
        if (window.getStoredScale) {
            const override = window.getStoredScale(currentView);
            if (override) {
                zMin = override.min;
                zMax = override.max;
            }
        }

        const n = plotOptions.contours;
        const hoverTpl = "x: %{x:.2f} mm<br>y: %{y:.2f} mm<br>value: %{z:.3e}<extra></extra>";

        if (currentView.startsWith("efield")) {
            // |E| heatmap (linear) for the color + colorbar...
            traces.push({
                type: "heatmap",
                zsmooth: "best",
                x: xMM, y: yMM, z: zData,
                zmin: zMin, zmax: zMax,
                colorscale: colorscale,
                colorbar: { title: zTitle, len: 0.8 },
                hovertemplate: hoverTpl
            });
            // ...overlaid with the SAME log-spaced contour-line trace the geometry view uses.
            if (n > 0) {
                traces.push(efieldContourTrace(xMM, yMM, zData, Math.max(zMin, 0), zMax, n));
            }
        } else {
            // Potential (and any other field view): linear heatmap + linear contour lines.
            const contourSettings = { coloring: 'heatmap', showlines: n > 0 };
            if (n > 0) {
                contourSettings.start = zMin;
                contourSettings.end = zMax;
                contourSettings.size = (zMax - zMin) / n;
            }
            traces.push({
                type: n > 0 ? "contour" : "heatmap",
                zsmooth: "best",
                x: xMM, y: yMM, z: zData,
                zmin: zMin, zmax: zMax,
                colorscale: colorscale,
                contours: contourSettings,
                line: { smoothing: 1.3, width: 0.5 },
                colorbar: { title: zTitle, len: 0.8 },
                hovertemplate: hoverTpl
            });
        }
    }

    // E / H arrows (filled by updateArrows once the axis ranges are known).
    const arrowTr = solver.solution_valid ? arrowPlaceholders() : [];
    if (arrowTr.length) {
        for (const t of traces) if (t.showlegend === undefined) t.showlegend = false;
        traces.push(...arrowTr);
    }

    // Mesh overlay
    // The H / J views were computed on the skin-refined eddy-current mesh, show that one.
    const overlayMesh = (mqsView && mqsField && mqsField.triMesh) ? mqsField.triMesh : solver.triMesh;
    if (showMesh && solver.solution_valid && overlayMesh) {
        // Triangular backend: draw triangle edges (deduped) as one batched trace.
        const { nodes, tris, nTris } = overlayMesh;
        const seen = new Set();
        const ex = [], ey = [];
        const nNodesTri = nodes.length / 2;
        const addEdge = (a, b) => {
            const n0 = a < b ? a : b, n1 = a < b ? b : a;
            const key = n0 * (nNodesTri + 1) + n1;
            if (seen.has(key)) return;
            seen.add(key);
            ex.push(nodes[2 * n0] * 1000, nodes[2 * n1] * 1000, null);
            ey.push(nodes[2 * n0 + 1] * 1000, nodes[2 * n1 + 1] * 1000, null);
        };
        for (let t = 0; t < nTris; t++) {
            const v0 = tris[3 * t], v1 = tris[3 * t + 1], v2 = tris[3 * t + 2];
            addEdge(v0, v1); addEdge(v1, v2); addEdge(v2, v0);
        }
        traces.push({
            type: "scattergl", x: ex, y: ey, mode: "lines",
            line: { width: 0.3, color: "rgba(0,0,0,0.5)" },
            showlegend: false, hoverinfo: "skip"
        });
    } else if (showMesh && solver.solution_valid) {
        const stepX = 1;
        const stepY = 1;

        // Use original mesh coordinates (before interpolation)
        for (let j = 0; j < nx_mesh; j += stepX) {
            traces.push({
                type: "scatter",
                x: [xMM_mesh[j], xMM_mesh[j]],
                y: [yMM_mesh[0], yMM_mesh[nyDisplay_mesh - 1]],
                mode: "lines",
                line: { width: 0.2, color: "black" },
                showlegend: false,
                hoverinfo: "skip"
            });
        }

        for (let i = 0; i < nyDisplay_mesh; i += stepY) {
            traces.push({
                type: "scatter",
                x: [xMM_mesh[0], xMM_mesh[nx_mesh - 1]],
                y: [yMM_mesh[i], yMM_mesh[i]],
                mode: "lines",
                line: { width: 0.2, color: "black" },
                showlegend: false,
                hoverinfo: "skip"
            });
        }
    }

    // UI menues
    const layout = {
        title: { text: title, font: { color: '#fff' } },
        xaxis: {
            title: { text: "Width (mm)", font: { color: '#aaa' } },
            scaleanchor: "y",
            scaleratio: 1,
            range: currentXRange,  // Preserve zoom/pan
            color: '#aaa',
            gridcolor: '#444',
            zerolinecolor: '#555'
        },
        yaxis: {
            title: { text: "Height (mm)", font: { color: '#aaa' } },
            range: currentYRange,  // Preserve zoom/pan
            color: '#aaa',
            gridcolor: '#444',
            zerolinecolor: '#555'
        },
        margin: { l: 70, r: 90, t: 50, b: 60 },
        showlegend: arrowTr.length > 0,
        legend: { x: 0.01, y: 0.99, xanchor: 'left', yanchor: 'top', bgcolor: 'rgba(30,30,30,0.7)',
                  bordercolor: '#555', borderwidth: 1, font: { color: '#ddd', size: 11 } },
        hovermode: "closest",
        dragmode: "pan",
        paper_bgcolor: '#2a2a2a',
        plot_bgcolor: '#1a1a1a',
        font: { color: '#fff' },
        shapes: shapes,  // Add vector shapes for geometry

        updatemenus: (() => {
            const menus = [];

            // View selector (Geometry/Potential/E-field)
            const viewButtons = [{ label: "Geometry", method: "skip", args: [] }];
            if (solver.solution_valid) {
                // A source-free medium (rectangular waveguide) has no static potential to
                // show, its field is the mode field, so the Potential button is omitted
                // rather than left to render a blank heatmap.
                if (solver.has_potential !== false) {
                    viewButtons.push({ label: "Potential", method: "skip", args: [] });
                }
                viewButtons.push({ label: "|E| Field", method: "skip", args: [] });
                // H field and current density (on demand: eddy-current solve, or the
                // closed form for coax and waveguide).
                viewButtons.push({ label: "|H| Field", method: "skip", args: [] });
                viewButtons.push({ label: "Current J", method: "skip", args: [] });
                viewButtons.push({ label: "Power flow S", method: "skip", args: [] });
            }
            // Both the highlighted button and the click handler key off the LABEL, never a
            // fixed index, with Potential absent, "|E| Field" is at index 1, not 2.
            // Prefix match so the differential "_odd"/"_even" view variants land on their
            // own button rather than falling through to the first one.
            const activeLabel = currentView.startsWith("geometry") ? "Geometry"
                : currentView.startsWith("potential") ? "Potential"
                : currentView === "hfield" ? "|H| Field"
                : currentView === "jfield" ? "Current J"
                : currentView === "sfield" ? "Power flow S" : "|E| Field";
            menus.push({
                x: 0.01,
                y: 1.15,
                showactive: true,
                active: Math.max(0, viewButtons.findIndex(b => b.label === activeLabel)),
                bgcolor: '#2a2a2a',
                bordercolor: '#444',
                font: { color: '#aaa' },
                buttons: viewButtons
            });

            // Mode selector (Odd/Even) - only for differential lines
            if (isDifferentialMode()) {
                const modeIndex = getSelectedModeIndex();
                menus.push({
                    x: 0.25,
                    y: 1.15,
                    showactive: true,
                    active: modeIndex,
                    bgcolor: '#2a2a2a',
                    bordercolor: '#444',
                    font: { color: '#aaa' },
                    buttons: [
                        {
                            label: "Odd Mode",
                            method: "skip",
                            args: []
                        },
                        {
                            label: "Even Mode",
                            method: "skip",
                            args: []
                        }
                    ]
                });
            }

            return menus;
        })()
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        scrollZoom: true,
        modeBarButtonsToAdd: [
            {
                name: "Toggle Mesh",
                icon: Plotly.Icons.grid,
                click: () => {
                    showMesh = !showMesh;
                    draw();
                }
            },
            {
                name: "Scale Range",
                icon: Plotly.Icons.autoscale,
                click: () => window.toggleScaleDialog && window.toggleScaleDialog()
            }
        ]
    };

    Plotly.react(container, traces, layout, config);
    if (arrowTr.length) updateArrows();
    if (!container._arrowListenerBound) {
        container.on('plotly_relayout', (ev) => {
            if (ev && Object.keys(ev).some(k => k.startsWith('xaxis') || k.startsWith('yaxis'))) updateArrows();
        });
        container._arrowListenerBound = true;
    }

    if (!container._viewListenerBound) {
        container.on('plotly_buttonclicked', (event) => {
            // Determine which menu was clicked based on x position
            // First menu (x=0.01): View selector (Geometry/Potential/E-field)
            // Second menu (x=0.25): Mode selector (Odd/Even) - only for differential

            if (event.menu.x < 0.2) {
                // View selector clicked. Key off the LABEL, not the index: the Potential
                // button is absent for a source-free medium (see the button list above),
                // so index 1 is not always "potential".
                const btn = event.menu.buttons[event.menu.active];
                const label = btn && btn.label;
                setCurrentView(label === "Geometry" ? "geometry"
                    : label === "Potential" ? "potential"
                    : label === "|H| Field" ? "hfield"
                    : label === "Current J" ? "jfield"
                    : label === "Power flow S" ? "sfield" : "efield");
            } else {
                // Mode selector clicked (differential lines only)
                const plotModeEl = document.getElementById('plot-mode');
                if (plotModeEl) {
                    plotModeEl.value = event.menu.active === 0 ? 'odd' : 'even';
                }
                // Trigger view change notification for mode switch
                if (window.onViewChanged) {
                    window.onViewChanged(currentView);
                }
            }
            draw();
        });
        container._viewListenerBound = true;
    }

    // Listen for autoscale events to reset color scale
    if (!container._autoscaleListenerBound) {
        let ignoreNextAutoscale = false;

        // Track double-clicks to distinguish from autoscale button
        container.on('plotly_doubleclick', () => {
            ignoreNextAutoscale = true;
            // Clear the flag after a short delay in case the autoscale event doesn't fire
            setTimeout(() => {
                ignoreNextAutoscale = false;
            }, 200);
        });

        // Handle autoscale button click
        container.on('plotly_relayout', (eventData) => {
            // Check if this is an autoscale event (both axes autoscaling)
            if (eventData && eventData['xaxis.autorange'] === true && eventData['yaxis.autorange'] === true) {
                // Only reset color scale if this is from the autoscale button, not double-click
                if (!ignoreNextAutoscale && window.resetColorScale) {
                    window.resetColorScale();
                }
                ignoreNextAutoscale = false;
            }
        });

        container._autoscaleListenerBound = true;
    }

}

function getYAxisLabel(selector) {
    const labels = {
        're_z0': 'Re(Z0) (Ohm)',
        'im_z0': 'Im(Z0) (Ohm)',
        'eps_eff': 'Effective permittivity',
        'loss': 'Loss (dB/m)',
        'R': 'R (Ohm/m)',
        'L': 'L (H/m)',
        'C': 'C (F/m)',
        'G': 'G (S/m)'
    };
    return labels[selector] || selector;
}

/**
 * Extract a single value from a mode result for a given selector and scaling.
 * Used by both frequency sweep results and parameter sweep plots.
 */
function extractModeValue(mode, selector, scale) {
    switch (selector) {
        case 're_z0':   return scale * mode.Zc.re;
        case 'im_z0':   return scale * mode.Zc.im;
        case 'eps_eff': return mode.eps_eff;
        case 'loss':    return mode.alpha_total;
        default:        return scale * mode.RLGC[selector];
    }
}

function buildResultsTraces(sweepResults, selector, useDiffMode) {
    const resultsAreDifferential = sweepResults[0].result.modes.length === 2;
    const freqs = sweepResults.map(r => r.freq / 1e9);
    const plotMode = freqs.length === 1 ? 'markers' : 'lines+markers';
    const traces = [];

    // Mode labels
    const mode0 = useDiffMode ? 'Differential' : 'Odd';
    const mode1 = useDiffMode ? 'Common' : 'Even';

    if (selector === 'loss') {
        if (resultsAreDifferential) {
            const suffix0 = useDiffMode ? 'diff' : 'odd';
            const suffix1 = useDiffMode ? 'common' : 'even';
            // Mode 0 losses (solid lines)
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[0].alpha_c),
                name: `Conductor (${suffix0})`, type: 'scatter', mode: plotMode
            });
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[0].alpha_d),
                name: `Dielectric (${suffix0})`, type: 'scatter', mode: plotMode
            });
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[0].alpha_total),
                name: `Total (${suffix0})`, type: 'scatter', mode: plotMode,
                line: { width: 2 }
            });
            // Mode 1 losses (dashed lines)
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[1].alpha_c),
                name: `Conductor (${suffix1})`, type: 'scatter', mode: plotMode,
                line: { dash: 'dash' }
            });
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[1].alpha_d),
                name: `Dielectric (${suffix1})`, type: 'scatter', mode: plotMode,
                line: { dash: 'dash' }
            });
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[1].alpha_total),
                name: `Total (${suffix1})`, type: 'scatter', mode: plotMode,
                line: { width: 2, dash: 'dash' }
            });
        } else {
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[0].alpha_c),
                name: 'Conductor', type: 'scatter', mode: plotMode
            });
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[0].alpha_d),
                name: 'Dielectric', type: 'scatter', mode: plotMode
            });
            traces.push({
                x: freqs,
                y: sweepResults.map(r => r.result.modes[0].alpha_total),
                name: 'Total', type: 'scatter', mode: plotMode,
                line: { width: 2 }
            });
        }
    } else {
        // Z0, eps_eff, RLGC parameters
        const scale0 = useDiffMode ? 2 : 1;
        const scale1 = useDiffMode ? 0.5 : 1;
        if (resultsAreDifferential) {
            traces.push({
                x: freqs,
                y: sweepResults.map(r => extractModeValue(r.result.modes[0], selector, scale0)),
                name: `${mode0} mode`, type: 'scatter', mode: plotMode
            });
            traces.push({
                x: freqs,
                y: sweepResults.map(r => extractModeValue(r.result.modes[1], selector, scale1)),
                name: `${mode1} mode`, type: 'scatter', mode: plotMode
            });
        } else {
            traces.push({
                x: freqs,
                y: sweepResults.map(r => extractModeValue(r.result.modes[0], selector, 1)),
                name: getYAxisLabel(selector), type: 'scatter', mode: plotMode
            });
        }
    }

    return traces;
}

function drawResultsPlot() {
    const frequencySweepResults = get.frequencySweepResults();
    const Plotly = getPlotly();
    if (!frequencySweepResults || frequencySweepResults.length === 0 || !Plotly) return;

    const selector = document.getElementById('results-plot-selector').value;
    const resultsAreDifferential = frequencySweepResults[0].result.modes.length === 2;
    const useDiffMode = document.getElementById('results-diff').checked && resultsAreDifferential;

    const activeTraces = buildResultsTraces(frequencySweepResults, selector, useDiffMode);

    // Assign explicit colors and legend groups so frozen traces don't shift the color cycle
    for (let i = 0; i < activeTraces.length; i++) {
        const color = PLOTLY_COLORS[i % PLOTLY_COLORS.length];
        activeTraces[i].line = { ...activeTraces[i].line, color };
        activeTraces[i].marker = { color };
        activeTraces[i].legendgroup = `group${i}`;
    }

    const allTraces = [];

    if (frozenResultsData) {
        const frozenDiff = frozenResultsData[0].result.modes.length === 2;
        const frozenUseDiff = document.getElementById('results-diff').checked && frozenDiff;
        const frozen = buildResultsTraces(frozenResultsData, selector, frozenUseDiff);
        for (let i = 0; i < frozen.length; i++) {
            const color = PLOTLY_COLORS[i % PLOTLY_COLORS.length];
            frozen[i].line = { color };
            frozen[i].opacity = 0.35;
            frozen[i].showlegend = false;
            frozen[i].hoverinfo = 'skip';
            frozen[i].mode = 'lines';
            frozen[i].legendgroup = `group${i}`;
        }
        allTraces.push(...frozen);
    }

    allTraces.push(...activeTraces);

    const useLogX = document.getElementById('results-log-x').checked;
    const layout = {
        xaxis: {
            title: { text: 'Frequency (GHz)', font: { color: '#aaa' } },
            type: useLogX ? 'log' : 'linear',
            color: '#aaa',
            gridcolor: '#444',
            zerolinecolor: '#555'
        },
        yaxis: {
            title: { text: getYAxisLabel(selector), font: { color: '#aaa' } },
            color: '#aaa',
            gridcolor: '#444',
            zerolinecolor: '#555'
        },
        margin: { l: 80, r: 40, t: 40, b: 60 },
        showlegend: true,
        legend: { x: 0.02, y: 0.98, font: { color: '#fff' } },
        paper_bgcolor: '#2a2a2a',
        plot_bgcolor: '#1a1a1a',
        font: { color: '#fff' }
    };

    Plotly.newPlot('results-plot', allTraces, layout, { responsive: true });
}

function buildSParamTraces(sweepResults, length, Z_ref, plotMode, useMixedMode) {
    // A self-referenced medium (waveguide) drops its below-cutoff points and normalizes
    // each remaining one to its own modal impedance; every other medium passes through.
    sweepResults = usableSweepPoints(sweepResults);
    if (!sweepResults.length) return [];
    const resultsAreDifferential = sweepResults[0].result.modes.length === 2;
    const freqs = sweepResults.map(r => r.freq / 1e9);
    const lineMode = freqs.length === 1 ? 'markers' : 'lines+markers';
    const traces = [];

    const sParamToPhase = (complexVal) => complexVal.arg() * 180 / Math.PI;

    if (!resultsAreDifferential) {
        const S11_data = [];
        const S21_data = [];

        for (const { freq, result } of sweepResults) {
            const sp = sparamsForPoint(freq, result, length, Z_ref);
            if (plotMode === 'magnitude') {
                S11_data.push(sParamTodB(sp.S11));
                S21_data.push(sParamTodB(sp.S21));
            } else {
                S11_data.push(sParamToPhase(sp.S11));
                S21_data.push(sParamToPhase(sp.S21));
            }
        }

        const label = plotMode === 'magnitude' ? '(dB)' : '(deg)';
        traces.push({ x: freqs, y: S11_data, name: `S11 ${label}`, type: 'scatter', mode: lineMode });
        traces.push({ x: freqs, y: S21_data, name: `S21 ${label}`, type: 'scatter', mode: lineMode });
    } else if (useMixedMode) {
        // An asymmetric pair converts between differential and common mode: SDC/SCD are non-zero
        // (zero for a symmetric line). Plot those terms when physMatrix is present so the mixed-mode
        // signature of the asymmetry is visible, not just the pure SDD/SCC responses.
        const isAsymmetric = sweepResults.some(({ result }) => result.physMatrix);
        const SDD11_data = [], SDD21_data = [], SCC11_data = [], SCC21_data = [];
        const SDC11_data = [], SCD11_data = [];
        const conv = plotMode === 'magnitude' ? sParamTodB : sParamToPhase;

        for (const { freq, result } of sweepResults) {
            const oddMode = result.modes.find(m => m.mode === 'odd');
            const evenMode = result.modes.find(m => m.mode === 'even');
            const sp = computeSParamsDiffAuto(freq, oddMode.RLGC, evenMode.RLGC, result.physMatrix, length, Z_ref);

            SDD11_data.push(conv(sp.SDD11));
            SDD21_data.push(conv(sp.SDD21));
            SCC11_data.push(conv(sp.SCC11));
            SCC21_data.push(conv(sp.SCC21));
            if (isAsymmetric) {
                SDC11_data.push(conv(sp.SDC11));   // common→differential conversion (reflection)
                SCD11_data.push(conv(sp.SCD11));   // differential→common conversion (reflection)
            }
        }

        const label = plotMode === 'magnitude' ? '(dB)' : '(deg)';
        traces.push({ x: freqs, y: SDD11_data, name: `SDD11 ${label}`, type: 'scatter', mode: lineMode });
        traces.push({ x: freqs, y: SDD21_data, name: `SDD21 ${label}`, type: 'scatter', mode: lineMode });
        traces.push({ x: freqs, y: SCC11_data, name: `SCC11 ${label}`, type: 'scatter', mode: lineMode, line: { dash: 'dash' } });
        traces.push({ x: freqs, y: SCC21_data, name: `SCC21 ${label}`, type: 'scatter', mode: lineMode, line: { dash: 'dash' } });
        if (isAsymmetric) {
            traces.push({ x: freqs, y: SDC11_data, name: `SDC11 ${label}`, type: 'scatter', mode: lineMode, line: { dash: 'dot' } });
            traces.push({ x: freqs, y: SCD11_data, name: `SCD11 ${label}`, type: 'scatter', mode: lineMode, line: { dash: 'dot' } });
        }
    } else {
        // An asymmetric coupled pair (physMatrix present) has a non-degenerate second column:
        // S22≠S11, S32≠S41, S42≠S31. Plot those extra terms so the asymmetry is visible.
        const isAsymmetric = sweepResults.some(({ result }) => result.physMatrix);

        const S11_data = [], S21_data = [], S31_data = [], S41_data = [];
        const S22_data = [], S32_data = [], S42_data = [];
        const conv = plotMode === 'magnitude' ? sParamTodB : sParamToPhase;

        for (const { freq, result } of sweepResults) {
            const oddMode = result.modes.find(m => m.mode === 'odd');
            const evenMode = result.modes.find(m => m.mode === 'even');
            const sp = computeSParamsDiffAuto(freq, oddMode.RLGC, evenMode.RLGC, result.physMatrix, length, Z_ref);

            S11_data.push(conv(sp.S[0][0]));
            S21_data.push(conv(sp.S[1][0]));
            S31_data.push(conv(sp.S[2][0]));
            S41_data.push(conv(sp.S[3][0]));
            if (isAsymmetric) {
                S22_data.push(conv(sp.S[1][1]));
                S32_data.push(conv(sp.S[2][1]));
                S42_data.push(conv(sp.S[3][1]));
            }
        }

        const label = plotMode === 'magnitude' ? '(dB)' : '(deg)';
        traces.push({ x: freqs, y: S11_data, name: `S11 ${label}`, type: 'scatter', mode: lineMode });
        traces.push({ x: freqs, y: S21_data, name: `S21 ${label}`, type: 'scatter', mode: lineMode });
        traces.push({ x: freqs, y: S31_data, name: `S31 ${label}`, type: 'scatter', mode: lineMode });
        traces.push({ x: freqs, y: S41_data, name: `S41 ${label}`, type: 'scatter', mode: lineMode, line: { dash: 'dash' } });
        if (isAsymmetric) {
            traces.push({ x: freqs, y: S22_data, name: `S22 ${label}`, type: 'scatter', mode: lineMode, line: { dash: 'dot' } });
            traces.push({ x: freqs, y: S32_data, name: `S32 ${label}`, type: 'scatter', mode: lineMode, line: { dash: 'dot' } });
            traces.push({ x: freqs, y: S42_data, name: `S42 ${label}`, type: 'scatter', mode: lineMode, line: { dash: 'dot' } });
        }
    }

    return traces;
}

function drawSParamPlot() {
    const frequencySweepResults = get.frequencySweepResults();
    const Plotly = getPlotly();
    if (!frequencySweepResults || frequencySweepResults.length === 0 || !Plotly) return;

    const length = get.inputValue('sparam-length');
    const Z_ref = parseFloat(document.getElementById('sparam-z-ref').value);
    const useMixedMode = document.getElementById('sparam-diff').checked;

    // A self-referenced medium ignores the reference-impedance box entirely (the UI hides
    // it and shows "Z0" instead), so it must not gate on parsing that field.
    const selfRef = isSelfReferenced(frequencySweepResults);
    if (isNaN(length) || length <= 0 || (!selfRef && (isNaN(Z_ref) || Z_ref <= 0))) {
        return;
    }

    const plotMode = document.getElementById('sparam-plot-mode').value;

    const activeTraces = buildSParamTraces(frequencySweepResults, length, Z_ref, plotMode, useMixedMode);

    // Assign explicit colors and legend groups so frozen traces don't shift the color cycle
    for (let i = 0; i < activeTraces.length; i++) {
        const color = PLOTLY_COLORS[i % PLOTLY_COLORS.length];
        activeTraces[i].line = { ...activeTraces[i].line, color };
        activeTraces[i].marker = { color };
        activeTraces[i].legendgroup = `group${i}`;
    }

    const allTraces = [];

    if (frozenSParamData) {
        const frozen = buildSParamTraces(
            frozenSParamData.results, frozenSParamData.length,
            frozenSParamData.zRef, plotMode, useMixedMode
        );
        for (let i = 0; i < frozen.length; i++) {
            const color = PLOTLY_COLORS[i % PLOTLY_COLORS.length];
            frozen[i].line = { color };
            frozen[i].opacity = 0.35;
            frozen[i].showlegend = false;
            frozen[i].hoverinfo = 'skip';
            frozen[i].mode = 'lines';
            frozen[i].legendgroup = `group${i}`;
        }
        allTraces.push(...frozen);
    }

    allTraces.push(...activeTraces);

    const useLogX = document.getElementById('sparam-log-x').checked;
    const yTitle = plotMode === 'magnitude' ? 'Magnitude (dB)' : 'Phase (degrees)';
    const layout = {
        xaxis: {
            title: { text: 'Frequency (GHz)', font: { color: '#aaa' } },
            type: useLogX ? 'log' : 'linear',
            color: '#aaa',
            gridcolor: '#444',
            zerolinecolor: '#555'
        },
        yaxis: {
            title: { text: yTitle, font: { color: '#aaa' } },
            color: '#aaa',
            gridcolor: '#444',
            zerolinecolor: '#555'
        },
        margin: { l: 80, r: 40, t: 40, b: 60 },
        showlegend: true,
        legend: { x: 0.02, y: 0.02, font: { color: '#fff' } },
        paper_bgcolor: '#2a2a2a',
        plot_bgcolor: '#1a1a1a',
        font: { color: '#fff' }
    };

    Plotly.newPlot('sparam-plot', allTraces, layout, { responsive: true });
}

function drawParameterSweepPlot(sweepData, xLabel, ySelector, useDiffMode) {
    const Plotly = getPlotly();
    if (!sweepData || sweepData.length === 0 || !Plotly) return;
    const xVals = sweepData.map(d => d.paramValue);
    const isDiff = sweepData[0].result.modes.length === 2;

    const name0 = !isDiff ? getYAxisLabel(ySelector) : (useDiffMode ? 'Differential' : 'Odd');
    const name1 = useDiffMode ? 'Common' : 'Even';
    const scale0 = isDiff && useDiffMode ? 2 : 1;
    const scale1 = isDiff && useDiffMode ? 0.5 : 1;

    const yVals0 = sweepData.map(d => extractModeValue(d.result.modes[0], ySelector, scale0));
    const yVals1 = isDiff ? sweepData.map(d => extractModeValue(d.result.modes[1], ySelector, scale1)) : null;

    const traces = [];

    if (xVals.length >= 2) {
        // Dense interpolated traces for hover-anywhere-on-line capability
        const interpPts = 500;
        const addInterpTrace = (xArr, yArr, name, color) => {
            const xInterp = [];
            const yInterp = [];
            for (let i = 0; i < xArr.length - 1; i++) {
                const nSeg = Math.max(2, Math.round(interpPts / (xArr.length - 1)));
                for (let j = 0; j < nSeg; j++) {
                    const t = j / nSeg;
                    xInterp.push(xArr[i] + t * (xArr[i + 1] - xArr[i]));
                    yInterp.push(yArr[i] + t * (yArr[i + 1] - yArr[i]));
                }
            }
            // Add final point
            xInterp.push(xArr[xArr.length - 1]);
            yInterp.push(yArr[yArr.length - 1]);

            // Interpolated line trace (hoverable, no visible markers)
            traces.push({
                x: xInterp, y: yInterp,
                name, type: 'scatter', mode: 'lines',
                line: { color, width: 2 },
                hoverinfo: 'x+y+name',
                showlegend: false
            });
            // Markers at actual computed points
            traces.push({
                x: xArr, y: yArr,
                name, type: 'scatter', mode: 'markers',
                marker: { color, size: 7 },
                hoverinfo: 'x+y+name',
                legendgroup: name,
                showlegend: true
            });
        };

        addInterpTrace(xVals, yVals0, name0, PLOTLY_COLORS[0]);
        if (isDiff) addInterpTrace(xVals, yVals1, name1, PLOTLY_COLORS[1]);
    } else {
        // Single point - just markers
        traces.push({ x: xVals, y: yVals0,
            name: name0, type: 'scatter', mode: 'markers',
            marker: { color: PLOTLY_COLORS[0] } });
        if (isDiff) {
            traces.push({ x: xVals, y: yVals1,
                name: name1, type: 'scatter', mode: 'markers',
                marker: { color: PLOTLY_COLORS[1] } });
        }
    }

    const layout = {
        xaxis: { title: { text: xLabel, font: { color: '#aaa' } }, color: '#aaa', gridcolor: '#444', zerolinecolor: '#555' },
        yaxis: { title: { text: getYAxisLabel(ySelector), font: { color: '#aaa' } }, color: '#aaa', gridcolor: '#444', zerolinecolor: '#555' },
        margin: { l: 80, r: 40, t: 40, b: 60 },
        hovermode: 'closest',
        showlegend: isDiff,
        legend: { x: 0.02, y: 0.98, font: { color: '#fff' } },
        paper_bgcolor: '#2a2a2a', plot_bgcolor: '#1a1a1a', font: { color: '#fff' }
    };
    Plotly.newPlot('sweep-plot', traces, layout, { responsive: true });
}

// Helper function to check if solver is in differential mode
function isDifferentialMode() {
    const solver = get.solver();
    if (!solver || !solver.Ex || !solver.Ey) return false;
    // In differential mode, Ex and Ey are arrays of 2 arrays (odd and even modes)
    // Check if Ex[0] and Ex[1] are both arrays
    return Array.isArray(solver.Ex) &&
           solver.Ex.length === 2 &&
           Array.isArray(solver.Ex[0]) &&
           Array.isArray(solver.Ex[1]);
}

// Get the selected mode index from sidebar (0=odd, 1=even)
function getSelectedModeIndex() {
    const modeSelect = document.getElementById('plot-mode');
    return modeSelect && modeSelect.value === 'even' ? 1 : 0;
}

// Helper function to get Ex/Ey fields (handles differential mode)
function getFields() {
    const solver = get.solver();
    if (!solver || !solver.Ex || !solver.Ey) {
        return { Ex: null, Ey: null };
    }

    if (isDifferentialMode()) {
        const modeIndex = getSelectedModeIndex();
        return { Ex: solver.Ex[modeIndex], Ey: solver.Ey[modeIndex] };
    } else {
        // Single-ended mode
        return { Ex: solver.Ex[0], Ey: solver.Ey[0] };
    }
}

// Helper function to get voltage potential (handles differential mode)
function getPotential() {
    const solver = get.solver();
    if (!solver || !solver.V) {
        return null;
    }

    if (isDifferentialMode()) {
        const modeIndex = getSelectedModeIndex();
        return solver.V[modeIndex];
    } else {
        // Single-ended mode
        return solver.V[0];
    }
}

// Get plot options from sidebar
function getPlotOptions() {
    const streamlinesEl = document.getElementById('plot-streamlines');
    const contoursEl = document.getElementById('plot-contours');

    const streamlinesVal = streamlinesEl ? streamlinesEl.value.trim() : '';
    const contoursVal = contoursEl ? contoursEl.value.trim() : '';

    return {
        streamlines: streamlinesVal === '' ? 0 : parseInt(streamlinesVal) || 0,
        contours: contoursVal === '' ? 0 : parseInt(contoursVal) || 0
    };
}

// Function to set current view
function setCurrentView(view) {
    currentView = view;
    // Notify app.js that view changed so it can restore the appropriate scale
    if (window.onViewChanged) {
        window.onViewChanged(view);
    }
}

// Unified freeze/unfreeze for both Results and S-Parameters tabs
function freeze() {
    const data = get.frequencySweepResults();
    if (data && data.length > 0) {
        frozenResultsData = JSON.parse(JSON.stringify(data));
        frozenSParamData = {
            results: JSON.parse(JSON.stringify(data)),
            length: get.inputValue('sparam-length'),
            zRef: parseFloat(document.getElementById('sparam-z-ref').value)
        };
    }
}
function unfreeze() {
    frozenResultsData = null;
    frozenSParamData = null;
}
function isFrozen() { return frozenResultsData !== null; }

export { draw, drawResultsPlot, drawSParamPlot, drawParameterSweepPlot, setGlobals, setCurrentView, getScaleRange, setScaleRange, getActualDataRange,
    freeze, unfreeze, isFrozen, conductorFillShapes, dielectricFillShapes, computeGeometryView,
    clearMqsField, setMqsField };
