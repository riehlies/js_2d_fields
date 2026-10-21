// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Worker side of the fork's field views: one job, 'forkField', that turns the field the
// original already solved for its plots into the grid data of the |H|, current density,
// power flow and loss views (src/fork/field_views.js).
//
// This file and mqs_grid.js are the only fork code that reads the original's solver
// internals (TriBackend: modeNames, domain, _plotCache, the MQS plot field). When an
// update of the original breaks the views, this is where to look.
//
// Registered in solve_worker.js: JOBS = { ..., ...forkJobs(() => simSolver) }.

import { fieldFromPlotSlot, buildMqsGrid, resampleMqsField, mqsLossShares } from './mqs_grid.js';
import { coaxFieldAt, waveguideFieldAt } from './analytic_fields.js';

const MU0 = 4 * Math.PI * 1e-7;
const f32 = (A) => A.map(row => Float32Array.from(row));

// H, J and A on a plot grid for mode `modeIdx` (0 = odd / single-ended, 1 = even) at the
// frequency of the original's current plot fields. { ok: false, reason } when there is
// no eddy-current field at that frequency.
function fieldAtPlotFrequency(s, modeIdx) {
    if (!s || !s.solution_valid) return { ok: false, reason: 'Solve the structure first.' };
    const f = s.fieldFreq;
    if (!(f > 0)) return { ok: false, reason: 'The current distribution needs a plot frequency above 0 Hz.' };
    // Closed forms: the waveguide mode and the concentric coax (rings, exact skin effect).
    if (s.mode_type === 'waveguide') return { ...waveguideFieldAt(s, f), f };
    if (s.is_coax) return { ...coaxFieldAt(s, f), f };
    const tri = s._triBackend;
    if (!tri || s.mesh_backend !== 'triangular') {
        return { ok: false, reason: 'H field, current density, power flow and losses need the Full-wave solver.' };
    }
    const mode = tri.modeNames[modeIdx] ?? tri.modeNames[0];
    const pc = tri._plotCache;
    const slot = pc && pc.f === f && pc.modes && pc.modes[mode];
    const mqs = slot && slot.mqs;
    if (!mqs || !mqs.field || !mqs.field.sol) {
        return { ok: false, reason: 'No eddy-current solve at the plot frequency (perturbation loss method, '
            + 'or the loss came from cached anchors). Change the plot frequency to solve it.' };
    }
    const field = fieldFromPlotSlot(mqs.field, mqs.cr);
    const forcedX = [], forcedY = [];
    for (const c of (s.conductors || [])) {
        forcedX.push(c.x_min, c.x_max);
        forcedY.push(c.y_min, c.y_max);
    }
    const grid = buildMqsGrid(field.mesh, tri.domain, field, { resolution: 400, forcedX, forcedY });
    const parity = field.sym > 1 ? (mode === 'odd' ? 'odd' : 'even') : null;
    const r = resampleMqsField(field.mesh, field, grid, parity);
    const sh = mqsLossShares(field.mesh, field);
    return {
        ok: true, f, mode,
        x: Float64Array.from(r.x), y: Float64Array.from(r.y),
        H: f32(r.H), Hxr: f32(r.Hxr), Hxi: f32(r.Hxi), Hyr: f32(r.Hyr), Hyi: f32(r.Hyi),
        J: f32(r.J), Jr: f32(r.Jr), Ji: f32(r.Ji), Q: f32(r.Q),
        Ar: f32(r.Ar), Ai: f32(r.Ai),
        sigma: field.sigma,
        delta: Math.sqrt(2 / (2 * Math.PI * f * MU0 * field.sigma)),
        deltaWall: field.deltaW,
        lossSplit: { trace: sh.signal, ground: sh.groundRects + sh.walls },
        differential: !!s.is_differential,
        triMesh: { nodes: field.mesh.nodes, tris: field.mesh.tris, nTris: field.mesh.nTris },
    };
}

export function forkJobs(getSolver) {
    return {
        forkField: async ({ modeIdx }) => {
            let field;
            try {
                field = fieldAtPlotFrequency(getSolver(), modeIdx | 0);
            } catch (e) {
                field = { ok: false, reason: (e && e.message) || String(e) };
            }
            return { field };
        },
    };
}
