// MODIFIED 2026-10-01/02 by David Riehl (fork of https://github.com/Ttl/js_2d_fields, GPL v3):
// added the |H| Field, Current J and Power flow S views, E / H / S arrows (now chosen in a
// menu of the plot), one excitation (voltage, current or power) and one time display for
// all field views, standing waves, field lines and equipotentials on the field views.
// The view builders live in field_views.js.
// See FORK_CHANGES.md for the full list of changes.

import { computeSParamsSingleEnded, computeSParamsDiffAuto, sParamTodB,
         isSelfReferenced, sparamsForPoint, usableSweepPoints } from './sparameters.js';
import { isComplement, svgRingPath } from './shapes.js';
import { buildFieldView, geometryLines, buildArrowData, formatFreq, isWaveguide,
         dielectricAt } from './field_views.js';
import { excitation, reflection, standingWave, parseImpedance, formatSI, formatPhasor,
         c, cmul, cconj, cabs } from './field_excitation.js';

// Lazy Plotly access - allows app to function while Plotly is loading
const getPlotly = () => window.Plotly;

let showMesh = false;
let currentView = "geometry";
let zMin = null;
let zMax = null;
// Store actual data range (before any user scaling)
let actualDataMin = null;
let actualDataMax = null;
// Color axis of the current field view: logarithmic (zMin / zMax are log10 values) and
// its unit, for the scale dialog.
let scaleLog = false;
let scaleUnit = '';

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

// Export functions to get/set scale range for current view
function getScaleRange() {
    return { min: zMin, max: zMax, view: currentView, log: scaleLog, unit: scaleUnit };
}

// ---- H field / current density data --------------------------------------------------
// The data comes from an extra eddy-current solve in the worker (TriBackend.mqsFieldAt),
// or the closed form for coax and waveguide, requested on demand through
// window.requestMqsField when a view or the arrows need it. Each result is tagged with
// the key it was requested for (solve generation, mode, frequency), a view whose key
// does not match asks again.
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

// H / J data available for the current settings (without requesting it).
function currentMqsField() {
    return (mqsField && mqsField.key === mqsKey() && mqsField.ok) ? mqsField : null;
}

// H, J and S need the eddy-current solve of the Full-wave solver.
function hasHField(solver) {
    return !!solver && solver.mesh_backend === 'triangular';
}

// ---- sidebar settings of the field views ---------------------------------------------
const elVal = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };

