# Changes in this fork

This repository is a modified version of
[js_2d_fields](https://github.com/Ttl/js_2d_fields) by Henrik Forstén, a 2D
transmission line field solver. It is based on upstream commit `318300a`
(2026-09-19) and, like the original, licensed under the
[GNU General Public License v3](LICENSE).

Changes by David Riehl, 2026-10-01 and 2026-10-02. Every modified file carries a `MODIFIED`
note at its top, new files carry their own copyright header. The original
copyright notices are unchanged.

## What is new

The fork is used for teaching (lecture *Advanced PCB Design*): it shows where the
fields, the current, the power and the losses of a transmission line sit in its
cross-section. The page opens with the **Full-wave solver** (before: quasi-static),
which all of the new views need; share links without a solver setting still open
with the quasi-static one they were made with.

### Field views

The view menu at the top left of the plot (Geometry tab) offers Geometry,
Potential, |E| Field, **|H| Field**, **Current J**, **Power flow S** and
**Losses**. Next to it are the **log / linear** scale menu and the **arrow** menu;
the odd / even mode of a differential pair sits apart on the right.

- **Potential**: linear and symmetric around 0 V. The ground (and the
  symmetry plane of an odd-mode pair) is dark, positive conductors red,
  negative blue. The conductors keep their potential in the color map.
- **|E|**, **|H|**: peak amplitudes, logarithmic scale by default (most fields
  span several decades: field concentration at the edges, skin effect). The
  log scale covers at most three decades and less when the field varies less.
  |H| includes the field inside the conductors, with the magnetic field lines
  drawn as contour lines of the vector potential A (density ∝ |H|).
- **Current J**: longitudinal current density J<sub>z</sub> in the traces, in
  coplanar grounds and vias, and in the ground planes / enclosure walls. Log
  scale: |J| (skin and proximity effect over decades). Linear scale:
  J<sub>z</sub> with its sign at the moment the line current peaks, current
  along the line red, return current blue.
- **Power flow S**: time average S<sub>z</sub> = ½Re(E × H*), with lines
  enclosing 50 %, 90 % and 99 % of the power and, in the title, ∫S dA against
  the power the excitation predicts and the share of the power flowing inside
  the dielectric. Cross-check: for the default microstrip (εr = 4.4,
  ε<sub>eff</sub> = 3.229) 64.1 % of the power flows in the dielectric, close to
  the filling factor (ε<sub>eff</sub> − 1)/(εr − 1) = 65.6 %. On the matched
  line S<sub>z</sub> ≥ 0, the scale is one-sided (numerical noise below zero is
  drawn as 0).
- **Losses** (new): time-average loss density ½|J|²/σ in the metal and
  ½ωε<sub>0</sub>ε<sub>r</sub>tanδ|E|² in the dielectric, in W/mm³, log scale
  over five decades. The title gives the loss per unit length from the
  solver's attenuation, P′ = 2αP, split into signal conductor, ground and
  dielectric (coax: inner conductor, shield, dielectric; waveguide: walls).
  The split of the conductor loss comes from the MQS solve
  (R<sub>trace</sub> / R<sub>ground</sub>, roughness and plating included); the
  loss density of the metal is exported by the solve on the plot grid
  (`Q = ½|J|²/σ`, wall metal with its own σ). Check: the dielectric part of
  the map integrates to 2α<sub>d</sub>P within 0.1 % (microstrip), the coax
  rings to 2α<sub>c</sub>P and 2α<sub>d</sub>P within 0.9 % and 0.2 %.

All views are scaled by **one excitation** (Plot Options → *Excitation*):
voltage per conductor, voltage between the conductors of a pair, current per
conductor or total power, peak or RMS. The solver's unit fields (E and potential
for 1 V, H and J for 1 A, the waveguide for 1 W) are scaled by the complex
amplitudes V and I = V/Z<sub>c</sub> of the plotted mode at the field frequency
(Plot Options → *Field frequency*, Z<sub>c</sub> interpolated in the sweep), so
½Re(E × H*) integrates to the predicted power directly (0.01–0.53 % for
microstrip, differential pair odd / even, coax, waveguide). The title shows V, I
and P. Fields are peak amplitudes, power flow and losses time averages, all for
the matched line.

The H and J fields come from the magneto-quasi-static (MQS) eddy-current solve
the Full-wave solver already runs for the conductor loss. Selecting one of the
views runs one extra MQS solve at the chosen frequency on the last simulation's
mesh. The loss, RLGC and S-parameter results are unchanged.

**Coax and rectangular waveguide** use the exact closed-form fields, since both
are exact shapes with a homogeneous fill:

