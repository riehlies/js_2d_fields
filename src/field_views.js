// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Traces of the field views (potential, |E|, |H|, current density, power flow, losses),
// the field lines and contour lines drawn on them, and the E / H / S arrows.
//
// Every view is scaled by ONE excitation (src/field_excitation.js): the unit fields of the
// solver (E and potential for 1 V, H and J for 1 A, the waveguide for 1 W) are multiplied
// by the complex amplitudes cE = V / 1 V and cH = I / 1 A of the matched line. Fields are
// shown as peak amplitudes, power flow and losses as time averages.
//
// Color scales (all perceptually uniform, lightness growing with the value, readable with
// colour-vision deficiency and in greyscale):
//   potential, Jz (linear)   Signed: dark at 0, red positive, blue negative
//   |E|, |H|                 Viridis
//   |J| (log)                Inferno
//   power flow S             Electric
//   losses                   Magma
//
// Line conventions:
//   field lines (count "Field lines"): E lines in the geometry, potential and |E| views,
//       H lines (contours of the vector potential A_z) in the |H| view. Equal flux per line.
//   contour lines (count "Contour lines"): equipotentials in the geometry, potential and
//       |E| views; lines enclosing 50 / 90 / 99 % of the power in the power flow view.
//
// `env` (built by plot.js from the solver and the sidebar):
//   { solver, view, freq, ex, opt, E: {Ex, Ey}, V, epsAt, stored(view), f (H / J data),
//     alpha: { c, d } (attenuation in Np/m at the field frequency, or null) }
//   ex  = { ok, cE, cH, P, Pexp, label, waveguide, nCond, mode, note }
//   opt = { log, nLines, nContours }

import { shapeContains, isComplement, svgRingPath } from './shapes.js';
import { electricFieldLines } from './streamlines.js';
import { isoLines } from './isolines.js';
import { c, cmul, cconj, cabs, carg } from './field_excitation.js';

