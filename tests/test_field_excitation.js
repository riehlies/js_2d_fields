// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Excitation of the field plots (src/field_excitation.js): V / I / P conversion over the
// line impedance, differential conventions, standing waves and the impedance parser.
import { excitation, reflection, standingWave, parseImpedance, cabs, carg, inst, c, formatSI }
    from '../src/field_excitation.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    if (!ok) failures++;
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const Z50 = c(50, 0);
// 1 V on 50 Ω: 20 mA, 10 mW.
{
    const e = excitation({ kind: 'V', value: 1, Zc: Z50 });
    check('1 V on 50 Ω gives 20 mA', near(e.I.re, 0.02) && near(e.I.im, 0));
    check('1 V on 50 Ω gives 10 mW', near(e.P, 0.01));
}
// RMS: 1 V rms is 1.414 V peak, P = V_rms² / Z.
{
    const e = excitation({ kind: 'V', value: 1, rms: true, Zc: Z50 });
    check('1 V rms is √2 V peak', near(e.V.re, Math.SQRT2));
    check('1 V rms on 50 Ω gives 20 mW', near(e.P, 0.02));
}
// Current and power round trip.
{
    const e = excitation({ kind: 'I', value: 0.1, Zc: Z50 });
    check('0.1 A on 50 Ω gives 5 V', near(e.V.re, 5));
    const p = excitation({ kind: 'P', value: e.P, Zc: Z50 });
    check('power excitation reproduces the voltage', near(p.V.re, 5, 1e-9));
}
// Lossy line: I lags V by arg(Zc), P = ½Re(V I*).
{
    const Z = c(50, -5);
    const e = excitation({ kind: 'V', value: 1, Zc: Z });
    check('current phase is −arg(Zc)', near(carg(e.I), -carg(Z)));
    const p = excitation({ kind: 'P', value: 0.01, Zc: Z });
    check('power excitation on a lossy line', near(p.P, 0.01, 1e-9));
}
// Differential pair: odd mode, 2 V between the conductors is 1 V per conductor,
// the power counts both conductors.
{
    const Zodd = c(45, 0);
    const e = excitation({ kind: 'Vd', value: 2, Zc: Zodd, nCond: 2, mode: 'odd' });
    check('2 V differential is 1 V per conductor', near(e.V.re, 1));
    check('odd-mode power counts both conductors', near(e.P, 2 * 0.5 / 45));
    const ev = excitation({ kind: 'Vd', value: 1, Zc: Zodd, nCond: 2, mode: 'even' });
    check('even mode falls back to the voltage per conductor', ev.kind === 'V' && near(ev.V.re, 1) && ev.note.length > 0);
}
// Waveguide: power only.
{
    const e = excitation({ kind: 'V', value: 4, waveguide: true });
    check('waveguide ignores a voltage setting', e.kind === 'P' && near(e.P, 1) && e.note.length > 0);
    const p = excitation({ kind: 'P', value: 4, waveguide: true });
    check('waveguide amplitude is √P', near(p.cE.re, 2) && near(p.cH.re, 2));
}
// Standing waves.
{
    const V = c(1), I = c(0.02);
    const m = standingWave(V, I, reflection('matched', Z50), 0.3);
    check('matched line: V and I unchanged', near(m.V.re, 1) && near(m.I.re, 0.02) && near(m.V.im, 0));
    const o0 = standingWave(V, I, reflection('open', Z50), 0);
    check('open end: double voltage, no current', near(cabs(o0.V), 2) && near(cabs(o0.I), 0, 1e-12));
    const o4 = standingWave(V, I, reflection('open', Z50), 0.25);
    check('λ/4 from an open end: no voltage, double current', near(cabs(o4.V), 0, 1e-12) && near(cabs(o4.I), 0.04));
    const o8 = standingWave(V, I, reflection('open', Z50), 0.125);
    const dph = (carg(o8.I) - carg(o8.V)) * 180 / Math.PI;
    check('λ/8 from an open end: V and I 90° apart', near(Math.abs(dph), 90, 1e-9), `${dph.toFixed(3)}°`);
    // At that point E and H alternate: when one is at its peak the other is zero.
    const wt = -carg(o8.V);
    check('E at its peak while H is zero', near(Math.abs(inst(o8.V, wt)), cabs(o8.V)) && near(inst(o8.I, wt), 0, 1e-12));
    const s0 = standingWave(V, I, reflection('short', Z50), 0);
    check('short: no voltage, double current', near(cabs(s0.V), 0, 1e-12) && near(cabs(s0.I), 0.04));
    const g = reflection('custom', Z50, c(100, 0));
    check('Γ of 100 Ω on 50 Ω is 1/3', near(g.re, 1 / 3) && near(g.im, 0));
}
// Impedance parser.
{
    const cases = [['50', 50, 0], ['50+20j', 50, 20], ['25 - 10j', 25, -10], ['j30', 0, 30], ['-j30', 0, -30],
                   ['1e3', 1000, 0], ['75 Ω', 75, 0], ['10+j5', 10, 5]];
    for (const [s, re, im] of cases) {
        const z = parseImpedance(s);
        check(`parse "${s}"`, z && near(z.re, re) && near(z.im, im), z ? `${z.re}${z.im >= 0 ? '+' : ''}${z.im}j` : 'null');
    }
    check('parse rejects text', parseImpedance('abc') === null);
}
check('SI formatting', formatSI(0.0199, 'A') === '19.9 mA' && formatSI(1, 'V') === '1 V' && formatSI(2.5e-6, 'W') === '2.5 µW',
      `${formatSI(0.0199, 'A')}, ${formatSI(1, 'V')}, ${formatSI(2.5e-6, 'W')}`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
