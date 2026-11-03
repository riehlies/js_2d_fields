// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK.md for the list of changes.
//
// Contract test of the fork's field views on the original's solver: the worker job
// 'forkField' (src/fork/worker_jobs.js) reads the original's plot fields, the views
// (src/fork/field_views.js) scale them by one excitation. Run after every update of the
// original: when it changes its internals, this test shows whether the adapter still fits.
//   - power: ∫ ½·Re(E × H*) dA = n·½·Re(V·I*) for microstrip (1 V, 1 W), pair odd / even,
//     coax, waveguide (E from the original's plot fields, H from the adapter)
//   - losses: the dielectric part of the loss map integrates to 2·α_d·P (microstrip),
//     the coax rings to 2·α_c·P and 2·α_d·P; the conductor loss split of the adapter
//     matches the solver's R (smooth metal, no roughness)
//   - color scales: potential symmetric around 0 V, |E| on a log scale, J signed on the
//     linear one
// Run: node tests/fork/test_field_views.js
import { MicrostripSolver } from '../../src/microstrip.js';
import { CoaxSolver } from '../../src/coax.js';
import { RectWaveguideSolver } from '../../src/rect_waveguide.js';
import { forkJobs } from '../../src/fork/worker_jobs.js';
import { buildFieldView, dielectricAt } from '../../src/fork/field_views.js';
import { excitation, cmul, cconj } from '../../src/fork/field_excitation.js';
import { check, done, quiet } from '../helpers.js';

const NP = 1 / 8.685889638065035;
const optBase = { log: true, nLines: 10, nContours: 10 };

// Solve at f, plot fields at f, the adapter's field of mode `modeIdx`.
async function setup(s, f) {
    s.use_causal_materials = false;
    const cached = await quiet(() => s.solve_adaptive({ max_nodes: 20000 }));
    await quiet(() => s.plotFieldsAt(f, cached));
    const res = await quiet(() => s.computeAtFrequency(f, cached));
    return { res };
}
async function env(s, res, view, modeIdx, exOpts = {}, opt = optBase) {
    const diff = !!s.is_differential, wg = s.mode_type === 'waveguide';
    const mode = diff ? (modeIdx === 0 ? 'odd' : 'even') : 'single';
    const m = res.modes[modeIdx];
    const ex = excitation({ kind: 'V', value: 1, Zc: m.Zc, nCond: diff ? 2 : 1, mode, waveguide: wg, ...exOpts });
    ex.nCond = diff ? 2 : 1; ex.mode = mode;
    ex.Pexp = wg ? ex.P : ex.nCond * 0.5 * cmul(ex.cE, cconj(ex.cH)).re;
    const { field } = await forkJobs(() => s).forkField({ modeIdx });
    return {
        solver: s, view, f: field, ex, opt, freq: s.fieldFreq, alpha: { c: m.alpha_c * NP, d: m.alpha_d * NP },
        E: { Ex: s.Ex && s.Ex[modeIdx], Ey: s.Ey && s.Ey[modeIdx] }, V: s.V && s.V[modeIdx],
        epsAt: (x, y) => dielectricAt(s, x, y), stored: () => null, arrowsH: false, mRes: m,
    };
}
function powerCheck(name, e, tol) {
    const v = buildFieldView(e);
    const err = Math.abs(v.power / e.ex.Pexp - 1);
    check(`${name}: ∫S dA = n·½Re(V·I*)`, err < tol,
          `${(v.power * 1e3).toFixed(4)} mW vs ${(e.ex.Pexp * 1e3).toFixed(4)} mW, ${(100 * err).toFixed(2)} %`);
}

const F = 1e9;
const ms = { trace_width: 0.3e-3, substrate_height: 0.254e-3, trace_thickness: 35e-6, epsilon_r: 3.66,
             tan_delta: 0.003, sigma_cond: 5.8e7, rq: 0, gnd_thickness: 35e-6, freq: F, mesh_backend: 'triangular',
             boundaries: ['open', 'open', 'open', 'gnd'] };