// ---- color scales --------------------------------------------------------------------
export const COLORSCALES = {
    Viridis: [[0, '#440154'], [0.0627, '#48186a'], [0.1255, '#472d7b'], [0.1882, '#424086'],
        [0.2510, '#3b528b'], [0.3137, '#33638d'], [0.3765, '#2c728e'], [0.4392, '#26828e'],
        [0.5020, '#21918c'], [0.5647, '#1fa088'], [0.6275, '#28ae80'], [0.6902, '#3fbc73'],
        [0.7529, '#5ec962'], [0.8157, '#84d44b'], [0.8784, '#addc30'], [0.9412, '#d8e219'], [1, '#fde725']],
    // matplotlib's Inferno and Magma.
    Inferno: [[0, '#000004'], [0.1, '#160b39'], [0.2, '#420a68'], [0.3, '#6a176e'], [0.4, '#932667'],
        [0.5, '#bc3754'], [0.6, '#dd513a'], [0.7, '#f37819'], [0.8, '#fca50a'], [0.9, '#f6d746'], [1, '#fcffa4']],
    Magma: [[0, '#000004'], [0.1, '#140e36'], [0.2, '#3b0f70'], [0.3, '#641a80'], [0.4, '#8c2981'],
        [0.5, '#b73779'], [0.6, '#de4968'], [0.7, '#f7705c'], [0.8, '#fe9f6d'], [0.9, '#fecf92'], [1, '#fcfdbf']],
    // Black → violet → amber → cream; lightness rises monotonically, with a steep step in
    // the upper third that makes the high power densities stand out.
    Electric: [[0, 'rgb(0,0,0)'], [0.15, 'rgb(30,0,100)'], [0.4, 'rgb(120,0,100)'], [0.6, 'rgb(160,90,0)'],
        [0.8, 'rgb(230,200,0)'], [1, 'rgb(255,250,220)']],
    // Diverging, DARK at zero (after F. Crameri's "berlin"): blue negative, red positive,
    // lightness grows with |value| on both sides. On the dark plot background zero (the
    // ground, a symmetry plane at 0 V, no current) stays dark; blue and red stay apart
    // for red-green colour-vision deficiency.
    Signed: [[0, '#9eb0ff'], [0.15, '#5aa2d9'], [0.3, '#2b6a8a'], [0.45, '#12222e'], [0.5, '#110d08'],
        [0.55, '#2b1205'], [0.7, '#722a14'], [0.85, '#b25a46'], [1, '#ffadad']],
};
// Plotly colorscale for a scale name: the arrays above, so the heatmaps and the ring
// views of the coax use identical colors.
const cs = (name) => COLORSCALES[name] || name;
function parseColor(col) {
    if (col[0] === '#') return [1, 3, 5].map(i => parseInt(col.slice(i, i + 2), 16));
    return col.match(/\d+/g).slice(0, 3).map(Number);
}
// Color of t ∈ [0, 1] on a scale, quantized to 256 levels (adjacent equal colors merge).
export function colorAt(scale, t) {
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

// Colorbar ticks for a log10 color axis, labelled with the actual values: decades, or
// 1-2-5 steps below three decades, or every mantissa 1…9 when the range spans less, or three ticks across a
// very narrow range.
export function logTicks(zmin, zmax) {
    const fmt = (v) => String(+(10 ** v).toPrecision(2)).replace(/\.0+e/, 'e');
    const steps = (ms) => {
        const out = [];
        for (let k = Math.floor(zmin) - 1; k <= Math.ceil(zmax); k++)
            for (const m of ms) { const v = k + Math.log10(m); if (v >= zmin - 1e-9 && v <= zmax + 1e-9) out.push(v); }
        return out;
    };
    let vals = [];
    for (let k = Math.ceil(zmin); k <= Math.floor(zmax); k++) vals.push(k);
    if (vals.length < 3) { const v2 = steps([1, 2, 5]); if (v2.length > vals.length) vals = v2; }
    if (vals.length < 2) vals = steps([1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9]);
    if (vals.length < 2) vals = [zmin, (zmin + zmax) / 2, zmax];
    if (!(zmax > zmin)) return {};
    return { tickvals: vals, ticktext: vals.map(fmt) };
}

export function formatFreq(f) {
    if (f >= 1e9) return `${+(f / 1e9).toPrecision(4)} GHz`;
    if (f >= 1e6) return `${+(f / 1e6).toPrecision(4)} MHz`;
    if (f >= 1e3) return `${+(f / 1e3).toPrecision(4)} kHz`;
    return `${+f.toPrecision(4)} Hz`;
}

export function formatLength(m) {
    if (m >= 1e-3) return `${+(m * 1e3).toPrecision(3)} mm`;
    return `${+(m * 1e6).toPrecision(3)} µm`;
}

// ---- small helpers ------------------------------------------------------------------
const EPS0 = 8.8541878128e-12;
const LINE = {
    fieldDark: { color: 'rgba(15, 15, 15, 0.9)', width: 1.1 },
    equiDark: { color: 'rgba(30, 30, 30, 0.55)', width: 1, dash: 'dot' },
    fieldLight: { color: 'rgba(255, 255, 255, 0.85)', width: 1.1 },
    equiLight: { color: 'rgba(255, 255, 255, 0.5)', width: 1, dash: 'dot' },
};

function percentile(vals, q) {
    if (!vals.length) return 0;
    const a = Float64Array.from(vals).sort();
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
}

// Value below which the fraction q of the total weight lies.
function weightedPercentile(vals, wts, q) {
    if (!vals.length) return 0;
    const idx = Array.from(vals.keys()).sort((a, b) => vals[a] - vals[b]);
    let tot = 0;
    for (const w of wts) tot += w;
    let acc = 0;
    for (const k of idx) { acc += wts[k]; if (acc >= q * tot) return vals[k]; }
    return vals[idx[idx.length - 1]];
}

// Half the distance to the neighbours: the cell width of a node of a graded grid.
const cellWidths = (a) => Array.from(a, (v, i) => 0.5 * (a[Math.min(a.length - 1, i + 1)] - a[Math.max(0, i - 1)]));

// Conductor interior on a rectilinear grid (cached per grid).
const maskCache = new WeakMap();
export function metalMask(solver, xs, ys) {
    const key = xs;
    const hit = maskCache.get(key);
    if (hit && hit.ys === ys && hit.n === (solver.conductors || []).length) return hit.mask;
    const conds = solver.conductors || [];
    const mask = Array.from({ length: ys.length }, (_, j) => {
        const row = new Uint8Array(xs.length);
        for (let i = 0; i < xs.length; i++) {
            for (const cd of conds) if (shapeContains(cd, xs[i], ys[j], 0)) { row[i] = 1; break; }
        }
        return row;
    });
    maskCache.set(key, { ys, n: conds.length, mask });
    return mask;
}

// Relative permittivity and loss tangent at a point (the last dielectric that contains it).
function dielectricPropsAt(solver, x, y) {
    let er = 1, tand = 0;
    for (const d of (solver.dielectrics || [])) {
        if (shapeContains(d, x, y, 0)) { er = d.epsilon_r; tand = d.tan_delta || 0; }
    }
    return { er, tand };
}
export function dielectricAt(solver, x, y) { return dielectricPropsAt(solver, x, y).er; }

// Is the solver a concentric coax / a waveguide?
export function isCoax(solver) {
    return !!solver && typeof solver.a === 'number' && typeof solver.b === 'number'
        && (solver.conductors || []).some(cd => cd.shape && isComplement(cd.shape));
}
export function isWaveguide(solver) {
    return !!solver && solver.mode_type === 'waveguide';
}

// Color axis of a view. `vals` are the plotted (linear) values that set the range:
//   signed: symmetric around 0 up to `top` (Signed scale), linear only
//   log:    log10, from `top` down `decades`, or less when the values (`vals`) span less
//           (their 2nd percentile, at least half a decade), so a field that varies little
//           still shows its variation
//   else:   0 … top
// Applies the stored override of the scale dialog. Returns the axis and the mapping of a
// value to its plotted z.
function colorAxis(env, { log, top, decades = 4, signed = false, unit, vals = null }) {
    const useLog = log && !signed;
    let zmin, zmax;
    if (signed) { zmax = Math.max(top, 1e-300); zmin = -zmax; }
    else if (useLog) {
        zmax = Math.log10(Math.max(top, 1e-300));
        zmin = zmax - decades;
        const lo = vals && vals.length ? percentile(vals, 0.02) : 0;
        if (lo > 0) zmin = Math.min(zmax - 0.5, Math.max(zmin, Math.log10(lo)));
    }
    else { zmin = 0; zmax = Math.max(top, 1e-300); }
    const dataMin = zmin, dataMax = zmax;
    const ov = env.stored(env.view);
    if (ov) { zmin = ov.min; zmax = ov.max; }
    const colorbar = { title: { text: useLog ? `log₁₀ ${unit}` : unit }, len: 0.8 };
    if (useLog) Object.assign(colorbar, logTicks(zmin, zmax));
    const toZ = useLog ? (v) => (v === null || !(v > 0) ? null : Math.log10(v)) : (v) => v;
    return { zmin, zmax, dataMin, dataMax, colorbar, toZ, log: useLog, unit };
}

// One heatmap trace on a rectilinear grid; `raw` holds the values shown in the hover.
function heatmap(xMM, yMM, raw, ax, scale, qty, digits = 4) {
    const z = ax.log ? raw.map(row => Array.from(row, ax.toZ)) : raw;
    return {
        type: 'heatmap', zsmooth: 'best', x: xMM, y: yMM, z, zmin: ax.zmin, zmax: ax.zmax, customdata: raw,
        colorscale: cs(scale), colorbar: ax.colorbar,
        hovertemplate: `x: %{x:.${digits}f} mm<br>y: %{y:.${digits}f} mm<br>${qty}: %{customdata:.3e} ${ax.unit}<extra></extra>`,
    };
}

// Result fields shared by every view.
const axisResult = (ax) => ({ zMin: ax.zmin, zMax: ax.zmax, dataMin: ax.dataMin, dataMax: ax.dataMax,
                              scaleLog: ax.log, scaleUnit: ax.unit });

// Contour lines of z at the levels m·step (m ≠ 0) up to ±maxAbs, plus the zero level if
// asked (not by default: for a single-ended line z = 0 is the ground, and a zero contour
// would trace the masked metal edges). One line trace (isolines.js), not a Plotly contour
// trace, which would re-contour the whole grid on every redraw.
function levelTraces(xMM, yMM, z, step, maxAbs, { zero = false, line, name, legend = true }) {
    if (!(step > 0) || !(maxAbs > 0)) return [];
    const K = Math.floor(maxAbs / step - 1e-9);
    const levels = [];
    for (let m = 1; m <= K; m++) levels.push(m * step, -m * step);
    if (zero) levels.push(0);
    if (!levels.length) return [];
    const l = isoLines(xMM, yMM, z, levels);
    if (!l.x.length) return [];
    return [{ type: 'scatter', mode: 'lines', x: l.x, y: l.y, line, hoverinfo: 'skip', name, showlegend: legend }];
}

// ---- unit-field samplers -----------------------------------------------------------
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

// Unit E: 1 V per conductor (waveguide: 1 W), real.
function unitESampler(env) {
    const { solver, f } = env;
    if (isWaveguide(solver)) return (f && f.kind === 'wg' && f.Exr) ? gridPhasor(f.x, f.y, f.Exr, null, f.Eyr, null) : null;
    if (isCoax(solver)) {
        const a = solver.a, b = solver.b, k = 1 / Math.log(b / a);
        return (x, y) => {
            const r = Math.hypot(x, y);
            if (!(r > a && r < b)) return null;
            const e = k / r;
            return { xr: e * x / r, xi: 0, yr: e * y / r, yi: 0 };
        };
    }
    const { Ex, Ey } = env.E || {};
    if (!Ex || !Ey || !solver.x) return null;
    return gridPhasor(solver.x, solver.y, Ex, null, Ey, null);
}

// Unit H: 1 A per conductor (waveguide: 1 W), with the sign that makes E × H point +z.
function unitHSampler(env) {
    const f = env.f;
    if (!f) return null;
    const s = hSign(env);
    if (f.kind === 'radial') {
        const rings = f.rings;
        return (x, y) => {
            const dx = x - f.cx, dy = y - f.cy, r = Math.hypot(dx, dy);
            if (!(r > 0) || r > rings[rings.length - 1].r1) return null;
            let lo = 0, hi = rings.length - 1;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (rings[mid].r1 < r) lo = mid + 1; else hi = mid; }
            const g = rings[lo], cs = dx / r, sn = dy / r;
            return { xr: -s * g.Hr * sn, xi: -s * g.Hi * sn, yr: s * g.Hr * cs, yi: s * g.Hi * cs };
        };
    }
    const base = gridPhasor(f.x, f.y, f.Hxr, f.Hxi, f.Hyr, f.Hyi);
    return s === 1 ? base : (x, y) => {
        const v = base(x, y);
        return v && { xr: -v.xr, xi: -v.xi, yr: -v.yr, yi: -v.yi };
    };
}

