// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// The fork's field plot: Potential, |E|, |H|, current density, power flow and losses,
// with field lines, equipotentials, E / H / S arrows, one excitation, log / linear
// scale, its own menu row, legend memory, scale dialog and help.
//
// How it docks onto the original (see FORK_CHANGES.md, "Hooks"):
//   - plot.js draw() asks forkPlot.draw(resetZoom, get) first. For a field view it draws
//     here and returns true; for the Geometry view it returns false, the original draws
//     its geometry, and the menu row is swapped for ours afterwards (plotly_afterplot).
//   - The original's menu click handler is never bound (container._viewListenerBound is
//     set before its first draw): all menu clicks come here.
//   - Field data: the grid fields the original grafts onto the main-thread solver
//     (x, y, V, Ex, Ey at the plot frequency) and, for H / J / S / losses, the worker job
//     'forkField' (src/fork/worker_jobs.js) through window.forkWorkerJob.
// Everything else (excitation controls, help texts, scale dialog) is added from here.

import { conductorFillShapes, dielectricFillShapes, computeGeometryView, displayTop, plotShiftMM, shiftPlotX,
         setCurrentView, darkAxis, darkBackground, draw } from '../plot.js';
import { buildFieldView, buildArrowData, formatFreq, isWaveguide, dielectricAt } from './field_views.js';
import { excitation, formatSI, formatPhasor, c, cmul, cconj, cabs } from './field_excitation.js';
import { FORK_HELP } from './help.js';

const getPlotly = () => window.Plotly;
const elVal = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };

// ---- state ------------------------------------------------------------------------
let get = null;                 // the original plot.js accessors (solver, sweep results)
let view = 'geometry';          // shown view
let logScale = true;            // log / linear color scale of the field views
let arrowMode = '';             // '', 'E', 'H', 'EH', 'S', 'EHS'
let showMesh = false;
let lastResult = null;          // last field view: scale range for the dialog
const storedScales = {};        // `${view}|${log}` → { min, max } from the scale dialog
const legendVisibility = {};    // legend group → visible state chosen by the user

// Views of the menu (internal name, button label).
const VIEW_BUTTONS = [['geometry', 'Geometry'], ['potential', 'Potential'], ['efield', '|E| Field'],
                      ['hfield', '|H| Field'], ['jfield', 'Current J'], ['sfield', 'Power flow S'],
                      ['lossfield', 'Losses']];
const VIEW_NAMES = { potential: 'Potential', efield: '|E| field', hfield: 'H field',
                     jfield: 'Current density', sfield: 'Power flow', lossfield: 'Losses' };
// Views computed from the eddy-current (H / J) data, which also lives inside the metal.
const MQS_VIEWS = ['hfield', 'jfield', 'sfield', 'lossfield'];

const isDifferential = (solver) => !!(solver && solver.is_differential);
const modeIndex = (solver) => (isDifferential(solver) && elVal('plot-mode') === 'even' ? 1 : 0);
const hasHField = (solver) => !!solver && solver.mesh_backend === 'triangular';

// ---- H / J field from the worker ----------------------------------------------------
// Keyed by solve (the grafted triMesh object), plot frequency and mode.
const solveIds = new WeakMap();
let solveCounter = 0;
let fieldCache = null, fieldPending = null;
function fieldKey(solver) {
    const m = solver.triMesh || solver;
    if (!solveIds.has(m)) solveIds.set(m, ++solveCounter);
    return `${solveIds.get(m)}|${solver.fieldFreq}|${modeIndex(solver)}`;
}
// The field for the current solve, plot frequency and mode, requested if missing.
function ensureField(solver) {
    const key = fieldKey(solver);
    if (fieldCache && fieldCache.key === key) return fieldCache;
    if (fieldPending !== key && window.forkWorkerJob) {
        fieldPending = key;
        window.forkWorkerJob('forkField', { modeIdx: modeIndex(solver) }).then(({ field }) => {
            fieldCache = { key, ...(field || { ok: false, reason: 'No data returned.' }) };
            if (field && !field.ok && window.forkLog) window.forkLog(`⚠ Field views: ${field.reason}`);
        }).catch((e) => {
            fieldCache = { key, ok: false, reason: (e && e.message) || String(e) };
        }).finally(() => {
            if (fieldPending === key) fieldPending = null;
            draw();
        });
    }
    return null;
}
const currentField = (solver) => (fieldCache && fieldCache.key === fieldKey(solver) ? fieldCache : null);
const fieldFailed = (solver) => { const f = currentField(solver); return !!f && !f.ok; };
const okField = (solver) => { const f = currentField(solver); return f && f.ok ? f : null; };

