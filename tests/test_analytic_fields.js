// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Closed-form H field / current density for coax and rectangular waveguide
// (tri_solver/analytic_fields.js), checked against independent references and
// against the solver's own loss results:
//   1. Complex Bessel J0/J1: reference values, series/asymptotic agreement.
//   2. Coax: inner conductor carries +1 A, shield −1 A; DC limit (uniform current,
//      R = 1/(σπa²)); the R implied by the plotted current, ∫|J|²/σ dA, matches the
//      solver's R at 1 and 10 GHz.
//   3. Waveguide: the plotted transverse H carries 1 W (½·Z_TE·∫|Ht|² dA); the
//      attenuation implied by the plotted wall current matches the solver's alpha_c;
//      below cutoff the request is refused.
import { CoaxSolver } from '../src/coax.js';
import { RectWaveguideSolver } from '../src/rect_waveguide.js';
import { besselJScaled } from '../src/tri_solver/analytic_fields.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    if (!ok) failures++;
}
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const MU0 = 4 * Math.PI * 1e-7, C0 = 299792458, NP_TO_DB = 20 / Math.LN10;
const SIG = 5.8e7;

// ---- 1: Bessel ----
{
    const J = (n, re, im) => { const r = besselJScaled(n, { re, im }); const e = Math.exp(r.s); return [r.v.re * e, r.v.im * e]; };
    const refs = [
        [0, 1, 0, 0.7651976865579666, 0], [1, 1, 0, 0.4400505857449335, 0],
        [0, 10, 0, -0.2459357644513483, 0], [1, 30, 0, -0.1187510626166229, 0],
        [0, 1, -1, 0.9376084768060293, 0.4965299476091221],
    ];
    let worst = 0;
    for (const [n, re, im, er, ei] of refs) {
        const [a, b] = J(n, re, im);
        worst = Math.max(worst, Math.hypot(a - er, b - ei) / Math.hypot(er, ei));
    }
    check('complex Bessel J0/J1 reference values', worst < 1e-9, `worst rel. error ${worst.toExponential(1)}`);
}

// ---- 2: coax ----
async function solved(s, f) {
    await quiet(() => s.solve_adaptive({ max_nodes: 20000 }));
    return (await quiet(() => s.computeAtFrequency(f))).modes[0];
}
function ringIntegrals(r, sigma) {
    let Iin = { re: 0, im: 0 }, Ish = { re: 0, im: 0 }, Rin = 0, Rsh = 0;
    for (const g of r.rings) {
        if (g.Jr === null) continue;
        const A = Math.PI * (g.r1 * g.r1 - g.r0 * g.r0);
        const inner = g.r1 <= r.a * (1 + 1e-12);
        const I = inner ? Iin : Ish;
        I.re += g.Jr * A; I.im += g.Ji * A;
        const p = (g.Jr * g.Jr + g.Ji * g.Ji) * A / sigma;
        if (inner) Rin += p; else Rsh += p;
    }
    return { Iin, Ish, Rin, Rsh };
}
{
    const geom = { inner_diameter: 1e-3, dielectric_diameter: 3.5e-3, epsilon_r: 2.1, tan_delta: 0,
                   sigma_cond: SIG, freq: 1e9 };
    const s = new CoaxSolver(geom);
    const m1 = await solved(s, 1e9);
    const tri = s._triBackend;
    const r1 = tri.mqsFieldAt(1e9, 'single');
    check('coax field export ok (closed form)', r1.ok && r1.kind === 'radial', r1.reason || '');
    const q = ringIntegrals(r1, SIG);
    check('coax inner conductor carries +1 A', Math.abs(q.Iin.re - 1) < 2e-3 && Math.abs(q.Iin.im) < 2e-3,
        `${q.Iin.re.toFixed(5)} ${q.Iin.im >= 0 ? '+' : ''}${q.Iin.im.toFixed(5)}j A`);
    check('coax shield carries −1 A', Math.abs(q.Ish.re + 1) < 1e-2 && Math.abs(q.Ish.im) < 1e-2,
        `${q.Ish.re.toFixed(5)} ${q.Ish.im >= 0 ? '+' : ''}${q.Ish.im.toFixed(5)}j A`);
    // Every ring's H at r: Ampère, 2πr·Hφ = enclosed current (dielectric: 1 A).
    const d = r1.rings.find(g => g.Jr === null);
    const rm = 0.5 * (d.r0 + d.r1);
    check('coax dielectric: 2πr·Hφ = 1 A', Math.abs(2 * Math.PI * rm * Math.hypot(d.Hr, d.Hi) - 1) < 2e-2);

    for (const [f, m] of [[1e9, m1], [10e9, null]]) {
        const mm = m || (await quiet(() => s.computeAtFrequency(f))).modes[0];
        const rf = f === 1e9 ? r1 : tri.mqsFieldAt(f, 'single');
        const qq = ringIntegrals(rf, SIG);
        const Rfield = qq.Rin + qq.Rsh;
        check(`coax R from the plotted current = solver R at ${f / 1e9} GHz`, rel(Rfield, mm.RLGC.R) < 0.03,
            `∫|J|²/σ = ${Rfield.toFixed(3)} Ω/m vs solver ${mm.RLGC.R.toFixed(3)} Ω/m`);
    }
    // DC limit: δ = 6.6 mm ≫ a at 100 Hz, inner current uniform, R_inner = 1/(σπa²).
    const rDC = tri.mqsFieldAt(100, 'single');
    const qd = ringIntegrals(rDC, SIG);
    const Rdc = 1 / (SIG * Math.PI * (0.5e-3) ** 2);
    check('coax 100 Hz: inner R = 1/(σπa²)', rel(qd.Rin, Rdc) < 1e-3,
        `${(qd.Rin * 1e3).toFixed(4)} vs ${(Rdc * 1e3).toFixed(4)} mΩ/m`);
}