// Sign convention of the H / J export relative to the static E: +1 if the unit fields
// give power flow in +z, −1 if the export's current runs the other way. Cached per field.
function hSign(env) {
    const f = env.f;
    if (!f) return 1;
    if (f._hSign) return f._hSign;
    if (f.kind === 'radial' || f.kind === 'wg') {
        // Coax and waveguide closed forms are built with power in +z.
        f._hSign = 1;
        return 1;
    }
    const E = unitESampler({ ...env, f: null });
    let sum = 0;
    if (E) {
        for (let j = 0; j < f.y.length; j += 2) for (let i = 0; i < f.x.length; i += 2) {
            const hx = f.Hxr[j][i], hy = f.Hyr[j][i];
            if (!Number.isFinite(hx) || !Number.isFinite(hy) || Number.isFinite(f.J[j][i])) continue;
            const e = E(f.x[i], f.y[j]);
            if (e) sum += e.xr * hy - e.yr * hx;
        }
    }
    f._hSign = sum < 0 ? -1 : 1;
    return f._hSign;
}

// ---- E field lines and equipotentials (geometry, potential and |E| views) ----------
function staticLineTraces(env, dark) {
    const { solver, ex, opt } = env;
    const out = [];
    const xs = solver.x, ys = solver.y;
    if (!xs || !ys) return out;
    const amp = cabs(ex.cE) || 1;
    const xMM = Array.from(xs, v => v * 1000), yMM = Array.from(ys, v => v * 1000);
    // Equipotentials in equal voltage steps.
    if (opt.nContours > 0 && env.V) {
        const mask = metalMask(solver, xs, ys);
        let vmin = Infinity, vmax = -Infinity;
        for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) {
            if (mask[j][i]) continue;
            const v = env.V[j][i];
            if (v < vmin) vmin = v; if (v > vmax) vmax = v;
        }
        const step = amp * (vmax - vmin) / (opt.nContours + 1);
        const z = env.V.map((row, j) => Array.from(row, (v, i) => (mask[j][i] ? null : amp * v)));
        out.push(...levelTraces(xMM, yMM, z, step, amp * Math.max(Math.abs(vmin), Math.abs(vmax)),
            { zero: vmin < -1e-6, line: dark ? LINE.equiDark : LINE.equiLight, name: 'Equipotentials' }));
    }
    if (opt.nLines > 0 && env.E && env.E.Ex) {
        const fl = electricFieldLines({ Ex: env.E.Ex, Ey: env.E.Ey, x: xs, y: ys,
            conductors: solver.conductors || [], epsAt: env.epsAt, n: opt.nLines });
        if (fl.x.length) out.push({ type: 'scatter', mode: 'lines', x: fl.x, y: fl.y, hoverinfo: 'skip',
            line: dark ? LINE.fieldDark : LINE.fieldLight, name: 'E field lines', showlegend: true });
    }
    return out;
}

// ---- coax: closed form on rings ------------------------------------------------------
function coaxRings(solver) {
    const a = solver.a, b = solver.b, n = 120, out = [];
    for (let i = 0; i < n; i++) out.push({ r0: a * Math.pow(b / a, i / n), r1: a * Math.pow(b / a, (i + 1) / n) });
    return out;
}

// Filled concentric rings of one value each (plotted z), merged where neighbours share a
// color and painted from the outside in (no anti-aliasing seams).
function ringShapes(rings, z, scale, zmin, zmax, cx, cy) {
    const shapes = [], groups = [];
    let grp = null;
    rings.forEach((g, k) => {
        const v = z[k];
        if (v === null || v === undefined) { grp = null; return; }
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
            shapes.push({ type: 'path', path: svgRingPath(cx, cy, gp.r0 * 1000, rg.r1 * 1000, 360),
                fillcolor: rg.color, fillrule: 'evenodd', line: { width: 0, color: 'rgba(0,0,0,0)' }, layer: 'between' });
        }
    }
    return shapes;
}

// Ring view of linear values `vals`: shapes, axis extent, hover probes along +x and the
// colorbar.
function ringView(rings, vals, ax, scale, R, cx, cy, qty) {
    const z = vals.map(v => (v === null ? null : ax.toZ(v)));
    const shapes = ringShapes(rings, z, scale, ax.zmin, ax.zmax, cx, cy);
    const probes = rings.map((g, k) => ({ x: cx + 500 * (g.r0 + g.r1), v: vals[k] })).filter(p => p.v !== null);
    const traces = [
        { type: 'scatter', mode: 'markers', x: [cx - R, cx + R], y: [cy - R, cy + R], marker: { size: 0, opacity: 0 },
          hoverinfo: 'skip', showlegend: false },
        { type: 'scatter', mode: 'markers', x: probes.map(p => p.x), y: probes.map(() => cy),
          customdata: probes.map(p => p.v), marker: { size: 6, color: 'rgba(0,0,0,0)' }, showlegend: false,
          hovertemplate: `r: %{x:.4f} mm<br>${qty}: %{customdata:.3e} ${ax.unit}<extra></extra>` },
        { type: 'scatter', mode: 'markers', x: [cx], y: [cy], hoverinfo: 'skip', showlegend: false,
          marker: { size: 0.1, opacity: 0, color: [ax.zmin], cmin: ax.zmin, cmax: ax.zmax,
                    colorscale: COLORSCALES[scale], showscale: true, colorbar: ax.colorbar } },
    ];
    return { shapes, traces };
}

function coaxLineTraces(env, dark) {
    const { solver, opt } = env;
    const out = [];
    const a = solver.a, b = solver.b;
    if (opt.nContours > 0) {
        // V(r) ∝ ln(b/r): circles in equal voltage steps.
        const X = [], Y = [];
        for (let m = 1; m <= opt.nContours; m++) {
            const r = b * Math.pow(a / b, m / (opt.nContours + 1)) * 1000;
            for (let k = 0; k <= 180; k++) { const t = 2 * Math.PI * k / 180; X.push(r * Math.cos(t)); Y.push(r * Math.sin(t)); }
            X.push(null); Y.push(null);
        }
        out.push({ type: 'scatter', mode: 'lines', x: X, y: Y, hoverinfo: 'skip',
            line: dark ? LINE.equiDark : LINE.equiLight, name: 'Equipotentials', showlegend: true });
    }
    const n = opt.nLines;
    if (n > 0) {
        const X = [], Y = [];
        for (let k = 0; k < n; k++) {
            const t = 2 * Math.PI * (k + 0.5) / n;
            X.push(a * 1000 * Math.cos(t), b * 1000 * Math.cos(t), null);
            Y.push(a * 1000 * Math.sin(t), b * 1000 * Math.sin(t), null);
        }
        out.push({ type: 'scatter', mode: 'lines', x: X, y: Y, hoverinfo: 'skip',
            line: dark ? LINE.fieldDark : LINE.fieldLight, name: 'E field lines', showlegend: true });
    }
    return out;
}

