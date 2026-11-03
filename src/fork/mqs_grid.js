// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK.md for the list of changes.
//
// Magnetic field and conductor current density from the MQS eddy-current solve,
// resampled onto a rectilinear plot grid, and the split of the conductor loss.
//
// Input: the original's MQS plot field (mqsConductorLoss opts.fieldOut, kept by
// TriBackend in its plot slot) plus the wall and symmetry data of its conductor set,
// assembled by fieldFromPlotSlot() below. Only this file and worker_jobs.js read the
// original's internals.
//
// The MQS solve (mqs_loss.js) works with the z-directed vector potential on a
// P2 mesh that includes the conductor interiors. With the field export
// (mqsConductorLoss opts.returnField) the physical quantities are
//
//   A  = C·A1                       (C = Cr + jCi, A1 = normalized solution)
//   H  = (∂A/∂y, −∂A/∂x) / μ0       everywhere (μr = 1)
//   Jz = σ·C·(u − jω·A1)            in meshed metal, u = drive (signal) or 0 (ground rect)
//
// for a line current of 1 A (per trace for a differential pair). Domain walls that
// are metal (absorbed ground planes, enclosure walls) are boundary conditions in the
// solve, A = 0, so they carry no volume unknowns. Their current is reconstructed from
// the surface current K = n × H at the wall with the same 1D slab model the loss
// calculation uses (field-free back face, thickness d):
//
//   Jz(s) = K·γ·cosh(γ(d − s)) / sinh(γd),    H_t(s) = H_t(0)·sinh(γ(d − s)) / sinh(γd)
//
// with γ = (1 + j)/δ and s the depth below the wall surface. For d ≫ δ both reduce
// to K·γ·e^(−γs) and H_t(0)·e^(−γs).

import { lv, le, lvGrad, leGrad, triCoefficients } from '../tri_solver/tri_fem.js';
import { buildGridFromMesh } from '../tri_solver/resample.js';

const MU0 = 4 * Math.PI * 1e-7;
const EV = [[0, 1], [1, 2], [2, 0]];
const isMetal = (cls) => cls === 1 || cls === 2;   // signal metal, passive ground rect

// The MQS plot field of one mode, in the form the functions below read: the original's
// fieldOut (mesh, sol, nF, dofOf, isCondTri, triGroup, triRect, sRel, sigma, omega, Cr,
// Ci, CgR, CgI) plus symmetry, walls and domain from its conductor set `cr`.
export function fieldFromPlotSlot(F, cr, wallSigma) {
    const sigmaW = wallSigma ?? F.sigma;
    return {
        ...F,
        sym: cr.symmetry > 1 ? 2 : 1,
        wallPEC: { ...(cr.wallPEC || {}) }, wallThick: { ...(cr.wallThick || {}) },
        sigmaW, deltaW: Math.sqrt(2 / (F.omega * MU0 * sigmaW)),
        domain: { xmin: cr.xmin_domain, xmax: cr.xmax_domain, ymin: cr.ymin_domain ?? 0, ymax: cr.ymax_domain },
    };
}

// Point location in a triangle mesh: bucket grid over the triangles' bounding boxes,
// first triangle whose barycentric coordinates are all >= -1e-9.
function makeLocator(mesh) {
    const { nodes, tris, nTris } = mesh;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < mesh.nNodes; i++) {
        const x = nodes[2 * i], y = nodes[2 * i + 1];
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
    const nb = Math.max(1, Math.round(Math.sqrt(nTris)));
    const dx = (xmax - xmin) / nb || 1, dy = (ymax - ymin) / nb || 1;
    const bx = (x) => Math.min(nb - 1, Math.max(0, Math.floor((x - xmin) / dx)));
    const by = (y) => Math.min(nb - 1, Math.max(0, Math.floor((y - ymin) / dy)));
    const buckets = Array.from({ length: nb * nb }, () => []);
    for (let t = 0; t < nTris; t++) {
        const v0 = tris[3 * t], v1 = tris[3 * t + 1], v2 = tris[3 * t + 2];
        const x0 = Math.min(nodes[2 * v0], nodes[2 * v1], nodes[2 * v2]), x1 = Math.max(nodes[2 * v0], nodes[2 * v1], nodes[2 * v2]);
        const y0 = Math.min(nodes[2 * v0 + 1], nodes[2 * v1 + 1], nodes[2 * v2 + 1]), y1 = Math.max(nodes[2 * v0 + 1], nodes[2 * v1 + 1], nodes[2 * v2 + 1]);
        for (let i = bx(x0); i <= bx(x1); i++) for (let j = by(y0); j <= by(y1); j++) buckets[i * nb + j].push(t);
    }
    const cache = new Array(nTris).fill(null);
    const coeffOf = (t) => cache[t] || (cache[t] = triCoefficients(nodes, tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]).coeff);
    let last = -1;
    const inside = (t, x, y) => {
        const c = coeffOf(t);
        return c[0][0] + c[0][1] * x + c[0][2] * y >= -1e-9 && c[1][0] + c[1][1] * x + c[1][2] * y >= -1e-9
            && c[2][0] + c[2][1] * x + c[2][2] * y >= -1e-9;
    };
    const locate = (x, y) => {
        if (x < xmin || x > xmax || y < ymin || y > ymax) return -1;
        if (last >= 0 && inside(last, x, y)) return last;
        for (const t of buckets[bx(x) * nb + by(y)]) if (inside(t, x, y)) { last = t; return t; }
        return -1;
    };
    return { locate, coeffOf };
}