// ---- 3: rectangular waveguide (WR-90) ----
{
    const A = 22.86e-3, B = 10.16e-3;
    const s = new RectWaveguideSolver({ width: A, height: B, sigma_cond: SIG, freq: 10e9 });
    const f = 10e9;
    const m = await solved(s, f);
    const tri = s._triBackend;
    const r = tri.mqsFieldAt(f, 'single');
    check('waveguide field export ok (TE10)', r.ok && r.kind === 'wg' && r.mode === 'TE10', r.reason || '');
    // Power: P = ½·Z_TE·∫|Ht|² dA over the interior, Z_TE = ωμ0/β.
    const omega = 2 * Math.PI * f, ZTE = omega * MU0 / r.beta;
    const ew = s.enclosure_walls;
    let P = 0;
    for (let j = 0; j + 1 < r.y.length; j++) {
        const yc = 0.5 * (r.y[j] + r.y[j + 1]);
        if (yc < ew.y_min || yc > ew.y_max) continue;
        for (let i = 0; i + 1 < r.x.length; i++) {
            const xc = 0.5 * (r.x[i] + r.x[i + 1]);
            if (xc < ew.x_min || xc > ew.x_max) continue;
            let h2 = 0;
            for (const [jj, ii] of [[j, i], [j + 1, i], [j, i + 1], [j + 1, i + 1]])
                h2 += r.Hxr[jj][ii] ** 2 + r.Hxi[jj][ii] ** 2 + r.Hyr[jj][ii] ** 2 + r.Hyi[jj][ii] ** 2;
            P += 0.5 * ZTE * (h2 / 4) * (r.x[i + 1] - r.x[i]) * (r.y[j + 1] - r.y[j]);
        }
    }
    check('waveguide transverse H carries 1 W', Math.abs(P - 1) < 0.01, `${P.toFixed(4)} W`);
    // Wall loss from the plotted current: per unit length P' = ½·Rs·∮|K|² dl with the
    // surface current |K| = |J(0)|·δ/√2 (thick wall), J(0) on the wall-surface lines.
    const Rs = 1 / (SIG * r.delta);
    const nearestIdx = (arr, v) => { let k = 0; for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[k] - v)) k = i; return k; };
    const K2 = (j, i) => (r.J[j][i] * r.delta / Math.SQRT2) ** 2;
    let Pl = 0;
    const tr = (a, b, fa, fb) => (b - a) * (fa + fb) / 2;
    for (const yw of [ew.y_min - 1e-9, ew.y_max + 1e-9]) {
        // the grid line exactly on the wall surface belongs to the interior, take the
        // first line inside the metal (depth 0.1δ) and undo its decay e^(−0.1)
        const j = nearestIdx(r.y, yw < ew.y_max ? ew.y_min - 0.1 * r.delta : ew.y_max + 0.1 * r.delta);
        for (let i = 0; i + 1 < r.x.length; i++) {
            if (r.x[i] < ew.x_min || r.x[i + 1] > ew.x_max) continue;
            Pl += 0.5 * Rs * tr(r.x[i], r.x[i + 1], K2(j, i), K2(j, i + 1)) * Math.exp(0.2);
        }
    }
    for (const xw of [ew.x_min, ew.x_max]) {
        const i = nearestIdx(r.x, xw === ew.x_min ? ew.x_min - 0.1 * r.delta : ew.x_max + 0.1 * r.delta);
        for (let j = 0; j + 1 < r.y.length; j++) {
            if (r.y[j] < ew.y_min || r.y[j + 1] > ew.y_max) continue;
            Pl += 0.5 * Rs * tr(r.y[j], r.y[j + 1], K2(j, i), K2(j + 1, i)) * Math.exp(0.2);
        }
    }
    const alphaField = Pl / (2 * P);   // Np/m
    check('waveguide alpha_c from the plotted wall current = solver alpha_c',
        rel(alphaField, m.alpha_c / NP_TO_DB) < 0.03,
        `${(alphaField * NP_TO_DB).toFixed(4)} vs ${m.alpha_c.toFixed(4)} dB/m`);
    const rc = tri.mqsFieldAt(5e9, 'single');
    check('waveguide below cutoff is refused with a reason', !rc.ok && /cutoff/.test(rc.reason || ''));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
