// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// H field / current density export from the MQS eddy-current solve
// (TriBackend.mqsFieldAt, tri_solver/mqs_field.js).
//
// Pins:
//   1. Normalization: the FEM current in the meshed signal metal equals the line
//      current the solve was normalized to (exact, the quadrature integrates the P2
//      current exactly), and Ampère's law around each trace on the resampled grid
//      gives ±1 A per trace with the mode's polarity, for the half-domain solve
//      (single-ended, odd, even) and the full-domain multi-drive differential path.
//   2. Physics: uniform current at low frequency (δ well above the thickness),
//      exponential skin decay across a wide face at high frequency.
//   3. Metal walls: the absorbed ground plane carries the reconstructed slab current
//      (opposite sign to the trace, decaying with depth); a stripline's top wall too.
//   4. Refusals: f = 0 and shaped conductors (coax) report ok = false with a reason.
import { MicrostripSolver } from '../src/microstrip.js';
import { CoaxSolver } from '../src/coax.js';
import { initTriBackend, TriBackend } from '../src/tri_solver/tri_backend.js';
import { mqsConductorLoss } from '../src/tri_solver/mqs_loss.js';
import { mqsMeshCurrents } from '../src/tri_solver/mqs_field.js';

const ctx = await initTriBackend();
let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    if (!ok) failures++;
}

const SIGMA = 5.8e7;
const ms = {
    trace_width: 0.3e-3, substrate_height: 0.254e-3, trace_thickness: 35e-6,
    epsilon_r: 3.66, tan_delta: 0.003, sigma_cond: SIGMA, rq: 0,
    gnd_thickness: 35e-6, freq: 1e9,
};
const diff = { ...ms, trace_width: 0.2e-3, trace_spacing: 0.2e-3, substrate_height: 0.2e-3 };

async function backend(geom, triOpts = {}) {
    const s = new MicrostripSolver(geom);
    const b = new TriBackend(ctx, s, { maxNodes: 18000, ...triOpts });
    await b.buildMesh();
    b.solveAt(1e9);
    return b;
}

const nearest = (arr, v) => {
    let k = 0;
    for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[k] - v)) k = i;
    return k;
};

// ∮H·dl counter-clockwise around [x0, x1] × [y0, y1] on the grid (trapezoidal).
function ampere(r, x0, x1, y0, y1) {
    const { x, y } = r;
    const i0 = nearest(x, x0), i1 = nearest(x, x1), j0 = nearest(y, y0), j1 = nearest(y, y1);
    const tr = (a, b, fa, fb) => (b - a) * (fa + fb) / 2;
    let re = 0, im = 0;
    for (let i = i0; i < i1; i++) {
        re += tr(x[i], x[i + 1], r.Hxr[j0][i], r.Hxr[j0][i + 1]) - tr(x[i], x[i + 1], r.Hxr[j1][i], r.Hxr[j1][i + 1]);
        im += tr(x[i], x[i + 1], r.Hxi[j0][i], r.Hxi[j0][i + 1]) - tr(x[i], x[i + 1], r.Hxi[j1][i], r.Hxi[j1][i + 1]);
    }
    for (let j = j0; j < j1; j++) {
        re += tr(y[j], y[j + 1], r.Hyr[j][i1], r.Hyr[j + 1][i1]) - tr(y[j], y[j + 1], r.Hyr[j][i0], r.Hyr[j + 1][i0]);
        im += tr(y[j], y[j + 1], r.Hyi[j][i1], r.Hyi[j + 1][i1]) - tr(y[j], y[j + 1], r.Hyi[j][i0], r.Hyi[j + 1][i0]);
    }
    return { re, im };
}

function traceAmperes(b, r, margin = 25e-6) {
    return b.solver.conductors.filter(c => c.is_signal).map(c =>
        ampere(r, c.x_min - margin, c.x_max + margin, c.y_min - margin, c.y_max + margin));
}

