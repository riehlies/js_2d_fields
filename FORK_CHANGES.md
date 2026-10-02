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

**|H| Field and Current J views** in the field plot (Geometry tab, view
selector at the top left of the plot):

- **|H| Field**: magnetic field magnitude everywhere, including inside the
  conductors (skin and proximity effect), with the magnetic field lines drawn
  as contour lines of the vector potential A. Their density is proportional to
  |H|.
- **Current J**: longitudinal current density J<sub>z</sub> in the traces, in
  coplanar grounds and vias, and in the ground planes / enclosure walls.
- Scaled by the common excitation of all field views (see *Field views*
  below), in the selected odd / even mode for a differential pair. Peak
  amplitude or instantaneous value at a phase ωt, logarithmic or linear color
  scale, selectable frequency (Plot Options → *Field frequency*).

The fields come from the magneto-quasi-static (MQS) eddy-current solve the
Full-wave solver already runs for the conductor loss. Selecting one of the
views runs one extra MQS solve at the chosen frequency on the last
simulation's mesh. The loss, RLGC and S-parameter results are unchanged.

**Coax and rectangular waveguide** (added 2026-10-01, second step) use the
exact closed-form fields instead, since both are exact shapes with a
homogeneous fill:

- Coax: Bessel-function skin effect in the inner conductor,
  H<sub>φ</sub> = I/(2πr) in the dielectric, exponential decay into the
  shield. Drawn as concentric rings, so thin skin layers stay round at any zoom.
  Field lines are circles at evenly spaced values of A ∝ ln(b/r).
- Waveguide: fundamental mode (TE10, or TE01 for a guide taller than wide),
  scaled by the transmitted power (a waveguide has no unique voltage or
  current). |H| includes the longitudinal
  H<sub>z</sub>; the field lines are arrows of the instantaneous transverse H;
  the wall current K = n × H has a longitudinal and a perimeter component.
  Below cutoff the request is refused (no power to normalize to).

**E / H field arrows** (menu in the plot, next to the view selector: off, E,
H, E + H, S, E + H + S) on every view: arrows of the transverse E (blue) and
H (red), on a lattice that is re-sampled when zooming or panning. **S** adds
the Poynting vector as white ⊙ symbols (power out of the page; ⊗ into the
page where the instantaneous power flow reverses in a standing wave), sized by
the power density. Arrow length grows with the field strength on a log scale
over two decades (the field is singular at conductor edges). E + H shows
directly that the two are perpendicular everywhere; E arrows are masked inside
metal. H and S need the Full-wave solver.

**Power flow S view**: color map of S<sub>z</sub>, the time average
½Re(E × H*) or the instantaneous E(t) × H(t), with lines enclosing 50 %, 90 %
and 99 % of the power and, in the title, ∫S dA against the power the
excitation predicts and the share of the power flowing inside the dielectric.
Cross-check: for the default microstrip (εr = 4.4, ε<sub>eff</sub> = 3.229)
64.1 % of the power flows in the dielectric, close to the filling factor
(ε<sub>eff</sub> − 1)/(εr − 1) = 65.6 % from the solver's ε<sub>eff</sub>.

### Field views: excitation, time display, field lines (2026-10-02)

- **One excitation for all views** (Plot Options → *Excitation*): voltage per
  conductor, voltage between the conductors of a pair, current per conductor
  or total power, peak or RMS. The solver's unit fields (E and potential for
  1 V, H and J for 1 A, the waveguide for 1 W) are scaled by the complex
  amplitudes V and I = V/Z<sub>c</sub> of the plotted mode at the field
  frequency (Z<sub>c</sub> interpolated in the sweep), so H carries the phase
  of Z<sub>c</sub> on a lossy line. The title shows V, I and P. Before, E was
  for 1 V and H for 1 A, so the two views differed by a factor Z<sub>c</sub>,
  and the power flow had to be renormalized to 1 W and the sign of E fixed by
  hand; now ½Re(E × H*) integrates to the predicted power directly
  (0.1–0.6 % for microstrip, differential pair odd / even, coax, waveguide).
- **One time display for all views**: *Peak amplitude* or *Instantaneous at
  ωt* now applies to potential, |E|, the arrows and S as well (S pulsates at
  2ω). In the instantaneous display the color scale and the line spacing stay
  those of the peak, so the fields shrink and the lines thin out as ωt runs
  (before, every phase was rescaled to the full color range, so at ωt = 90°
  the small residual looked like a full field). ▶ runs through ωt.
