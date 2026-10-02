// MODIFIED 2026-10-02 by David Riehl (fork of https://github.com/Ttl/js_2d_fields, GPL v3):
// rewritten. Field lines now start at points spaced by equal electric FLUX (D = εE, so each
// line carries the same charge), cover all signal conductors with one budget, are traced
// with an adaptive RK4 step on a binary-search grid sampler, stop in field-free regions
// instead of drifting, and lines between two signal conductors are drawn once.
// See FORK_CHANGES.md for the full list of changes.
//
// Electric field lines of a quasi-TEM cross-section.
//
// Seeding: the boundary of every signal conductor is sampled densely, each sample
// weighted by the flux density |ε·E·n| leaving or entering the metal there (the surface
// charge, Gauss). One cumulative distribution over all signal conductors is split into
// n equal parts and a line starts at the midpoint of each part, so every line carries
// the same flux and the line density anywhere is proportional to |D|. The start
// direction follows the sign of E·n: away from the conductor along +E where the charge
// is positive, along −E where it is negative.
//
// A line between two signal conductors (odd mode) is found from both ends. The copy
// traced from the negatively charged end is dropped, its partner from the positive end
// carries the same flux.
import { shapeContains, distToShapeBoundary, shapePerimeter, shapePerimeterPoint,
         isComplement } from './shapes.js';

function inMetal(conductors, x, y) {
    for (let k = 0; k < conductors.length; k++) {
        if (shapeContains(conductors[k], x, y, 0)) return k;
    }
    return -1;
}

function distToMetal(conductors, x, y) {
    let d = Infinity;
    for (const c of conductors) d = Math.min(d, distToShapeBoundary(c, x, y));
    return d;
}

// Bilinear field sampler on a rectilinear grid, index lookup by binary search.
function gridSampler(xs, ys, Ex, Ey) {
    const nx = xs.length, ny = ys.length;
    const find = (arr, n, v) => {
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid; }
        return lo;
    };
    return (x, y) => {
        if (!(x >= xs[0] && x <= xs[nx - 1] && y >= ys[0] && y <= ys[ny - 1])) return null;
        const i = find(xs, nx, x), j = find(ys, ny, y);
        const tx = (x - xs[i]) / ((xs[i + 1] - xs[i]) || 1), ty = (y - ys[j]) / ((ys[j + 1] - ys[j]) || 1);
        const bl = (A) => (A[j][i] * (1 - tx) + A[j][i + 1] * tx) * (1 - ty)
                        + (A[j + 1][i] * (1 - tx) + A[j + 1][i + 1] * tx) * ty;
        return { ex: bl(Ex), ey: bl(Ey) };
    };
}

// Boundary samples of one conductor: points just outside the surface with the outward
// normal. Rectangles walk their four faces, round conductors their perimeter.
function boundarySamples(c, n, offset) {
    const out = [];
    if (c.shape) {
        for (let k = 0; k < n; k++) {
            const p = shapePerimeterPoint(c, (k + 0.5) / n);
            out.push({ x: p.x + p.nx * offset, y: p.y + p.ny * offset, nx: p.nx, ny: p.ny,
                       ds: shapePerimeter(c) / n });
        }
        return out;
    }
    const x0 = Math.min(c.x_min, c.x_max), x1 = Math.max(c.x_min, c.x_max);
    const y0 = Math.min(c.y_min, c.y_max), y1 = Math.max(c.y_min, c.y_max);
    const w = x1 - x0, h = y1 - y0, per = 2 * (w + h);
    const faces = [
        { len: w, at: (t) => [x0 + t * w, y1 + offset], nx: 0, ny: 1 },
        { len: h, at: (t) => [x1 + offset, y1 - t * h], nx: 1, ny: 0 },
        { len: w, at: (t) => [x1 - t * w, y0 - offset], nx: 0, ny: -1 },
        { len: h, at: (t) => [x0 - offset, y0 + t * h], nx: -1, ny: 0 },
    ];
    for (const f of faces) {
        const m = Math.max(2, Math.round(n * f.len / per));
        for (let k = 0; k < m; k++) {
            const [x, y] = f.at((k + 0.5) / m);
            out.push({ x, y, nx: f.nx, ny: f.ny, ds: f.len / m });
        }
    }
    return out;
}

/**
 * Field lines of E from the signal conductors.
 *
 * @param {object} o
 * @param {Array<Float64Array>} o.Ex, o.Ey  field on the grid, [ny][nx]
 * @param {ArrayLike<number>} o.x, o.y      grid coordinates (m)
 * @param {Array} o.conductors              all conductors (signal ones carry is_signal)
 * @param {function} o.epsAt                (x, y) → relative permittivity
 * @param {number} o.n                      number of lines (equal flux each)
 * @returns {{x: Array<number|null>, y: Array<number|null>}} polylines in mm
 */