// Potential / |E| of the coax from the closed form, V(r) = V·ln(b/r)/ln(b/a).
function coaxStaticView(env, isE) {
    const { solver, ex, opt } = env;
    const a = solver.a, b = solver.b, L = Math.log(b / a);
    const rings = coaxRings(solver);
    const amp = cabs(ex.cE);
    const vals = rings.map(g => {
        const r = Math.sqrt(g.r0 * g.r1);
        return isE ? amp / (r * L) : amp * Math.log(b / r) / L;
    });
    // |E| ∝ 1/r spans only log10(b/a) decades: the log scale covers just that range.
    const ax = isE ? colorAxis(env, { log: opt.log, top: amp / (a * L), decades: Math.max(0.3, Math.log10(b / a)), unit: 'V/m' })
                   : colorAxis(env, { signed: true, top: amp, unit: 'V' });
    const scale = isE ? 'Viridis' : 'Signed';
    const R = (b + (solver.shield_thickness || 0.1 * b)) * 1000;
    const { shapes, traces } = ringView(rings, vals, ax, scale, R, 0, 0, isE ? '|E|' : 'V');
    if (!isE) {
        // Conductors at their potential: inner conductor V, shield 0.
        const col = (v) => colorAt(scale, (v - ax.zmin) / ((ax.zmax - ax.zmin) || 1));
        const am = a * 1000;
        shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: -am, y0: -am, x1: am, y1: am,
            fillcolor: col(amp), line: { width: 0, color: 'rgba(0,0,0,0)' }, layer: 'between' });
        shapes.push({ type: 'path', path: svgRingPath(0, 0, b * 1000, R, 360), fillcolor: col(0), fillrule: 'evenodd',
            line: { width: 0, color: 'rgba(0,0,0,0)' }, layer: 'between' });
    }
    traces.push(...coaxLineTraces(env, false));
    return { traces, shapes, ...axisResult(ax), xMM: [-R, R], yMM: [-R, R],
             title: `${isE ? '|E| (peak)' : 'Potential (peak)'} · closed form` };
}

// ---- waveguide E -------------------------------------------------------------------
// TE10 E lines run straight between the broad walls, spaced so each carries equal flux:
// the line density follows sin(πx/a). TE01 the same rotated.
function waveguideLineTraces(env, dark) {
    const { solver, opt, f } = env;
    const w = solver.enclosure_walls;
    if (!w) return [];
    const along = f && f.mode === 'TE01' ? 'y' : ((w.x_max - w.x_min) >= (w.y_max - w.y_min) ? 'x' : 'y');
    const n = opt.nLines;
    if (!(n > 0)) return [];
    const X = [], Y = [];
    for (let k = 0; k < n; k++) {
        const F = (k + 0.5) / n;
        const u = Math.acos(1 - 2 * F) / Math.PI;          // CDF of sin(πu) on [0, 1]
        if (along === 'x') {
            const x = (w.x_min + u * (w.x_max - w.x_min)) * 1000;
            X.push(x, x, null); Y.push(w.y_min * 1000, w.y_max * 1000, null);
        } else {
            const y = (w.y_min + u * (w.y_max - w.y_min)) * 1000;
            X.push(w.x_min * 1000, w.x_max * 1000, null); Y.push(y, y, null);
        }
    }
    return [{ type: 'scatter', mode: 'lines', x: X, y: Y, hoverinfo: 'skip',
              line: dark ? LINE.fieldDark : LINE.fieldLight, name: 'E field lines', showlegend: true }];
}

function waveguideEView(env) {
    const { f, ex, opt } = env;
    const xMM = Array.from(f.x, v => v * 1000), yMM = Array.from(f.y, v => v * 1000);
    const amp = cabs(ex.cE);
    let peak = 0;
    const raw = f.Exr.map((row, j) => Array.from(row, (exr, i) => {
        const v = amp * Math.hypot(exr, f.Eyr[j][i]);
        if (!Number.isFinite(v)) return null;
        peak = Math.max(peak, v);
        return v;
    }));
    const ax = colorAxis(env, { log: opt.log, top: peak, decades: 2, unit: 'V/m',
                                vals: raw.flat().filter(v => v > 0) });
    const traces = [heatmap(xMM, yMM, raw, ax, 'Viridis', '|E|', 3)];
    traces.push(...waveguideLineTraces(env, false));
    return { traces, shapes: [], ...axisResult(ax), xMM, yMM, title: `|E| (peak) · ${f.mode}` };
}

// ---- potential and |E| on the static grid ------------------------------------------
function staticView(env, isE) {
    const { solver, ex, opt } = env;
    const xs = solver.x, ys = solver.y;
    const xMM = Array.from(xs, v => v * 1000), yMM = Array.from(ys, v => v * 1000);
    const amp = cabs(ex.cE);
    let raw, ax;
    if (isE) {
        const mask = metalMask(solver, xs, ys);
        const { Ex, Ey } = env.E;
        const all = [], wts = [];
        const wx = cellWidths(xs), wy = cellWidths(ys);
        raw = Ex.map((row, j) => Array.from(row, (exv, i) => {
            if (mask[j][i]) return null;
            const v = amp * Math.hypot(exv, Ey[j][i]);
            if (!Number.isFinite(v)) return null;
            all.push(v); wts.push(wx[i] * wy[j]);
            return v;
        }));
        // The field is singular at conductor corners, where the grid is also densest: the
        // color range ends where 99.99 % of the cross-section AREA has a lower field (the
        // same scale for the graded quasi-static grid and the full-wave resampling).
        ax = colorAxis(env, { log: opt.log, top: weightedPercentile(all, wts, 0.9999), decades: 3, unit: 'V/m', vals: all });
    } else {
        // The potential is defined in the conductors too (each is an equipotential at
        // its drive voltage), so they keep their color here. Symmetric scale around 0 V:
        // the ground (and the symmetry plane of an odd-mode pair) is dark.
        let vmax = 0;
        raw = env.V.map((row) => Array.from(row, (v) => {
            if (!Number.isFinite(v)) return null;
            vmax = Math.max(vmax, Math.abs(v));
            return amp * v;
        }));
        ax = colorAxis(env, { signed: true, top: amp * vmax, unit: 'V' });
    }
    const traces = [heatmap(xMM, yMM, raw, ax, isE ? 'Viridis' : 'Signed', isE ? '|E|' : 'V', 3)];
    traces.push(...staticLineTraces(env, false));
    return { traces, shapes: [], ...axisResult(ax), xMM, yMM, title: isE ? '|E| (peak)' : 'Potential (peak)' };
}