// ---- excitation ---------------------------------------------------------------------
// A quantity of the plotted mode at frequency f, interpolated linearly in the sweep.
function sweepAt(results, f, modeIdx, pick) {
    if (!results || !results.length) return null;
    const pts = results.map(r => {
        const modes = r.result && r.result.modes;
        return { f: r.freq, v: modes && modes.length ? pick(modes[modeIdx] || modes[0]) : null };
    }).filter(p => p.v !== null && p.v !== undefined).sort((a, b) => a.f - b.f);
    if (!pts.length) return null;
    if (!(f > pts[0].f)) return pts[0].v;
    if (f >= pts[pts.length - 1].f) return pts[pts.length - 1].v;
    let k = 1;
    while (k < pts.length - 1 && pts[k].f < f) k++;
    const a = pts[k - 1], b = pts[k], t = (f - a.f) / ((b.f - a.f) || 1);
    if (typeof a.v === 'number') return a.v + t * (b.v - a.v);
    return c(a.v.re + t * (b.v.re - a.v.re), a.v.im + t * (b.v.im - a.v.im));
}
const NP_PER_DB = 1 / 8.685889638065035;
function plotFreq(solver) {
    if (solver.fieldFreq > 0) return solver.fieldFreq;
    const res = get.frequencySweepResults();
    return res && res.length ? Math.max(...res.map(r => r.freq)) : 1e9;
}
function readExcitation(solver) {
    const diff = isDifferential(solver), modeIdx = modeIndex(solver);
    const mode = diff ? (modeIdx === 0 ? 'odd' : 'even') : 'single';
    const wg = isWaveguide(solver);
    const f = plotFreq(solver), results = get.frequencySweepResults();
    const Zc = wg ? null : sweepAt(results, f, modeIdx, (m) => {
        if (m.Zc && Number.isFinite(m.Zc.re) && Number.isFinite(m.Zc.im)) return c(m.Zc.re, m.Zc.im);
        return Number.isFinite(m.Z0) ? c(m.Z0, 0) : null;
    });
    const kind = elVal('fork-exc-kind') || 'V';
    const value = parseFloat(elVal('fork-exc-value'));
    const rms = elVal('fork-exc-rms') === 'rms';
    const nCond = diff ? 2 : 1;
    const base = excitation({ kind, value, rms, Zc, nCond, mode, waveguide: wg });
    if (!base.ok) return { ...base, cE: c(1), cH: c(0), label: base.note };
    const ex = { ...base, nCond, mode, Zc };
    ex.Pexp = wg ? base.P : nCond * 0.5 * cmul(ex.cE, cconj(ex.cH)).re;
    const pk = (rms && kind !== 'P') ? ' (peak values)' : '';
    let s;
    if (ex.waveguide) s = `P = ${formatSI(ex.P, 'W')}`;
    else {
        const V = ex.cE, I = ex.cH;
        if (mode === 'odd') s = `±${formatPhasor(V, 'V')} per conductor (${formatSI(2 * cabs(V), 'V')} differential), ±${formatPhasor(I, 'A')}`;
        else if (mode === 'even') s = `${formatPhasor(V, 'V')} on both conductors, ${formatPhasor(I, 'A')} each`;
        else s = `V = ${formatPhasor(V, 'V')}, I = ${formatPhasor(I, 'A')}`;
        s += `, P = ${formatSI(ex.P, 'W')}`;
    }
    ex.label = s + pk + (ex.note ? ' · ' + ex.note : '');
    return ex;
}
function alphaAt(solver) {
    const f = plotFreq(solver), results = get.frequencySweepResults(), mi = modeIndex(solver);
    const ac = sweepAt(results, f, mi, (m) => (Number.isFinite(m.alpha_c) ? m.alpha_c : null));
    const ad = sweepAt(results, f, mi, (m) => (Number.isFinite(m.alpha_d) ? m.alpha_d : null));
    return ac === null || ad === null ? null : { c: ac * NP_PER_DB, d: ad * NP_PER_DB };
}

