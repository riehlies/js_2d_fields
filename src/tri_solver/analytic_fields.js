// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Closed-form magnetic field and current density for the two media the MQS
// eddy-current field export does not cover: the concentric coax and the
// rectangular waveguide. Both are exact shapes with a homogeneous fill, so the
// fields are known analytically and consistent with how the solver models them.
//
// Coax (1 A line current, e^(jωt)):
//   inner conductor (r < a):  Hφ = I·J1(kr) / (2πa·J1(ka)),  Jz = I·k·J0(kr) / (2πa·J1(ka))
//                             k = (1 − j)/δ  (k² = −jωμ0σ)
//   dielectric (a < r < b):   Hφ = I / (2πr)
//   shield (r > b):           Hφ = Hb·√(b/r)·e^(−γ(r−b)),  Jz = (1/r)·∂(r·Hφ)/∂r,  γ = (1 + j)/δ
// The shield is modelled as infinitely thick, as in the solver. Its profile is the
// large-argument form of the exact K1(γr)/K1(γb) solution, accurate for δ ≪ b; the
// net shield current is exactly −I either way.
//
// Rectangular waveguide (fundamental TE10, or TE01 when the guide is taller than wide,
// normalized to 1 W transmitted power), e.g. TE10 with x' = x − x_min:
//   Hx = (βa/π)·|A|·sin(πx'/a),  Hz = −j·|A|·cos(πx'/a),  P = ωμ0·a³·b·β·|A|² / (4π²)
// (phase reference chosen so the transverse fields are real at ωt = 0). The wall current
// is K = n × H, distributed through the wall with the 1D slab profile of the loss model.

const MU0 = 4 * Math.PI * 1e-7;
const C0 = 299792458;