// ---- |H| and current density ---------------------------------------------------------
// |H| and |J| as peak amplitudes. On a linear scale J is drawn with its sign instead:
// Re{Jz} at the moment the line current peaks, current along +z red, return current
// blue (not for the waveguide, whose wall current also runs around the perimeter).
function mqsView(env, isH) {
    const { f, ex, opt } = env;
    if (f.kind === 'radial') return coaxMqsView(env, isH);
    const xMM = Array.from(f.x, v => v * 1000), yMM = Array.from(f.y, v => v * 1000);
    const amp = cabs(ex.cH), sg = hSign(env);
    const signed = !isH && !opt.log && !f.Jtr;
    // peakVals set the top of the scale; the H outside the metal sets the bottom of a log
    // scale (inside, H decays to nothing within a few skin depths).
    const raw = [], peakVals = [], outside = [];
    for (let j = 0; j < f.y.length; j++) {
        const row = new Array(f.x.length);
        for (let i = 0; i < f.x.length; i++) {
            const pk = isH ? amp * f.H[j][i] : amp * f.J[j][i] * 1e-6;
            const v = signed ? sg * amp * f.Jr[j][i] * 1e-6 : pk;
            row[i] = Number.isFinite(v) ? v : null;
            if (Number.isFinite(pk) && pk > 0) {
                peakVals.push(pk);
                if (isH && !Number.isFinite(f.J[j][i])) outside.push(pk);
            }
        }
        raw.push(row);
    }
    let pkMax = 0;
    for (const v of peakVals) if (v > pkMax) pkMax = v;
    const unit = isH ? 'A/m' : 'A/mm²';
    const ax = colorAxis(env, { log: opt.log, signed, top: opt.log ? pkMax : (percentile(peakVals, 0.99) || pkMax),
                                decades: isH ? 3 : 4, unit, vals: isH ? outside : peakVals });
    const qty = isH ? '|H|' : (signed ? 'Jz' : (f.Jtr ? '|J|' : '|Jz|'));
    const traces = [heatmap(xMM, yMM, raw, ax, signed ? 'Signed' : (isH ? 'Viridis' : 'Inferno'), qty)];
    if (isH && opt.nLines > 0 && f.kind === 'wg' && !env.arrowsH) {
        // Waveguide: the transverse H has sources (∂Hz/∂z), no potential to draw contours
        // of. Arrows of the transverse field instead.
        traces.push(quiverTrace(f, ex.cH, opt.nLines));
    }
    if (isH && opt.nLines > 0 && f.Ar) traces.push(...hFieldLines(env, amp, xMM, yMM));
    const per = f.kind === 'wg' ? ` · ${f.mode}` : (f.differential ? (f.mode === 'even' ? ' · even mode' : ' · odd mode') : '');
    const what = signed ? 'Jz at the current maximum' : `${qty} (peak)`;
    return { traces, shapes: [], ...axisResult(ax), xMM, yMM, title: `${what}${per} · δ = ${formatLength(f.delta)}` };
}

// H field lines = contour lines of the vector potential A_z (in phase with the line
// current). Equal ΔA between lines, so the line density is proportional to |B|.
function hFieldLines(env, amp, xMM, yMM) {
    const { f, opt } = env;
    const A = [];
    let pLo = Infinity, pHi = -Infinity, sawNeg = false, sawPos = false;
    for (let j = 0; j < f.y.length; j++) {
        const row = new Array(f.x.length);
        for (let i = 0; i < f.x.length; i++) {
            const ar = f.Ar[j][i];
            if (!Number.isFinite(ar)) { row[i] = null; continue; }
            row[i] = amp * ar;
            if (!Number.isFinite(f.J[j][i])) {   // dielectric: sets the level range
                if (row[i] < pLo) pLo = row[i]; if (row[i] > pHi) pHi = row[i];
                if (ar < 0) sawNeg = true; if (ar > 0) sawPos = true;
            }
        }
        A.push(row);
    }
    if (!(pHi > pLo)) return [];
    const step = (pHi - pLo) / (opt.nLines + 1);
    return levelTraces(xMM, yMM, A, step, Math.max(Math.abs(pLo), Math.abs(pHi)),
        { zero: sawNeg && sawPos, line: { color: 'rgba(255, 255, 255, 0.55)', width: 1 }, name: 'H field lines' });
}

// Arrows of the transverse H on a coarse grid (waveguide), at the phase of the drive.
function quiverTrace(r, cH, n) {
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    const ny = r.y.length, nx = r.x.length;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!Number.isFinite(r.H[j][i]) || Number.isFinite(r.J[j][i])) continue;   // interior only
        xlo = Math.min(xlo, r.x[i]); xhi = Math.max(xhi, r.x[i]);
        ylo = Math.min(ylo, r.y[j]); yhi = Math.max(yhi, r.y[j]);
    }
    const W = xhi - xlo, Hh = yhi - ylo;
    const nc = Math.max(4, Math.round(n * Math.sqrt(W / Hh))), nr = Math.max(3, Math.round(n * Math.sqrt(Hh / W)));
    const ph = -carg(cH), cw = Math.cos(ph), sw = Math.sin(ph);
    const re = (xr, xi) => (cH.re * xr - cH.im * xi) * cw - (cH.re * xi + cH.im * xr) * sw;
    const pts = [];
    let vmax = 0;
    for (let a = 0; a < nr; a++) for (let cc = 0; cc < nc; cc++) {
        const x = xlo + W * (cc + 0.5) / nc, y = ylo + Hh * (a + 0.5) / nr;
        const i = nearestIndex(r.x, x), j = nearestIndex(r.y, y);
        const hx = re(r.Hxr[j][i], r.Hxi[j][i]), hy = re(r.Hyr[j][i], r.Hyi[j][i]);
        pts.push([x, y, hx, hy]);
        vmax = Math.max(vmax, cabs(cH) * Math.hypot(Math.hypot(r.Hxr[j][i], r.Hxi[j][i]), Math.hypot(r.Hyr[j][i], r.Hyi[j][i])));
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
        hoverinfo: 'skip', showlegend: true, name: 'H field (transverse)',
    };
}

// Coax |H| / J from the closed-form rings.
function coaxMqsView(env, isH) {
    const { f, ex, opt } = env;
    const amp = cabs(ex.cH);
    const signed = !isH && !opt.log;
    const vals = f.rings.map(g => {
        if (isH) return amp * Math.hypot(g.Hr, g.Hi);
        if (g.Jr === null) return null;
        return (signed ? amp * g.Jr : amp * Math.hypot(g.Jr, g.Ji)) * 1e-6;
    });
    let pkMax = 0;
    for (const g of f.rings) {
        const v = isH ? amp * Math.hypot(g.Hr, g.Hi) : (g.Jr === null ? 0 : amp * Math.hypot(g.Jr, g.Ji) * 1e-6);
        if (v > pkMax) pkMax = v;
    }
    const unit = isH ? 'A/m' : 'A/mm²';
    const ax = colorAxis(env, { log: opt.log, signed, top: pkMax, decades: isH ? 3 : 4, unit,
                                vals: vals.filter((v, k) => v !== null && v > 0 && (!isH || f.rings[k].Jr === null)) });
    const scale = signed ? 'Signed' : (isH ? 'Viridis' : 'Inferno');
    const cxm = f.cx * 1000, cym = f.cy * 1000;
    const R = (f.b + f.tShield) * 1000;
    const qty = isH ? '|H|' : (signed ? 'Jz' : '|Jz|');
    const { shapes, traces } = ringView(f.rings, vals, ax, scale, R, cxm, cym, qty);
    // H field lines: circles at equal steps of A ∝ ln(b/r) (density ∝ |H|). A line
    // trace, not shapes, so the legend switches them like the other field lines.
    if (isH && opt.nLines > 0) {
        const X = [], Y = [];
        for (let k = 1; k <= opt.nLines; k++) {
            const rr = f.b * Math.pow(f.a / f.b, k / (opt.nLines + 1)) * 1000;
            for (let q = 0; q <= 180; q++) { const t = 2 * Math.PI * q / 180; X.push(cxm + rr * Math.cos(t)); Y.push(cym + rr * Math.sin(t)); }
            X.push(null); Y.push(null);
        }
        traces.push({ type: 'scatter', mode: 'lines', x: X, y: Y, hoverinfo: 'skip', name: 'H field lines',
                      showlegend: true, line: { color: 'rgba(255, 255, 255, 0.55)', width: 1 } });
    }
    const what = signed ? 'Jz at the current maximum' : `${qty} (peak)`;
    return { traces, shapes, ...axisResult(ax), xMM: [-R, R], yMM: [-R, R],
             title: `${what} · δ = ${formatLength(f.delta)}` };
}