// Count inputs of the original's Plot Options; empty means the fork's default (the lines
// start hidden in the legend anyway).
function count(id, dflt) {
    const raw = String(elVal(id)).trim();
    if (raw === '') return dflt;
    const n = parseInt(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 0;
}

function buildEnv(solver, v, f) {
    const mi = modeIndex(solver);
    return {
        solver, view: v, f, ex: readExcitation(solver),
        opt: { log: logScale, nLines: count('plot-streamlines', 20), nContours: count('plot-contours', 15) },
        freq: plotFreq(solver), alpha: alphaAt(solver),
        E: { Ex: solver.Ex && solver.Ex[mi], Ey: solver.Ey && solver.Ey[mi] },
        V: solver.V && solver.V[mi],
        epsAt: (x, y) => dielectricAt(solver, x, y),
        stored: (vv) => storedScales[`${vv}|${logScale}`] || null,
        arrowsH: arrowOptions(solver).H,
    };
}

// ---- shapes -------------------------------------------------------------------------
// Conductor and dielectric outlines only: H, J and the losses live inside the metal,
// the potential colors the conductors with their voltage, |E| and S leave them dark.
function outlineShapes(solver, maxY) {
    const cond = conductorFillShapes(solver, maxY).map(s => ({
        ...s, fillcolor: 'rgba(0,0,0,0)',
        line: s.line && s.line.color === 'rgba(255, 215, 0, 1.0)' ? s.line : { color: 'rgba(255, 255, 255, 0.55)', width: 1 },
    }));
    const diel = dielectricFillShapes(solver, maxY, { alpha: 0, airAlpha: 0, layer: 'above', lineColor: 'rgba(200, 200, 200, 0.3)' });
    return [...diel, ...cond];
}

// ---- arrows -------------------------------------------------------------------------
const ARROW_COLORS = { E: 'rgba(70, 150, 255, 0.95)', H: 'rgba(255, 60, 60, 0.95)', S: 'rgba(255, 255, 255, 0.9)' };
const ARROW_CHOICES = [['', 'Arrows: off'], ['E', 'E arrows'], ['H', 'H arrows'], ['EH', 'E + H arrows'],
                       ['S', 'S markers'], ['EHS', 'E + H + S']];
function arrowOptions(solver) {
    let m = arrowMode;
    if (solver && !hasHField(solver)) m = m.replace(/[HS]/g, '');
    const n = parseInt(elVal('fork-arrow-density'));
    return { E: m.includes('E'), H: m.includes('H'), S: m.includes('S'),
             density: Number.isFinite(n) && n >= 4 ? Math.min(n, 80) : 24 };
}
function arrowPlaceholders(solver) {
    const opt = arrowOptions(solver), t = [];
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
// Re-sample the arrows for the visible range (the plot may be drawn shifted in x).
function updateArrows(container) {
    const solver = get && get.solver(), Plotly = getPlotly();
    if (!container || !container.data || !solver || !Plotly || !solver.solution_valid || view === 'geometry') return;
    const idx = [];
    container.data.forEach((t, k) => {
        if (t.name === 'E arrows' || t.name === 'H arrows' || (t.name || '').startsWith('S power flow')) idx.push(k);
    });
    if (!idx.length) return;
    const fl = container._fullLayout || container.layout;
    const xr = fl.xaxis && fl.xaxis.range, yr = fl.yaxis && fl.yaxis.range;
    if (!xr || !yr) return;
    const arrows = arrowOptions(solver);
    const needF = arrows.H || arrows.S || (arrows.E && isWaveguide(solver));
    const f = needF ? (ensureField(solver), okField(solver)) : okField(solver);
    const env = buildEnv(solver, view, f);
    if (!env.ex.ok) return;
    const dx = plotShiftMM(solver);
    const d = buildArrowData(env, arrows, [Math.min(...xr) - dx, Math.max(...xr) - dx], [Math.min(...yr), Math.max(...yr)]);
    const shift = (a) => (dx ? a.map(v => (v === null ? null : v + dx)) : a);
    const xs = [], ys = [];
    for (const k of idx) {
        const w = container.data[k].name[0];
        xs.push(shift((d[w] && d[w].x) || [])); ys.push((d[w] && d[w].y) || []);
    }
    Plotly.restyle(container, { x: xs, y: ys }, idx);
    const sIdx = idx.find(k => container.data[k].name.startsWith('S power flow'));
    if (sIdx !== undefined) Plotly.restyle(container, { 'marker.size': [(d.S && d.S.size) || []] }, [sIdx]);
}

// ---- legend memory ------------------------------------------------------------------
// Field lines, equipotentials and the power-containment lines start hidden.
const hiddenByDefault = (key) => /^(Equipotentials|E field lines|H field lines|H field \(transverse\))$/.test(key)
    || /% of the power$/.test(key);
const legendKey = (t) => t.legendgroup || (t.showlegend ? t.name : null);
function applyLegendVisibility(traces) {
    for (const t of traces) {
        const key = legendKey(t);
        if (!key) continue;
        const v = key in legendVisibility ? legendVisibility[key] : (hiddenByDefault(key) ? 'legendonly' : true);
        if (v !== true) t.visible = v;
    }
}

// ---- menu row -----------------------------------------------------------------------
const MENU_BASE = { y: 1.01, yanchor: 'bottom', xanchor: 'left', showactive: true,
                    bgcolor: '#2a2a2a', bordercolor: '#444', font: { color: '#aaa' }, pad: { t: 0, b: 2 } };
function scaleLabels(v, solver) {
    if (v === 'geometry' || v === 'potential') return null;
    if (v === 'jfield' && !isWaveguide(solver)) return ['|J| log', 'Jz linear (±)'];
    return ['Log scale', 'Linear scale'];
}
function viewButtonsFor(solver) {
    const out = [];
    for (const [v, label] of VIEW_BUTTONS) {
        if (v !== 'geometry' && !solver.solution_valid) continue;
        if (v === 'potential' && solver.has_potential === false) continue;
        if (MQS_VIEWS.includes(v) && !hasHField(solver)) continue;
        out.push({ label, method: 'skip', args: [] });
    }
    return out;
}
function menus(solver) {
    const out = [];
    const vb = viewButtonsFor(solver);
    const activeLabel = (VIEW_BUTTONS.find(([v]) => v === view) || [null, 'Geometry'])[1];
    out.push({ ...MENU_BASE, name: 'view', x: 0, active: Math.max(0, vb.findIndex(b => b.label === activeLabel)), buttons: vb });
    const sl = scaleLabels(view, solver);
    if (solver.solution_valid && sl) {
        out.push({ ...MENU_BASE, name: 'scale', x: 0.15, active: logScale ? 0 : 1,
            buttons: sl.map(label => ({ label, method: 'skip', args: [] })) });
    }
    if (solver.solution_valid && view !== 'geometry') {
        const choices = ARROW_CHOICES.filter(([v]) => hasHField(solver) || !/[HS]/.test(v));
        out.push({ ...MENU_BASE, name: 'arrows', x: 0.3, active: Math.max(0, choices.findIndex(([v]) => v === arrowMode)),
            buttons: choices.map(([, label]) => ({ label, method: 'skip', args: [] })) });
    }
    if (isDifferential(solver)) {
        out.push({ ...MENU_BASE, name: 'mode', x: 0.5, active: modeIndex(solver),
            buttons: [{ label: 'Odd Mode', method: 'skip', args: [] }, { label: 'Even Mode', method: 'skip', args: [] }] });
    }
    return out;
}
// Fixed pixel gaps: Plotly places menus at fractions of the plot width.
const MENU_GAP_PX = 6, MODE_GAP_PX = 28;
function packMenus(container) {
    const Plotly = getPlotly(), fl = container && container._fullLayout;
    if (!Plotly || !fl || !fl.updatemenus || !fl.updatemenus.length || !(fl._size && fl._size.w > 0)) return;
    const heads = container.querySelectorAll('.updatemenu-header-group');
    if (heads.length !== fl.updatemenus.length) return;
    const w = fl._size.w, upd = {};
    let px = 0;
    fl.updatemenus.forEach((m, k) => {
        if (k > 0) px += m.name === 'mode' ? MODE_GAP_PX : MENU_GAP_PX;
        const x = px / w;
        if (Math.abs(m.x - x) > 1e-4 || m.xanchor !== 'left') { upd[`updatemenus[${k}].x`] = x; upd[`updatemenus[${k}].xanchor`] = 'left'; }
        px += heads[k].getBoundingClientRect().width;
    });
    if (Object.keys(upd).length) Plotly.relayout(container, upd);
}

// ---- event handlers (bound once) ----------------------------------------------------
function bindOnce(container) {
    // The original's menu handler stays unbound: the menu row is ours in every view.
    container._viewListenerBound = true;
    if (container._forkBound) return;
    if (typeof container.on !== 'function') {
        // Not a Plotly plot yet: bind once the original's first draw has made it one.
        setTimeout(() => { if (typeof container.on === 'function') { bindOnce(container); swapGeometryMenus(container); } }, 0);
        return;
    }
    container._forkBound = true;
    container.on('plotly_buttonclicked', (event) => {
        const solver = get && get.solver();
        if (!solver) return;
        const name = event.menu.name, active = event.menu.active;
        const btn = event.menu.buttons[active], label = btn && btn.label;
        if (name === 'view') {
            const v = VIEW_BUTTONS.find(([, l]) => l === label);
            view = v ? v[0] : 'geometry';
            closeScaleDialog();
        } else if (name === 'scale') {
            logScale = active !== 1;
        } else if (name === 'arrows') {
            const choice = ARROW_CHOICES.find(([, l]) => l === label);
            arrowMode = choice ? choice[0] : '';
        } else if (name === 'mode') {
            const el = document.getElementById('plot-mode');
            if (el) el.value = active === 0 ? 'odd' : 'even';
            if (window.onViewChanged) window.onViewChanged(view);
        } else {
            return;
        }
        draw();
    });
    container.on('plotly_restyle', (ev) => {
        const [upd, idx] = ev || [];
        if (!upd || !('visible' in upd) || !Array.isArray(idx)) return;
        idx.forEach((k, i) => {
            const t = container.data[k], key = t && (t.legendgroup || t.name);
            if (!key) return;
            const v = Array.isArray(upd.visible) ? upd.visible[i % upd.visible.length] : upd.visible;
            legendVisibility[key] = v === undefined ? true : v;
        });
    });
    container.on('plotly_relayout', (ev) => {
        if (ev && Object.keys(ev).some(k => k.startsWith('xaxis') || k.startsWith('yaxis'))) updateArrows(container);
        if (ev && ev['xaxis.autorange'] === true && ev['yaxis.autorange'] === true && view !== 'geometry') {
            delete storedScales[`${view}|${logScale}`];
            draw();
        }
    });
    container.on('plotly_afterplot', () => swapGeometryMenus(container));
    let t = null;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => packMenus(container), 150); });
}

