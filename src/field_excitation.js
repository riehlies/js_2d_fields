// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Excitation of the field plots: one voltage, current or power for every view.
//
// The solver's fields come in unit drives: the static E and potential for 1 V on each
// signal conductor (±1 V odd, +1 V even), H and J for 1 A per signal conductor, the
// waveguide for 1 W. A line carries V = Zc·I, so a single excitation fixes both
// complex amplitudes:
//   cE = V / 1 V   multiplies E and the potential,
//   cH = I / 1 A   multiplies H and J,
// and P = n·½·Re(V·I*) is the transmitted power (n = 2 signal conductors for a
// differential pair, the time average). The waveguide has no unique V and I, only
// cE = cH = √(P / 1 W).
//
// A termination turns the matched (travelling) wave into a standing wave. With the
// incident wave as reference and d the distance from the load (d/λ in wavelengths):
//   V(d) = V⁺·(1 + Γ·e^(−j4πd/λ)),   I(d) = I⁺·(1 − Γ·e^(−j4πd/λ)),
// Γ = (Z_L − Zc)/(Z_L + Zc). Matched: V = V⁺, I = I⁺ everywhere, E and H in phase.
// Open end (Γ = 1) at d = λ/8: V = V⁺(1 − j), I = I⁺(1 + j), 90° apart.

export const c = (re, im = 0) => ({ re, im });
export const cmul = (a, b) => c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const cdiv = (a, b) => {
    const d = b.re * b.re + b.im * b.im;
    return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
export const cconj = (a) => c(a.re, -a.im);
export const cabs = (a) => Math.hypot(a.re, a.im);
export const carg = (a) => Math.atan2(a.im, a.re);
export const cscale = (a, s) => c(a.re * s, a.im * s);
// Re{a·e^(jωt)}: the instantaneous value of phasor a at phase ωt (rad).
export const inst = (a, wt) => a.re * Math.cos(wt) - a.im * Math.sin(wt);

/**
 * Complex amplitudes of the incident wave for one excitation setting.
 *
 * @param {object} o
 * @param {'V'|'Vd'|'I'|'P'} o.kind   voltage per conductor, voltage between the two
 *                                     conductors of a differential pair, current per
 *                                     conductor, total power
 * @param {number} o.value            in V, A or W
 * @param {boolean} o.rms             value is an RMS value (V and I only)
 * @param {{re,im}} o.Zc              line impedance per conductor for the mode
 * @param {number} o.nCond            signal conductors carrying the mode (1 or 2)
 * @param {'single'|'odd'|'even'} o.mode
 * @param {boolean} o.waveguide       only power is defined
 * @returns {{ok, V, I, P, cE, cH, kind, note}}  V, I per conductor (peak phasors)
 */
export function excitation({ kind, value, rms = false, Zc, nCond = 1, mode = 'single', waveguide = false }) {
    const val = Number.isFinite(value) ? value : 1;
    if (waveguide) {
        const P = kind === 'P' ? val : 1;
        const a = Math.sqrt(Math.max(P, 0));
        return { ok: true, waveguide: true, P, cE: c(a), cH: c(a), V: null, I: null, kind: 'P',
                 note: kind === 'P' ? '' : 'A waveguide has no unique voltage or current, power is used.' };
    }
    const peak = (kind === 'P' || !rms) ? val : val * Math.SQRT2;
    const Z = (Zc && Number.isFinite(Zc.re) && Number.isFinite(Zc.im) && cabs(Zc) > 0) ? Zc : null;
    let k = kind, note = '';
    if (k === 'Vd' && mode !== 'odd') {
        k = 'V';
        note = mode === 'even'
            ? 'In the even mode both conductors carry the same voltage, the setting applies per conductor.'
            : '';
    }
    let V, I;
    if (k === 'V' || k === 'Vd') {
        V = c(k === 'Vd' ? peak / 2 : peak);
        I = Z ? cdiv(V, Z) : null;
    } else if (k === 'I') {
        I = c(peak);
        V = Z ? cmul(Z, I) : null;
    } else {
        // P = n·½·Re(V·I*) = n·½·|V|²·Re(1/Zc*) with V real.
        if (!Z) return { ok: false, note: 'The line impedance is not available.' };
        const g = cdiv(c(1), cconj(Z)).re;
        if (!(g > 0)) return { ok: false, note: 'The line impedance has no real part.' };
        V = c(Math.sqrt(2 * Math.max(peak, 0) / (nCond * g)));
        I = cdiv(V, Z);
    }
    if (!V || !I) return { ok: false, note: 'The line impedance is not available.' };
    const P = nCond * 0.5 * cmul(V, cconj(I)).re;
    return { ok: true, waveguide: false, V, I, P, cE: V, cH: I, kind: k, note };
}

// Reflection coefficient of a termination.
export function reflection(load, Zc, ZL) {
    if (load === 'open') return c(1);
    if (load === 'short') return c(-1);
    if (load === 'custom' && ZL && Zc) {
        return cdiv(c(ZL.re - Zc.re, ZL.im - Zc.im), c(ZL.re + Zc.re, ZL.im + Zc.im));
    }
    return c(0);
}

// Voltage and current d/λ from the load for incident amplitudes V⁺, I⁺ (see header).
export function standingWave(Vp, Ip, gamma, dOverLambda) {
    const ph = -4 * Math.PI * dOverLambda;
    const ge = cmul(gamma, c(Math.cos(ph), Math.sin(ph)));
    return {
        V: cmul(Vp, c(1 + ge.re, ge.im)),
        I: cmul(Ip, c(1 - ge.re, -ge.im)),
    };
}

// "50", "50 + 20j", "25-10i", "j30" → {re, im} or null.
export function parseImpedance(s) {
    if (s === null || s === undefined) return null;
    let t = String(s).replace(/\s+/g, '').replace(/ohm|Ω/gi, '').replace(/i/g, 'j').toLowerCase();
    if (!t) return null;
    // Split into signed terms at + / − that do not belong to an exponent.
    const terms = [];
    let cur = '';
    for (let k = 0; k < t.length; k++) {
        const ch = t[k];
        if ((ch === '+' || ch === '-') && k > 0 && t[k - 1] !== 'e') { terms.push(cur); cur = ch; }
        else cur += ch;
    }
    terms.push(cur);
    let re = 0, im = 0;
    for (let term of terms) {
        if (!term) return null;
        if (term.includes('j')) {
            const sign = term[0] === '-' ? -1 : 1;
            const mag = term.replace(/^[+-]/, '').replace('j', '');
            const v = mag === '' ? 1 : Number(mag);
            if (!Number.isFinite(v)) return null;
            im += sign * v;
        } else {
            const v = Number(term);
            if (!Number.isFinite(v)) return null;
            re += v;
        }
    }
    return c(re, im);
}

// SI formatting for labels: 0.0199 → "19.9 m", with the unit appended.
export function formatSI(v, unit, digits = 3) {
    if (!Number.isFinite(v)) return '–';
    if (v === 0) return `0 ${unit}`;
    const a = Math.abs(v);
    const pre = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
    for (const [s, p] of pre) {
        if (a >= s * 0.9995) return `${+(v / s).toPrecision(digits)} ${p}${unit}`;
    }
    return `${v.toExponential(digits - 1)} ${unit}`;
}

// Complex value as "magnitude ∠ phase°" (phase only when it is not ~0).
export function formatPhasor(z, unit) {
    const m = formatSI(cabs(z), unit);
    const deg = carg(z) * 180 / Math.PI;
    return Math.abs(deg) < 0.05 ? m : `${m} ∠ ${deg.toFixed(1)}°`;
}
