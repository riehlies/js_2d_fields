// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Traces of the field views (potential, |E|, |H|, current density, power flow), the
// field lines and contour lines drawn on them, and the E / H / S arrows.
//
// Every view is scaled by ONE excitation (src/field_excitation.js): the unit fields of the
// solver (E and potential for 1 V, H and J for 1 A, the waveguide for 1 W) are multiplied
// by the complex amplitudes cE = V / 1 V and cH = I / 1 A of the line at the plotted
// position. In the time display "instantaneous" every quantity is Re{X·e^(jωt)} and the
// color scale and the line spacing stay those of the peak, so fields visibly shrink and
// lines thin out as ωt runs.
//
// Line conventions:
//   field lines (count "Field lines"): E lines in the geometry, potential and |E| views,
//       H lines (contours of the vector potential A_z) in the |H| view. Equal flux per line.
//   contour lines (count "Contour lines"): equipotentials in the geometry, potential and
//       |E| views, or magnitude levels of |E| / |J| when "Contours show" is set so; lines
//       enclosing 50 / 90 / 99 % of the power in the power flow view.
//
// `env` (built by plot.js from the solver and the sidebar):
//   { solver, view, freq, ex, opt, E: {Ex, Ey}, V, epsAt, stored(view), f (H / J data) }
//   ex  = { ok, cE, cH, P, Pexp, label, waveguide, nCond, mode, note }
//   opt = { inst, wt, log, nLines, nContours, contourKind }

import { shapeContains, isComplement, svgRingPath } from './shapes.js';
import { electricFieldLines } from './streamlines.js';
import { isoLines } from './isolines.js';
import { c, cmul, cconj, cabs, carg, inst } from './field_excitation.js';