// Complex helpers on [re, im] pairs.
const cmul = (ar, ai, br, bi) => [ar * br - ai * bi, ar * bi + ai * br];
const cdiv = (ar, ai, br, bi) => {
    const d = br * br + bi * bi;
    return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
};
const ccosh = (a, b) => [Math.cosh(a) * Math.cos(b), Math.sinh(a) * Math.sin(b)];
const csinh = (a, b) => [Math.sinh(a) * Math.cos(b), Math.cosh(a) * Math.sin(b)];

// Depth profiles of the 1D slab (complex factors relative to the surface value):
// current density per unit surface current, and the tangential H ratio.
// x = d/δ (Infinity for a semi-infinite wall), u = s/δ.
function slabProfile(x, u, delta) {
    if (!(x < 20)) {
        // e^(−γs) = e^(−u)·(cos u − j sin u); γ = (1 + j)/δ.
        const e = Math.exp(-u);
        const er = e * Math.cos(u), ei = -e * Math.sin(u);
        const [jr, ji] = cmul(er, ei, 1 / delta, 1 / delta);
        return { jr, ji, hr: er, hi: ei };
    }
    // γd = (1 + j)x, γ(d − s) = (1 + j)(x − u).
    const v = Math.max(0, x - u);
    const [shr, shi] = csinh(x, x);
    const [chr, chi] = ccosh(v, v);
    const [svr, svi] = csinh(v, v);
    const [cr, ci] = cdiv(chr, chi, shr, shi);
    const [jr, ji] = cmul(cr, ci, 1 / delta, 1 / delta);
    const [hr, hi] = cdiv(svr, svi, shr, shi);
    return { jr, ji, hr, hi };
}

// Plot grid for the MQS fields: graded on the skin-refined mesh (so the skin layers
// get grid lines), with the conductor faces and a few skin-depth lines inside each
// metal wall forced in.
export function buildMqsGrid(mqsMesh, domain, field, opts = {}) {
    const forcedX = [...(opts.forcedX || [])], forcedY = [...(opts.forcedY || [])];
    const d = field.domain, wt = field.wallThick || {}, wp = field.wallPEC || {};
    const deltaW = field.deltaW;
    const depths = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6];
    const addDepth = (arr, base, sign, side) => {
        if (!wp[side]) return;
        const t = wt[side] ?? Infinity;
        for (const k of depths) {
            const s = k * deltaW;
            if (s < t) arr.push(base + sign * s);
        }
    };
    addDepth(forcedY, d.ymin, -1, 'bottom');
    addDepth(forcedY, d.ymax, +1, 'top');
    addDepth(forcedX, d.xmax, +1, 'right');
    if (field.sym > 1) {
        // Mirror image of the right wall on a half-domain solve.
        if (wp.right) for (const k of depths) {
            const s = k * deltaW;
            if (s < (wt.right ?? Infinity)) forcedX.push(-(d.xmax + s));
        }
    } else {
        addDepth(forcedX, d.xmin, -1, 'left');
    }
    // Companion lines just outside every metal face (conductor faces, wall surfaces and
    // the far face of a finite wall). A heatmap cell spans halfway to the neighbouring
    // grid line, so without them a face cell with data bleeds visibly into the
    // dielectric next to it (J is undefined there). The offset is just above the grid
    // builder's de-duplication tolerance so they survive.
    const res = opts.resolution || 400;
    const tolX = (domain.x_max - domain.x_min) / (res * 20);
    const tolY = (domain.y_max - domain.y_min) / (res * 20);
    const faceX = [...forcedX], faceY = [...forcedY];
    if (wp.bottom) faceY.push(d.ymin, d.ymin - (wt.bottom ?? Infinity));
    if (wp.top) faceY.push(d.ymax, d.ymax + (wt.top ?? Infinity));
    if (wp.right) faceX.push(d.xmax, d.xmax + (wt.right ?? Infinity));
    for (const v of faceX) if (Number.isFinite(v)) forcedX.push(v - 1.5 * tolX, v + 1.5 * tolX);
    for (const v of faceY) if (Number.isFinite(v)) forcedY.push(v - 1.5 * tolY, v + 1.5 * tolY);
    if (field.sym > 1) for (const v of faceX) if (Number.isFinite(v)) forcedX.push(-v - 1.5 * tolX, -v + 1.5 * tolX);
    return buildGridFromMesh(mqsMesh, domain, {
        resolution: res, forcedX, forcedY, mirrorX: field.sym > 1,
    });
}