// Geometry view: the original drew it with its own menu row; swap in ours.
function swapGeometryMenus(container) {
    if (view !== 'geometry' || container._forkSwapping || !container.layout) return;
    const solver = get && get.solver();
    const um = container.layout.updatemenus;
    if (!solver || (um && um[0] && um[0].name === 'view')) return;
    container._forkSwapping = true;
    getPlotly().relayout(container, { updatemenus: menus(solver), 'margin.t': 78 })
        .then(() => packMenus(container)).finally(() => { container._forkSwapping = false; });
}

// ---- plot config (built once, see the original's geometryPlotConfig) ----------------
let _config = null;
function plotConfig(Plotly) {
    return _config ??= {
        responsive: true, displayModeBar: true, scrollZoom: true,
        modeBarButtonsToRemove: ['select2d', 'lasso2d'],
        modeBarButtonsToAdd: [
            { name: 'Toggle Mesh', icon: Plotly.Icons.grid || Plotly.Icons.autoscale, click: () => { showMesh = !showMesh; draw(); } },
            { name: 'Scale Range', icon: Plotly.Icons.autoscale, click: toggleScaleDialog },
            { name: 'About this plot', icon: Plotly.Icons.question, click: () => window.showHelpModal && window.showHelpModal('fork_views') },
        ],
    };
}