// ---- 1: single-ended microstrip, normalization ----
{
    const b = await backend(ms);
    const r = b.mqsFieldAt(1e9, 'single');
    check('microstrip field export ok', r.ok, r.reason || '');
    const [a] = traceAmperes(b, r);
    check('microstrip Ampère around trace = 1 A', Math.abs(a.re - 1) < 0.01 && Math.abs(a.im) < 0.01,
        `${a.re.toFixed(4)} ${a.im >= 0 ? '+' : ''}${a.im.toFixed(4)}j A`);

    // FEM current in the meshed (half) signal metal = I_mesh = 0.5 A, independent of
    // the resampling.
    const out = mqsConductorLoss(b._skinCache.mesh, b.condRect, 1e9, SIGMA,
        ctx.helpers.solveComplexSymmetric, 0, { cache: {}, returnField: true,
            wallPEC: b.condRect.wallPEC, wallThick: b.condRect.wallThick });
    const I = mqsMeshCurrents(b._skinCache.mesh, out.field).signal;
    check('FEM signal current = 0.5 A on the half mesh', Math.abs(I.re - 0.5) < 1e-6 && Math.abs(I.im) < 1e-6,
        `${I.re.toFixed(8)} ${I.im >= 0 ? '+' : ''}${I.im.toExponential(1)}j A`);

    // ---- 2: physics ----
    const c = b.solver.conductors.find(cc => cc.is_signal);
    const insideTrace = (rr, fn) => {
        const vals = [];
        for (let j = 0; j < rr.y.length; j++) {
            if (rr.y[j] <= c.y_min + 2e-6 || rr.y[j] >= c.y_max - 2e-6) continue;
            for (let i = 0; i < rr.x.length; i++) {
                if (rr.x[i] <= c.x_min + 2e-6 || rr.x[i] >= c.x_max - 2e-6) continue;
                vals.push(fn(rr, j, i));
            }
        }
        return vals;
    };
    const rLow = b.mqsFieldAt(1e5, 'single');
    const jl = insideTrace(rLow, (rr, j, i) => rr.J[j][i]).filter(Number.isFinite);
    const lmax = Math.max(...jl), lmin = Math.min(...jl);
    check('100 kHz: current nearly uniform in the trace (δ = 210 µm ≫ t)',
        jl.length > 20 && lmax / lmin < 1.25, `max/min ${(lmax / lmin).toFixed(3)} over ${jl.length} pts`);
    // Mean J ≈ I / area.
    const area = (c.x_max - c.x_min) * (c.y_max - c.y_min);
    const mean = jl.reduce((s, v) => s + v, 0) / jl.length;
    check('100 kHz: mean |J| ≈ 1 A / trace area', Math.abs(mean * area - 1) < 0.1,
        `mean·A = ${(mean * area).toFixed(3)} A`);

    // 10 GHz: |J| along the trace's top-face normal at x = 0 decays as e^(−s/δ).
    const rHi = b.mqsFieldAt(10e9, 'single');
    const i0 = nearest(rHi.x, 0);
    const pts = [];
    for (let j = 0; j < rHi.y.length; j++) {
        const s = c.y_max - rHi.y[j];
        if (s >= 0.5 * rHi.delta && s <= 4 * rHi.delta && Number.isFinite(rHi.J[j][i0])) pts.push([s, rHi.J[j][i0]]);
    }
    // Least-squares slope of ln|J| vs s.
    let slope = NaN;
    if (pts.length >= 3) {
        const n = pts.length, sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + Math.log(p[1]), 0);
        const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * Math.log(p[1]), 0);
        slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    }
    const decay = -1 / slope;
    check('10 GHz: |J| decays into the top face with length ≈ δ',
        Math.abs(decay / rHi.delta - 1) < 0.2, `fitted ${(decay * 1e6).toFixed(3)} µm vs δ ${(rHi.delta * 1e6).toFixed(3)} µm, ${pts.length} pts`);

    // ---- 3: ground plane slab current ----
    const jg = [];
    for (let j = 0; j < rHi.y.length; j++) {
        const s = -rHi.y[j];
        if (s > 0 && s < 3 * rHi.deltaWall && Number.isFinite(rHi.Jr[j][i0])) jg.push([s, rHi.Jr[j][i0], rHi.J[j][i0]]);
    }
    jg.sort((p, q) => p[0] - q[0]);   // shallowest first
    check('ground plane carries return current (opposite sign under the trace)',
        jg.length >= 2 && jg.every(p => p[1] < 0 || p[2] < 1e-3 * jg[0][2]),
        jg.slice(0, 3).map(p => `s=${(p[0] * 1e6).toFixed(2)}µm Jr=${p[1].toExponential(2)}`).join(', '));
    check('ground plane |J| decays with depth', jg.length >= 2 && jg[jg.length - 1][2] < jg[0][2],
        `${jg[0] && jg[0][2].toExponential(2)} → ${jg.length && jg[jg.length - 1][2].toExponential(2)} A/m²`);
    // Surface current density ∫J ds under the trace from the slab profile equals the
    // tangential H at the surface (|K| = |Hx|): compare J(0)·δ/(1+j) with H at y = 0⁺.
    const jSurf = nearest(rHi.y, 0);
    const Hs = Math.hypot(rHi.Hxr[jSurf][i0], rHi.Hxi[jSurf][i0]);
    check('ground surface |J(0)| = |K|·√2/δ (thick plane)',
        Math.abs(rHi.J[jSurf][i0] * rHi.deltaWall / Math.SQRT2 / Hs - 1) < 0.02,
        `|J0|δ/√2 = ${(rHi.J[jSurf][i0] * rHi.deltaWall / Math.SQRT2).toFixed(1)} A/m vs |H| ${Hs.toFixed(1)} A/m`);

    // ---- 4: refusals ----
    const r0 = b.mqsFieldAt(0, 'single');
    check('f = 0 is refused with a reason', !r0.ok && typeof r0.reason === 'string');
}

