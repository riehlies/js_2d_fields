// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK.md for the list of changes.
//
// After an update of the original: are the fork's hooks still in place, and does the
// original still export what src/fork imports? Run: node tests/fork/check_hooks.mjs
// (then node tests/fork/run.mjs for the behaviour, and a look at the page).
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) bad++; };

// 1. The hooks in the original's files (each line marked "FORK").
const HOOKS = [
    ['src/plot.js', 'window.forkPlot.draw(resetZoom, get)', 'draw() hands field views to the fork'],
    ['src/app_solver.js', 'window.forkWorkerJob', 'worker access for the fork'],
    ['src/solve_worker.js', "import { forkJobs } from './fork/worker_jobs.js'", 'worker job import'],
    ['src/solve_worker.js', '...forkJobs(() => simSolver)', 'worker job registration'],
    ['src/field_solver.html', 'src="fork/plot_fields.js"', 'fork module loaded by the page'],
    ['src/field_solver.html', '<option value="fullwave_mqs" selected>', 'Full-wave solver as the default'],
    // Separate upper trace width of the broadside coupled stripline (a change of the
    // original's solver, not a hook: candidate for a pull request upstream).
    ['src/app_solver.js', "['bs_w_top', 'inp_bs_w_top', 'unit', 'sphl']", 'broadside: setting bs_w_top'],
    ['src/field_solver.html', 'id="inp_bs_w_top"', 'broadside: Trace Width (top) input'],
    ['src/solver_factory.js', 'trace_width_top:', 'broadside: trace_width_top passed to the solver'],
    ['src/broadside_stripline.js', 'this.w_top = options.trace_width_top', 'broadside: upper trace width in the solver'],
    ['src/tri_solver/tri_backend.js', 's.w_top ?? Infinity', 'broadside: mesh reference of unequal widths'],
];
for (const [file, needle, what] of HOOKS) check(read(file).includes(needle), `${file}: ${what}`);
// Number of FORK-marked lines per file: a different count after a merge means a fork
// line was lost or doubled.
const MARKED = {
    'src/plot.js': 1, 'src/app_solver.js': 3, 'src/solve_worker.js': 2, 'src/field_solver.html': 8,
    'src/broadside_stripline.js': 6, 'src/solver_factory.js': 1, 'src/tri_solver/tri_backend.js': 1,
};
for (const [file, n] of Object.entries(MARKED)) {
    const got = read(file).split('\n').filter(l => l.includes('FORK')).length;
    check(got === n, `${file}: ${got} FORK-marked lines (expected ${n})`);
}

// 2. Named imports of src/fork from the original's modules still exported.
const forkDir = new URL('src/fork/', root);
for (const f of readdirSync(forkDir).filter(n => n.endsWith('.js'))) {
    const src = readFileSync(new URL(f, forkDir), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\.\/[^']+)'/g)) {
        const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
        const target = new URL(m[2], new URL(f, forkDir));
        const text = readFileSync(target, 'utf8');
        for (const n of names) {
            const ok = new RegExp(`export\\s+(async\\s+)?(function|const|let|class)\\s+${n}\\b`).test(text)
                || new RegExp(`export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`).test(text);
            check(ok, `${f}: ${n} from ${m[2]}`);
        }
    }
}
console.log(bad ? `\n${bad} problem(s)` : '\nall hooks and imports in place');
process.exit(bad ? 1 : 0);