function readFieldOptions() {
    const phase = parseFloat(elVal('plot-field-phase'));
    const phaseDeg = Number.isFinite(phase) ? phase : 0;
    const count = (id, dflt) => {
        const raw = String(elVal(id)).trim();
        if (raw === '') return dflt;
        const n = parseInt(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 0;
    };
    return {
        inst: elVal('plot-field-display') === 'inst',
        phaseDeg,
        wt: phaseDeg * Math.PI / 180,
        log: elVal('plot-field-scale') !== 'linear',
        nLines: count('plot-streamlines', 0),
        nContours: count('plot-contours', 0),
        contourKind: elVal('plot-contour-kind') === 'mag' ? 'mag' : 'equi',
    };
}

// Line impedance of the plotted mode at the field frequency, interpolated in the sweep.
function zcAt(results, freq, modeIdx) {
    if (!results || !results.length) return null;
    const zOf = (r) => {
        const modes = r.result && r.result.modes;
        if (!modes || !modes.length) return null;
        const m = modes[modeIdx] || modes[0];
        if (m.Zc && Number.isFinite(m.Zc.re) && Number.isFinite(m.Zc.im)) return c(m.Zc.re, m.Zc.im);
        return Number.isFinite(m.Z0) ? c(m.Z0, 0) : null;
    };
    const pts = results.map(r => ({ f: r.freq, z: zOf(r) })).filter(p => p.z).sort((a, b) => a.f - b.f);
    if (!pts.length) return null;
    if (freq <= pts[0].f) return pts[0].z;
    if (freq >= pts[pts.length - 1].f) return pts[pts.length - 1].z;
    let k = 1;
    while (k < pts.length - 1 && pts[k].f < freq) k++;
    const a = pts[k - 1], b = pts[k], t = (freq - a.f) / ((b.f - a.f) || 1);
    return c(a.z.re + t * (b.z.re - a.z.re), a.z.im + t * (b.z.im - a.z.im));
}

const LOAD_NAMES = { open: 'open end', short: 'short circuit', custom: 'load' };

// Excitation of the field views: amplitudes cE, cH of the plotted position, the expected
// power and the label for the title.
function readExcitation(solver) {
    const diff = isDifferentialMode();
    const modeIdx = mqsModeIndex();
    const mode = diff ? (modeIdx === 0 ? 'odd' : 'even') : 'single';
    const wg = isWaveguide(solver);
    const freq = fieldPlotFreq();
    const Zc = wg ? null : zcAt(get.frequencySweepResults(), freq, modeIdx);
    const kind = elVal('plot-exc-kind') || 'V';
    const value = parseFloat(elVal('plot-exc-value'));
    const rms = elVal('plot-exc-rms') === 'rms';
    const nCond = diff ? 2 : 1;
    const base = excitation({ kind, value, rms, Zc, nCond, mode, waveguide: wg });
    if (!base.ok) return { ...base, cE: c(1), cH: c(0), label: base.note };
    const ex = { ...base, nCond, mode, Zc };
    // Termination: standing wave at d/λ from the load (TEM lines only).
    const load = elVal('plot-sw-load') || 'matched';
    const dl = parseFloat(elVal('plot-sw-pos'));
    ex.standing = false;
    if (!wg && load !== 'matched') {
        const ZL = parseImpedance(elVal('plot-sw-zl'));
        if (load === 'custom' && !ZL) ex.note = 'The load impedance could not be read, the line is drawn matched.';
        else {
            const gamma = reflection(load, Zc, ZL);
            const sw = standingWave(base.V, base.I, gamma, Number.isFinite(dl) ? dl : 0);
            ex.cE = sw.V; ex.cH = sw.I;
            ex.standing = { load, gamma, dl: Number.isFinite(dl) ? dl : 0, ZL };
        }
    }
    ex.Pexp = nCond * 0.5 * cmul(ex.cE, cconj(ex.cH)).re;
    if (wg) ex.Pexp = base.P;
    ex.label = excitationLabel(ex, rms, kind);
    return ex;
}

function excitationLabel(ex, rms, kind) {
    const pk = (rms && kind !== 'P') ? ' (peak values)' : '';
    if (ex.waveguide) return `P = ${formatSI(ex.P, 'W')}${ex.note ? ' · ' + ex.note : ''}`;
    const V = ex.cE, I = ex.cH;
    let s;
    if (ex.mode === 'odd') s = `±${formatPhasor(V, 'V')} per conductor (${formatSI(2 * cabs(V), 'V')} differential), ±${formatPhasor(I, 'A')}`;
    else if (ex.mode === 'even') s = `${formatPhasor(V, 'V')} on both conductors, ${formatPhasor(I, 'A')} each`;
    else s = `V = ${formatPhasor(V, 'V')}, I = ${formatPhasor(I, 'A')}`;
    if (ex.standing) {
        const sw = ex.standing;
        const name = sw.load === 'custom' ? `Z_L = ${formatPhasor(sw.ZL, 'Ω')}` : LOAD_NAMES[sw.load];
        s = `${name}, ${+sw.dl.toFixed(4)} λ from it: ${s} · incident P = ${formatSI(ex.P, 'W')}`;
    } else {
        s += `, P = ${formatSI(ex.P, 'W')}`;
    }
    return s + pk + (ex.note ? ' · ' + ex.note : '');
}

// Everything a field view builder needs (see field_views.js).
function buildEnv(solver, view, f) {
    const opt = readFieldOptions();
    const ex = readExcitation(solver);
    const fields = getFields();
    return {
        solver, view, f, ex, opt,
        freq: fieldPlotFreq(),
        E: { Ex: fields.Ex, Ey: fields.Ey },
        V: getPotential(),
        epsAt: (x, y) => dielectricAt(solver, x, y),
        stored: (v) => (window.getStoredScale ? window.getStoredScale(v) : null),
        arrowsH: getArrowOptions().H,
    };
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

// Conductor fills BELOW the traces (field lines and arrows stay visible on top of the
// metal; the field heatmaps leave the metal empty) with their outline on top.
function conductorLayerShapes(solver, maxY) {
    const fills = conductorFillShapes(solver, maxY).map(s => ({ ...s, layer: 'between',
        line: s.fillcolor && s.fillcolor !== 'rgba(0,0,0,0)' ? { color: s.fillcolor, width: 0 } : s.line }));
    const outlines = conductorFillShapes(solver, maxY)
        .filter(s => s.fillcolor !== 'rgba(0,0,0,0)')
        // In the conductor color: a crisp edge over field lines and arrows, no dark rim.
        .map(s => ({ ...s, fillcolor: 'rgba(0,0,0,0)', line: { color: s.fillcolor, width: 1 }, layer: 'above' }));
    return [...fills, ...outlines];
}

// ---- E / H arrows ------------------------------------------------------------------
const ARROW_COLORS = { E: 'rgba(70, 150, 255, 0.95)', H: 'rgba(255, 60, 60, 0.95)', S: 'rgba(255, 255, 255, 0.9)' };
const ARROW_CHOICES = [['', 'Arrows: off'], ['E', 'E arrows'], ['H', 'H arrows'], ['EH', 'E + H arrows'],
                       ['S', 'S markers'], ['EHS', 'E + H + S']];

function getArrowOptions() {
    const solver = get.solver();
    let m = elVal('plot-arrows') || '';
    if (solver && !hasHField(solver)) m = m.replace(/[HS]/g, '');
    const n = parseInt(elVal('plot-arrow-density'));
    return { E: m.includes('E'), H: m.includes('H'), S: m.includes('S'),
             density: Number.isFinite(n) && n >= 4 ? Math.min(n, 80) : 24 };
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
    const arrows = getArrowOptions();
    const needF = arrows.H || arrows.S || (arrows.E && isWaveguide(solver));
    const f = needF ? ensureMqsField() : currentMqsField();
    const env = buildEnv(solver, currentView, f);
    if (!env.ex.ok) return;
    const d = buildArrowData(env, arrows, [Math.min(...xr), Math.max(...xr)], [Math.min(...yr), Math.max(...yr)]);
    const xs = [], ys = [];
    for (const k of idx) {
        const w = container.data[k].name[0];
        xs.push((d[w] && d[w].x) || []); ys.push((d[w] && d[w].y) || []);
    }
    Plotly.restyle(container, { x: xs, y: ys }, idx);
    const sIdx = idx.find(k => container.data[k].name.startsWith('S power flow'));
    if (sIdx !== undefined) {
        Plotly.restyle(container, { 'marker.size': [(d.S && d.S.size) || []],
                                    'marker.symbol': [(d.S && d.S.symbol) || 'circle-open-dot'] }, [sIdx]);
    }
}
// Get actual data range (before any user scaling)
function getActualDataRange() {
    return { min: actualDataMin, max: actualDataMax };
}

function setScaleRange(min, max) {
    zMin = min;
    zMax = max;
    // The views read the stored override (window.getStoredScale) while they are built, so
    // a redraw applies it everywhere: heatmaps, the ring views of the coax and the
    // contour levels tied to the color scale.
    draw();
}

function draw(resetZoom = false) {
    const solver = get.solver();
    const Plotly = getPlotly();
    if (!solver || !Plotly) return;

    const container = document.getElementById('sim_canvas');

    // Preserve current view state if plot exists (unless resetZoom is requested)
    let currentXRange = null;
    let currentYRange = null;
    if (!resetZoom && container && container.layout && container.layout.xaxis) {
        currentXRange = container.layout.xaxis.range;
        currentYRange = container.layout.yaxis.range;
    }

    let title = "";
    let subtitle = "";
    let shapes = [];
    let traces = [];
    let xMM, yMM;
    let fieldView = null;   // result of buildFieldView for the field views
    scaleLog = false; scaleUnit = '';
    const wg = isWaveguide(solver);
    const maxY = Math.max(
        solver.dielectrics.reduce((max, d) => Math.max(max, d.y_max), 0),
        solver.conductors.reduce((max, c) => Math.max(max, c.y_max), 0)
    );
    const gridMM = () => {
        if (solver.x && solver.y) return [Array.from(solver.x, v => v * 1000), Array.from(solver.y, v => v * 1000)];
        return [[0, (solver.w || 1) * 2000], [0, (maxY || solver.h || 1) * 1000]];
    };
    const view = currentView.startsWith('potential') ? 'potential'
        : currentView.startsWith('efield') ? 'efield' : currentView;
    const VIEW_NAMES = { potential: 'Potential', efield: '|E| field', hfield: 'H field',
                         jfield: 'Current density', sfield: 'Power flow' };

    if (view === "geometry") {
        title = "Transmission Line Geometry";
        if (!currentXRange || resetZoom) {
            const gv = computeGeometryView(solver, maxY);
            if (gv) { currentXRange = gv.xRange; currentYRange = gv.yRange; }
        }
        // Dielectrics below, conductors under the field lines (with their outline on top).
        shapes.push(...dielectricFillShapes(solver, maxY));
        shapes.push(...conductorLayerShapes(solver, maxY));
        [xMM, yMM] = gridMM();
        if (solver.solution_valid && solver.mesh_generated) {
            // Field lines and equipotentials of the current excitation and time display.
            const f = wg ? ensureMqsField() : currentMqsField();
            const env = buildEnv(solver, 'geometry', f);
            if (env.ex.ok) traces.push(...geometryLines(env));
        }
        // Invisible scatter for the axis scaling.
        traces.unshift({ type: "scatter", x: [xMM[0], xMM[xMM.length - 1]], y: [yMM[0], yMM[yMM.length - 1]],
                         mode: "markers", marker: { size: 0, opacity: 0 }, showlegend: false, hoverinfo: "skip" });
    }

    else if (VIEW_NAMES[view] && solver.solution_valid) {
        if (!solver.mesh_generated) solver.ensure_mesh();
        const needF = view === 'hfield' || view === 'jfield' || view === 'sfield' || (wg && view === 'efield');
        const f = needF ? ensureMqsField() : currentMqsField();
        const failed = needF && !f && mqsField && mqsField.key === mqsKey() && !mqsField.ok;
        if (failed) {
            title = `${VIEW_NAMES[view]} not available (see log)`;
        } else if (needF && !f) {
            title = `Computing ${VIEW_NAMES[view].toLowerCase()} at ${formatFreq(fieldPlotFreq())}…`;
        } else {
            const env = buildEnv(solver, view, f);
            fieldView = buildFieldView(env);
            if (fieldView.pending) {
                title = `Computing ${VIEW_NAMES[view].toLowerCase()} at ${formatFreq(fieldPlotFreq())}…`;
                fieldView = null;
            } else if (fieldView.error) {
                title = fieldView.error;
                fieldView = null;
            } else {
                traces.push(...fieldView.traces);
                shapes.push(...(fieldView.shapes || []));
                title = `${fieldView.title} · ${formatFreq(env.freq)}`;
                subtitle = env.ex.label + (fieldView.info ? ` · ${fieldView.info}` : '');
                xMM = fieldView.xMM; yMM = fieldView.yMM;
                zMin = fieldView.zMin; zMax = fieldView.zMax;
                scaleLog = !!fieldView.scaleLog; scaleUnit = fieldView.scaleUnit || '';
                actualDataMin = fieldView.dataMin; actualDataMax = fieldView.dataMax;
            }
        }
        if (!xMM) [xMM, yMM] = gridMM();
        if (!fieldView) {
            // Waiting for (or missing) data: invisible scatter keeps the axes.
            traces.push({ type: "scatter", x: [xMM[0], xMM[xMM.length - 1]], y: [yMM[0], yMM[yMM.length - 1]],
                          mode: "markers", marker: { size: 0, opacity: 0 }, showlegend: false, hoverinfo: "skip" });
        }
        const yTop = solver.y ? solver.y[solver.y.length - 1] : maxY;
        if (view === 'hfield' || view === 'jfield') {
            // The field lives inside the metal too: outlines only.
            shapes.push(...outlineShapes(solver, Math.max(maxY, yTop)));
        } else if (view === 'potential') {
            // The conductors carry their potential in the color map: outlines only.
            shapes.push(...outlineShapes(solver, Math.max(maxY, yTop)));
        } else {
            shapes.push(...dielectricFillShapes(solver, Math.max(maxY, yTop), {
                alpha: 0, airAlpha: 0, layer: 'above', lineColor: 'rgba(200, 200, 200, 0.3)' }));
            shapes.push(...conductorLayerShapes(solver, Math.max(maxY, yTop)));
        }
    }

    else {
        title = "No Data Available";
        [xMM, yMM] = gridMM();
        traces.push({ type: "scatter", x: xMM, y: yMM, mode: "markers", marker: { size: 0, opacity: 0 },
                      showlegend: false, hoverinfo: "skip" });
    }

    // Static grid for the rectilinear mesh overlay.
    const [xMM_mesh, yMM_mesh] = gridMM();
    const nx_mesh = xMM_mesh.length, nyDisplay_mesh = yMM_mesh.length;
    const mqsView = !!fieldView && (view === 'hfield' || view === 'jfield' || view === 'sfield');

    // E / H arrows (filled by updateArrows once the axis ranges are known).
    const arrowTr = solver.solution_valid ? arrowPlaceholders() : [];
    traces.push(...arrowTr);
    for (const t of traces) if (t.showlegend === undefined) t.showlegend = false;
    const anyLegend = traces.some(t => t.showlegend);

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

    // UI menus: view, odd / even mode (differential lines) and arrows, in one row above
    // the plot area. The title sits above them.
    const menuBase = { y: 1.01, yanchor: 'bottom', xanchor: 'left', showactive: true,
                       bgcolor: '#2a2a2a', bordercolor: '#444', font: { color: '#aaa' }, pad: { t: 0, b: 2 } };
    const titleText = subtitle
        ? `${title}<br><span style="font-size:12px;color:#bbb">${subtitle}</span>`
        : title;
    const layout = {
        title: { text: titleText, font: { color: '#fff', size: 15 }, x: 0.5, xanchor: 'center',
                 y: 0.985, yref: 'container', yanchor: 'top' },
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
        margin: { l: 70, r: 90, t: subtitle ? 92 : 78, b: 60 },
        showlegend: anyLegend,
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
            menus.push({ ...menuBase, name: 'view', x: 0.0,
                active: Math.max(0, viewButtons.findIndex(b => b.label === activeLabel)),
                buttons: viewButtons });

            let x = 0.17;
            // Mode selector (Odd/Even) - only for differential lines
            if (isDifferentialMode()) {
                menus.push({ ...menuBase, name: 'mode', x, active: getSelectedModeIndex(),
                    buttons: [{ label: "Odd Mode", method: "skip", args: [] },
                              { label: "Even Mode", method: "skip", args: [] }] });
                x += 0.15;
            }

            // Arrow selector: E, H and S need the H field of the Full-wave solver.
            if (solver.solution_valid) {
                const choices = ARROW_CHOICES.filter(([v]) => hasHField(solver) || !/[HS]/.test(v));
                const cur = elVal('plot-arrows') || '';
                menus.push({ ...menuBase, name: 'arrows', x,
                    active: Math.max(0, choices.findIndex(([v]) => v === cur)),
                    buttons: choices.map(([v, label]) => ({ label, method: 'skip', args: [], value: v })) });
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
            // Which menu: by name (view / mode / arrows), x position as a fallback.
            const name = event.menu.name || (event.menu.x < 0.1 ? 'view' : 'mode');
            const btn = event.menu.buttons[event.menu.active];
            const label = btn && btn.label;
            if (name === 'view') {
                // Key off the LABEL, not the index: the Potential button is absent for a
                // source-free medium (see the button list above), so index 1 is not always
                // "potential".
                setCurrentView(label === "Geometry" ? "geometry"
                    : label === "Potential" ? "potential"
                    : label === "|H| Field" ? "hfield"
                    : label === "Current J" ? "jfield"
                    : label === "Power flow S" ? "sfield" : "efield");
            } else if (name === 'arrows') {
                const choice = ARROW_CHOICES.find(([, l]) => l === label);
                const sel = document.getElementById('plot-arrows');
                if (sel && choice) sel.value = choice[0];
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
