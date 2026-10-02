// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Field views (src/field_views.js) scaled by one excitation. The static E (1 V) and the
// eddy-current H (1 A) come from two different solves; scaled by V and I = V/Zc their
// Poynting vector must carry exactly the power the excitation predicts:
//   ∫ ½·Re(E × H*) dA = n·½·Re(V·I*)
// for microstrip, a differential pair (odd and even), coax and waveguide. The loss view
// must reproduce the solver's dielectric loss 2·α_d·P from its map (and for the coax the
// conductor loss 2·α_c·P from the closed-form current). Also checks the color scales: the
// potential symmetric around 0 V, |E| on a log scale, J with its sign on the linear one.
import { MicrostripSolver } from '../src/microstrip.js';
import { CoaxSolver } from '../src/coax.js';
import { RectWaveguideSolver } from '../src/rect_waveguide.js';
import { initTriBackend, TriBackend } from '../src/tri_solver/tri_backend.js';
import { buildFieldView, dielectricAt } from '../src/field_views.js';
import { excitation, cmul, cconj } from '../src/field_excitation.js';

const ctx = await initTriBackend();
let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    if (!ok) failures++;
}

const F = 1e9;
const optBase = { log: true, nLines: 10, nContours: 10, contourKind: 'equi' };
const NP = 1 / 8.685889638065035;

async function setup(s, f = F, maxNodes = 12000) {
    const tb = new TriBackend(ctx, s, { maxNodes });
    await tb.buildMesh();
    const res = tb.solveAt(f);
    return { tb, res };
}

function env(s, tb, res, view, modeIdx, exOpts, opt = optBase, f = F) {
    const diff = !!s.is_differential;
    const mode = diff ? (modeIdx === 0 ? 'odd' : 'even') : 'single';
    const m = res.modes[modeIdx];
    const wg = s.mode_type === 'waveguide';
    const ex = excitation({ kind: 'V', value: 1, Zc: m.Zc, nCond: diff ? 2 : 1, mode, waveguide: wg, ...exOpts });
    ex.nCond = diff ? 2 : 1; ex.mode = mode;
    ex.Pexp = wg ? ex.P : ex.nCond * 0.5 * cmul(ex.cE, cconj(ex.cH)).re;
    const field = tb.mqsFieldAt(f, tb.modeNames[modeIdx] ?? tb.modeNames[0]);
    return {
        solver: s, view, f: field, ex, opt, freq: f, alpha: { c: m.alpha_c * NP, d: m.alpha_d * NP },
        E: { Ex: s.Ex && s.Ex[modeIdx], Ey: s.Ey && s.Ey[modeIdx] }, V: s.V && s.V[modeIdx],
        epsAt: (x, y) => dielectricAt(s, x, y), stored: () => null, arrowsH: false,
    };
}

function powerCheck(name, e, tol) {
    const v = buildFieldView(e);
    const err = Math.abs(v.power / e.ex.Pexp - 1);
    check(`${name}: ∫S dA = n·½Re(V·I*)`, err < tol,
          `${(v.power * 1e3).toFixed(4)} mW vs ${(e.ex.Pexp * 1e3).toFixed(4)} mW, ${(100 * err).toFixed(2)} %`);
    return v;
}

const ms = { trace_width: 0.3e-3, substrate_height: 0.254e-3, trace_thickness: 35e-6, epsilon_r: 3.66,
             tan_delta: 0.003, sigma_cond: 5.8e7, rq: 0, gnd_thickness: 35e-6, freq: F, mesh_backend: 'triangular' };