// ---- 1: differential pair, half domain (mode walls) and full domain (multi-drive) ----
for (const [label, triOpts] of [['half domain', {}], ['full domain, multi-drive', { symmetry: false }]]) {
    const b = await backend(diff, triOpts);
    for (const [mode, sign] of [['odd', -1], ['even', +1]]) {
        const r = b.mqsFieldAt(1e9, mode);
        const a = traceAmperes(b, r).sort((p, q) => 0);
        const sig = b.solver.conductors.filter(c => c.is_signal);
        const left = a[sig[0].x_min < sig[1].x_min ? 0 : 1], right = a[sig[0].x_min < sig[1].x_min ? 1 : 0];
        // Right trace +1 A, left trace ±1 A with the mode's sign.
        const ok = r.ok && Math.abs(right.re - 1) < 0.015 && Math.abs(left.re - sign) < 0.015
            && Math.abs(left.im) < 0.015 && Math.abs(right.im) < 0.015;
        check(`diff ${label}, ${mode}: Ampère ${sign > 0 ? '+1/+1' : '−1/+1'} A per trace`, ok,
            `left ${left.re.toFixed(4)}, right ${right.re.toFixed(4)} A`);
    }
}

// ---- 3: stripline top wall ----
{
    const b = await backend({ trace_width: 0.15e-3, substrate_height: 0.2e-3, trace_thickness: 17e-6,
        gnd_thickness: 17e-6, epsilon_r: 4.1, epsilon_r_top: 4.1, tan_delta: 0.02, tan_delta_top: 0.02,
        enclosure_height: 0.4e-3, sigma_cond: SIGMA, freq: 2e9, rq: 0, boundaries: ['open', 'open', 'gnd', 'gnd'] });
    const r = b.mqsFieldAt(1e9, 'single');
    const [a] = traceAmperes(b, r);
    check('stripline Ampère around trace = 1 A', r.ok && Math.abs(a.re - 1) < 0.01, `${a.re.toFixed(4)} A`);
    check('stripline has a metal top wall', r.ok && r.wallPEC.top === true);
    // Current just above the top wall's surface (inside the top ground metal).
    const ytop = Math.max(...b.solver.dielectrics.map(d => d.y_max));
    let found = false;
    for (let j = 0; j < r.y.length; j++) {
        if (r.y[j] > ytop && r.y[j] < ytop + 3 * r.deltaWall && Number.isFinite(r.J[nearest(r.y, r.y[j])][nearest(r.x, 0)])
            && r.Jr[j][nearest(r.x, 0)] < 0) { found = true; break; }
    }
    check('stripline top ground carries return current', found);
}

// ---- 4: shaped conductors are refused ----
{
    const s = new CoaxSolver({ inner_diameter: 1e-3, dielectric_diameter: 3.5e-3, epsilon_r: 2.1, sigma_cond: SIGMA, freq: 1e9, mesh_backend: 'triangular' });
    const b = new TriBackend(ctx, s, { maxNodes: 12000 });
    await b.buildMesh();
    b.solveAt(1e9);
    const r = b.mqsFieldAt(1e9, b.modeNames[0]);
    check('coax (shaped conductors) is refused with a reason', !r.ok && typeof r.reason === 'string', r.reason || '');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