// ---- shared color scales (Plotly's definitions), used where colors are computed here ----
export const COLORSCALES = {
    Viridis: [[0, '#440154'], [0.0627, '#48186a'], [0.1255, '#472d7b'], [0.1882, '#424086'],
        [0.2510, '#3b528b'], [0.3137, '#33638d'], [0.3765, '#2c728e'], [0.4392, '#26828e'],
        [0.5020, '#21918c'], [0.5647, '#1fa088'], [0.6275, '#28ae80'], [0.6902, '#3fbc73'],
        [0.7529, '#5ec962'], [0.8157, '#84d44b'], [0.8784, '#addc30'], [0.9412, '#d8e219'], [1, '#fde725']],
    // matplotlib's perceptually uniform maps (also readable with colour-vision deficiency
    // and in greyscale): Inferno for the current density, Magma for the power flow.
    Inferno: [[0, '#000004'], [0.1, '#160b39'], [0.2, '#420a68'], [0.3, '#6a176e'], [0.4, '#932667'],
        [0.5, '#bc3754'], [0.6, '#dd513a'], [0.7, '#f37819'], [0.8, '#fca50a'], [0.9, '#f6d746'], [1, '#fcffa4']],
    Magma: [[0, '#000004'], [0.1, '#140e36'], [0.2, '#3b0f70'], [0.3, '#641a80'], [0.4, '#8c2981'],
        [0.5, '#b73779'], [0.6, '#de4968'], [0.7, '#f7705c'], [0.8, '#fe9f6d'], [0.9, '#fecf92'], [1, '#fcfdbf']],
    // Diverging, DARK at zero (after F. Crameri's "berlin"): blue = negative, red =
    // positive, lightness grows with |value| on both sides. On the dark plot background a
    // zero field stays dark instead of lighting up white, and blue / red stay apart for
    // red-green colour-vision deficiency (the sign is also carried by the lightness
    // symmetry, not by hue alone).
    RdBu: [[0, '#9eb0ff'], [0.15, '#5aa2d9'], [0.3, '#2b6a8a'], [0.45, '#12222e'], [0.5, '#110d08'],
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

// Colorbar ticks for a log10 color axis: decades, or 1-2-5 steps when the range spans
// less than two decades, labelled with the actual values.
export function logTicks(zmin, zmax) {
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
const ETA0 = 376.730313668;
const LINE = {
    fieldDark: { color: 'rgba(15, 15, 15, 0.9)', width: 1.1 },
    equiDark: { color: 'rgba(30, 30, 30, 0.55)', width: 1, dash: 'dot' },
    fieldLight: { color: 'rgba(255, 255, 255, 0.85)', width: 1.1 },
    equiLight: { color: 'rgba(255, 255, 255, 0.5)', width: 1, dash: 'dot' },
};

// Time factor of a phasor: its instantaneous value at ωt, or its magnitude for the
// peak display.
function timeFactor(a, opt) { return opt.inst ? inst(a, opt.wt) : cabs(a); }

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

export function dielectricAt(solver, x, y) {
    let er = 1;
    for (const d of (solver.dielectrics || [])) {
        if (shapeContains(d, x, y, 0)) er = d.epsilon_r;
    }
    return er;
}

// Is the solver a concentric coax / a waveguide?
export function isCoax(solver) {
    return !!solver && typeof solver.a === 'number' && typeof solver.b === 'number'
        && (solver.conductors || []).some(cd => cd.shape && isComplement(cd.shape));
}
export function isWaveguide(solver) {
    return !!solver && solver.mode_type === 'waveguide';
}

// Contour lines of z at the levels m·step (m ≠ 0) up to ±maxAbs, plus the zero level if
// asked (not by default: for a single-ended line z = 0 is the ground, and a zero contour
// would trace the masked metal edges). Levels from the PEAK field, so in the instantaneous
// display the lines thin out. One line trace (isolines.js), not a Plotly contour trace,
// which would re-contour the whole grid on every redraw.
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
    if (f.kind !== 'grid' && f.kind !== undefined && f.kind !== 'mqs') {
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
    const s = timeFactor(ex.cE, opt), amp = cabs(ex.cE) || 1;
    const frac = Math.abs(s) / amp;
    const xMM = Array.from(xs, v => v * 1000), yMM = Array.from(ys, v => v * 1000);
    // Equipotentials of the scaled potential.
    if (opt.nContours > 0 && env.V && (opt.contourKind !== 'mag' || env.view === 'geometry' || env.view === 'potential')) {
        const mask = metalMask(solver, xs, ys);
        let vmin = Infinity, vmax = -Infinity;
        for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) {
            if (mask[j][i]) continue;
            const v = env.V[j][i];
            if (v < vmin) vmin = v; if (v > vmax) vmax = v;
        }
        const step = amp * (vmax - vmin) / (opt.nContours + 1);
        const z = env.V.map((row, j) => Array.from(row, (v, i) => (mask[j][i] ? null : s * v)));
        out.push(...levelTraces(xMM, yMM, z, step, Math.abs(s) * Math.max(Math.abs(vmin), Math.abs(vmax)),
            { zero: vmin < -1e-6 && Math.abs(s) > 1e-6 * amp, line: dark ? LINE.equiDark : LINE.equiLight,
              name: 'Equipotentials' }));
    }
    // Field lines: as many as the instantaneous flux allows.
    const n = Math.round(opt.nLines * frac);
    if (n > 0 && env.E && env.E.Ex) {
        const fl = electricFieldLines({ Ex: env.E.Ex, Ey: env.E.Ey, x: xs, y: ys,
            conductors: solver.conductors || [], epsAt: env.epsAt, n });
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

// Filled concentric rings of one value each, merged where neighbours share a color and
// painted from the outside in (no anti-aliasing seams).
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

// Axis extent, hover probes along +x and the colorbar of a ring view.
function ringTraces(rings, vals, R, cx, cy, qty, unit, scale, zmin, zmax, colorbar) {
    const probes = rings.map((g, k) => ({ x: cx + 500 * (g.r0 + g.r1), v: vals[k] })).filter(p => p.v !== null);
    return [
        { type: 'scatter', mode: 'markers', x: [cx - R, cx + R], y: [cy - R, cy + R], marker: { size: 0, opacity: 0 },
          hoverinfo: 'skip', showlegend: false },
        { type: 'scatter', mode: 'markers', x: probes.map(p => p.x), y: probes.map(() => cy),
          customdata: probes.map(p => p.v), marker: { size: 6, color: 'rgba(0,0,0,0)' }, showlegend: false,
          hovertemplate: `r: %{x:.4f} mm<br>${qty}: %{customdata:.3e} ${unit}<extra></extra>` },
        { type: 'scatter', mode: 'markers', x: [cx], y: [cy], hoverinfo: 'skip', showlegend: false,
          marker: { size: 0.1, opacity: 0, color: [zmin], cmin: zmin, cmax: zmax,
                    colorscale: COLORSCALES[scale], showscale: true, colorbar } },
    ];
}

function coaxLineTraces(env, dark) {
    const { solver, ex, opt } = env;
    const out = [];
    const a = solver.a, b = solver.b;
    const s = timeFactor(ex.cE, opt), amp = cabs(ex.cE) || 1;
    if (opt.nContours > 0 && (opt.contourKind !== 'mag' || env.view !== 'efield') && Math.abs(s) > 1e-9 * amp) {
        // V(r) = s·ln(b/r)/ln(b/a): circles at the levels m·step, step from the peak.
        const step = amp / (opt.nContours + 1);
        const X = [], Y = [];
        for (let m = 1; m * step < Math.abs(s); m++) {
            const u = m * step / Math.abs(s);
            const r = b * Math.pow(a / b, u) * 1000;
            for (let k = 0; k <= 180; k++) { const t = 2 * Math.PI * k / 180; X.push(r * Math.cos(t)); Y.push(r * Math.sin(t)); }
            X.push(null); Y.push(null);
        }
        if (X.length) out.push({ type: 'scatter', mode: 'lines', x: X, y: Y, hoverinfo: 'skip',
            line: dark ? LINE.equiDark : LINE.equiLight, name: 'Equipotentials', showlegend: true });
    }
    const n = Math.round(opt.nLines * Math.abs(s) / amp);
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
    const s = timeFactor(ex.cE, opt), amp = cabs(ex.cE);
    const vals = rings.map(g => {
        const r = Math.sqrt(g.r0 * g.r1);
        return isE ? Math.abs(s) / (r * L) : s * Math.log(b / r) / L;
    });
    let zmin, zmax, scale;
    if (isE) { zmin = 0; zmax = amp / (a * L); scale = 'Viridis'; }
    else if (opt.inst) { zmin = -amp; zmax = amp; scale = 'RdBu'; }
    else { zmin = 0; zmax = amp; scale = 'Viridis'; }
    const dataMin = zmin, dataMax = zmax;
    const ov = env.stored(env.view);
    if (ov) { zmin = ov.min; zmax = ov.max; }
    const unit = isE ? 'V/m' : 'V';
    const colorbar = { title: { text: unit }, len: 0.8 };
    const R = (b + (solver.shield_thickness || 0.1 * b)) * 1000;
    const shapes = ringShapes(rings, vals, scale, zmin, zmax, 0, 0);
    if (!isE) {
        // Conductors at their potential: inner conductor s, shield 0.
        const col = (v) => colorAt(scale, (v - zmin) / ((zmax - zmin) || 1));
        const am = a * 1000;
        shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: -am, y0: -am, x1: am, y1: am,
            fillcolor: col(s), line: { width: 0, color: 'rgba(0,0,0,0)' }, layer: 'between' });
        shapes.push({ type: 'path', path: svgRingPath(0, 0, b * 1000, R, 360), fillcolor: col(0), fillrule: 'evenodd',
            line: { width: 0, color: 'rgba(0,0,0,0)' }, layer: 'between' });
    }
    const traces = [...ringTraces(rings, vals, R, 0, 0, isE ? '|E|' : 'V', unit, scale, zmin, zmax, colorbar),
                    ...coaxLineTraces(env, false)];
    return { traces, shapes, zMin: zmin, zMax: zmax, scaleLog: false, scaleUnit: unit, dataMin, dataMax, xMM: [-R, R], yMM: [-R, R],
             title: `${isE ? '|E|' : 'Potential'}${timeLabel(opt)} · closed form` };
}

// ---- waveguide E -------------------------------------------------------------------
// TE10 E lines run straight between the broad walls, spaced so each carries equal flux:
// the line density follows sin(πx/a). TE01 the same rotated.
function waveguideLineTraces(env, dark) {
    const { solver, ex, opt, f } = env;
    const w = solver.enclosure_walls;
    if (!w) return [];
    const along = f && f.mode === 'TE01' ? 'y' : ((w.x_max - w.x_min) >= (w.y_max - w.y_min) ? 'x' : 'y');
    const amp = cabs(ex.cE) || 1, s = timeFactor(ex.cE, opt);
    const n = Math.round(opt.nLines * Math.abs(s) / amp);
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
    const s = Math.abs(timeFactor(ex.cE, opt)), amp = cabs(ex.cE);
    let peak = 0;
    const z = f.Exr.map((row, j) => Array.from(row, (exr, i) => {
        const v = Math.hypot(exr, f.Eyr[j][i]);
        if (!Number.isFinite(v)) return null;
        peak = Math.max(peak, v);
        return s * v;
    }));
    let zmin = 0, zmax = amp * peak;
    const dataMin = zmin, dataMax = zmax;
    const ov = env.stored(env.view);
    if (ov) { zmin = ov.min; zmax = ov.max; }
    const traces = [{ type: 'heatmap', zsmooth: 'best', x: xMM, y: yMM, z, zmin, zmax, colorscale: cs('Viridis'),
        colorbar: { title: { text: 'V/m' }, len: 0.8 },
        hovertemplate: 'x: %{x:.3f} mm<br>y: %{y:.3f} mm<br>|E|: %{z:.3e} V/m<extra></extra>' }];
    if (opt.nContours > 0 && opt.contourKind === 'mag') {
        traces.push(...levelTraces(xMM, yMM, z, amp * peak / (opt.nContours + 1), s * peak,
            { line: LINE.equiLight, name: '|E| levels' }));
    }
    traces.push(...waveguideLineTraces(env, false));
    return { traces, shapes: [], zMin: zmin, zMax: zmax, scaleLog: false, scaleUnit: 'V/m', dataMin, dataMax, xMM, yMM,
             title: `|E|${timeLabel(opt)} · ${f.mode}` };
}

// ---- potential and |E| on the static grid ------------------------------------------
function staticView(env, isE) {
    const { solver, ex, opt } = env;
    const xs = solver.x, ys = solver.y;
    const xMM = Array.from(xs, v => v * 1000), yMM = Array.from(ys, v => v * 1000);
    const mask = metalMask(solver, xs, ys);
    const s = timeFactor(ex.cE, opt), amp = cabs(ex.cE);
    let zmin, zmax, scale = 'Viridis';
    let z;
    if (isE) {
        const { Ex, Ey } = env.E;
        const all = [], wts = [];
        const cell = (arr, k) => 0.5 * (arr[Math.min(arr.length - 1, k + 1)] - arr[Math.max(0, k - 1)]);
        z = Ex.map((row, j) => Array.from(row, (exv, i) => {
            if (mask[j][i]) return null;
            const v = Math.hypot(exv, Ey[j][i]);
            all.push(v); wts.push(cell(xs, i) * cell(ys, j));
            return Math.abs(s) * v;
        }));
        // The field is singular at conductor corners, where the grid is also densest: the
        // color range ends where 99.99 % of the cross-section AREA has a lower field (the
        // same scale for the graded quasi-static grid and the full-wave resampling).
        zmin = 0; zmax = amp * weightedPercentile(all, wts, 0.9999);
    } else {
        // The potential is defined in the conductors too (each is an equipotential at
        // its drive voltage), so they keep their color here.
        let vmin = Infinity, vmax = -Infinity;
        z = env.V.map((row) => Array.from(row, (v) => {
            if (!Number.isFinite(v)) return null;
            if (v < vmin) vmin = v; if (v > vmax) vmax = v;
            return s * v;
        }));
        if (opt.inst) { const m = amp * Math.max(Math.abs(vmin), Math.abs(vmax)); zmin = -m; zmax = m; scale = 'RdBu'; }
        else { zmin = amp * vmin; zmax = amp * vmax; }
    }
    const dataMin = zmin, dataMax = zmax;
    const ov = env.stored(env.view);
    if (ov) { zmin = ov.min; zmax = ov.max; }
    const unit = isE ? 'V/m' : 'V';
    const traces = [{ type: 'heatmap', zsmooth: 'best', x: xMM, y: yMM, z, zmin, zmax, colorscale: cs(scale),
        colorbar: { title: { text: unit }, len: 0.8 },
        hovertemplate: `x: %{x:.3f} mm<br>y: %{y:.3f} mm<br>${isE ? '|E|' : 'V'}: %{z:.3e} ${unit}<extra></extra>` }];
    if (isE && opt.nContours > 0 && opt.contourKind === 'mag') {
        traces.push(magnitudeContourTrace(xMM, yMM, z, amp, zmax / Math.max(amp, 1e-300), Math.abs(s), opt.nContours));
    }
    traces.push(...staticLineTraces(env, false));
    const what = isE ? '|E|' : 'Potential';
    return { traces, shapes: [], zMin: zmin, zMax: zmax, scaleLog: false, scaleUnit: unit, dataMin, dataMax, xMM, yMM,
             title: `${what}${timeLabel(opt)}` };
}

// Log-spaced |E| levels (lines evenly spaced instead of crowding at the singular
// corners), the levels fixed by the peak field.
function magnitudeContourTrace(xMM, yMM, z, amp, unitMax, s, n) {
    const eMax = amp * unitMax;
    const lo = Math.log10(Math.max(eMax * 1e-2, 1e-30)), hi = Math.log10(Math.max(eMax, 1e-30));
    const size = (hi - lo) / n;
    const levels = Array.from({ length: n }, (_, k) => lo + size / 2 + k * size);
    const lz = z.map(row => row.map(v => (v === null || !(v > 0) ? null : Math.log10(v))));
    const l = isoLines(xMM, yMM, lz, levels);
    return { type: 'scatter', mode: 'lines', x: l.x, y: l.y, hoverinfo: 'skip',
             line: { width: 1, color: 'rgba(255, 255, 255, 0.35)' }, name: '|E| levels', showlegend: true };
}

// ---- |H| and current density ---------------------------------------------------------
function mqsView(env, isH) {
    const { f, ex, opt } = env;
    if (f.kind === 'radial') return coaxMqsView(env, isH);
    const xMM = Array.from(f.x, v => v * 1000), yMM = Array.from(f.y, v => v * 1000);
    const ny = f.y.length, nx = f.x.length;
    const cH = cmul(ex.cH, c(hSign(env))), amp = cabs(cH);
    const cw = Math.cos(opt.wt), sw = Math.sin(opt.wt);
    const re = (xr, xi) => (cH.re * xr - cH.im * xi) * cw - (cH.re * xi + cH.im * xr) * sw;   // Re{cH·X·e^jωt}
    const signed = !isH && opt.inst && !f.Jtr;
    const raw = [], peakVals = [];
    for (let j = 0; j < ny; j++) {
        const row = new Array(nx);
        for (let i = 0; i < nx; i++) {
            let v, pk;
            if (isH) {
                pk = amp * f.H[j][i];
                if (opt.inst) {
                    const hx = re(f.Hxr[j][i], f.Hxi[j][i]), hy = re(f.Hyr[j][i], f.Hyi[j][i]);
                    const hz = f.Hzr ? re(f.Hzr[j][i], f.Hzi[j][i]) : 0;
                    v = Math.sqrt(hx * hx + hy * hy + hz * hz);
                } else v = pk;
            } else {
                pk = amp * f.J[j][i] * 1e-6;
                if (opt.inst && f.Jtr) v = Math.hypot(re(f.Jr[j][i], f.Ji[j][i]), re(f.Jtr[j][i], f.Jti[j][i])) * 1e-6;
                else if (opt.inst) v = re(f.Jr[j][i], f.Ji[j][i]) * 1e-6;
                else v = pk;
            }
            row[i] = Number.isFinite(v) ? v : null;
            if (Number.isFinite(pk) && pk > 0) peakVals.push(pk);
        }
        raw.push(row);
    }
    const useLog = opt.log && !signed;
    const z = useLog ? raw.map(row => row.map(v => (v === null ? null : Math.log10(Math.max(v, 1e-30))))) : raw;
    // The scale follows the PEAK field: in the instantaneous display it stays put.
    let pkMax = 0;
    for (const v of peakVals) if (v > pkMax) pkMax = v;
    const p99 = percentile(peakVals, 0.99) || pkMax;
    let zmin, zmax;
    if (signed) { zmin = -p99; zmax = p99; }
    else if (useLog) { zmax = Math.log10(Math.max(pkMax, 1e-30)); zmin = zmax - (isH ? 3 : 4); }
    else { zmin = 0; zmax = p99; }
    const dataMin = zmin, dataMax = zmax;
    const ov = env.stored(env.view);
    if (ov) { zmin = ov.min; zmax = ov.max; }
    const unit = isH ? 'A/m' : 'A/mm²';
    const qty = isH ? '|H|' : (signed ? 'Jz' : (f.Jtr ? '|J|' : '|Jz|'));
    const colorbar = { title: { text: useLog ? `log₁₀ ${unit}` : unit }, len: 0.8 };
    if (useLog) Object.assign(colorbar, logTicks(zmin, zmax));
    const traces = [{
        type: 'heatmap', zsmooth: 'best', x: xMM, y: yMM, z, zmin, zmax, customdata: raw,
        // RdBu runs blue → red with increasing z: current in +z red, return current blue.
        colorscale: cs(signed ? 'RdBu' : (isH ? 'Viridis' : 'Inferno')), reversescale: false, colorbar,
        hovertemplate: `x: %{x:.4f} mm<br>y: %{y:.4f} mm<br>${qty}: %{customdata:.3e} ${unit}<extra></extra>`,
    }];
    if (isH && opt.nLines > 0 && f.kind === 'wg' && !env.arrowsH) {
        // Waveguide: the transverse H has sources (∂Hz/∂z), no potential to draw contours
        // of. Arrows of the instantaneous transverse field instead.
        traces.push(quiverTrace(f, cH, opt, opt.nLines));
    }
    if (isH && opt.nLines > 0 && f.Ar) traces.push(...hFieldLines(env, cH, xMM, yMM));
    const per = f.kind === 'wg' ? ` · ${f.mode}` : (f.differential ? (f.mode === 'even' ? ' · even mode' : ' · odd mode') : '');
    const title = `${qty}${timeLabel(opt)}${per} · δ = ${formatLength(f.delta)}`;
    return { traces, shapes: [], zMin: zmin, zMax: zmax, scaleLog: useLog, scaleUnit: unit, dataMin, dataMax, title, xMM, yMM };
}

// H field lines = contour lines of the vector potential A_z. Equal ΔA between lines, so
// the line density is proportional to |B|. Levels from the peak; instantaneous lines are
// contours of Re{cH·A·e^jωt} at the same levels and thin out with the field.
function hFieldLines(env, cH, xMM, yMM) {
    const { f, opt } = env;
    const ny = f.y.length, nx = f.x.length;
    const amp = cabs(cH);
    // Peak pattern: A rotated to the phase of the drive (|cH|·A for a real A).
    const ph = opt.inst ? opt.wt : -carg(cH);
    const cw = Math.cos(ph), sw = Math.sin(ph);
    const A = [];
    let pLo = Infinity, pHi = -Infinity, sawNeg = false, sawPos = false;
    for (let j = 0; j < ny; j++) {
        const row = new Array(nx);
        for (let i = 0; i < nx; i++) {
            const ar = f.Ar[j][i], ai = f.Ai[j][i];
            if (!Number.isFinite(ar)) { row[i] = null; continue; }
            const zr = cH.re * ar - cH.im * ai, zi = cH.re * ai + cH.im * ar;
            row[i] = zr * cw - zi * sw;
            if (!Number.isFinite(f.J[j][i])) {   // dielectric: sets the level range
                const pk = amp * ar;              // peak pattern for a real drive
                if (pk < pLo) pLo = pk; if (pk > pHi) pHi = pk;
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

// Arrows of the instantaneous transverse H on a coarse grid (waveguide).
function quiverTrace(r, cH, opt, n) {
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    const ny = r.y.length, nx = r.x.length;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!Number.isFinite(r.H[j][i]) || Number.isFinite(r.J[j][i])) continue;   // interior only
        xlo = Math.min(xlo, r.x[i]); xhi = Math.max(xhi, r.x[i]);
        ylo = Math.min(ylo, r.y[j]); yhi = Math.max(yhi, r.y[j]);
    }
    const W = xhi - xlo, Hh = yhi - ylo;
    const nc = Math.max(4, Math.round(n * Math.sqrt(W / Hh))), nr = Math.max(3, Math.round(n * Math.sqrt(Hh / W)));
    const ph = opt.inst ? opt.wt : -carg(cH), cw = Math.cos(ph), sw = Math.sin(ph);
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
    const cH = ex.cH, amp = cabs(cH);
    const val = (r, i) => {
        // Re{cH·X·e^jωt} or |cH·X|
        if (opt.inst) return (cH.re * r - cH.im * i) * Math.cos(opt.wt) - (cH.re * i + cH.im * r) * Math.sin(opt.wt);
        return amp * Math.hypot(r, i);
    };
    const signed = !isH && opt.inst;
    const vals = f.rings.map(g => {
        if (isH) return Math.abs(val(g.Hr, g.Hi));
        if (g.Jr === null) return null;
        return val(g.Jr, g.Ji) * 1e-6;
    });
    const peak = f.rings.map(g => (isH ? amp * Math.hypot(g.Hr, g.Hi) : (g.Jr === null ? null : amp * Math.hypot(g.Jr, g.Ji) * 1e-6)));
    const useLog = opt.log && !signed;
    const z = vals.map(v => (v === null ? null : (useLog ? Math.log10(Math.max(Math.abs(v), 1e-30)) : v)));
    let pkMax = 0;
    for (const v of peak) if (v !== null && v > pkMax) pkMax = v;
    let zmin, zmax;
    if (signed) { zmin = -pkMax; zmax = pkMax; }
    else if (useLog) { zmax = Math.log10(Math.max(pkMax, 1e-30)); zmin = zmax - (isH ? 3 : 4); }
    else { zmin = 0; zmax = pkMax; }
    const dataMin = zmin, dataMax = zmax;
    const ov = env.stored(env.view);
    if (ov) { zmin = ov.min; zmax = ov.max; }
    const scale = signed ? 'RdBu' : (isH ? 'Viridis' : 'Inferno');
    const cxm = f.cx * 1000, cym = f.cy * 1000;
    const shapes = ringShapes(f.rings, z, scale, zmin, zmax, cxm, cym);
    // H field lines: circles at equal steps of A ∝ ln(b/r) (density ∝ |H|), thinning out
    // with the instantaneous current.
    const frac = opt.inst ? Math.abs(inst(cH, opt.wt)) / (amp || 1) : 1;
    const nL = Math.round(opt.nLines * frac);
    if (isH && nL > 0) {
        for (let k = 1; k <= nL; k++) {
            const rr = f.b * Math.pow(f.a / f.b, k / (opt.nLines + 1)) * 1000;
            shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: cxm - rr, y0: cym - rr, x1: cxm + rr, y1: cym + rr,
                line: { color: 'rgba(255, 255, 255, 0.55)', width: 1 }, fillcolor: 'rgba(0,0,0,0)', layer: 'above' });
        }
    }
    const unit = isH ? 'A/m' : 'A/mm²';
    const qty = isH ? '|H|' : (signed ? 'Jz' : '|Jz|');
    const colorbar = { title: { text: useLog ? `log₁₀ ${unit}` : unit }, len: 0.8 };
    if (useLog) Object.assign(colorbar, logTicks(zmin, zmax));
    const R = (f.b + f.tShield) * 1000;
    const shown = vals.map(v => (v === null ? null : (isH ? v : v)));
    const traces = ringTraces(f.rings, shown, R, cxm, cym, qty, unit, scale, zmin, zmax, colorbar);
    const title = `${qty}${timeLabel(opt)} · δ = ${formatLength(f.delta)}`;
    return { traces, shapes, zMin: zmin, zMax: zmax, scaleLog: useLog, scaleUnit: unit, dataMin, dataMax, title, xMM: [-R, R], yMM: [-R, R] };
}

// ---- power flow --------------------------------------------------------------------
// S_z = ½·Re(E × H*) (time average) or E(t) × H(t) (instantaneous) from the scaled fields.
// The integral over the cross-section is the transmitted power, shown next to the value
// the excitation predicts as a consistency check.
function powerView(env) {
    const { f, ex, opt, solver } = env;
    if (f.kind === 'radial') return coaxPowerView(env);
    const E = unitESampler(env);
    if (!E) return null;
    const cE = ex.cE, cH = cmul(ex.cH, c(hSign(env)));
    const k = cmul(cE, cconj(cH));
    const xs = f.x, ys = f.y, nx = xs.length, ny = ys.length;
    const conds = solver.conductors || [];
    const Sav = [], Sinst = [], envl = [];
    for (let j = 0; j < ny; j++) {
        const ra = new Array(nx), ri = new Array(nx);
        for (let i = 0; i < nx; i++) {
            const x = xs[i], y = ys[j];
            const hxr = f.Hxr[j][i], hyr = f.Hyr[j][i];
            ra[i] = null; ri[i] = null;
            if (!Number.isFinite(hxr) || !Number.isFinite(hyr) || Number.isFinite(f.J[j][i])
                || conds.some(cd => shapeContains(cd, x, y, 0))) continue;
            const e = E(x, y);
            if (!e) continue;
            const hxi = f.Hxi[j][i], hyi = f.Hyi[j][i];
            // q = ex·hy* − ey·hx* (unit fields, E real)
            const qr = e.xr * hyr - e.yr * hxr, qi = -(e.xr * hyi - e.yr * hxi);
            ra[i] = 0.5 * (k.re * qr - k.im * qi);
            if (opt.inst) {
                const et = inst(cE, opt.wt);
                const hx = inst(cmul(cH, c(hxr, hxi)), opt.wt), hy = inst(cmul(cH, c(hyr, hyi)), opt.wt);
                ri[i] = et * (e.xr * hy - e.yr * hx);
            }
            envl.push(cabs(cE) * cabs(cH) * Math.hypot(e.xr, e.yr) * Math.hypot(Math.hypot(hxr, hxi), Math.hypot(hyr, hyi)));
        }
        Sav.push(ra); Sinst.push(ri);
    }
    const dx = Array.from(xs, (v, i) => 0.5 * ((xs[Math.min(nx - 1, i + 1)] - xs[Math.max(0, i - 1)])));
    const dy = Array.from(ys, (v, j) => 0.5 * ((ys[Math.min(ny - 1, j + 1)] - ys[Math.max(0, j - 1)])));
    let total = 0, inDiel = 0;
    const cells = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const v = Sav[j][i];
        if (v === null) continue;
        const p = v * dx[i] * dy[j];
        total += p;
        if (dielectricAt(solver, xs[i], ys[j]) > 1.01) inDiel += p;
        if (v > 0) cells.push([v, p]);
    }
    const xMM = Array.from(xs, v => v * 1000), yMM = Array.from(ys, v => v * 1000);
    const toMM = (arr) => arr.map(row => row.map(v => (v === null ? null : v * 1e-6)));   // W/m² → W/mm²
    const avg = toMM(Sav), now = toMM(Sinst);
    const res = powerHeatmap(env, xMM, yMM, avg, now, percentile(envl, 0.99) * 1e-6);
    // Containment lines: S_z levels enclosing 50 / 90 / 99 % of the transmitted power.
    // Containment lines of the transmitted power: not for a standing wave, whose average
    // power flow is (nearly) zero.
    if (opt.nContours > 0 && total > 0 && !ex.standing) res.traces.push(...containmentTraces(xMM, yMM, avg, cells, total));
    Object.assign(res, powerTitle(env, total, inDiel, solver));
    res.power = total;
    return res;
}

function powerHeatmap(env, xMM, yMM, avg, now, envMax) {
    const { opt } = env;
    const unit = 'W/mm²';
    let z, zmin, zmax, scale, colorbar, scaleLog = false;
    if (opt.inst) {
        // Instantaneous power density, linear scale fixed to the envelope. On a matched
        // line E and H are in phase and S_z(t) = 2·S_avg·cos²(ωt) never goes negative:
        // 0 … envelope. Only a standing wave reverses the power flow locally; then a
        // signed scale (blue = towards the generator).
        let mn = 0;
        for (const row of now) for (const v of row) if (v !== null && v < mn) mn = v;
        const signed = !!env.ex.standing || mn < -1e-3 * envMax;
        scale = signed ? 'RdBu' : 'Magma';
        if (!signed && opt.log) {
            // Non-negative: the same logarithmic scale as the time average, fixed to the
            // envelope (4 decades).
            z = now.map(row => row.map(v => (v === null || v <= 0 ? null : Math.log10(v))));
            zmax = Math.log10(Math.max(envMax, 1e-300)); zmin = zmax - 4; scaleLog = true;
            colorbar = { title: { text: `log₁₀ ${unit}` }, len: 0.8, ...logTicks(zmin, zmax) };
        } else {
            z = now;
            zmin = signed ? -envMax : 0; zmax = envMax;
            colorbar = { title: { text: unit }, len: 0.8 };
        }
    } else if (opt.log) {
        scaleLog = true;
        z = avg.map(row => row.map(v => (v === null || v <= 0 ? null : Math.log10(v))));
        let hi = -Infinity;
        for (const row of z) for (const v of row) if (v !== null && v > hi) hi = v;
        zmax = hi; zmin = hi - 4; scale = 'Magma';
        colorbar = { title: { text: `log₁₀ ${unit}` }, len: 0.8, ...logTicks(zmin, zmax) };
    } else {
        z = avg; scale = 'Magma'; zmin = 0;
        const a = [];
        for (const row of avg) for (const v of row) if (v !== null && v > 0) a.push(v);
        zmax = percentile(a, 0.99);
        colorbar = { title: { text: unit }, len: 0.8 };
    }
    const dataMin = zmin, dataMax = zmax;
    const ov = env.stored(env.view);
    if (ov) { zmin = ov.min; zmax = ov.max; }
    const custom = opt.inst ? now : avg;
    const traces = [{ type: 'heatmap', zsmooth: 'best', x: xMM, y: yMM, z, zmin, zmax, customdata: custom,
        colorscale: cs(scale), colorbar,
        hovertemplate: `x: %{x:.4f} mm<br>y: %{y:.4f} mm<br>S_z: %{customdata:.3e} ${unit}<extra></extra>` }];
    return { traces, shapes: [], zMin: zmin, zMax: zmax, scaleLog: scaleLog, scaleUnit: unit, dataMin, dataMax, xMM, yMM };
}

const CONTAIN = [[0.5, 'solid', '50 % of the power'], [0.9, 'dash', '90 % of the power'], [0.99, 'dot', '99 % of the power']];
function containmentTraces(xMM, yMM, avg, cells, total) {
    cells.sort((p, q) => q[0] - p[0]);
    const out = [];
    let acc = 0, ci = 0;
    for (const [v, p] of cells) {
        acc += p;
        while (ci < CONTAIN.length && acc >= CONTAIN[ci][0] * total) {
            const [, dash, name] = CONTAIN[ci];
            const l = isoLines(xMM, yMM, avg, [v * 1e-6]);
            out.push({ type: 'scatter', mode: 'lines', x: l.x, y: l.y, hoverinfo: 'skip',
                line: { color: 'rgba(120, 220, 255, 0.9)', width: 1.4, dash }, name, showlegend: true });
            ci++;
        }
        if (ci >= CONTAIN.length) break;
    }
    return out;
}

function powerTitle(env, total, inDiel, solver) {
    const { ex, opt } = env;
    const share = total > 0 ? inDiel / total : 0;
    const anyAir = (solver.dielectrics || []).some(d => d.epsilon_r <= 1.01) || share < 0.999;
    const shareTxt = (share > 0.001 && anyAir && !opt.inst) ? ` · ${(100 * share).toFixed(1)} % in the dielectric` : '';
    const check = Number.isFinite(ex.Pexp) ? `${opt.inst ? 'time-average ' : ''}∫S dA = ${fmtW(total)} (expected ${fmtW(ex.Pexp)})` : '';
    const what = opt.inst ? `Power flow S_z${timeLabel(opt)}` : 'Power flow S_z (time average)';
    return { title: what, info: `${check}${shareTxt}` };
}

function fmtW(p) {
    const a = Math.abs(p);
    const pre = [[1, 'W'], [1e-3, 'mW'], [1e-6, 'µW'], [1e-9, 'nW']];
    for (const [s, u] of pre) if (a >= s * 0.9995) return `${+(p / s).toPrecision(3)} ${u}`;
    return `${p.toExponential(2)} W`;
}

function coaxPowerView(env) {
    const { f, ex, opt, solver } = env;
    const a = solver.a, b = solver.b, L = Math.log(b / a);
    const cE = ex.cE, cH = ex.cH;
    const k = cmul(cE, cconj(cH));
    let total = 0;
    const avg = [], now = [];
    f.rings.forEach((g) => {
        if (g.Jr !== null) { avg.push(null); now.push(null); return; }
        const r = Math.sqrt(g.r0 * g.r1);
        const e = 1 / (r * L);                     // unit E_r (1 V)
        // ½·Re(cE·cH*·e·H*)
        const sav = 0.5 * e * (k.re * g.Hr + k.im * g.Hi);
        total += sav * Math.PI * (g.r1 * g.r1 - g.r0 * g.r0);
        avg.push(sav * 1e-6);
        if (opt.inst) now.push(inst(cE, opt.wt) * e * inst(cmul(cH, c(g.Hr, g.Hi)), opt.wt) * 1e-6);
        else now.push(null);
    });
    const envMax = cabs(cE) * cabs(cH) * Math.max(...f.rings.map(g => (g.Jr === null
        ? Math.hypot(g.Hr, g.Hi) / (Math.sqrt(g.r0 * g.r1) * L) : 0))) * 1e-6;
    const vals = opt.inst ? now : avg;
    let zmin, zmax, scale;
    // Signed only where the power flow reverses (standing wave), see powerHeatmap.
    const mnNow = opt.inst ? Math.min(0, ...now.filter(v => v !== null)) : 0;
    const signedInst = opt.inst && (!!ex.standing || mnNow < -1e-3 * envMax);
    const useLog = opt.log && !signedInst;
    const z = vals.map(v => (v === null ? null : (useLog ? (v > 0 ? Math.log10(v) : null) : v)));
    if (opt.inst) {
        if (signedInst) { zmin = -envMax; zmax = envMax; scale = 'RdBu'; }
        else if (useLog) { zmax = Math.log10(Math.max(envMax, 1e-300)); zmin = zmax - 4; scale = 'Magma'; }
        else { zmin = 0; zmax = envMax; scale = 'Magma'; }
    } else {
        let hi = -Infinity, lo = Infinity;
        for (const v of z) if (v !== null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
        zmax = hi; zmin = useLog ? Math.max(lo, hi - 4) : 0; scale = 'Magma';
    }
    const dataMin = zmin, dataMax = zmax;
    const ov = env.stored(env.view);
    if (ov) { zmin = ov.min; zmax = ov.max; }
    const unit = 'W/mm²';
    const colorbar = { title: { text: useLog ? `log₁₀ ${unit}` : unit }, len: 0.8 };
    if (useLog) Object.assign(colorbar, logTicks(zmin, zmax));
    const cxm = f.cx * 1000, cym = f.cy * 1000;
    const shapes = ringShapes(f.rings, z, scale, zmin, zmax, cxm, cym);
    const R = (f.b + f.tShield) * 1000;
    const traces = ringTraces(f.rings, vals, R, cxm, cym, 'S_z', unit, scale, zmin, zmax, colorbar);
    // Containment circles: P(< r) ∝ ln(r/a) for the TEM coax (not for a standing wave).
    if (opt.nContours > 0 && !ex.standing) {
        for (const [frac, dash, name] of CONTAIN) {
            const r = a * Math.pow(b / a, frac) * 1000;
            const X = [], Y = [];
            for (let kk = 0; kk <= 180; kk++) { const t = 2 * Math.PI * kk / 180; X.push(cxm + r * Math.cos(t)); Y.push(cym + r * Math.sin(t)); }
            traces.push({ type: 'scatter', mode: 'lines', x: X, y: Y, hoverinfo: 'skip', name, showlegend: true,
                line: { color: 'rgba(120, 220, 255, 0.9)', width: 1.4, dash } });
        }
    }
    return { traces, shapes, zMin: zmin, zMax: zmax, scaleLog: useLog, scaleUnit: unit, dataMin, dataMax, xMM: [-R, R], yMM: [-R, R],
             ...powerTitle(env, total, total, solver), power: total };
}

// ---- E / H arrows and S markers ------------------------------------------------------
// Arrows of the instantaneous transverse E and / or H at ωt on a regular lattice over the
// visible range. Direction from the instantaneous vector; length from the peak magnitude
// on a log scale over two decades (the field is singular at conductor corners) times the
// instantaneous fraction, so arrows shrink and flip as ωt runs. In the peak display the
// arrows show the field at the phase of its own maximum.
export function buildArrowData(env, arrows, xr, yr) {
    const out = {};
    if (!arrows.E && !arrows.H && !arrows.S) return out;
    const { ex, opt, solver } = env;
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
    // Phase of the drawing: ωt, or for the peak display the phase of each field's drive.
    const phaseOf = (k) => (opt.inst ? opt.wt : -carg(k === 'E' ? ex.cE : ex.cH));
    if (arrows.S && vals.E && vals.H) {
        const S = vals.E.map((e, k) => {
            const h = vals.H[k];
            if (!e || !h) return 0;
            if (opt.inst) {
                const cw = Math.cos(opt.wt), sw = Math.sin(opt.wt);
                const exn = e.xr * cw - e.xi * sw, eyn = e.yr * cw - e.yi * sw;
                const hxn = h.xr * cw - h.xi * sw, hyn = h.yr * cw - h.yi * sw;
                return exn * hyn - eyn * hxn;
            }
            return 0.5 * ((e.xr * h.yr + e.xi * h.yi) - (e.yr * h.xr + e.yi * h.xi));
        });
        // Size reference: the peak envelope |E|·|H|, so the markers pulse with ωt.
        const envl = vals.E.map((e, k) => {
            const h = vals.H[k];
            return (e && h) ? Math.hypot(e.xr, e.xi, e.yr, e.yi) * Math.hypot(h.xr, h.xi, h.yr, h.yi) * (opt.inst ? 1 : 0.5) : 0;
        }).filter(v => v > 0).sort((p, q) => p - q);
        const X = [], Y = [], SZ = [], SYM = [];
        if (envl.length) {
            const ref = envl[Math.min(envl.length - 1, Math.floor(0.98 * envl.length))];
            S.forEach((v, idx) => {
                if (!(Math.abs(v) > 1e-2 * ref)) return;
                const g = Math.min(1, Math.max(0, Math.log10(Math.abs(v) / ref) / 2 + 1));
                X.push(pts[idx][0]); Y.push(pts[idx][1]); SZ.push(4 + 10 * g);
                SYM.push(v >= 0 ? 'circle-open-dot' : 'circle-x-open');
            });
        }
        out.S = { x: X, y: Y, size: SZ, symbol: SYM };
    }
    for (const k of ['E', 'H']) {
        if (!arrows[k] || !vals[k]) continue;
        const ph = phaseOf(k), cp = Math.cos(ph), sp = Math.sin(ph);
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
function timeLabel(opt) {
    return opt.inst ? ` at ωt = ${+opt.phaseDeg.toFixed(1)}°` : ' (peak)';
}

// Field-line / contour overlay of the geometry view.
export function geometryLines(env) {
    const { solver } = env;
    if (isWaveguide(solver)) return env.f ? waveguideLineTraces(env, true) : [];
    if (isCoax(solver)) return coaxLineTraces(env, true);
    return staticLineTraces(env, true);
}

// A dark seam under every light line (field lines, equipotentials, power lines), so
// they stay visible on the bright end of a color map.
function addHalos(traces) {
    const out = [];
    for (const t of traces) {
        const col = t && t.type === 'scatter' && t.mode === 'lines' && t.line && t.line.color;
        const m = col && String(col).match(/\d+(\.\d+)?/g);
        // Solid light lines only: a seam under a dotted line would turn it into a grey line.
        const light = m && (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 > 170 && !/arrows/.test(t.name || '')
            && !t.line.dash;
        if (light) {
            out.push({ type: 'scatter', mode: 'lines', x: t.x, y: t.y, hoverinfo: 'skip', showlegend: false,
                       line: { color: 'rgba(0, 0, 0, 0.3)', width: (t.line.width || 1) + 1.0 } });
        }
        out.push(t);
    }
    return out;
}

// Builds a field view. Returns { traces, shapes, title, zMin, zMax, dataMin, dataMax,
// xMM, yMM } or { pending: true } while the H / J data is being computed, or
// { error } when the view is not available.
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
    return mqsView(env, view === 'hfield');
}

// Hook used by buildArrowData callers to know whether the H arrows replace the waveguide
// quiver.
export function needsMqs(view, arrows) {
    return view === 'hfield' || view === 'jfield' || view === 'sfield' || arrows.H || arrows.S;
}
