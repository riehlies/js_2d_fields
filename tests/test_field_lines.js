// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Field-line placement (src/streamlines.js) and the resampled static field next to a
// round conductor (src/tri_solver/resample.js).
//   1. Equal flux per line: a line charge with a dielectric (εr = 4) below it and air
//      above sends 4/5 of its flux D = εE downwards, so 4/5 of the lines must start on
//      the lower half of the conductor.
//   2. Odd mode: a line between two signal conductors is drawn once, not twice.
//   3. Coax: |E| on the plot grid follows V/(r·ln(b/a)) up to the inner conductor, with
//      no spike from the mesh hole of the round conductor and the conductor at 1 V.
import { electricFieldLines } from '../src/streamlines.js';
import { CoaxSolver } from '../src/coax.js';
import { initTriBackend, TriBackend } from '../src/tri_solver/tri_backend.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    if (!ok) failures++;
}

const axis = (a, b, n) => Float64Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
const grid = (xs, ys, fn) => {
    const Ex = [], Ey = [];
    for (const y of ys) {
        const rx = new Float64Array(xs.length), ry = new Float64Array(xs.length);
        xs.forEach((x, i) => { const [ex, ey] = fn(x, y); rx[i] = ex; ry[i] = ey; });
        Ex.push(rx); Ey.push(ry);
    }
    return { Ex, Ey };
};
// Polylines → list of [start, end] points.
const lines = (fl) => {
    const out = [];
    let cur = [];
    for (let k = 0; k < fl.x.length; k++) {
        if (fl.x[k] === null) { if (cur.length) out.push(cur); cur = []; }
        else cur.push([fl.x[k] / 1000, fl.y[k] / 1000]);
    }
    if (cur.length) out.push(cur);
    return out;
};

// ---- 1: flux weighting with a dielectric ----
{
    const xs = axis(-1, 1, 401), ys = axis(-1, 1, 401);
    const { Ex, Ey } = grid(xs, ys, (x, y) => { const r2 = x * x + y * y || 1e-12; return [x / r2, y / r2]; });
    const a = 0.05;
    const conductors = [{ is_signal: true, x_min: -a, x_max: a, y_min: -a, y_max: a, width: 2 * a, height: 2 * a }];
    const n = 40;
    const fl = electricFieldLines({ Ex, Ey, x: xs, y: ys, conductors, epsAt: (x, y) => (y < 0 ? 4 : 1), n });
    const ls = lines(fl);
    const down = ls.filter(l => l[0][1] < 0).length;
    check('every line is drawn', ls.length === n, `${ls.length}`);
    check('4/5 of the lines start into the εr = 4 half', Math.abs(down / ls.length - 0.8) <= 0.05, `${down} of ${ls.length}`);
    const flAir = electricFieldLines({ Ex, Ey, x: xs, y: ys, conductors, epsAt: () => 1, n });
    const downAir = lines(flAir).filter(l => l[0][1] < 0).length;
    check('without the dielectric half of them', Math.abs(downAir / n - 0.5) <= 0.05, `${downAir} of ${n}`);
}

// ---- 2: odd mode, lines between two conductors drawn once ----
{
    const xs = axis(-1, 1, 401), ys = axis(-1, 1, 401);
    const d = 0.3, a = 0.05;
    // Two opposite line charges at x = ±d: E = r̂₊/r₊ − r̂₋/r₋.
    const { Ex, Ey } = grid(xs, ys, (x, y) => {
        const x1 = x + d, x2 = x - d;
        const r1 = x1 * x1 + y * y || 1e-12, r2 = x2 * x2 + y * y || 1e-12;
        return [x1 / r1 - x2 / r2, y / r1 - y / r2];
    });
    const sq = (cx) => ({ is_signal: true, x_min: cx - a, x_max: cx + a, y_min: -a, y_max: a, width: 2 * a, height: 2 * a });
    const conductors = [sq(-d), sq(d)];
    const n = 30;
    const ls = lines(electricFieldLines({ Ex, Ey, x: xs, y: ys, conductors, epsAt: () => 1, n }));
    const joining = ls.filter(l => {
        const s = l[0], e = l[l.length - 1];
        const near = (p, cx) => Math.abs(p[0] - cx) <= a * 1.01 && Math.abs(p[1]) <= a * 1.01;
        return (near(s, -d) && near(e, d)) || (near(s, d) && near(e, -d));
    }).length;
    // All flux of a symmetric dipole inside the box joins the two conductors (apart from
    // the lines leaving the plotted area): without the de-duplication there would be
    // about n lines between them, with it about n/2.
    check('lines between the conductors are drawn once', joining > 0.3 * n && joining <= 0.55 * n, `${joining} of ${n}`);
}

// ---- 3: coax field on the plot grid ----
{
    const ctx = await initTriBackend();
    const a = 0.5e-3, b = 1.75e-3;
    const s = new CoaxSolver({ inner_diameter: 2 * a, dielectric_diameter: 2 * b, epsilon_r: 2.1,
                               sigma_cond: 5.8e7, freq: 1e9, mesh_backend: 'triangular' });
    const tb = new TriBackend(ctx, s, { maxNodes: 12000 });
    await tb.buildMesh();
    tb.solveAt(1e9);
    const { x, y, Ex, Ey, V } = tb._static[tb.modeNames[0]].fields;
    const L = Math.log(b / a);
    let mx = 0, worst = 0, sum = 0, n = 0, vMin = Infinity, vMax = -Infinity;
    for (let j = 0; j < y.length; j++) for (let i = 0; i < x.length; i++) {
        const r = Math.hypot(x[i], y[j]);
        const e = Math.hypot(Ex[j][i], Ey[j][i]);
        mx = Math.max(mx, e);
        if (r < 0.9 * a) { vMin = Math.min(vMin, V[j][i]); vMax = Math.max(vMax, V[j][i]); }
        if (r > 1.02 * a && r < b / 1.02) {
            const err = Math.abs(e * r * L - 1);
            worst = Math.max(worst, err); sum += err; n++;
        }
    }
    const eA = 1 / (a * L);
    check('no |E| spike at the round inner conductor', mx < 1.05 * eA, `max ${mx.toFixed(0)} V/m, V/(a·ln(b/a)) = ${eA.toFixed(0)} V/m`);
    check('|E| within 1.5 % of the closed form beyond 2 % of a from the surface', worst < 0.015, `${(100 * worst).toFixed(2)} %`);
    check('mean |E| error below 0.2 %', sum / n < 0.002, `${(100 * sum / n).toFixed(3)} %`);
    check('inner conductor interior at its potential', Math.abs(vMin - 1) < 1e-9 && Math.abs(vMax - 1) < 1e-9, `${vMin}…${vMax}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
