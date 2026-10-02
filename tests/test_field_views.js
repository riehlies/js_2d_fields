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
// for microstrip, a differential pair (odd and even), coax and waveguide. Also checks the
// fixed scale of the instantaneous display and a standing wave.
import { MicrostripSolver } from '../src/microstrip.js';
import { CoaxSolver } from '../src/coax.js';
import { RectWaveguideSolver } from '../src/rect_waveguide.js';
import { initTriBackend, TriBackend } from '../src/tri_solver/tri_backend.js';
import { buildFieldView, dielectricAt } from '../src/field_views.js';
import { excitation, reflection, standingWave, cmul, cconj } from '../src/field_excitation.js';

const ctx = await initTriBackend();
let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    if (!ok) failures++;
}

const F = 1e9;
const optBase = { inst: false, wt: 0, phaseDeg: 0, log: true, nLines: 10, nContours: 10, contourKind: 'equi' };

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
        solver: s, view, f: field, ex, opt, freq: f,
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
    // Instantaneous display: the scale stays that of the peak, the field follows cos ωt.
    const pk = buildFieldView(env(s, tb, res, 'efield', 0, {}));
    const at60 = buildFieldView(env(s, tb, res, 'efield', 0, {}, { ...optBase, inst: true, wt: Math.PI / 3, phaseDeg: 60 }));
    const mx = (v) => { let m = 0; for (const row of v.traces[0].z) for (const z of row) if (z !== null && z > m) m = z; return m; };
    check('instantaneous |E| at 60° is half the peak', Math.abs(mx(at60) / mx(pk) - 0.5) < 1e-6, `${(mx(at60) / mx(pk)).toFixed(4)}`);
    check('instantaneous display keeps the peak color scale', at60.zMax === pk.zMax);
    // Standing wave, open end, λ/8: E and H 90° apart, average power ≈ 0.
    const m0 = res.modes[0];
    const base = excitation({ kind: 'V', value: 1, Zc: m0.Zc });
    const sw = standingWave(base.V, base.I, reflection('open', m0.Zc), 0.125);
    const e = env(s, tb, res, 'sfield', 0, {});
    e.ex = { ...e.ex, cE: sw.V, cH: sw.I, Pexp: 0.5 * cmul(sw.V, cconj(sw.I)).re };
    const v = buildFieldView(e);
    check('open end, λ/8: average power flow nearly zero', Math.abs(v.power) < 0.02 * base.P,
          `${(v.power * 1e6).toFixed(2)} µW of ${(base.P * 1e3).toFixed(2)} mW incident`);
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
                               sigma_cond: 5.8e7, freq: F, mesh_backend: 'triangular' });
    const { tb, res } = await setup(s);
    powerCheck('coax', env(s, tb, res, 'sfield', 0, {}), 0.005);
    const pot = buildFieldView(env(s, tb, res, 'potential', 0, {}));
    check('coax potential from the closed form', pot.zMax === 1 && pot.zMin === 0, `${pot.zMin}…${pot.zMax}`);
}

// ---- waveguide ----
{
    const s = new RectWaveguideSolver({ width: 22.86e-3, height: 10.16e-3, sigma_cond: 5.8e7, freq: 10e9 });
    const { tb, res } = await setup(s, 10e9);
    powerCheck('waveguide TE10, 2 W', env(s, tb, res, 'sfield', 0, { kind: 'P', value: 2 }, optBase, 10e9), 0.01);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