// ---- microstrip ----
{
    const s = new MicrostripSolver(ms);
    const { res } = await setup(s, F);
    const e = await env(s, res, 'sfield', 0);
    check('adapter: field at the plot frequency', e.f.ok && e.f.f === F, e.f.reason || '');
    powerCheck('microstrip, 1 V', e, 0.02);
    powerCheck('microstrip, 1 W', await env(s, res, 'sfield', 0, { kind: 'P', value: 1 }), 0.02);
    // Loss split of the adapter against the solver's R (per 1 A: P = ½·R·1², R per line).
    const sp = e.f.lossSplit, R = e.mRes.RLGC.R;
    const err = Math.abs((sp.trace + sp.ground) / (0.5 * R) - 1);
    check('adapter: conductor loss of the split = ½·R·(1 A)²', err < 0.03,
          `${(sp.trace + sp.ground).toFixed(3)} vs ${(0.5 * R).toFixed(3)} W/m, ${(100 * err).toFixed(2)} %`);
    const pot = buildFieldView({ ...e, view: 'potential' });
    check('potential: symmetric scale around 0 V', pot.zMin === -pot.zMax && Math.abs(pot.zMax - 1) < 0.02,
          `${pot.zMin.toFixed(4)}…${pot.zMax.toFixed(4)}`);
    const eLog = buildFieldView({ ...e, view: 'efield' });
    check('|E|: log scale', eLog.scaleLog && eLog.zMax - eLog.zMin <= 3 + 1e-9);
    const jLin = buildFieldView({ ...e, view: 'jfield', opt: { ...optBase, log: false } });
    let pos = 0, neg = 0;
    for (const row of jLin.traces[0].z) for (const v of row) { if (v > 0) pos++; if (v < 0) neg++; }
    check('J linear: signed, current and return current', jLin.zMin === -jLin.zMax && pos > 0 && neg > 0, `${pos} / ${neg}`);
    const lv = buildFieldView({ ...e, view: 'lossfield' });
    const pd = 2 * e.alpha.d * e.ex.Pexp, ed = Math.abs(lv.lossDielMap / pd - 1);
    check('losses: dielectric map integral = 2·α_d·P', ed < 0.06, `${(100 * ed).toFixed(2)} %`);
    check('losses: title with the split', /signal conductor .*ground .*dielectric/.test(lv.info), lv.info);
}

// ---- differential pair ----
{
    const s = new MicrostripSolver({ ...ms, trace_width: 0.2e-3, trace_spacing: 0.2e-3, substrate_height: 0.2e-3, is_differential: true });
    const { res } = await setup(s, F);
    if (s.is_differential && res.modes.length === 2) {
        // Above its static limit the original plots the full-wave mode E fitted to the
        // static field by least squares, not normalized to the trace voltage: for this
        // pair at 1 GHz that is 2.5 % (odd) and 4 % (even) more power than V·I predicts
        // (exact with the static E, checked at 20 MHz while porting).
        powerCheck('differential pair, odd mode', await env(s, res, 'sfield', 0), 0.05);
        powerCheck('differential pair, even mode', await env(s, res, 'sfield', 1), 0.05);
    } else {
        check('differential pair solved with two modes', false, `is_differential=${s.is_differential}, modes=${res.modes.length}`);
    }
}

// ---- coax (closed form) ----
{
    const s = new CoaxSolver({ inner_diameter: 1e-3, dielectric_diameter: 3.5e-3, epsilon_r: 2.1, tan_delta: 0.0004,
                               sigma_cond: 5.8e7, freq: F });
    const { res } = await setup(s, F);
    const e = await env(s, res, 'sfield', 0);
    powerCheck('coax', e, 0.005);
    const lv = buildFieldView({ ...e, view: 'lossfield' });
    const pc = 2 * e.alpha.c * e.ex.Pexp, pd = 2 * e.alpha.d * e.ex.Pexp;
    check('coax losses: conductor rings = 2·α_c·P', Math.abs(lv.lossCondMap / pc - 1) < 0.03, `${(100 * (lv.lossCondMap / pc - 1)).toFixed(2)} %`);
    check('coax losses: dielectric rings = 2·α_d·P', Math.abs(lv.lossDielMap / pd - 1) < 0.02, `${(100 * (lv.lossDielMap / pd - 1)).toFixed(2)} %`);
}

// ---- waveguide ----
{
    const s = new RectWaveguideSolver({ width: 22.86e-3, height: 10.16e-3, sigma_cond: 5.8e7, freq: 10e9 });
    const { res } = await setup(s, 10e9);
    powerCheck('waveguide TE10, 2 W', await env(s, res, 'sfield', 0, { kind: 'P', value: 2 }), 0.01);
}

done();