// ---- power flow --------------------------------------------------------------------
// Time-average S_z = ½·Re(E × H*) from the scaled fields. On the matched line it is
// non-negative (numerical noise below zero is drawn as 0). The integral over the
// cross-section is the transmitted power, shown next to the value the excitation
// predicts as a consistency check.
function powerView(env) {
    const { f, ex, opt, solver } = env;
    if (f.kind === 'radial') return coaxPowerView(env);
    const E = unitESampler(env);
    if (!E) return null;
    const cH = cmul(ex.cH, c(hSign(env)));
    const k = cmul(ex.cE, cconj(cH));
    const xs = f.x, ys = f.y, nx = xs.length, ny = ys.length;
    const conds = solver.conductors || [];
    const wx = cellWidths(xs), wy = cellWidths(ys);
    const avg = [], cells = [], pos = [];
    let total = 0, inDiel = 0;
    for (let j = 0; j < ny; j++) {
        const row = new Array(nx).fill(null);
        for (let i = 0; i < nx; i++) {
            const x = xs[i], y = ys[j];
            const hxr = f.Hxr[j][i], hyr = f.Hyr[j][i];
            if (!Number.isFinite(hxr) || !Number.isFinite(hyr) || Number.isFinite(f.J[j][i])
                || conds.some(cd => shapeContains(cd, x, y, 0))) continue;
            const e = E(x, y);
            if (!e) continue;
            // ex·hy* − ey·hx* (unit fields, E real)
            const qr = e.xr * hyr - e.yr * hxr, qi = -(e.xr * f.Hyi[j][i] - e.yr * f.Hxi[j][i]);
            const s = 0.5 * (k.re * qr - k.im * qi);
            const p = s * wx[i] * wy[j];
            total += p;
            if (dielectricAt(solver, x, y) > 1.01) inDiel += p;
            const v = Math.max(0, s) * 1e-6;          // W/m² → W/mm²
            row[i] = v;
            if (v > 0) { cells.push([v, p]); pos.push(v); }
        }
        avg.push(row);
    }
    const xMM = Array.from(xs, v => v * 1000), yMM = Array.from(ys, v => v * 1000);
    let mx = 0;
    for (const v of pos) if (v > mx) mx = v;
    const ax = colorAxis(env, { log: opt.log, top: opt.log ? mx : percentile(pos, 0.99), decades: 4, unit: 'W/mm²', vals: pos });
    const traces = [heatmap(xMM, yMM, avg, ax, 'Electric', 'S_z')];
    if (opt.nContours > 0 && total > 0) traces.push(...containmentTraces(xMM, yMM, avg, cells, total));
    return { traces, shapes: [], ...axisResult(ax), xMM, yMM, ...powerTitle(env, total, inDiel, solver), power: total };
}

// Lines enclosing 50 / 90 / 99 % of the transmitted power: the S_z levels where the
// power of all cells above the level reaches the fraction.
const CONTAIN = [[0.5, 'solid', '50 % of the power'], [0.9, 'dash', '90 % of the power'], [0.99, 'dot', '99 % of the power']];
function containmentTraces(xMM, yMM, avg, cells, total) {
    cells.sort((p, q) => q[0] - p[0]);
    const out = [];
    let acc = 0, ci = 0;
    for (const [v, p] of cells) {
        acc += p;
        while (ci < CONTAIN.length && acc >= CONTAIN[ci][0] * total) {
            const [, dash, name] = CONTAIN[ci];
            const l = isoLines(xMM, yMM, avg, [v]);
            out.push({ type: 'scatter', mode: 'lines', x: l.x, y: l.y, hoverinfo: 'skip',
                line: { color: 'rgba(120, 220, 255, 0.9)', width: 1.4, dash }, name, showlegend: true });
            ci++;
        }
        if (ci >= CONTAIN.length) break;
    }
    return out;
}

function powerTitle(env, total, inDiel, solver) {
    const { ex } = env;
    const share = total > 0 ? inDiel / total : 0;
    const anyAir = (solver.dielectrics || []).some(d => d.epsilon_r <= 1.01) || share < 0.999;
    const shareTxt = (share > 0.001 && anyAir) ? ` · ${(100 * share).toFixed(1)} % in the dielectric` : '';
    const check = Number.isFinite(ex.Pexp) ? `∫S dA = ${fmtW(total)} (expected ${fmtW(ex.Pexp)})` : '';
    return { title: 'Power flow S_z (time average)', info: `${check}${shareTxt}` };
}