export function electricFieldLines({ Ex, Ey, x, y, conductors, epsAt, n }) {
    const X = [], Y = [];
    if (!(n > 0) || !Ex || !Ey) return { x: X, y: Y };
    const samp = gridSampler(x, y, Ex, Ey);
    const nx = x.length, ny = y.length;
    const W = x[nx - 1] - x[0], H = y[ny - 1] - y[0], diag = Math.hypot(W, H);
    // A complement (coax shield) is never a source, but it is metal a line ends on.
    const metal = conductors;
    const signal = conductors.filter(c => c.is_signal && !(c.shape && isComplement(c.shape)));
    if (!signal.length) return { x: X, y: Y };
    const offset = 1e-4 * diag;

    // Flux-weighted samples over all signal conductors.
    const samples = [];
    let total = 0, eRef = 0;
    signal.forEach((c) => {
        for (const s of boundarySamples(c, 400, offset)) {
            const f = samp(s.x, s.y);
            if (!f) continue;
            const en = f.ex * s.nx + f.ey * s.ny;
            const flux = Math.abs(en) * (epsAt ? epsAt(s.x, s.y) : 1) * s.ds;
            if (!(flux > 0)) continue;
            eRef = Math.max(eRef, Math.hypot(f.ex, f.ey));
            total += flux;
            samples.push({ ...s, cum: total, dir: en >= 0 ? 1 : -1, cond: c });
        }
    });
    if (!(total > 0)) return { x: X, y: Y };

    const dsMax = diag / 250, dsMin = diag / 1e5;
    const eStop = 1e-5 * eRef;
    let si = 0;
    for (let k = 0; k < n; k++) {
        const target = (k + 0.5) / n * total;
        while (si < samples.length - 1 && samples[si].cum < target) si++;
        const s = samples[si];
        const line = traceLine(s, samp, metal, dsMin, dsMax, eStop, 4 * diag, offset);
        // Odd mode: drop the copy found from the negative end of a line that joins two
        // signal conductors.
        if (s.dir < 0 && line.end && line.end.is_signal) continue;
        if (line.pts.length < 2) continue;
        for (const [px, py] of line.pts) { X.push(px * 1000); Y.push(py * 1000); }
        X.push(null); Y.push(null);
    }
    return { x: X, y: Y };
}

// RK4 along ±E/|E| from the seed until the line enters metal, leaves the grid, reaches
// a field-free region or exceeds the length budget.
function traceLine(seed, samp, metal, dsMin, dsMax, eStop, maxLen, offset) {
    const dir = seed.dir;
    // Start ON the surface (the seed sits `offset` outside it).
    const pts = [[seed.x - seed.nx * offset, seed.y - seed.ny * offset], [seed.x, seed.y]];
    let x = seed.x, y = seed.y, len = 0, end = null;
    const unit = (px, py) => {
        const f = samp(px, py);
        if (!f) return null;
        const m = Math.hypot(f.ex, f.ey);
        if (!(m > eStop)) return null;
        return [dir * f.ex / m, dir * f.ey / m];
    };
    for (let step = 0; step < 6000 && len < maxLen; step++) {
        const d = distToMetal(metal, x, y);
        const ds = Math.min(dsMax, Math.max(dsMin, 0.4 * d));
        const k1 = unit(x, y); if (!k1) break;
        const k2 = unit(x + 0.5 * ds * k1[0], y + 0.5 * ds * k1[1]); if (!k2) break;
        const k3 = unit(x + 0.5 * ds * k2[0], y + 0.5 * ds * k2[1]); if (!k3) break;
        const k4 = unit(x + ds * k3[0], y + ds * k3[1]); if (!k4) break;
        const nx = x + ds * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6;
        const ny = y + ds * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
        const hit = inMetal(metal, nx, ny);
        if (hit >= 0) {
            // Bisect onto the surface and stop there.
            let ax = x, ay = y, bx = nx, by = ny;
            for (let it = 0; it < 30; it++) {
                const mx = 0.5 * (ax + bx), my = 0.5 * (ay + by);
                if (inMetal(metal, mx, my) >= 0) { bx = mx; by = my; } else { ax = mx; ay = my; }
            }
            pts.push([bx, by]);
            end = metal[hit];
            break;
        }
        len += Math.hypot(nx - x, ny - y);
        x = nx; y = ny;
        pts.push([x, y]);
    }
    return { pts, end };
}