// ---- draw ---------------------------------------------------------------------------
// Called first by the original's draw(). Returns true when it drew the plot.
export function forkDraw(resetZoom, accessors) {
    get = accessors;
    const solver = get.solver(), Plotly = getPlotly();
    const container = document.getElementById('sim_canvas');
    if (!solver || !Plotly || !container) return false;
    bindOnce(container);
    if (view !== 'geometry' && !solver.solution_valid) view = 'geometry';
    if (view === 'geometry') {
        // The original keeps its own view state; hold it at its geometry view.
        setCurrentView('geometry');
        return false;
    }
    drawFieldView(resetZoom, solver, Plotly, container);
    return true;
}

function drawFieldView(resetZoom, solver, Plotly, container) {
    let xRange = null, yRange = null;
    if (!resetZoom && container.layout && container.layout.xaxis) {
        xRange = container.layout.xaxis.range; yRange = container.layout.yaxis.range;
    }
    const maxY = displayTop(solver);
    const yTop = solver.y ? solver.y[solver.y.length - 1] : maxY;
    const wg = isWaveguide(solver);
    const needF = MQS_VIEWS.includes(view) || (wg && view === 'efield');
    const f = needF ? (ensureField(solver), okField(solver)) : okField(solver);
    let title = '', subtitle = '', traces = [], shapes = [], fieldView = null;
    const gridMM = () => (solver.x && solver.y
        ? [Array.from(solver.x, v => v * 1000), Array.from(solver.y, v => v * 1000)]
        : [[0, (solver.w || 1) * 2000], [0, (maxY || 1) * 1000]]);
    let xMM, yMM;
    if (needF && !f && fieldFailed(solver)) {
        title = `${VIEW_NAMES[view]} not available: ${currentField(solver).reason}`;
    } else if (needF && !f) {
        title = `Computing ${VIEW_NAMES[view].toLowerCase()} at ${formatFreq(plotFreq(solver))}…`;
    } else {
        const env = buildEnv(solver, view, f);
        fieldView = buildFieldView(env);
        if (fieldView.pending) { title = `Computing ${VIEW_NAMES[view].toLowerCase()}…`; fieldView = null; }
        else if (fieldView.error) { title = fieldView.error; fieldView = null; }
        else {
            traces.push(...fieldView.traces);
            shapes.push(...(fieldView.shapes || []));
            title = `${fieldView.title} · ${formatFreq(env.freq)}`;
            const info = fieldView.info || '';
            subtitle = env.ex.label + (!info ? '' : (env.ex.label.length + info.length > 100 ? '<br>' : ' · ') + info);
            xMM = fieldView.xMM; yMM = fieldView.yMM;
        }
    }
    lastResult = fieldView;
    if (!xMM) [xMM, yMM] = gridMM();
    if (!fieldView) {
        traces.push({ type: 'scatter', x: [xMM[0], xMM[xMM.length - 1]], y: [yMM[0], yMM[yMM.length - 1]],
                      mode: 'markers', marker: { size: 0, opacity: 0 }, showlegend: false, hoverinfo: 'skip' });
    }
    shapes.push(...outlineShapes(solver, Math.max(maxY, yTop)));
    const arrowTr = arrowPlaceholders(solver);
    traces.push(...arrowTr);
    // Mesh overlay: the eddy-current mesh for the H / J views, else the solve's mesh.
    const mesh = (MQS_VIEWS.includes(view) && f && f.triMesh) ? f.triMesh : solver.triMesh;
    if (showMesh && mesh) {
        const { nodes, tris, nTris } = mesh, seen = new Set(), ex = [], ey = [], nn = nodes.length / 2;
        const edge = (a, b) => {
            const n0 = Math.min(a, b), n1 = Math.max(a, b), key = n0 * (nn + 1) + n1;
            if (seen.has(key)) return; seen.add(key);
            ex.push(nodes[2 * n0] * 1000, nodes[2 * n1] * 1000, null); ey.push(nodes[2 * n0 + 1] * 1000, nodes[2 * n1 + 1] * 1000, null);
        };
        for (let t = 0; t < nTris; t++) { edge(tris[3 * t], tris[3 * t + 1]); edge(tris[3 * t + 1], tris[3 * t + 2]); edge(tris[3 * t + 2], tris[3 * t]); }
        traces.push({ type: 'scattergl', x: ex, y: ey, mode: 'lines', line: { width: 0.3, color: 'rgba(0,0,0,0.5)' }, showlegend: false, hoverinfo: 'skip' });
    }
    for (const t of traces) if (t.showlegend === undefined) t.showlegend = false;
    applyLegendVisibility(traces);
    const fit = { xRange, yRange };
    if (!xRange || resetZoom) {
        const gv = computeGeometryView(solver, maxY);
        if (gv) { fit.xRange = gv.xRange; fit.yRange = gv.yRange; }
        shiftPlotX(plotShiftMM(solver), [], [], fit);
    }
    shiftPlotX(plotShiftMM(solver), traces, shapes);
    const titleText = subtitle
        ? `${title}<br><span style="font-size:12px;color:#bbb">${subtitle.replace('<br>', '</span><br><span style="font-size:12px;color:#bbb">')}</span>`
        : title;
    const layout = {
        title: { text: titleText, font: { color: '#fff', size: 15 }, x: 0.5, xanchor: 'center', y: 0.985, yref: 'container', yanchor: 'top' },
        xaxis: darkAxis('Width (mm)', { scaleanchor: 'y', scaleratio: 1, range: fit.xRange }),
        yaxis: darkAxis('Height (mm)', { range: fit.yRange }),
        margin: { l: 70, r: 90, t: subtitle ? (subtitle.includes('<br>') ? 108 : 92) : 78, b: 60 },
        showlegend: traces.some(t => t.showlegend),
        legend: { x: 0.01, y: 0.99, xanchor: 'left', yanchor: 'top', bgcolor: 'rgba(30,30,30,0.7)',
                  bordercolor: '#555', borderwidth: 1, font: { color: '#ddd', size: 11 } },
        hovermode: 'closest', dragmode: 'pan',
        ...darkBackground(),
        plot_bgcolor: '#1a1a1a',
        shapes,
        updatemenus: menus(solver),
    };
    container._plotShift = plotShiftMM(solver);
    Plotly.react(container, traces, layout, plotConfig(Plotly));
    packMenus(container);
    if (arrowTr.length) updateArrows(container);
}