- Coax: Bessel-function skin effect in the inner conductor,
  H<sub>φ</sub> = I/(2πr) in the dielectric, exponential decay into the
  shield, V(r) = V·ln(b/r)/ln(b/a). Drawn as concentric rings, so thin skin
  layers stay round at any zoom. H lines are circles at evenly spaced values of
  A ∝ ln(b/r); radial E lines and circular equipotentials.
- Waveguide: fundamental mode (TE10, or TE01 for a guide taller than wide),
  scaled by the transmitted power (a waveguide has no unique voltage or
  current). |H| includes the longitudinal H<sub>z</sub>, the transverse H is
  drawn as arrows; the wall current K = n × H has a longitudinal and a
  perimeter component. E lines between the broad walls, spaced by equal flux
  (density ∝ sin(πx/a)). Below cutoff the request is refused.

**E / H field arrows** (menu in the plot: off, E, H, E + H, S, E + H + S) on every
view: arrows of the transverse E (blue) and H (red), each at the phase of its
own maximum, on a lattice that is re-sampled when zooming or panning. **S** adds
the Poynting vector as white ⊙ symbols (power out of the page), sized by the
time-average power density. Arrow length grows with the field strength on a log
scale over two decades. E + H shows directly that the two are perpendicular
everywhere. E arrows next to a conductor are shortened so they do not reach into
the metal. H and S need the Full-wave solver.

**Field lines and contour lines** (Plot Options → *Field lines*, *Contour
lines*):

- Geometry, Potential, |E|: electric field lines and equipotentials in equal
  voltage steps (they cross at right angles). Before, the |E| view drew lines
  of equal |E|, which look like equipotentials but are not. Field lines start at points of equal electric FLUX (weighted by
  ε·E<sub>n</sub>, the surface charge, over all signal conductors), so every
  line carries the same charge (before, conductor faces in the substrate got
  ε<sub>r</sub> times too few lines). A line between the two conductors of a pair
  is drawn once, lines stop in field-free regions.
- |H|: H field lines (contours of A<sub>z</sub>), no further contour lines:
  those of a magnetic scalar potential would run along the E field lines.
  Power flow: 50 / 90 / 99 % lines. Current J and Losses: no lines.
- Equipotentials and the power-containment lines start hidden; a click on
  their legend entry shows them. Legend clicks switch a line set together with
  its dark contrast seam and are kept across redraws, views and scale changes
  (Plotly would reset them on every redraw).
- Contour lines are computed with a marching-squares pass of our own
  (`src/isolines.js`) and drawn as line traces: a redraw takes 0.1–0.15 s
  (with Plotly contour traces 0.55–1.3 s).