// Resample H (complex Hx, Hy) and Jz onto `grid` ({x, y}). parity: null for a
// full-domain solve, 'even' / 'odd' for the parity of A about x = 0 on a half-domain
// solve (odd = the antisymmetric differential mode).
export function resampleMqsField(mesh, field, grid, parity = null) {
    const { nodes, tris, triEdges, nNodes, nTris } = mesh;
    const { sol, nF, dofOf, isCondTri, triGroup, Cr, Ci, CgR, CgI, omega, sigma } = field;
    const sigmaW = field.sigmaW ?? sigma;
    // Conductivity of a metal triangle: the solve's sigma scaled per conductor (sRel).
    const sigT = (t) => sigma * (field.sRel && field.triRect ? field.sRel[field.triRect[t]] : 1);
    const dom = field.domain;

    // A1 at every P2 DOF (vertices then edges), Dirichlet DOFs are 0.
    const nP2 = dofOf.length;
    const aR = new Float64Array(nP2), aI = new Float64Array(nP2);
    for (let i = 0; i < nP2; i++) {
        const g = dofOf[i];
        if (g >= 0) { aR[i] = sol[g]; aI[i] = sol[nF + g]; }
    }

    // Gradient recovery: area-weighted average of the element P2 gradients at each
    // vertex. H is continuous across the conductor surfaces (μr = 1, finite σ), so no
    // region splitting is needed; the averaged nodal gradient interpolated linearly is
    // smooth where the raw per-element gradient would show element facets.
    const gxR = new Float64Array(nNodes), gxI = new Float64Array(nNodes);
    const gyR = new Float64Array(nNodes), gyI = new Float64Array(nNodes);
    const wN = new Float64Array(nNodes);
    const { locate, coeffOf } = makeLocator(mesh);
    const lg = new Int32Array(6);
    for (let t = 0; t < nTris; t++) {
        const v = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
        const ax = nodes[2 * v[0]], ay = nodes[2 * v[0] + 1];
        const area = Math.abs((nodes[2 * v[1]] - ax) * (nodes[2 * v[2] + 1] - ay)
                            - (nodes[2 * v[2]] - ax) * (nodes[2 * v[1] + 1] - ay)) / 2;
        if (!(area > 0)) continue;
        const coeff = coeffOf(t);
        lg[0] = v[0]; lg[1] = v[1]; lg[2] = v[2];
        for (let k = 0; k < 3; k++) lg[3 + k] = nNodes + triEdges[3 * t + k];
        for (let m = 0; m < 3; m++) {
            const px = nodes[2 * v[m]], py = nodes[2 * v[m] + 1];
            let xr = 0, xi = 0, yr = 0, yi = 0;
            for (let k = 0; k < 6; k++) {
                const g = k < 3 ? lvGrad(coeff, k, px, py) : leGrad(coeff, EV[k - 3][0], EV[k - 3][1], px, py);
                const r = aR[lg[k]], im = aI[lg[k]];
                xr += g[0] * r; xi += g[0] * im; yr += g[1] * r; yi += g[1] * im;
            }
            const n = v[m];
            gxR[n] += area * xr; gxI[n] += area * xi;
            gyR[n] += area * yr; gyI[n] += area * yi;
            wN[n] += area;
        }
    }
    for (let n = 0; n < nNodes; n++) {
        if (wN[n] > 0) { gxR[n] /= wN[n]; gxI[n] /= wN[n]; gyR[n] /= wN[n]; gyI[n] /= wN[n]; }
    }

    const span = Math.hypot(dom.xmax - dom.xmin, dom.ymax - dom.ymin) || 1;
    const eps = 1e-9 * span;
    // Locate with a deterministic nudge (grid lines sit exactly on mesh lines).
    const find = (qx, qy) => {
        let t = locate(qx + eps, qy + eps);
        if (t < 0) t = locate(qx, qy);
        if (t < 0) t = locate(qx - eps, qy - eps);
        return t;
    };
    // Everything at a point of the meshed (half) domain, in mesh coordinates:
    // A1 (complex) and its recovered gradient.
    const evalAt = (t, qx, qy) => {
        const c = coeffOf(t);
        const v0 = tris[3 * t], v1 = tris[3 * t + 1], v2 = tris[3 * t + 2];
        const l0 = c[0][0] + c[0][1] * qx + c[0][2] * qy;
        const l1 = c[1][0] + c[1][1] * qx + c[1][2] * qy;
        const l2 = c[2][0] + c[2][1] * qx + c[2][2] * qy;
        const gxr = l0 * gxR[v0] + l1 * gxR[v1] + l2 * gxR[v2];
        const gxi = l0 * gxI[v0] + l1 * gxI[v1] + l2 * gxI[v2];
        const gyr = l0 * gyR[v0] + l1 * gyR[v1] + l2 * gyR[v2];
        const gyi = l0 * gyI[v0] + l1 * gyI[v1] + l2 * gyI[v2];
        let ar = 0, ai = 0;
        const vs = [v0, v1, v2];
        for (let k = 0; k < 3; k++) {
            const N = lv(c, k, qx, qy);
            ar += N * aR[vs[k]]; ai += N * aI[vs[k]];
        }
        for (let k = 0; k < 3; k++) {
            const e = nNodes + triEdges[3 * t + k];
            const N = le(c, EV[k][0], EV[k][1], qx, qy);
            ar += N * aR[e]; ai += N * aI[e];
        }
        return { ar, ai, gxr, gxi, gyr, gyi };
    };
    // Physical H in mesh coordinates: H = C·(∂A1/∂y, −∂A1/∂x)/μ0.
    const hFrom = (p) => {
        const [hxr, hxi] = cmul(Cr, Ci, p.gyr / MU0, p.gyi / MU0);
        const [hyr, hyi] = cmul(Cr, Ci, -p.gxr / MU0, -p.gxi / MU0);
        return { hxr, hxi, hyr, hyi };
    };

    // Metal walls: thickness and skin depth of the wall metal.
    const wp = field.wallPEC || {}, wt = field.wallThick || {};
    const deltaW = field.deltaW;
    // Wall the (mesh-coordinate) point lies behind, with its depth, or null.
    const wallAt = (qx, qy) => {
        const inX = qx >= dom.xmin - eps && qx <= dom.xmax + eps;
        const inY = qy >= dom.ymin - eps && qy <= dom.ymax + eps;
        if (wp.bottom && inX && qy < dom.ymin) return { w: 'bottom', s: dom.ymin - qy };
        if (wp.top && inX && qy > dom.ymax) return { w: 'top', s: qy - dom.ymax };
        if (wp.right && inY && qx > dom.xmax) return { w: 'right', s: qx - dom.xmax };
        if (wp.left && field.sym === 1 && inY && qx < dom.xmin) return { w: 'left', s: dom.xmin - qx };
        return null;
    };
    // H just outside the wall at the foot point of (qx, qy).
    const wallSurfaceH = (w, qx, qy) => {
        let fx = qx, fy = qy;
        const inset = 1e-6 * span;
        if (w === 'bottom') fy = dom.ymin + inset;
        else if (w === 'top') fy = dom.ymax - inset;
        else if (w === 'right') fx = dom.xmax - inset;
        else fx = dom.xmin + inset;
        fx = Math.min(Math.max(fx, dom.xmin + inset), dom.xmax - inset);
        fy = Math.min(Math.max(fy, dom.ymin + inset), dom.ymax - inset);
        const t = find(fx, fy);
        if (t < 0) return null;
        return hFrom(evalAt(t, fx, fy));
    };

    // Surface current K_z = (n × H)_z of a wall, n the outward normal of the metal
    // (pointing into the field region).
    const surfaceCurrent = (w, hxr, hxi, hyr, hyi) => {
        if (w === 'bottom') return [-hxr, -hxi];
        if (w === 'top') return [hxr, hxi];
        if (w === 'right') return [-hyr, -hyi];
        return [hyr, hyi];
    };

    const { x, y } = grid;
    const nx = x.length, ny = y.length;
    const mk = () => Array.from({ length: ny }, () => new Float64Array(nx));
    const Hxr = mk(), Hxi = mk(), Hyr = mk(), Hyi = mk();
    const Jr = mk(), Ji = mk();
    const H = mk(), J = mk();
    // Conductor loss density ½·|J|²/σ (W/m³ for the 1 A drive), σ of the meshed metal or
    // of the wall metal.
    const Q = mk();
    // Physical vector potential A = C·A1 (Wb/m). Its contour lines are the H field
    // lines (H = curl(A ẑ)/μ0 is tangential to them); evenly spaced levels give a line
    // density proportional to |H|. Defined on the meshed domain only.
    const Ar = mk(), Ai = mk();

    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            let qx = x[i];
            const qy = y[j];
            // Half-domain mirroring. A_full(−x) = s·A(x): Hx = s·∂A/∂y keeps the sign,
            // Hy = −∂A_full/∂x flips once more (chain rule), Jz follows A.
            let s = 1, m = 1;
            if (parity && qx < 0) { qx = -qx; m = -1; if (parity === 'odd') s = -1; }
            let hxr = NaN, hxi = NaN, hyr = NaN, hyi = NaN, jr = NaN, ji = NaN;
            let apr = NaN, api = NaN, sig = sigma;
            const t = find(qx, qy);
            // A grid line lying exactly on a metal face belongs to the metal for J:
            // the default nudge picks one side, so look at the other sides too. A is
            // continuous, so evaluating it in the metal triangle is exact there.
            let tJ = t;
            if (t >= 0 && !isMetal(isCondTri[t])) {
                for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
                    const tt = locate(qx + dx * eps, qy + dy * eps);
                    if (tt >= 0 && isMetal(isCondTri[tt])) { tJ = tt; break; }
                }
            }
            if (t >= 0) {
                const p = evalAt(t, qx, qy);
                ({ hxr, hxi, hyr, hyi } = hFrom(p));
                [apr, api] = cmul(Cr, Ci, p.ar, p.ai);
                const cls = isCondTri[tJ];
                if (isMetal(cls)) {
                    const pj = tJ === t ? p : evalAt(tJ, qx, qy);
                    let ur = 0, ui = 0;
                    if (cls === 1) {
                        if (CgR) { const g = triGroup[tJ]; ur = CgR[g]; ui = CgI[g]; } else ur = 1;
                    }
                    // u − jω·A1
                    const er = ur + omega * pj.ai, ei = ui - omega * pj.ar;
                    sig = sigT(tJ);
                    [jr, ji] = cmul(Cr, Ci, sig * er, sig * ei);
                } else {
                    // On the surface of a metal wall: the slab current at depth 0.
                    const onWall = (wp.bottom && Math.abs(qy - dom.ymin) <= eps) ? 'bottom'
                        : (wp.top && Math.abs(qy - dom.ymax) <= eps) ? 'top'
                        : (wp.right && Math.abs(qx - dom.xmax) <= eps) ? 'right'
                        : (wp.left && field.sym === 1 && Math.abs(qx - dom.xmin) <= eps) ? 'left' : null;
                    if (onWall) {
                        sig = sigmaW;
                        const prof = slabProfile((wt[onWall] ?? Infinity) / deltaW, 0, deltaW);
                        const k = surfaceCurrent(onWall, hxr, hxi, hyr, hyi);
                        [jr, ji] = cmul(k[0], k[1], prof.jr, prof.ji);
                    }
                }
            } else {
                const wl = wallAt(qx, qy);
                const d = wl ? (wt[wl.w] ?? Infinity) : 0;
                if (wl && wl.s <= d) {
                    const hs = wallSurfaceH(wl.w, qx, qy);
                    if (hs) {
                        sig = sigmaW;
                        const prof = slabProfile(d / deltaW, wl.s / deltaW, deltaW);
                        const [kr, ki] = surfaceCurrent(wl.w, hs.hxr, hs.hxi, hs.hyr, hs.hyi);
                        [jr, ji] = cmul(kr, ki, prof.jr, prof.ji);
                        // Tangential H decays into the wall, the normal component is 0.
                        if (wl.w === 'bottom' || wl.w === 'top') {
                            [hxr, hxi] = cmul(hs.hxr, hs.hxi, prof.hr, prof.hi);
                            hyr = 0; hyi = 0;
                        } else {
                            [hyr, hyi] = cmul(hs.hyr, hs.hyi, prof.hr, prof.hi);
                            hxr = 0; hxi = 0;
                        }
                    }
                }
            }
            if (Number.isFinite(hxr)) {
                Hxr[j][i] = s * hxr; Hxi[j][i] = s * hxi;
                Hyr[j][i] = s * m * hyr; Hyi[j][i] = s * m * hyi;
                H[j][i] = Math.sqrt(hxr * hxr + hxi * hxi + hyr * hyr + hyi * hyi);
            } else {
                Hxr[j][i] = Hxi[j][i] = Hyr[j][i] = Hyi[j][i] = NaN;
                H[j][i] = NaN;
            }
            Ar[j][i] = s * apr; Ai[j][i] = s * api;
            if (Number.isFinite(jr)) {
                Jr[j][i] = s * jr; Ji[j][i] = s * ji;
                J[j][i] = Math.hypot(jr, ji);
                Q[j][i] = 0.5 * (jr * jr + ji * ji) / sig;
            } else {
                Jr[j][i] = Ji[j][i] = J[j][i] = Q[j][i] = NaN;
            }
        }
    }
    return { x, y, H, Hxr, Hxi, Hyr, Hyi, J, Jr, Ji, Q, Ar, Ai };
}