- **Line termination** (matched, open, short, Z<sub>L</sub>) and the distance
  from the load in wavelengths: the cross-section of a standing wave,
  V(d) = V⁺(1 + Γe<sup>−j4πd/λ</sup>), I(d) = I⁺(1 − Γe<sup>−j4πd/λ</sup>).
  On a matched line E and H are in phase (both zero at ωt = 90°); λ/8 from an
  open end they are 90° apart and alternate. The help text explains the
  difference. TEM lines only.
- **Field lines and contour lines per view** (Plot Options → *Field lines*,
  *Contour lines*, *Contours show*):
  - Geometry, Potential, |E|: electric field lines and equipotentials (they
    cross at right angles). Before, the |E| view and the geometry overlay drew
    lines of equal |E|, which look like equipotentials but are not; they are
    still available as *|E| levels*. Field lines are now also drawn in
    the potential and |E| views.
  - Field lines start at points of equal electric FLUX (weighted by
    ε·E<sub>n</sub>, the surface charge, over all signal conductors), so
    every line carries the same charge. Before, they were weighted by
    E<sub>n</sub> and distributed by perimeter, which gave conductor faces in
    the substrate ε<sub>r</sub> times too few lines. A line between the two
    conductors of a pair is drawn once (before twice), lines stop in
    field-free regions (before, some ran straight to the domain corners).
  - |H|: H field lines (contours of A<sub>z</sub>) unchanged, with levels from
    the peak field.
  - Current J: no lines (J points along the line). Power flow: 50 / 90 / 99 %
    lines.
  - Coax: radial E lines and circular equipotentials from the closed form;
    waveguide: TE10 / TE01 E lines between the broad walls, spaced by equal
    flux (density ∝ sin(πx/a)).
- **Coax |E| and potential from the closed form**, drawn as rings like H and
  J. The resampled FEM field of a round conductor had |E| spikes of about 200×
  the surface field at the inner conductor (an unmeshed conductor interior
  read 0 V instead of 1 V in the difference stencil), which pushed the color
  scale up so the plot looked black, removed the contours and showed the inner
  conductor at 0 V in the potential view. Fixed in the resampler as well
  (used by the arrows and the power flow): |E| within 1 % of V/(r·ln(b/a))
  from 2 % of the radius off the surface.
- **Waveguide |E|** from the closed-form mode scaled by the power (before the
  arbitrarily scaled eigenvector, so its V/m values meant nothing).
- **Conductors no longer cover arrows and lines**: the conductor fill is drawn
  below the traces with its outline on top, the field maps leave the metal
  empty (no dark rim at the edges). The |E| color range ends at the
  area-weighted 99.99th percentile instead of the singular corner value
  (quasi-static grid: 98 kV/m → 9 kV/m for the default microstrip at 1 V).
- **Arrow selection in the plot**, next to the view and mode selectors.
- **Potential view**: the conductors keep their potential in the color map
  (each is an equipotential at its drive voltage), only their outlines are
  drawn on top.
- **E arrows next to a conductor** are shortened so they do not reach into the
  metal (E is zero there), or dropped.
- **Redraw speed**: contour lines (equipotentials, H field lines, power lines,
  |E| levels) are computed with a marching-squares pass of our own
  (`src/isolines.js`, joined into polylines) and drawn as line traces. Plotly
  contour traces re-contoured the whole grid with smoothing on every redraw,
  once per trace: a redraw of the power flow view took 1.3 s, of the |H| view
  0.55 s; now 0.1–0.15 s.
- **Power flow S sign**: in a matched or lossy travelling wave S<sub>z</sub> is
  positive everywhere, so the S view uses a one-sided scale (log in the
  instantaneous display too). A signed scale is used only for a standing wave
  or when S<sub>z</sub> really turns negative, where the instantaneous power
  flows back and forth; the containment lines are then left out. The
  conductors are drawn filled in the S view (no power flows inside).
- **Scale dialog** (click on the color bar) shows the real values and the unit
  also for log scales (it showed the log10 exponents).
