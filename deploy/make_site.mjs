// Copyright (C) 2026 David Riehl
// Part of a modified version (fork) of js_2d_fields by Henrik Forstén,
// https://github.com/Ttl/js_2d_fields. This file is new in the fork and is licensed
// under the GNU General Public License v3, like the rest of the project (see
// LICENSE). See FORK_CHANGES.md for the list of changes.
//
// Builds the upload folder for a static web host, without any npm dependencies:
//
//   node deploy/make_site.mjs [outDir]        (default: site/tl)
//
// Copies exactly the files the page loads at runtime, found by following the module
// imports from the two entry points (app_solver.js, solve_worker.js), plus the
// WebAssembly modules, Plotly, the stylesheet, LICENSE.txt, THIRD_PARTY_NOTICES.txt,
// .htaccess and an index.html that redirects the folder URL to the solver. The modules
// are shipped unbundled (no build step), so .htaccess makes browsers revalidate every
// file instead of caching it for a year.
//
// The WebAssembly binaries are not in git (see src/wasm_solver/README.md); build them
// or copy them into src/wasm_solver/ first.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.resolve(ROOT, process.argv[2] || 'site/tl');

const fail = (msg) => { console.error('make_site: ' + msg); process.exit(1); };

// Follow static imports, dynamic import('…') with literal paths and
// new URL('…', import.meta.url) references.
const PATTERNS = [
    /\bimport\s+[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bexport\s+[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /new\s+URL\(\s*['"]([^'"]+\.m?js)['"]\s*,\s*import\.meta\.url\s*\)/g,
];
const files = new Set();
function walk(rel) {
    const norm = path.normalize(rel);
    if (files.has(norm)) return;
    const abs = path.join(SRC, norm);
    if (!fs.existsSync(abs)) fail(`missing ${norm} (imported by the page)`);
    files.add(norm);
    const code = fs.readFileSync(abs, 'utf8');
    for (const re of PATTERNS) {
        for (const m of code.matchAll(re)) {
            const target = m[1].startsWith('.') ? m[1] : './' + m[1];
            walk(path.join(path.dirname(norm), target));
        }
    }
}
walk('app_solver.js');
walk('solve_worker.js');
walk('tri_solver/tri_backend.js');   // lazily imported through a computed path
walk('wasm_solver/gmsh.js');          // loaded via new URL(...) inside gmsh_mesh.js

// Each Emscripten loader fetches the .wasm with the same name next to it.
for (const f of [...files]) {
    if (f.startsWith('wasm_solver' + path.sep) && f.endsWith('.js')) {
        const w = f.replace(/\.js$/, '.wasm');
        if (!fs.existsSync(path.join(SRC, w))) fail(`missing ${w}: build or copy the WebAssembly binaries first`);
        files.add(w);
    }
}
for (const f of [...files]) if (f.includes(`${path.sep}tests${path.sep}`)) files.delete(f);
files.add('solver-style.css');
files.add('plotly-3.3.0.min.js');

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of files) {
    const dst = path.join(OUT, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), dst);
}

let version = new Date().toISOString().slice(0, 10);
try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    const dirty = execSync('git status --porcelain -- src', { cwd: ROOT }).toString().trim() ? '+' : '';
    version += ` (${hash}${dirty})`;
} catch { /* not a git checkout */ }
const html = fs.readFileSync(path.join(SRC, 'field_solver.html'), 'utf8').replace(/BUILD_VERSION/g, version);
fs.writeFileSync(path.join(OUT, 'field_solver.html'), html);

fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE.txt'));
fs.copyFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.txt'), path.join(OUT, 'THIRD_PARTY_NOTICES.txt'));
fs.copyFileSync(path.join(ROOT, 'deploy', 'htaccess'), path.join(OUT, '.htaccess'));
fs.copyFileSync(path.join(ROOT, 'deploy', 'index.html'), path.join(OUT, 'index.html'));

let bytes = 0, n = 0;
(function size(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) size(p); else { bytes += fs.statSync(p).size; n++; }
    }
})(OUT);
console.log(`make_site: ${n} files, ${(bytes / 1e6).toFixed(1)} MB → ${path.relative(ROOT, OUT)} (version ${version})`);