function fmtW(p, unit = 'W') {
    const a = Math.abs(p);
    const pre = [[1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n']];
    for (const [s, u] of pre) if (a >= s * 0.9995) return `${+(p / s).toPrecision(3)} ${u}${unit}`;
    return `${p.toExponential(2)} ${unit}`;
}

function coaxPowerView(env) {
    const { f, ex, opt, solver } = env;
    const a = solver.a, b = solver.b, L = Math.log(b / a);
    const k = cmul(ex.cE, cconj(ex.cH));
    let total = 0;
    const vals = f.rings.map((g) => {
        if (g.Jr !== null) return null;
        const r = Math.sqrt(g.r0 * g.r1);
        // ½·Re(cE·cH*·E_unit·H*), E_unit = 1/(r·ln(b/a)) for 1 V
        const sav = 0.5 * (k.re * g.Hr + k.im * g.Hi) / (r * L);
        total += sav * Math.PI * (g.r1 * g.r1 - g.r0 * g.r0);
        return Math.max(0, sav) * 1e-6;
    });
    let mx = 0;
    for (const v of vals) if (v !== null && v > mx) mx = v;
    const ax = colorAxis(env, { log: opt.log, top: mx, decades: Math.max(0.6, 2 * Math.log10(b / a)), unit: 'W/mm²' });
    const cxm = f.cx * 1000, cym = f.cy * 1000;
    const R = (f.b + f.tShield) * 1000;
    const { shapes, traces } = ringView(f.rings, vals, ax, 'Electric', R, cxm, cym, 'S_z');
    // Containment circles: P(< r) ∝ ln(r/a) for the TEM coax.
    if (opt.nContours > 0) {
        for (const [frac, dash, name] of CONTAIN) {
            const r = a * Math.pow(b / a, frac) * 1000;
            const X = [], Y = [];
            for (let kk = 0; kk <= 180; kk++) { const t = 2 * Math.PI * kk / 180; X.push(cxm + r * Math.cos(t)); Y.push(cym + r * Math.sin(t)); }
            traces.push({ type: 'scatter', mode: 'lines', x: X, y: Y, hoverinfo: 'skip', name, showlegend: true,
                line: { color: 'rgba(120, 220, 255, 0.9)', width: 1.4, dash } });
        }
    }
    return { traces, shapes, ...axisResult(ax), xMM: [-R, R], yMM: [-R, R],
             ...powerTitle(env, total, total, solver), power: total };
}

// ---- losses ------------------------------------------------------------------------
// Time-average loss power density: ½·|J|²/σ in the metal (the current of the eddy-current
// solve, skin and proximity effect included) and ½·ω·ε0·εr·tanδ·|E|² in the dielectric.
// The map shows where the power goes; the totals in the title are those of the solver,
// P′ = 2·α·P per unit length (roughness and plating, which the plotted current of the
// smooth metal does not contain, included), split into conductor and dielectric loss.
function lossView(env) {
    const { f, ex, opt, solver } = env;
    if (f.kind === 'radial') return coaxLossView(env);
    const E = unitESampler(env);
    const w = 2 * Math.PI * f.f;
    const aE2 = cabs(ex.cE) ** 2, aH2 = cabs(ex.cH) ** 2;
    const xs = f.x, ys = f.y, nx = xs.length, ny = ys.length;
    const conds = solver.conductors || [];
    const wx = cellWidths(xs), wy = cellWidths(ys);
    const raw = [], pos = [];
    let pDiel = 0;
    for (let j = 0; j < ny; j++) {
        const row = new Array(nx).fill(null);
        for (let i = 0; i < nx; i++) {
            let q = null;
            if (Number.isFinite(f.J[j][i])) {
                // Metal: the exported density, or ½|J|²/σ (waveguide walls).
                q = aH2 * (f.Q ? f.Q[j][i] : 0.5 * f.J[j][i] ** 2 / f.sigma);
            } else if (E && !conds.some(cd => shapeContains(cd, xs[i], ys[j], 0))) {
                const e = E(xs[i], ys[j]);
                const { er, tand } = dielectricPropsAt(solver, xs[i], ys[j]);
                if (e && tand > 0) {
                    q = 0.5 * w * EPS0 * er * tand * aE2 * (e.xr * e.xr + e.yr * e.yr);
                    pDiel += q * wx[i] * wy[j];
                }
            }
            if (q !== null && Number.isFinite(q) && q > 0) { row[i] = q * 1e-9; pos.push(q * 1e-9); }   // W/m³ → W/mm³
        }
        raw.push(row);
    }
    const xMM = Array.from(xs, v => v * 1000), yMM = Array.from(ys, v => v * 1000);
    const top = opt.log ? percentile(pos, 0.999) : percentile(pos, 0.99);
    const ax = colorAxis(env, { log: opt.log, top, decades: 5, unit: 'W/mm³' });
    const traces = [heatmap(xMM, yMM, raw, ax, 'Magma', 'p')];
    const split = f.lossSplit && f.lossSplit.trace + f.lossSplit.ground > 0
        ? { a: f.lossSplit.trace, b: f.lossSplit.ground, na: 'signal conductor', nb: 'ground' }
        : null;
    const per = f.kind === 'wg' ? ` · ${f.mode}` : (f.differential ? (f.mode === 'even' ? ' · even mode' : ' · odd mode') : '');
    return { traces, shapes: [], ...axisResult(ax), xMM, yMM, title: `Loss density (time average)${per}`,
             info: lossInfo(env, split), lossDielMap: pDiel };
}

// Title line of the losses view: P′ per unit length from the solver's attenuation and its
// shares, the conductor loss split by `split` (signal conductor / ground, or inner
// conductor / shield) where it is known.
function lossInfo(env, split) {
    const { ex, alpha } = env;
    const P = ex.waveguide ? ex.P : ex.Pexp;
    if (!alpha || !Number.isFinite(alpha.c) || !Number.isFinite(alpha.d) || !(P > 0)) return '';
    const pc = 2 * alpha.c * P, pd = 2 * alpha.d * P, tot = pc + pd;
    if (!(tot > 0)) return '';
    const pct = (v) => `${(100 * v / tot).toFixed(v / tot < 0.1 ? 1 : 0)} %`;
    const parts = [];
    if (split) {
        const s = split.a + split.b;
        parts.push(`${split.na} ${pct(pc * split.a / s)}`, `${split.nb} ${pct(pc * split.b / s)}`);
    } else {
        parts.push(`${ex.waveguide ? 'walls' : 'conductors'} ${pct(pc)}`);
        if (!(pd > 0)) parts.length = 0;    // all of it in the metal: the total says it
    }
    if (pd > 0) parts.push(`dielectric ${pct(pd)}`);
    return parts.length ? `loss ${fmtW(tot, 'W/m')}: ${parts.join(', ')}` : `loss ${fmtW(tot, 'W/m')}, all in the metal`;
}

function coaxLossView(env) {
    const { f, ex, opt, solver } = env;
    const a = solver.a, b = solver.b, L = Math.log(b / a);
    const w = 2 * Math.PI * f.f;
    const aE2 = cabs(ex.cE) ** 2, aH2 = cabs(ex.cH) ** 2;
    const er = solver.epsilon_r ?? f.er ?? 1, tand = solver.tan_delta || 0;
    let pIn = 0, pSh = 0, pDiel = 0;
    const vals = f.rings.map((g) => {
        const r = Math.sqrt(g.r0 * g.r1), area = Math.PI * (g.r1 * g.r1 - g.r0 * g.r0);
        let q;
        if (g.Jr !== null) {
            q = 0.5 * aH2 * (g.Jr * g.Jr + g.Ji * g.Ji) / f.sigma;
            if (r < a) pIn += q * area; else pSh += q * area;
        } else {
            if (!(tand > 0)) return null;
            q = 0.5 * w * EPS0 * er * tand * aE2 / (r * L) ** 2;
            pDiel += q * area;
        }
        return q > 0 ? q * 1e-9 : null;
    });
    const pos = vals.filter(v => v !== null);
    const ax = colorAxis(env, { log: opt.log, top: opt.log ? Math.max(...pos) : percentile(pos, 0.99), decades: 5, unit: 'W/mm³' });
    const cxm = f.cx * 1000, cym = f.cy * 1000;
    const R = (f.b + f.tShield) * 1000;
    const { shapes, traces } = ringView(f.rings, vals, ax, 'Magma', R, cxm, cym, 'p');
    const split = pIn + pSh > 0 ? { a: pIn, b: pSh, na: 'inner conductor', nb: 'shield' } : null;
    return { traces, shapes, ...axisResult(ax), xMM: [-R, R], yMM: [-R, R],
             title: 'Loss density (time average) · closed form', info: lossInfo(env, split),
             lossCondMap: pIn + pSh, lossDielMap: pDiel };
}

// ---- E / H arrows and S markers ------------------------------------------------------
// Arrows of the transverse E and / or H on a regular lattice over the visible range, each
// field at the phase of its own maximum. Length from the magnitude on a log scale over two
// decades (the field is singular at conductor corners). S markers (⊙, power out of the
// page) sized by the time-average power density.
export function buildArrowData(env, arrows, xr, yr) {
    const out = {};
    if (!arrows.E && !arrows.H && !arrows.S) return out;
    const { ex, solver } = env;
    const needH = arrows.H || arrows.S, needE = arrows.E || arrows.S;
    const Eu = needE ? unitESampler(env) : null;
    const Hu = needH ? unitHSampler(env) : null;
    const W = xr[1] - xr[0], Hh = yr[1] - yr[0];
    if (!(W > 0 && Hh > 0)) return out;
    const nc = arrows.density, nr = Math.max(2, Math.round(nc * Hh / W));
    const pts = [];
    for (let a = 0; a < nr; a++) for (let cc = 0; cc < nc; cc++)
        pts.push([xr[0] + W * (cc + 0.5) / nc, yr[0] + Hh * (a + 0.5) / nr]);
    const conds = solver.conductors || [];
    const inMetal = (x, y) => conds.some(cd => shapeContains(cd, x, y, 0));
    const scale = (u, k) => u && {
        xr: k.re * u.xr - k.im * u.xi, xi: k.re * u.xi + k.im * u.xr,
        yr: k.re * u.yr - k.im * u.yi, yi: k.re * u.yi + k.im * u.yr,
    };
    const vals = {};
    if (Eu) vals.E = pts.map(([x, y]) => (inMetal(x / 1000, y / 1000) ? null : scale(Eu(x / 1000, y / 1000), ex.cE)));
    if (Hu) vals.H = pts.map(([x, y]) => scale(Hu(x / 1000, y / 1000), ex.cH));
    if (arrows.S && vals.E && vals.H) {
        const S = vals.E.map((e, k) => {
            const h = vals.H[k];
            if (!e || !h) return 0;
            return 0.5 * ((e.xr * h.yr + e.xi * h.yi) - (e.yr * h.xr + e.yi * h.xi));
        });
        const sorted = S.filter(v => v > 0).sort((p, q) => p - q);
        const X = [], Y = [], SZ = [];
        if (sorted.length) {
            const ref = sorted[Math.min(sorted.length - 1, Math.floor(0.98 * sorted.length))];
            S.forEach((v, idx) => {
                if (!(v > 1e-2 * ref)) return;
                const g = Math.min(1, Math.max(0, Math.log10(v / ref) / 2 + 1));
                X.push(pts[idx][0]); Y.push(pts[idx][1]); SZ.push(4 + 10 * g);
            });
        }
        out.S = { x: X, y: Y, size: SZ };
    }
    for (const k of ['E', 'H']) {
        if (!arrows[k] || !vals[k]) continue;
        const ph = -carg(k === 'E' ? ex.cE : ex.cH), cp = Math.cos(ph), sp = Math.sin(ph);
        const mags = vals[k].map(v => (v ? Math.sqrt(v.xr * v.xr + v.xi * v.xi + v.yr * v.yr + v.yi * v.yi) : 0));
        const sorted = mags.filter(m => m > 0).sort((p, q) => p - q);
        if (!sorted.length) { out[k] = { x: [], y: [] }; continue; }
        const ref = sorted[Math.min(sorted.length - 1, Math.floor(0.98 * sorted.length))];
        const Lcell = 0.9 * Math.min(W / nc, Hh / nr);
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
            // E is zero inside metal: an E arrow next to a conductor is shortened until it
            // no longer reaches into it, or dropped.
            let Lc = L;
            if (k === 'E') {
                const hits = (len) => {
                    for (let t = -0.5; t <= 0.5; t += 0.125) {
                        if (inMetal((x + t * len * ux) / 1000, (y + t * len * uy) / 1000)) return true;
                    }
                    return false;
                };
                while (Lc >= 0.08 * Lcell && hits(Lc)) Lc *= 0.7;
                if (Lc < 0.08 * Lcell) return;
            }
            const xa = x - 0.5 * Lc * ux, ya = y - 0.5 * Lc * uy, xb = x + 0.5 * Lc * ux, yb = y + 0.5 * Lc * uy;
            const hl = 0.35 * Lc, ca = Math.cos(Math.PI / 7), sa = Math.sin(Math.PI / 7);
            X.push(xa, xb, null, xb, xb + hl * (-ux * ca + uy * sa), null, xb, xb + hl * (-ux * ca - uy * sa), null);
            Y.push(ya, yb, null, yb, yb + hl * (-uy * ca - ux * sa), null, yb, yb + hl * (-uy * ca + ux * sa), null);
        });
        out[k] = { x: X, y: Y };
    }
    return out;
}