**Color maps**, all perceptually uniform with lightness growing with the value,
readable with colour-vision deficiency and in greyscale: Viridis for |E| and
|H|, Inferno for |J|, Electric (black → violet → amber → cream) for S, Magma for
the losses, and for signed values (potential, J<sub>z</sub> linear) a diverging
map that is dark at zero (after Crameri's *berlin*), blue negative and red
positive. Light solid field lines get a thin dark seam for contrast. Log color
bars are labelled with real values; the **scale dialog** (click on the color
bar) also shows real values and the unit.

**Other fixes**

- Coax |E|: the resampled FEM field of a round conductor had |E| spikes of
  about 200× the surface field at the inner conductor (an unmeshed conductor
  interior read 0 V in the difference stencil). Fixed in the resampler (used by
  the arrows and the power flow); the coax views use the closed form.
- Waveguide |E| from the closed-form mode scaled by the power (before the
  arbitrarily scaled eigenvector).
- Conductors no longer cover arrows and lines: the field views draw only the
  conductor outlines. In the |E| and power flow views (no field in the metal)
  the conductors stay dark, the geometry view keeps the filled conductors below
  the field lines. The linear |E| color range ends at the area-weighted
  99.99th percentile instead of the singular corner value.

**Removed for teaching (2026-10-02).** An intermediate version also had an
instantaneous time display (phase ωt, ▶ animation) and line terminations
(open, short, Z<sub>L</sub>: the cross-section of a standing wave). Both were
removed again: a termination only changes the amplitudes of E and H at a
position, not the shape of the fields in the cross-section, and standing waves
are taught better along the line (1D, Smith chart, TDR); on the matched line
the time display adds little beyond "E and H are in phase", while its
switching color scales (signed, one-sided, log or not) confused more than they
showed.

### How the fields are computed

The MQS solve works with the vector potential A<sub>z</sub> on a P2 mesh that
includes the conductor interiors:

- H = (∂A/∂y, −∂A/∂x) / μ<sub>0</sub>
- J<sub>z</sub> = σ·C·(u − jω·A<sub>1</sub>) in meshed metal (u: drive constant
  of the signal, 0 in passive ground rects)

Ground planes and enclosure walls are boundary conditions of that solve
(A = 0), so their current is reconstructed from the surface current
K = n × H with the 1D slab profile the loss calculation already uses:
J(s) = K·γ·cosh(γ(d − s)) / sinh(γd), γ = (1 + j)/δ.

### Limitations

- H, J, S and the losses need the Full-wave solver. The quasi-static solver
  does not mesh the conductor interiors (its potential, |E|, field lines and E
  arrows work).
- The coax shield is modelled as infinitely thick, as in the solver. Its
  profile uses the large-argument form of the exact solution (accurate for
  δ ≪ shield radius); the net shield current is exactly −1 A either way.
- The ground-plane current uses the 1D skin profile. That is accurate when the
  skin depth and the plane thickness are small compared to the width of the
  return current distribution (PCB copper: above a few MHz). At lower
  frequencies the lateral spreading of the return current is not modelled.
- Plating and roughness are post-processing in the loss calculation. The
  plotted current and loss density are those of the smooth bulk metal; the
  loss totals in the title include them.
- The loss map uses the nominal ε<sub>r</sub> and tanδ of each dielectric
  (with causal materials the solver's values vary with frequency). Integrating
  the metal part of the map on the plot grid overestimates the conductor loss
  where the grid does not resolve the skin depth, so the totals come from the
  solver.

## Files

| File | Change |
|---|---|
| `src/tri_solver/analytic_fields.js` | **New.** Closed-form coax and waveguide fields (H, J, and the waveguide's transverse E), complex Bessel J0/J1 (scaled, overflow-free in the skin-effect regime) |
| `src/tri_solver/mqs_field.js` | **New.** Resamples H, J, A and the loss density ½\|J\|²/σ from the MQS solution onto the plot grid, wall slab current, grid with skin-depth and face lines |
| `src/tri_solver/mqs_loss.js` | `mqsConductorLoss(…, { returnField: true })` exports the normalized solution and the trace / ground split of the loss |
| `src/tri_solver/tri_backend.js` | `TriBackend.mqsFieldAt(f, mode)` runs an exact MQS solve and resamples the fields |
| `src/tri_solver/resample.js` | `buildLocator` exported; unmeshed conductor interiors take the conductor potential, the E stencil does not straddle a curved conductor surface |
| `src/field_views.js` | **New.** All field views (potential, \|E\|, \|H\|, J, S, losses, coax and waveguide variants), color scales, field lines, equipotentials, power-containment lines, arrows, scaled by the excitation |
| `src/field_excitation.js` | **New.** Voltage / current / power conversion over Z<sub>c</sub>, label formatting |
| `src/isolines.js` | **New.** Marching-squares contour lines joined into polylines (all field views) |
| `src/streamlines.js` | Rewritten: flux-weighted seeding over all signal conductors, adaptive RK4 tracing, de-duplicated lines between conductors |
| `src/solve_worker.js` | New `mqsField` job, keeps the last simulation's solver |
| `src/plot.js` | New views and arrows (builders in `field_views.js`), excitation, menu row in the plot (view, log / linear, arrows, odd / even), attenuation for the losses view, conductors below the traces |
| `src/app_solver.js` | On-demand field request, scale dialog types (real values for log scales), plot option handlers |
| `src/field_solver.html` | Plot options, help texts, fork notice in the About tab, Full-wave solver as the default |
| `tests/test_mqs_field.js` | **New.** 18 checks: current normalization (exact FEM integral), Ampère's law ±1 A per trace for every MQS path (single-ended, odd/even on half and full domain, stripline), uniform current at 100 kHz, skin decay length = δ at 10 GHz, wall slab current, refusals |
| `tests/test_analytic_fields.js` | **New.** 12 checks: Bessel reference values, coax ±1 A and DC limit, R from the plotted coax current vs the solver's R (1 and 10 GHz), waveguide 1 W normalization, α<sub>c</sub> from the plotted wall current vs the solver's α<sub>c</sub>, below-cutoff refusal |
| `tests/test_field_excitation.js` | **New.** V / I / P conversion (peak, RMS, lossy Z<sub>c</sub>, differential), waveguide, label formatting |
| `tests/test_field_lines.js` | **New.** 11 checks: flux-weighted seeding with a dielectric, de-duplicated lines between two conductors, coax \|E\| on the plot grid vs the closed form, contour lines (closed, on the circle, ending at masked cells) |
| `tests/test_field_views.js` | **New.** 15 checks: ∫S dA = n·½Re(V·I*) for microstrip (1 V, 1 W), pair odd / even, coax, waveguide; color scales (potential symmetric, \|E\| log, J signed); losses against 2αP (microstrip dielectric, coax conductor and dielectric) |
| `tests/run.mjs` | New tests registered in the fast tier |
| `src/snp_export.js` | Touchstone header names the hosted version and the original |
| `deploy/make_site.mjs`, `deploy/htaccess`, `deploy/index.html` | **New.** Upload folder for the hosted version |
| `THIRD_PARTY_NOTICES.txt` | **New.** Third-party components, licenses and sources |

## Verification

- `node tests/test_mqs_field.js`: all 18 checks pass (∮H·dl around each
  trace = 1.000 A ± 0.2 %, fitted skin decay 0.659 µm vs δ = 0.661 µm at
  10 GHz).
- `node tests/test_analytic_fields.js`: all 12 checks pass. The R implied by
  the plotted coax current, ∫|J|²/σ dA, matches the solver's R within 0.8 %
  (1 and 10 GHz); the waveguide α<sub>c</sub> from the plotted wall current
  matches the solver's α<sub>c</sub> (0.1084 dB/m for WR-90 at 10 GHz).
- `node tests/test_field_views.js`: ∫S dA matches n·½Re(V·I*) within 0.53 %
  (microstrip), 0.31 / 0.14 % (pair odd / even), 0.01 % (coax), 0.00 %
  (waveguide); the loss map matches 2α<sub>d</sub>P within 0.1 % (microstrip)
  and 2α<sub>c</sub>P / 2α<sub>d</sub>P within 0.9 / 0.2 % (coax).
- `npm run test:fast`: same result as upstream at `318300a`. The only failure,
  `complex_symmetric_test.mjs`, is a test file that is registered upstream but
  missing from the repository.
- `test_gcpw_mqs.js`, `test_symmetry_half_full.js`,
  `test_fullwave_correctness.js` (slow tier, MQS paths): pass unchanged.

## Hosted version and deployment

This version runs at https://advpcb.davidriehl.de/tl/field_solver.html.
`node deploy/make_site.mjs` (no npm dependencies) builds the upload folder
`site/tl/`: exactly the files the page loads (found by following the module
imports), the WebAssembly modules, Plotly, `LICENSE.txt`,
`THIRD_PARTY_NOTICES.txt`, an `index.html` that redirects the folder URL to
the solver, and a `.htaccess` (`deploy/htaccess`) that serves `.wasm` with the
right MIME type, compresses, and makes browsers revalidate every file. The
modules are shipped unbundled, so the upstream policy of caching for a year
(meant for the content-hashed `build.sh` output) would leave browsers with
stale files after an update.

For the hosted version the page metadata (canonical URL, Open Graph) points to
advpcb.davidriehl.de instead of hforsten.com, the root-relative favicon links
of the original site are removed, and Touchstone exports name the hosted
version and the original. The page loads nothing from other servers (Plotly
is served locally), uses no cookies or browser storage and sends no requests
besides fetching its own files.

## Licensing

- The project is GPL v3. The About tab carries the notices GPL v3 §5(d)
  asks of an interactive program: copyright of the original author and of the
  modifications, the no-warranty statement, a link to the license
  (`LICENSE.txt`) and to the complete source code (this repository).
- `THIRD_PARTY_NOTICES.txt` lists every bundled third-party component with its
  license and exact source: Plotly.js (MIT), Gmsh (GPL-2.0-or-later, pinned
  commit plus `gmsh.patch`), Open CASCADE 7.5.1 (LGPL-2.1 with exception),
  Eigen and Spectra (MPL-2.0, pinned commits), and the Emscripten runtime in
  the WebAssembly loaders (MIT).
- Distributing the WebAssembly binaries obliges the distributor to provide
  their corresponding source. This repository contains the C++ sources,
  patches, pinned submodules and build instructions. The binaries used for the
  hosted version are the upstream author's build of commit `318300a` (taken
  from the original site; `solver.js` is the Emscripten loader extracted from
  its bundled worker). The fork does not change any C++ source. Rebuilding them
  from this repository (`src/wasm_solver/README.md`) makes the correspondence
  between binary and source verifiable.

## WASM binaries

As upstream, the WASM solver binaries are not part of the repository
(`src/wasm_solver/.gitignore`). Build them as described in
[src/wasm_solver/README.md](src/wasm_solver/README.md). This fork does not
change the C++ sources. When you distribute the binaries (for example on a
website), the GPL requires the corresponding source, including the gmsh and
OpenCASCADE sources used to build `gmsh.wasm`.
