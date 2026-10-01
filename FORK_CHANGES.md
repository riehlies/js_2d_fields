# Changes in this fork

This repository is a modified version of
[js_2d_fields](https://github.com/Ttl/js_2d_fields) by Henrik Forstén, a 2D
transmission line field solver. It is based on upstream commit `318300a`
(2026-09-19) and, like the original, licensed under the
[GNU General Public License v3](LICENSE).

Changes by David Riehl, 2026-10-01. Every modified file carries a `MODIFIED`
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
- Normalized to a line current of 1 A (1 A per trace for a differential pair,
  in the selected odd / even mode). Peak magnitude or instantaneous value at a
  phase ωt, logarithmic or linear color scale, selectable frequency
  (Plot Options → *H / J …*).

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
  normalized to **1 W** transmitted power. |H| includes the longitudinal
  H<sub>z</sub>; the field lines are arrows of the instantaneous transverse H;
  the wall current K = n × H has a longitudinal and a perimeter component.
  Below cutoff the request is refused (no power to normalize to).

**E / H field arrows** (Plot Options → *Field arrows*: off, E, H, E + H) on
every field view: arrows of the instantaneous transverse E (magenta) and H
(cyan) at phase ωt, on a lattice that is re-sampled when zooming or panning.
Arrow length grows with the field strength on a log scale over two decades
(the field is singular at conductor edges). E + H shows directly that the
two are perpendicular everywhere; the sign of E is chosen so that power flows
in +z, and E arrows are masked inside metal.

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

- Full-wave solver only. The quasi-static solver does not mesh the conductor
  interiors.
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
| `src/tri_solver/resample.js` | `buildLocator` exported |
| `src/solve_worker.js` | New `mqsField` job, keeps the last simulation's solver |
| `src/plot.js` | New views, H field lines, coax ring renderer, waveguide H arrows, E / H field arrows on all field views (zoom-aware), conductor outlines instead of fills in these views |
| `src/app_solver.js` | On-demand field request, scale dialog types, plot option handlers (incl. field arrows) |
| `src/field_solver.html` | Plot options, help text, fork notice in the About tab |
| `tests/test_mqs_field.js` | **New.** 18 checks: current normalization (exact FEM integral), Ampère's law ±1 A per trace for every MQS path (single-ended, odd/even on half and full domain, stripline), uniform current at 100 kHz, skin decay length = δ at 10 GHz, wall slab current, refusals |
| `tests/test_analytic_fields.js` | **New.** 12 checks: Bessel reference values, coax ±1 A and DC limit, R from the plotted coax current vs the solver's R (1 and 10 GHz), waveguide 1 W normalization, α<sub>c</sub> from the plotted wall current vs the solver's α<sub>c</sub>, below-cutoff refusal |
| `tests/run.mjs` | New tests registered in the fast tier |

## Verification

- `node tests/test_mqs_field.js`: all 18 checks pass (∮H·dl around each
  trace = 1.000 A ± 0.2 %, fitted skin decay 0.659 µm vs δ = 0.661 µm at
  10 GHz).
- `node tests/test_analytic_fields.js`: all 12 checks pass. The R implied by
  the plotted coax current, ∫|J|²/σ dA, matches the solver's R within 0.8 %
  (1 and 10 GHz); the waveguide α<sub>c</sub> from the plotted wall current
  matches the solver's α<sub>c</sub> (0.1084 dB/m for WR-90 at 10 GHz).
- `npm run test:fast`: same result as upstream at `318300a`. The only failure,
  `complex_symmetric_test.mjs`, is a test file that is registered upstream but
  missing from the repository.
- `test_gcpw_mqs.js`, `test_symmetry_half_full.js`,
  `test_fullwave_correctness.js` (slow tier, MQS paths): pass unchanged.

## WASM binaries

As upstream, the WASM solver binaries are not part of the repository
(`src/wasm_solver/.gitignore`). Build them as described in
[src/wasm_solver/README.md](src/wasm_solver/README.md). This fork does not
change the C++ sources. When you distribute the binaries (for example on a
website), the GPL requires the corresponding source, including the gmsh and
OpenCASCADE sources used to build `gmsh.wasm`.