// ---- view dispatch -----------------------------------------------------------------
// Field-line / contour overlay of the geometry view.
export function geometryLines(env) {
    const { solver } = env;
    if (isWaveguide(solver)) return env.f ? waveguideLineTraces(env, true) : [];
    if (isCoax(solver)) return coaxLineTraces(env, true);
    return staticLineTraces(env, true);
}

// A dark seam under every light solid line (field lines, power lines), so they stay
// visible on the bright end of a color map. Not under dotted lines, which it would turn
// into grey lines.
function addHalos(traces) {
    const out = [];
    for (const t of traces) {
        const col = t && t.type === 'scatter' && t.mode === 'lines' && t.line && t.line.color;
        const m = col && String(col).match(/\d+(\.\d+)?/g);
        const light = m && (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 > 170 && !/arrows/.test(t.name || '')
            && !t.line.dash;
        if (light) {
            // Same legend group as its line: a click in the legend hides both.
            if (t.name && !t.legendgroup) t.legendgroup = t.name;
            out.push({ type: 'scatter', mode: 'lines', x: t.x, y: t.y, hoverinfo: 'skip', showlegend: false,
                       legendgroup: t.legendgroup,
                       line: { color: 'rgba(0, 0, 0, 0.3)', width: (t.line.width || 1) + 1.0 } });
        }
        out.push(t);
    }
    return out;
}

// Builds a field view. Returns { traces, shapes, title, info, zMin, zMax, dataMin, dataMax,
// scaleLog, scaleUnit, xMM, yMM } or { pending: true } while the H / J data is being
// computed, or { error } when the view is not available.
export function buildFieldView(env) {
    const v = buildFieldViewRaw(env);
    if (v && v.traces) v.traces = addHalos(v.traces);
    return v;
}

function buildFieldViewRaw(env) {
    const { view, solver, f } = env;
    if (!env.ex.ok) return { error: env.ex.note || 'Excitation not available' };
    if (view === 'potential' || view === 'efield') {
        const isE = view === 'efield';
        if (isWaveguide(solver)) {
            if (!isE) return { error: 'A waveguide has no static potential' };
            if (!f) return { pending: true };
            return waveguideEView(env);
        }
        if (isCoax(solver)) return coaxStaticView(env, isE);
        if (isE ? !(env.E && env.E.Ex) : !env.V) return { error: 'No field data' };
        return staticView(env, isE);
    }
    if (!f) return { pending: true };
    if (view === 'sfield') return powerView(env) || { error: 'Power flow not available (no E field)' };
    if (view === 'lossfield') return lossView(env);
    return mqsView(env, view === 'hfield');
}