// ---- complex helpers on {re, im} ----
const cx = (re, im = 0) => ({ re, im });
const cadd = (a, b) => cx(a.re + b.re, a.im + b.im);
const csub = (a, b) => cx(a.re - b.re, a.im - b.im);
const cmul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const cscale = (a, s) => cx(a.re * s, a.im * s);
const cdiv = (a, b) => {
    const d = b.re * b.re + b.im * b.im;
    return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const cabs = (a) => Math.hypot(a.re, a.im);
const csqrt = (a) => {
    const r = cabs(a);
    const re = Math.sqrt((r + a.re) / 2);
    const im = Math.sign(a.im || 1) * Math.sqrt(Math.max(0, (r - a.re) / 2));
    return cx(re, im);
};
const cexp = (a) => { const e = Math.exp(a.re); return cx(e * Math.cos(a.im), e * Math.sin(a.im)); };

// Bessel J0 / J1 of a complex argument, SCALED: returns { v, s } with
// J_n(z) = v · e^(s), s = |Im z|. Power series for |z| ≤ 20, Hankel asymptotic
// expansion beyond (relative error < 1e-10 there). The scaling keeps the skin-effect
// regime (|z| up to ~1e4 at GHz) free of overflow.
export function besselJScaled(n, z) {
    const s = Math.abs(z.im);
    const az = cabs(z);
    if (az <= 20) {
        // Σ (−1)^m (z/2)^(2m+n) / (m! (m+n)!)
        const h = cscale(z, 0.5), h2 = cmul(h, h);
        let term = n === 0 ? cx(1) : h;   // m = 0
        let sum = term;
        for (let m = 1; m < 200; m++) {
            term = cscale(cmul(term, h2), -1 / (m * (m + n)));
            sum = cadd(sum, term);
            if (cabs(term) < 1e-17 * cabs(sum)) break;
        }
        return { v: cscale(sum, Math.exp(-s)), s };
    }
    // J_n(z) = √(2/(πz)) · (P cos χ − Q sin χ),  χ = z − (n/2 + 1/4)π,  μ = 4n²
    const mu = 4 * n * n;
    const w = cdiv(cx(1), cscale(z, 8));   // 1/(8z)
    let P = cx(1), Q = cx(0);
    let t = cx(1);                         // running product (μ−1)(μ−9)… / (k! (8z)^k)
    for (let k = 1; k <= 16; k++) {
        t = cscale(cmul(t, w), (mu - (2 * k - 1) * (2 * k - 1)) / k);
        if (k % 2 === 1) Q = (k % 4 === 1) ? cadd(Q, t) : csub(Q, t);
        else P = (k % 4 === 2) ? csub(P, t) : cadd(P, t);
        if (cabs(t) < 1e-16) break;
    }
    const chi = csub(z, cx((n / 2 + 0.25) * Math.PI));
    // cos/sin of χ = u + iv scaled by e^(−|v|)
    const u = chi.re, v = chi.im, e2 = Math.exp(-2 * Math.abs(v)), sg = Math.sign(v) || 1;
    const chS = (1 + e2) / 2, shS = sg * (1 - e2) / 2;
    const cosS = cx(Math.cos(u) * chS, -Math.sin(u) * shS);
    const sinS = cx(Math.sin(u) * chS, Math.cos(u) * shS);
    const pre = csqrt(cdiv(cx(2 / Math.PI), z));
    const v0 = cmul(pre, csub(cmul(P, cosS), cmul(Q, sinS)));
    return { v: v0, s: Math.abs(v) };   // |Im χ| = |Im z|
}

// J_n(z1) / J_m(z2) without overflow.
function besselRatio(n, z1, m, z2) {
    const a = besselJScaled(n, z1), b = besselJScaled(m, z2);
    return cscale(cdiv(a.v, b.v), Math.exp(a.s - b.s));
}

// Radii sampling a layer [r0, r1] densely next to the face at `face` (= r0 or r1),
// so a skin layer of depth δ is resolved, plus a uniform background.
function layerRadii(r0, r1, face, delta, nUniform) {
    const out = new Set();
    for (let i = 0; i <= nUniform; i++) out.add(r0 + (r1 - r0) * i / nUniform);
    const sgn = face === r1 ? -1 : 1;
    for (let d = 0.02 * delta; d < 12 * delta && d < (r1 - r0); d *= 1.15) out.add(face + sgn * d);
    return Float64Array.from([...out].filter(r => r >= r0 && r <= r1).sort((p, q) => p - q));
}

// ---- Coax ----
// Returns radial profiles (layer edges r and per-ring values at the ring mid radius).
export function coaxFieldAt(s, f) {
    const sigma = s.sigma_cond ?? 5.8e7;
    const a = s.a, b = s.b, tS = s.shield_thickness ?? 0.1 * b;
    const omega = 2 * Math.PI * f;
    const delta = Math.sqrt(2 / (omega * MU0 * sigma));
    const I = 1;
    const k = cx(1 / delta, -1 / delta);          // (1 − j)/δ
    const gam = cx(1 / delta, 1 / delta);         // (1 + j)/δ

    // Inner conductor
    const rIn = layerRadii(0, a, a, delta, 80);
    const ka = cscale(k, a);
    const pre = I / (2 * Math.PI * a);
    const inner = [];
    for (let i = 0; i + 1 < rIn.length; i++) {
        const r = 0.5 * (rIn[i] + rIn[i + 1]);
        const kr = cscale(k, r);
        const H = cscale(besselRatio(1, kr, 1, ka), pre);
        const J = cscale(cmul(k, besselRatio(0, kr, 1, ka)), pre);
        inner.push({ r0: rIn[i], r1: rIn[i + 1], H, J });
    }
    // Dielectric: Hφ = I/(2πr), A = (μ0 I / 2π) ln(b/r) (A = 0 on the shield)
    const rD = [];
    const nD = 60;
    for (let i = 0; i <= nD; i++) rD.push(a * Math.pow(b / a, i / nD));
    const diel = [];
    for (let i = 0; i < nD; i++) {
        const r = Math.sqrt(rD[i] * rD[i + 1]);
        diel.push({ r0: rD[i], r1: rD[i + 1], H: cx(I / (2 * Math.PI * r)), J: null });
    }
    // Shield
    const Hb = I / (2 * Math.PI * b);
    const rS = layerRadii(b, b + tS, b, delta, 40);
    const shield = [];
    for (let i = 0; i + 1 < rS.length; i++) {
        const r = 0.5 * (rS[i] + rS[i + 1]);
        const e = cexp(cscale(gam, -(r - b)));
        const H = cscale(e, Hb * Math.sqrt(b / r));
        const J = cmul(H, csub(cx(1 / (2 * r)), gam));
        shield.push({ r0: rS[i], r1: rS[i + 1], H, J });
    }
    return {
        ok: true, kind: 'radial', f, mode: 'single', delta, deltaWall: delta,
        cx: 0, cy: 0, a, b, tShield: tS, differential: false, per: '1 A',
        rings: [...inner, ...diel, ...shield].map(g => ({
            r0: g.r0, r1: g.r1, Hr: g.H.re, Hi: g.H.im,
            Jr: g.J ? g.J.re : null, Ji: g.J ? g.J.im : null,
        })),
    };
}

// ---- Rectangular waveguide ----
// Slab profile of a metal wall (thickness d, field-free back): complex factors for the
// current density per unit surface current and for the tangential H.
function slab(dOverDelta, sOverDelta, delta) {
    const gam = cx(1 / delta, 1 / delta);
    if (!(dOverDelta < 20)) {
        const e = cexp(cx(-sOverDelta, -sOverDelta));
        return { j: cmul(e, gam), h: e };
    }
    const x = dOverDelta, v = Math.max(0, x - sOverDelta);
    const sh = (u) => cx(Math.sinh(u) * Math.cos(u), Math.cosh(u) * Math.sin(u));
    const ch = (u) => cx(Math.cosh(u) * Math.cos(u), Math.sinh(u) * Math.sin(u));
    return { j: cmul(cdiv(ch(v), sh(x)), gam), h: cdiv(sh(v), sh(x)) };
}

export function waveguideFieldAt(s, f, opts = {}) {
    const W = s.a, Hh = s.b;                     // width (x), height (y)
    const er = s.epsilon_r ?? 1;
    const sigma = s.sigma_cond ?? 5.8e7;
    const omega = 2 * Math.PI * f;
    const k = omega * Math.sqrt(er) / C0;
    const along = W >= Hh ? 'x' : 'y';           // TE10 (variation along x) or TE01
    const L = Math.max(W, Hh), S = Math.min(W, Hh);
    const kc = Math.PI / L;
    if (!(k > kc)) {
        const fc = C0 * kc / (2 * Math.PI * Math.sqrt(er));
        return { ok: false, reason: `Below the cutoff frequency (${(fc / 1e9).toFixed(3)} GHz) the ` +
            'fundamental mode carries no power, so a field normalized to 1 W does not exist. ' +
            'Choose an H / J frequency above cutoff.' };
    }
    const beta = Math.sqrt(k * k - kc * kc);
    const Aamp = Math.sqrt(4 * Math.PI * Math.PI / (omega * MU0 * L * L * L * S * beta));
    const delta = Math.sqrt(2 / (omega * MU0 * sigma));
    const dWall = s.wall_thickness ?? 1e-3;      // physical wall (loss model)
    const ew = s.enclosure_walls;
    const x0 = ew.x_min, x1 = ew.x_max, y0 = ew.y_min, y1 = ew.y_max, tW = ew.thickness;

    // Interior field at (x, y): { hx, hy, hz } complex.
    const interior = (x, y) => {
        const u = along === 'x' ? (x - x0) / W : (y - y0) / Hh;
        const sn = Math.sin(Math.PI * u), cs = Math.cos(Math.PI * u);
        const ht = cx(beta * L / Math.PI * Aamp * sn);
        const hz = cx(0, -Aamp * cs);
        return along === 'x' ? { hx: ht, hy: cx(0), hz } : { hx: cx(0), hy: ht, hz };
    };

    // Grid: uniform interior plus skin-depth lines inside each wall.
    const res = opts.resolution || 200;
    const axis = (lo, hi, n) => {
        const set = new Set();
        for (let i = 0; i <= n; i++) set.add(lo + (hi - lo) * i / n);
        const depths = [0, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 9].map(d => d * delta);
        for (const d of depths) {
            if (d <= tW) { set.add(lo - d); set.add(hi + d); }
        }
        for (let i = 1; i <= 8; i++) { set.add(lo - tW * i / 8); set.add(hi + tW * i / 8); }
        // companion lines just inside the wall faces (heatmap cell edges)
        set.add(lo + (hi - lo) * 1e-4); set.add(hi - (hi - lo) * 1e-4);
        return Float64Array.from([...set].sort((p, q) => p - q));
    };
    const aspect = W / Hh;
    const xs = axis(x0, x1, aspect >= 1 ? res : Math.max(40, Math.round(res * aspect)));
    const ys = axis(y0, y1, aspect >= 1 ? Math.max(40, Math.round(res / aspect)) : res);
    const nx = xs.length, ny = ys.length;
    const mk = () => Array.from({ length: ny }, () => new Float32Array(nx).fill(NaN));
    const Hxr = mk(), Hxi = mk(), Hyr = mk(), Hyi = mk(), Hzr = mk(), Hzi = mk(), H = mk();
    const Jr = mk(), Ji = mk(), Jtr = mk(), Jti = mk(), J = mk();
    const tol = 1e-12 * L;
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const x = xs[i], y = ys[j];
            const inX = x >= x0 - tol && x <= x1 + tol, inY = y >= y0 - tol && y <= y1 + tol;
            let hx, hy, hz;
            if (inX && inY) {
                ({ hx, hy, hz } = interior(x, y));
            } else if (inX || inY) {
                // Inside one wall (corners are left empty).
                let wall, depth, fx = x, fy = y;
                if (!inY) { wall = y < y0 ? 'bottom' : 'top'; depth = y < y0 ? y0 - y : y - y1; fy = y < y0 ? y0 : y1; }
                else { wall = x < x0 ? 'left' : 'right'; depth = x < x0 ? x0 - x : x - x1; fx = x < x0 ? x0 : x1; }
                if (depth > tW) continue;
                const h0 = interior(fx, fy);
                const p = slab(dWall / delta, depth / delta, delta);
                // Tangential components decay into the wall, the normal one vanishes.
                // K = n × H(0), n the normal pointing into the guide.
                let kt, kz;
                if (wall === 'bottom') { kt = h0.hz; kz = cscale(h0.hx, -1); }
                else if (wall === 'top') { kt = cscale(h0.hz, -1); kz = h0.hx; }
                else if (wall === 'left') { kt = cscale(h0.hz, -1); kz = h0.hy; }
                else { kt = h0.hz; kz = cscale(h0.hy, -1); }
                const jt = cmul(kt, p.j), jz = cmul(kz, p.j);
                Jtr[j][i] = jt.re; Jti[j][i] = jt.im; Jr[j][i] = jz.re; Ji[j][i] = jz.im;
                J[j][i] = Math.hypot(cabs(jt), cabs(jz));
                const horiz = wall === 'bottom' || wall === 'top';
                hx = horiz ? cmul(h0.hx, p.h) : cx(0);
                hy = horiz ? cx(0) : cmul(h0.hy, p.h);
                hz = cmul(h0.hz, p.h);
            } else continue;
            Hxr[j][i] = hx.re; Hxi[j][i] = hx.im; Hyr[j][i] = hy.re; Hyi[j][i] = hy.im;
            Hzr[j][i] = hz.re; Hzi[j][i] = hz.im;
            H[j][i] = Math.sqrt(cabs(hx) ** 2 + cabs(hy) ** 2 + cabs(hz) ** 2);
        }
    }
    return {
        ok: true, kind: 'wg', f, mode: along === 'x' ? 'TE10' : 'TE01', per: '1 W',
        x: Float64Array.from(xs), y: Float64Array.from(ys),
        H, Hxr, Hxi, Hyr, Hyi, Hzr, Hzi, J, Jr, Ji, Jtr, Jti,
        delta, deltaWall: delta, beta, differential: false,
    };
}
