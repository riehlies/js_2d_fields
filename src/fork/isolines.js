// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Contour lines (marching squares) on a rectilinear grid, joined into polylines.
//
// The field views draw equipotentials, H field lines and power-containment lines with
// these instead of Plotly contour traces: Plotly re-runs its own contouring (with
// smoothing) over the whole grid for every contour trace on every redraw, which made a
// redraw of the |H| or power-flow view take 0.5–1.3 s. Here one pass per level costs a
// few milliseconds and the result is a plain line trace.
//
// Cells with a missing corner (null / NaN, e.g. inside metal) are skipped, so lines end
// at masked regions. Saddle cells are resolved with the cell-centre average.

/**
 * @param {ArrayLike<number>} xs  grid x (any unit, used for the output)
 * @param {ArrayLike<number>} ys  grid y
 * @param {Array<ArrayLike<number|null>>} z  values [ny][nx]
 * @param {number[]} levels
 * @returns {{x: Array<number|null>, y: Array<number|null>}} polylines separated by null
 */
export function isoLines(xs, ys, z, levels) {
    const nx = xs.length, ny = ys.length;
    const X = [], Y = [];
    const fin = (v) => v !== null && v !== undefined && Number.isFinite(v);
    const lv = Array.from(levels).filter(Number.isFinite).sort((p, q) => p - q);
    if (!lv.length) return { x: X, y: Y };
    const hk = (i, j) => (j * nx + i) * 2;        // edge (i,j)–(i+1,j)
    const vk = (i, j) => (j * nx + i) * 2 + 1;    // edge (i,j)–(i,j+1)
    // One pass over the cells for all levels: a cell is only visited for the levels
    // between its smallest and largest corner value.
    const pts = lv.map(() => new Map());   // per level: edge key → [x, y]
    const adj = lv.map(() => new Map());   // per level: edge key → [edge keys]
    const firstAbove = (v) => {            // first level index with lv[k] >= v
        let lo = 0, hi = lv.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (lv[m] < v) lo = m + 1; else hi = m; }
        return lo;
    };
    for (let j = 0; j < ny - 1; j++) {
        const r0 = z[j], r1 = z[j + 1];
        if (!r0 || !r1) continue;
        const y0 = ys[j], y1 = ys[j + 1];
        for (let i = 0; i < nx - 1; i++) {
            const a = r0[i], b = r0[i + 1], cc = r1[i + 1], d = r1[i];   // BL, BR, TR, TL
            if (!fin(a) || !fin(b) || !fin(cc) || !fin(d)) continue;
            const mn = Math.min(a, b, cc, d), mx = Math.max(a, b, cc, d);
            if (!(mx > mn)) continue;
            const x0 = xs[i], x1 = xs[i + 1];
            const kB = hk(i, j), kR = vk(i + 1, j), kT = hk(i, j + 1), kL = vk(i, j);
            for (let li = firstAbove(mn); li < lv.length && lv[li] < mx; li++) {
                const L = lv[li];
                const idx = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (cc > L ? 4 : 0) | (d > L ? 8 : 0);
                if (idx === 0 || idx === 15) continue;
                const P = pts[li], A = adj[li];
                const put = (key, px, py) => { if (!P.has(key)) P.set(key, [px, py]); return key; };
                const link = (p, q) => {
                    let lp = A.get(p); if (!lp) A.set(p, lp = []); lp.push(q);
                    let lq = A.get(q); if (!lq) A.set(q, lq = []); lq.push(p);
                };
                const pB = () => put(kB, x0 + (L - a) / (b - a) * (x1 - x0), y0);
                const pT = () => put(kT, x0 + (L - d) / (cc - d) * (x1 - x0), y1);
                const pL = () => put(kL, x0, y0 + (L - a) / (d - a) * (y1 - y0));
                const pR = () => put(kR, x1, y0 + (L - b) / (cc - b) * (y1 - y0));
                switch (idx) {
                    case 1: case 14: link(pL(), pB()); break;
                    case 2: case 13: link(pB(), pR()); break;
                    case 4: case 11: link(pR(), pT()); break;
                    case 8: case 7: link(pL(), pT()); break;
                    case 3: case 12: link(pL(), pR()); break;
                    case 6: case 9: link(pB(), pT()); break;
                    case 5:     // BL and TR above
                        if ((a + b + cc + d) / 4 > L) { link(pB(), pR()); link(pL(), pT()); }
                        else { link(pL(), pB()); link(pR(), pT()); }
                        break;
                    case 10:    // BR and TL above
                        if ((a + b + cc + d) / 4 > L) { link(pL(), pB()); link(pR(), pT()); }
                        else { link(pB(), pR()); link(pL(), pT()); }
                        break;
                }
            }
        }
    }
    // Join the segments into polylines: open chains from their ends first, then the
    // remaining closed loops.
    lv.forEach((L, li) => {
        const P = pts[li], A = adj[li];
        const walk = (start) => {
            let cur = start;
            const p0 = P.get(cur); X.push(p0[0]); Y.push(p0[1]);
            for (;;) {
                const l = A.get(cur);
                if (!l || !l.length) break;
                const nxt = l.pop();
                const ln = A.get(nxt); ln.splice(ln.indexOf(cur), 1);
                const p = P.get(nxt); X.push(p[0]); Y.push(p[1]);
                cur = nxt;
            }
            X.push(null); Y.push(null);
        };
        for (const [k, l] of A) if (l.length === 1) walk(k);
        for (const [k, l] of A) while (l.length) walk(k);
    });
    return { x: X, y: Y };
}