// Split of the conductor loss of a solve (per unit length, mesh coordinates, the full
// line on a half-domain solve): signal metal, passive ground rects and the metal walls.
// Volume: ½·|J|²/σ by quadrature over the metal triangles. Walls (boundary conditions
// A = 0 of the solve): ½·Re(Zs)·|K|² along the wall, K = |∂A/∂n|·|C|/μ0, Zs of the
// slab with field-free back. Shares only (smooth metal, no roughness or plating).
export function mqsLossShares(mesh, field) {
    const { nodes, tris, triEdges, nNodes, nTris } = mesh;
    const { sol, nF, dofOf, isCondTri, triGroup, Cr, Ci, CgR, CgI, omega, sigma } = field;
    const sigT = (t) => sigma * (field.sRel && field.triRect ? field.sRel[field.triRect[t]] : 1);
    // Degree-4 Gauss rule (6 points) on the reference triangle: |J|² of a P2 field.
    const a1 = 0.445948490915965, b1 = 0.091576213509771, w1 = 0.223381589678011, w2 = 0.109951743655322;
    const QP = [[1 - 2 * a1, a1, a1, w1], [a1, 1 - 2 * a1, a1, w1], [a1, a1, 1 - 2 * a1, w1],
                [1 - 2 * b1, b1, b1, w2], [b1, 1 - 2 * b1, b1, w2], [b1, b1, 1 - 2 * b1, w2]];
    const { coeffOf } = makeLocator(mesh);
    const lg = new Int32Array(6);
    let pSig = 0, pGr = 0, pWall = 0;
    for (let t = 0; t < nTris; t++) {
        const cls = isCondTri[t];
        if (!isMetal(cls)) continue;
        const v = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
        const xs = v.map(n => nodes[2 * n]), ys = v.map(n => nodes[2 * n + 1]);
        const area = Math.abs((xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])) / 2;
        const c = coeffOf(t), sg = sigT(t);
        lg[0] = v[0]; lg[1] = v[1]; lg[2] = v[2];
        for (let k = 0; k < 3; k++) lg[3 + k] = nNodes + triEdges[3 * t + k];
        let ur = 0, ui = 0;
        if (cls === 1) { if (CgR) { const g = triGroup[t]; ur = CgR[g]; ui = CgI[g]; } else ur = 1; }
        let p = 0;
        for (const [b0, b1, b2, w] of QP) {
            const qx = b0 * xs[0] + b1 * xs[1] + b2 * xs[2], qy = b0 * ys[0] + b1 * ys[1] + b2 * ys[2];
            let ar = 0, ai = 0;
            for (let k = 0; k < 6; k++) {
                const g = dofOf[lg[k]];
                if (g < 0) continue;
                const N = k < 3 ? lv(c, k, qx, qy) : le(c, EV[k - 3][0], EV[k - 3][1], qx, qy);
                ar += N * sol[g]; ai += N * sol[nF + g];
            }
            const [er, ei] = cmul(Cr, Ci, ur + omega * ai, ui - omega * ar);
            p += 0.5 * sg * (er * er + ei * ei) * w * area;
        }
        if (cls === 1) pSig += p; else pGr += p;
    }
    // Walls: boundary edges on a metal wall, next to a non-metal triangle.
    const dom = field.domain, wp = field.wallPEC || {}, wt = field.wallThick || {};
    const span = Math.hypot(dom.xmax - dom.xmin, dom.ymax - dom.ymin) || 1, tol = 1e-9 * span;
    const RsW = 1 / (field.sigmaW * field.deltaW);
    const reZ = (w) => {
        const d = wt[w] ?? Infinity, x = d / field.deltaW;
        if (!(x < 20)) return RsW;
        const den = Math.cosh(2 * x) - Math.cos(2 * x);
        return RsW * (Math.sinh(2 * x) + Math.sin(2 * x)) / den;
    };
    const owner = new Map();
    for (let t = 0; t < nTris; t++) for (let k = 0; k < 3; k++) {
        const e = triEdges[3 * t + k];
        owner.set(e, owner.has(e) ? -1 : t * 3 + k);
    }
    const C2 = Cr * Cr + Ci * Ci;
    const GL = [[0.5 - 0.387298334620742, 5 / 18], [0.5, 8 / 18], [0.5 + 0.387298334620742, 5 / 18]];
    for (const [, o] of owner) {
        if (o < 0) continue;
        const t = Math.floor(o / 3), k = o % 3;
        if (isMetal(isCondTri[t])) continue;
        const n0 = tris[3 * t + EV[k][0]], n1 = tris[3 * t + EV[k][1]];
        const x0 = nodes[2 * n0], y0 = nodes[2 * n0 + 1], x1 = nodes[2 * n1], y1 = nodes[2 * n1 + 1];
        const on = (a, b, v) => Math.abs(a - v) <= tol && Math.abs(b - v) <= tol;
        const wall = (wp.bottom && on(y0, y1, dom.ymin)) ? 'bottom' : (wp.top && on(y0, y1, dom.ymax)) ? 'top'
            : (wp.right && on(x0, x1, dom.xmax)) ? 'right' : (wp.left && field.sym === 1 && on(x0, x1, dom.xmin)) ? 'left' : null;
        if (!wall) continue;
        const comp = (wall === 'bottom' || wall === 'top') ? 1 : 0;   // dA/dy or dA/dx
        const c = coeffOf(t);
        lg[0] = tris[3 * t]; lg[1] = tris[3 * t + 1]; lg[2] = tris[3 * t + 2];
        for (let q = 0; q < 3; q++) lg[3 + q] = nNodes + triEdges[3 * t + q];
        const L = Math.hypot(x1 - x0, y1 - y0);
        for (const [u, w] of GL) {
            const qx = x0 + u * (x1 - x0), qy = y0 + u * (y1 - y0);
            let gr = 0, gi = 0;
            for (let m = 0; m < 6; m++) {
                const g = dofOf[lg[m]];
                if (g < 0) continue;
                const gv = m < 3 ? lvGrad(c, m, qx, qy) : leGrad(c, EV[m - 3][0], EV[m - 3][1], qx, qy);
                gr += gv[comp] * sol[g]; gi += gv[comp] * sol[nF + g];
            }
            pWall += 0.5 * reZ(wall) * C2 * (gr * gr + gi * gi) / (MU0 * MU0) * w * L;
        }
    }
    const s = field.sym > 1 ? 2 : 1;
    return { signal: s * pSig, groundRects: s * pGr, walls: s * pWall };
}