// ---- microstrip ----
{
    const s = new MicrostripSolver(ms);
    const { tb, res } = await setup(s);
    powerCheck('microstrip, 1 V', env(s, tb, res, 'sfield', 0, {}), 0.02);
    powerCheck('microstrip, 1 W', env(s, tb, res, 'sfield', 0, { kind: 'P', value: 1 }), 0.02);
    const pot = buildFieldView(env(s, tb, res, 'potential', 0, {}));
    check('potential: symmetric scale around 0 V', pot.zMin === -pot.zMax && Math.abs(pot.zMax - 1) < 1e-6,
          `${pot.zMin}…${pot.zMax}`);
    const eLog = buildFieldView(env(s, tb, res, 'efield', 0, {}));
    const eLin = buildFieldView(env(s, tb, res, 'efield', 0, {}, { ...optBase, log: false }));
    const span = eLog.zMax - eLog.zMin;
    check('|E|: log scale up to the linear top, at most three decades', eLog.scaleLog && !eLin.scaleLog
          && Math.abs(10 ** eLog.zMax / eLin.zMax - 1) < 1e-9 && span <= 3 + 1e-9 && span >= 0.5, `${span.toFixed(2)} decades`);
    const jLin = buildFieldView(env(s, tb, res, 'jfield', 0, {}, { ...optBase, log: false }));
    let jPos = 0, jNeg = 0;
    for (const row of jLin.traces[0].z) for (const v of row) { if (v > 0) jPos++; if (v < 0) jNeg++; }
    check('J linear: signed, current and return current', jLin.zMin === -jLin.zMax && jPos > 0 && jNeg > 0
          && /^Jz/.test(jLin.title), `${jPos} positive, ${jNeg} negative cells`);
    // Losses: the dielectric part of the map against the solver.
    const lv = buildFieldView(env(s, tb, res, 'lossfield', 0, {}));
        const e0 = env(s, tb, res, 'lossfield', 0, {});
    const pdExp = 2 * e0.alpha.d * e0.ex.Pexp;
    const err = Math.abs(lv.lossDielMap / pdExp - 1);
    check('losses: dielectric map integral = 2·α_d·P', err < 0.06,
          `${(lv.lossDielMap * 1e3).toFixed(4)} mW/m vs ${(pdExp * 1e3).toFixed(4)} mW/m, ${(100 * err).toFixed(1)} %`);
    check('losses: title with the split', /signal conductor .*ground .*dielectric/.test(lv.info), lv.info);
    check('losses: log scale over five decades', lv.scaleLog && Math.abs(lv.zMax - lv.zMin - 5) < 1e-9);
}

// ---- differential pair ----
{
    const s = new MicrostripSolver({ ...ms, trace_width: 0.2e-3, trace_spacing: 0.2e-3, substrate_height: 0.2e-3 });
    const { tb, res } = await setup(s, F, 18000);
    powerCheck('differential pair, odd mode', env(s, tb, res, 'sfield', 0, {}), 0.025);
    powerCheck('differential pair, even mode', env(s, tb, res, 'sfield', 1, {}), 0.025);
}

// ---- coax (closed form) ----
{
    const s = new CoaxSolver({ inner_diameter: 1e-3, dielectric_diameter: 3.5e-3, epsilon_r: 2.1,
                               tan_delta: 0.0004, sigma_cond: 5.8e7, freq: F, mesh_backend: 'triangular' });
    const { tb, res } = await setup(s);
    powerCheck('coax', env(s, tb, res, 'sfield', 0, {}), 0.005);
    const pot = buildFieldView(env(s, tb, res, 'potential', 0, {}));
    check('coax potential from the closed form', pot.zMax === 1 && pot.zMin === -1, `${pot.zMin}…${pot.zMax}`);
    const e = env(s, tb, res, 'lossfield', 0, {});
    const lv = buildFieldView(e);
    const pc = 2 * e.alpha.c * e.ex.Pexp, pd = 2 * e.alpha.d * e.ex.Pexp;
    const ec = Math.abs(lv.lossCondMap / pc - 1), ed = Math.abs(lv.lossDielMap / pd - 1);
    check('coax losses: conductor rings = 2·α_c·P', ec < 0.02, `${(100 * ec).toFixed(2)} %`);
    check('coax losses: dielectric rings = 2·α_d·P', ed < 0.02, `${(100 * ed).toFixed(2)} %`);
}

// ---- waveguide ----
{
    const s = new RectWaveguideSolver({ width: 22.86e-3, height: 10.16e-3, sigma_cond: 5.8e7, freq: 10e9 });
    const { tb, res } = await setup(s, 10e9);
    powerCheck('waveguide TE10, 2 W', env(s, tb, res, 'sfield', 0, { kind: 'P', value: 2 }, optBase, 10e9), 0.01);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