// ---- scale dialog -------------------------------------------------------------------
// Its own small dialog (the original's dialog writes into the original's plot state).
let dlg = null;
function closeScaleDialog() { if (dlg) dlg.style.display = 'none'; }
function toggleScaleDialog() {
    if (view === 'geometry') { if (window.toggleScaleDialog) window.toggleScaleDialog(); return; }
    if (!dlg) {
        dlg = document.createElement('div');
        dlg.id = 'forkScaleDialog';
        dlg.style.cssText = 'position:fixed;right:24px;top:120px;z-index:1000;background:#2a2a2a;border:1px solid #555;'
            + 'border-radius:6px;padding:10px 12px;color:#ddd;font-size:13px;width:220px;box-shadow:0 4px 16px rgba(0,0,0,.5)';
        dlg.innerHTML = '<div id="forkScaleTitle" style="font-weight:600;margin-bottom:8px"></div>'
            + '<label style="display:block;margin-bottom:6px">Max <input id="forkScaleMax" type="number" step="any" style="width:120px;float:right"></label>'
            + '<label style="display:block;margin-bottom:10px">Min <input id="forkScaleMin" type="number" step="any" style="width:120px;float:right"></label>'
            + '<button id="forkScaleAuto" type="button">Auto</button> <button id="forkScaleClose" type="button" style="float:right">Close</button>';
        document.body.appendChild(dlg);
        const apply = () => {
            if (!lastResult) return;
            const toZ = (x) => (lastResult.scaleLog ? (x > 0 ? Math.log10(x) : NaN) : x);
            const lo = toZ(Number(document.getElementById('forkScaleMin').value));
            const hi = toZ(Number(document.getElementById('forkScaleMax').value));
            if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)) return;
            storedScales[`${view}|${logScale}`] = { min: lo, max: hi };
            draw();
        };
        document.getElementById('forkScaleMin').addEventListener('change', apply);
        document.getElementById('forkScaleMax').addEventListener('change', apply);
        document.getElementById('forkScaleAuto').addEventListener('click', () => { delete storedScales[`${view}|${logScale}`]; draw(); fillDialog(); });
        document.getElementById('forkScaleClose').addEventListener('click', closeScaleDialog);
    }
    if (dlg.style.display === 'block') { closeScaleDialog(); return; }
    fillDialog();
    dlg.style.display = 'block';
}
function fillDialog() {
    if (!dlg || !lastResult) return;
    const toD = (z) => (lastResult.scaleLog ? 10 ** z : z);
    const fmt = (x) => (Number.isFinite(x) ? String(Number(x.toPrecision(4))) : '');
    document.getElementById('forkScaleTitle').textContent =
        `Color scale (${lastResult.scaleUnit || ''}${lastResult.scaleLog ? ', log' : ''})`;
    document.getElementById('forkScaleMin').value = fmt(toD(lastResult.zMin));
    document.getElementById('forkScaleMax').value = fmt(toD(lastResult.zMax));
}

