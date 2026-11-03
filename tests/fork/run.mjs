// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK.md for the list of changes.
//
// The fork's tests (field views). Run: node tests/fork/run.mjs
import { spawnSync } from 'node:child_process';
const files = ['test_field_excitation.js', 'test_field_lines.js', 'test_field_views.js'];
let failed = 0;
for (const f of files) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [new URL(f, import.meta.url).pathname], { encoding: 'utf8' });
    const ok = r.status === 0;
    if (!ok) { failed++; process.stdout.write(r.stdout + r.stderr); }
    console.log(`${ok ? '✓' : '✗'} tests/fork/${f}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log(failed ? `\n${failed} of ${files.length} fork test files failed` : `\nall ${files.length} fork test files passed`);
process.exit(failed ? 1 : 0);