- **Color maps** reviewed for color-vision deficiency, all perceptually
  uniform with lightness growing with the value: Viridis for potential, |E|,
  |H|; Inferno for J; Magma for S; signed values (instantaneous display,
  standing waves) use a diverging map that is dark at zero (after Crameri's
  *berlin*), blue negative and red positive, so a zero field stays dark on the
  dark background instead of lighting up white. Light solid field lines get a
  thin dark seam for contrast on the light end of the maps.

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

- H, J and S need the Full-wave solver. The quasi-static solver does not mesh
  the conductor interiors (its potential, |E|, field lines and E arrows work).
- The standing wave neglects the attenuation over the distance from the load
  and is not offered for the waveguide.
- The coax shield is modelled as infinitely thick, as in the solver. Its
  profile uses the large-argument form of the exact solution (accurate for
  δ ≪ shield radius); the net shield current is exactly −1 A either way.
- The ground-plane current uses the 1D skin profile. That is accurate when the
  skin depth and the plane thickness are small compared to the width of the
  return current distribution (PCB copper: above a few MHz). At lower
  frequencies the lateral spreading of the return current is not modelled.
- Plating and roughness are post-processing in the loss calculation. The
  plotted current is that of the smooth bulk metal.

## Files

| File | Change |
|---|---|
| `src/tri_solver/analytic_fields.js` | **New.** Closed-form coax and waveguide fields (H, J, and the waveguide's transverse E), complex Bessel J0/J1 (scaled, overflow-free in the skin-effect regime) |
| `src/tri_solver/mqs_field.js` | **New.** Resamples H, J and A from the MQS solution onto the plot grid, wall slab current, grid with skin-depth and face lines |
| `src/tri_solver/mqs_loss.js` | `mqsConductorLoss(…, { returnField: true })` exports the normalized solution |
| `src/tri_solver/tri_backend.js` | `TriBackend.mqsFieldAt(f, mode)` runs an exact MQS solve and resamples the fields |
| `src/tri_solver/resample.js` | `buildLocator` exported; unmeshed conductor interiors take the conductor potential, the E stencil does not straddle a curved conductor surface |
| `src/field_views.js` | **New.** All field views (potential, \|E\|, \|H\|, J, S, coax and waveguide variants), field lines, equipotentials, power-containment lines, arrows, scaled by the excitation |
| `src/field_excitation.js` | **New.** Voltage / current / power conversion over Z<sub>c</sub>, standing wave, impedance parser |
| `src/isolines.js` | **New.** Marching-squares contour lines joined into polylines (all field views) |
| `src/streamlines.js` | Rewritten: flux-weighted seeding over all signal conductors, adaptive RK4 tracing, de-duplicated lines between conductors |
| `src/solve_worker.js` | New `mqsField` job, keeps the last simulation's solver |
| `src/plot.js` | New views and arrows (builders in `field_views.js`), excitation and time settings, arrow menu in the plot, conductors below the traces |
| `src/app_solver.js` | On-demand field request, scale dialog types, plot option handlers, ▶ animation, termination controls |
| `src/field_solver.html` | Plot options, help texts, fork notice in the About tab |
| `tests/test_mqs_field.js` | **New.** 18 checks: current normalization (exact FEM integral), Ampère's law ±1 A per trace for every MQS path (single-ended, odd/even on half and full domain, stripline), uniform current at 100 kHz, skin decay length = δ at 10 GHz, wall slab current, refusals |
| `tests/test_analytic_fields.js` | **New.** 12 checks: Bessel reference values, coax ±1 A and DC limit, R from the plotted coax current vs the solver's R (1 and 10 GHz), waveguide 1 W normalization, α<sub>c</sub> from the plotted wall current vs the solver's α<sub>c</sub>, below-cutoff refusal |
| `tests/test_field_excitation.js` | **New.** 30 checks: V / I / P conversion (peak, RMS, lossy Z<sub>c</sub>, differential), standing wave (open, short, λ/8 alternation), impedance parser |
| `tests/test_field_lines.js` | **New.** 11 checks: flux-weighted seeding with a dielectric, de-duplicated lines between two conductors, coax \|E\| on the plot grid vs the closed form, contour lines (closed, on the circle, ending at masked cells) |
| `tests/test_field_views.js` | **New.** 10 checks: ∫S dA = n·½Re(V·I*) for microstrip (1 V, 1 W), pair odd / even, coax, waveguide; fixed scale of the instantaneous display; standing-wave power |
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
  (waveguide).
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