// ---- controls and help --------------------------------------------------------------
// The excitation and the arrow density go into the original's Plot Options section.
function addControls() {
    const sec = document.querySelector('#plot-options .section-content');
    if (!sec || document.getElementById('fork-exc-kind')) return;
    const box = document.createElement('div');
    box.innerHTML = `
        <div class="control-group">
            <label>Excitation <span class="help-icon" onclick="showHelpModal('fork_excitation', event)">?</span></label>
            <select id="fork-exc-kind">
                <option value="V">Voltage per conductor</option>
                <option value="Vd">Voltage between conductors</option>
                <option value="I">Current per conductor</option>
                <option value="P">Total power</option>
            </select>
        </div>
        <div class="control-group">
            <label>Value (<span id="fork-exc-unit">V</span>)</label>
            <div style="display:flex; gap:6px;">
                <input type="number" id="fork-exc-value" value="1" min="0" step="any" style="flex:1; min-width:0;">
                <select id="fork-exc-rms" style="flex:1; min-width:0;">
                    <option value="peak">Peak</option>
                    <option value="rms">RMS</option>
                </select>
            </div>
        </div>
        <div class="control-group">
            <label>Arrows across the view <span class="help-icon" onclick="showHelpModal('fork_arrows', event)">?</span></label>
            <input type="number" id="fork-arrow-density" value="24" min="4" max="80" step="2">
        </div>`;
    sec.append(...box.children);
    for (const id of ['fork-exc-kind', 'fork-exc-value', 'fork-exc-rms', 'fork-arrow-density']) {
        document.getElementById(id).addEventListener('change', () => {
            for (const k of Object.keys(storedScales)) delete storedScales[k];
            updateControls();
            draw();
        });
    }
    updateControls();
}
// Units and choices of the excitation for the current line type.
function updateControls() {
    const solver = get && get.solver();
    const kindEl = document.getElementById('fork-exc-kind');
    if (!kindEl) return;
    const isWG = isWaveguide(solver), isDiff = isDifferential(solver);
    for (const o of kindEl.options) o.disabled = (isWG && o.value !== 'P') || (o.value === 'Vd' && !isDiff);
    if (kindEl.selectedOptions[0] && kindEl.selectedOptions[0].disabled) kindEl.value = isWG ? 'P' : 'V';
    document.getElementById('fork-exc-unit').textContent = { V: 'V', Vd: 'V', I: 'A', P: 'W' }[kindEl.value] || 'V';
    document.getElementById('fork-exc-rms').disabled = kindEl.value === 'P';
}
// Help: the fork's topics, everything else to the original's modal.
function wrapHelp() {
    const orig = window.showHelpModal;
    if (!orig || orig._fork) return;
    const wrapped = function (topic, event) {
        const h = FORK_HELP[topic];
        if (!h) return orig(topic, event);
        if (event) { event.stopPropagation(); event.preventDefault(); }
        document.getElementById('helpModalTitle').textContent = h.title;
        document.getElementById('helpModalBody').innerHTML = h.body;
        const content = document.querySelector('#helpModal .help-modal-content');
        if (content) content.classList.toggle('wide', true);
        document.getElementById('helpModal').style.display = 'block';
    };
    wrapped._fork = true;
    window.showHelpModal = wrapped;
}

export function initForkPlot() {
    window.forkPlot = { draw: forkDraw };
    const start = () => {
        addControls(); wrapHelp();
        // Line type changes: excitation choices follow (waveguide: power only).
        document.getElementById('tl_type')?.addEventListener('change', () => setTimeout(updateControls, 0));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
}

initForkPlot();
