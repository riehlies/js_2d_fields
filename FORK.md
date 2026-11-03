# Fork: field views on top of the original

This branch is the original [js_2d_fields](https://github.com/Ttl/js_2d_fields) by
Henrik Forstén (GPL v3) at upstream commit `b5ea9eb` (2026-10-18) plus the field
views of the fork, added as a separate layer so that the next update of the
original touches as little fork code as possible. Changes by David Riehl,
2026-10-21 and 2026-11-03.

The first version of the fork (2026-10-01 to 2026-10-05, on upstream `318300a`,
with the changes spread over the original's files and its list of changes in
`FORK_CHANGES.md`) is kept in the branch
[`fork-v1`](https://github.com/riehlies/js_2d_fields/tree/fork-v1); it can no
longer be merged with the original.

## What the fork adds

The plot views **Potential, |E| Field, |H| Field, Current J, Power flow S and
Losses**, drawn at the original's *Plot Frequency*:

- one excitation for all views (Plot Options → *Excitation*: voltage, voltage
  between conductors, current or power, peak or RMS), V, I and P in the title
- |H| with field lines (contours of A<sub>z</sub>), J with its sign on the linear scale,
  power flow with 50 / 90 / 99 % lines and the ∫S dA check, losses with the split
  into signal conductor, ground and dielectric
- E / H / S arrows, field lines by equal flux, equipotentials
- menu row in the plot (view, log / linear, arrows, odd / even with fixed gaps),
  legend that remembers what was switched off (field lines and contour lines start
  hidden), colour scales readable with colour-vision deficiency, own scale dialog
  with real values, help texts
- coax and rectangular waveguide from the closed-form fields
- the page opens with the Full-wave solver
- broadside coupled stripline: separate width of the upper trace (*Trace Width
  (top)*, empty = same as the bottom trace)
- notice of the modified version and the license in the About tab, page
  metadata of the hosted version, fork notice in the README,
  `THIRD_PARTY_NOTICES.txt`, the site build in `deploy/`

The Geometry view is the original's (its geometry plot, E contours and streamlines,
custom-geometry highlights); only its menu row is replaced by the fork's.

## Structure

```
src/fork/                 the fork, nothing of the original inside
  plot_fields.js          plot: draw of the field views, menus, legend, arrows,
                          scale dialog, Plot Options controls, help wrapper
  field_views.js          traces and colour scales of every view (pure functions)
  field_excitation.js     V / I / P conversion over Zc
  field_lines.js          E field lines by equal flux
  isolines.js             contour lines (marching squares)
  analytic_fields.js      closed-form coax and waveguide fields
  worker_jobs.js          ADAPTER, worker side: job 'forkField'
  mqs_grid.js             ADAPTER: the original's MQS plot field → H, J, A, loss
                          density on a grid, loss split
  shape_util.js, help.js  small helpers, help texts
tests/fork/               the fork's tests and the hook check
deploy/                   upload folder for the web host (make_site.mjs,
                          .htaccess, index.html)
THIRD_PARTY_NOTICES.txt   licenses of Plotly, Gmsh, OCCT, Eigen, Spectra,
                          Emscripten
```

Only the two adapter files read internals of the original (TriBackend
`_plotCache`, `modeNames`, `domain`, the MQS `fieldOut` of the plot slot and its
conductor set). Everything else uses the original's exported functions or the
fields it grafts onto the main-thread solver (`x, y, V, Ex, Ey`, `fieldFreq`).

## Hooks in the original's files

Every fork line in the original's files is marked `FORK`;
`tests/fork/check_hooks.mjs` checks them and their number per file. The six
hooks of the field views:

| File | Line |
|---|---|
| `src/plot.js` | first line of `draw()`: `if (window.forkPlot && window.forkPlot.draw(resetZoom, get)) return;` |
| `src/app_solver.js` | `window.forkWorkerJob = …; window.forkLog = …;` before `workerJob` |
| `src/solve_worker.js` | `import { forkJobs } from './fork/worker_jobs.js';` |
| `src/solve_worker.js` | `...forkJobs(() => simSolver),` in `JOBS` |
| `src/field_solver.html` | `<script type="module" src="fork/plot_fields.js">` |
| `src/field_solver.html` | `selected` on the Full-wave option |

Further changes of the original's files, also marked `FORK`:

| File | Change |
|---|---|
| `src/field_solver.html` | page metadata of the hosted version (canonical URL, author, description instead of the original's site and icons), notice of the modified version and license text in the About tab, input and help text *Trace Width (top)* |
| `src/app_solver.js` | setting `bs_w_top` (default and settings table) |
| `src/solver_factory.js` | passes `trace_width_top` |
| `src/broadside_stripline.js` | upper trace with its own width, domain margin and enclosure check with the wider trace |
| `src/tri_solver/tri_backend.js` | mesh reference width: the narrower trace |
| `README.md` | fork notice at the top, visualization line |

The broadside change is independent of the field views and a candidate for a
pull request to the original.

Not changed: the original's views, menus and scale dialog code stay in place; the
fork draws instead of them (its menu handler is never bound, the fork's handles all
menu clicks).

## Updating to a newer original

```
git fetch upstream
git merge upstream/master          # conflicts only in FORK-marked lines, if at all
node tests/fork/check_hooks.mjs    # hooks present, imported functions still exported
node tests/fork/run.mjs            # contract test: power, losses, scales on the new solver
```

If the contract test fails, the fix belongs in `worker_jobs.js` / `mqs_grid.js`.
Then a look at the page (all views, one single-ended line, a pair, coax,
waveguide).

## Web host

```
node deploy/make_site.mjs          # → site/tl (gitignored), upload its content
```

It copies exactly the files the page loads (following the imports from
`app_solver.js`, `solve_worker.js` and `fork/plot_fields.js`), the WebAssembly
modules, Plotly, `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt`, `.htaccess` and an
`index.html` that redirects the folder to the solver, and writes the version
(date and commit) into the About tab.

## WASM

The original needs `solver.wasm`, `eigen_solver.wasm`, `gmsh.wasm` and, new,
`fft.wasm` (time domain) in `src/wasm_solver/`, built with Emscripten (`make all`,
see `src/wasm_solver/README.md`) or taken from the original's site. Its C++
sources changed since `318300a`, so the binaries of the hosted fork version are
outdated.

Built for this branch on 2026-10-21 with Emscripten 6.0.0, LLVM 23.1.4 and
Binaryen 129 (the versions Emscripten 6.0.0 expects), Eigen `fdfdd4c` with
`eigen.patch`, Spectra `3133be5`, flags from the Makefile:
`make solver eigen_solver fft`. `gmsh.wasm` is unchanged (gmsh sources are the
same as in the hosted version). The binaries are not in git (`.gitignore`).

## Checks (2026-10-21, this branch)

- `node tests/fork/run.mjs`: excitation, field lines, contract test all pass.
  ∫S dA against n·½Re(V·I*): microstrip 0.7 %, coax 0.01 %, waveguide 0.00 %,
  differential pair 2.5 % (odd) / 4 % (even) at 1 GHz: above its static limit the
  original plots the full-wave E fitted to the static field by least squares, not
  normalized to the trace voltage (exact with the static E). Loss split of the
  adapter = ½·R·(1 A)² of the solver within 0.01 %; dielectric loss map = 2α<sub>d</sub>P
  within 0.4 %, coax rings within 0.3 %.
- `node tests/run.mjs fast`: 30 / 30 with the binaries built above (eye /
  transient tests included).
- Browser: all views for microstrip, differential pair, coax and waveguide, no
  console errors; `fft.wasm` loads in the page.
