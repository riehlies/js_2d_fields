// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK.md for the list of changes.
//
// Shape helpers of the fork's field views that the original's shapes.js no longer has.

// A conductor that fills everything OUTSIDE its outline (the old coax shield).
export function isComplement(shape) {
    return !!shape && (shape.type === 'outside_circle' || shape.type === 'outside_polygon');
}

// SVG path of a circular ring (centre cx, cy, radii rIn < rOut) for Plotly shapes
// with fillrule 'evenodd'.
export function svgRingPath(cx, cy, rIn, rOut, n = 180) {
    const loop = (r, dir) => {
        let d = '';
        for (let k = 0; k < n; k++) {
            const th = dir * 2 * Math.PI * k / n;
            const x = cx + r * Math.cos(th), y = cy + r * Math.sin(th);
            d += (k === 0 ? 'M' : 'L') + x.toFixed(6) + ',' + y.toFixed(6);
        }
        return d + 'Z';
    };
    return loop(rOut, 1) + loop(rIn, -1);
}
