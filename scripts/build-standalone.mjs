#!/usr/bin/env node
/**
 * Standalone build (spec §14.8): bundles every .ts file in components/hippo-run/ (not .tsx) into
 * ONE self-contained public/play.html — no external URLs, no <link>, no <img>, no <script src>.
 *
 *   node scripts/build-standalone.mjs        (also runs as "prebuild" and "build:play")
 *
 * How: typescript.transpileModule each file -> CommonJS/ES2019, wrap each in a function inside a
 * tiny require registry, IIFE, boot require('index').createGame(canvas, { standalone: true }).
 * Whitespace between tokens is dropped (line breaks kept, token stream re-verified; see squeeze()).
 * No new dependencies: uses the repo's own `typescript`.
 *
 * Fails (exit 1) on transpile diagnostics, an external URL in the output, or > 400 KB.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'components', 'hippo-run');
// `--out <path>` writes somewhere else (e.g. a scratch dir while several people test changes in parallel).
const outArg = process.argv.indexOf('--out');
const OUT_FILE = outArg > -1 && process.argv[outArg + 1] ? resolve(process.argv[outArg + 1]) : join(ROOT, 'public', 'play.html');
const MAX_BYTES = 400 * 1024;

function fail(msg) {
  console.error(`[build-standalone] ${msg}`);
  process.exit(1);
}

const files = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .sort();

if (!files.includes('index.ts')) fail('components/hippo-run/index.ts not found');

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2019,
  isolatedModules: true,
  removeComments: true,
  esModuleInterop: false,
  importHelpers: false,
  sourceMap: false,
};

/**
 * Strip leading indentation (TS emits 4-space indents: ~30% of the bytes). Only when the module
 * has no template literal and no backslash line-continuation, the only places where leading
 * whitespace can be string content. (Fallback for squeeze().)
 */
function compact(code) {
  if (code.includes('`') || /\\\r?\n/.test(code)) return code;
  return code.replace(/^[ \t]+/gm, '');
}

/**
 * Token-level whitespace removal (~11% smaller than compact()). Re-emits the module's tokens as
 * the TypeScript parser sees them (strings, template parts and regexes stay byte-identical):
 * a gap that held a line break becomes one '\n' (so ASI / restricted productions are unchanged),
 * any other gap disappears unless the two neighbours would otherwise fuse (`a in b`, `a - -b`,
 * `1 .x`, `/ /re/`, `<!`, `-->`). Self-checking: the result is re-parsed and must yield exactly
 * the same token sequence (kind + text); otherwise the module falls back to compact().
 */
function leafTokens(code, file) {
  const sf = ts.createSourceFile(file.replace(/\.ts$/, '.js'), code, ts.ScriptTarget.ES2019, true, ts.ScriptKind.JS);
  const out = [];
  const walk = (node) => {
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.end > node.getStart(sf)) out.push({ kind: node.kind, start: node.getStart(sf), end: node.end, text: node.getText(sf) });
      return;
    }
    for (const k of kids) walk(k);
  };
  walk(sf);
  return { toks: out, diags: sf.parseDiagnostics ? sf.parseDiagnostics.length : 0 };
}

const ID_CHAR = /[A-Za-z0-9_$\\\u0080-\uffff]/;
function needsSpace(a, b) {
  const x = a[a.length - 1];
  const y = b[0];
  if (ID_CHAR.test(x) && ID_CHAR.test(y)) return true;
  if (y === '.' && /^[0-9]/.test(a)) return true;
  if ((x === '+' || x === '-') && y === x) return true;
  if (x === '/' && (y === '/' || y === '*')) return true;
  if (x === '<' && y === '!') return true;
  if (x === '-' && y === '>') return true;
  return false;
}

function squeeze(code, file) {
  const src = leafTokens(code, file);
  if (src.diags) return compact(code);
  let out = '';
  let prevEnd = 0;
  let prev = '';
  for (const t of src.toks) {
    const gap = code.slice(prevEnd, t.start);
    if (out) {
      if (/[\n\r\u2028\u2029]/.test(gap)) out += '\n';
      else if (gap && needsSpace(prev, t.text)) out += ' ';
    }
    out += t.text;
    prevEnd = t.end;
    prev = t.text;
  }
  const back = leafTokens(out, file);
  const same = !back.diags && back.toks.length === src.toks.length && back.toks.every((t, i) => t.kind === src.toks[i].kind && t.text === src.toks[i].text);
  if (!same) {
    console.warn(`[build-standalone] ${file}: token check failed after whitespace removal; using indentation strip only`);
    return compact(code);
  }
  return out;
}

const modules = files.map((file) => {
  const source = readFileSync(join(SRC_DIR, file), 'utf8');
  const result = ts.transpileModule(source, { compilerOptions, fileName: file, reportDiagnostics: true });
  const diags = result.diagnostics || [];
  if (diags.length) {
    const text = diags.map((d) => `${file}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`).join('\n');
    fail(`transpile errors:\n${text}`);
  }
  const js = result.outputText.replace(/\/\/# sourceMappingURL=.*$/gm, '').trim();
  return { name: file.slice(0, -3), code: squeeze(js, file) };
});

const defs = modules
  .map((m) => `${JSON.stringify(m.name)}: function (module, exports, require) {\n${m.code}\n}`)
  .join(',\n');

// ~25-line module registry + boot.
const bundle = `(function () {
'use strict';
var defs = {
${defs}
};
var cache = {};
function normalize(id) {
  var s = String(id);
  if (s.indexOf('./') === 0) s = s.slice(2);
  if (s.slice(-3) === '.ts') s = s.slice(0, -3);
  return s;
}
function require(id) {
  var name = normalize(id);
  var cached = cache[name];
  if (cached) return cached.exports;
  var def = defs[name];
  if (!def) throw new Error('hippo-run: unknown module "' + id + '"');
  var module = { exports: {} };
  cache[name] = module;
  def.call(module.exports, module, module.exports, require);
  return module.exports;
}
require('index').createGame(document.getElementById('game'), { standalone: true });
})();`;

// Keep the inline script from closing early or opening an HTML comment.
const safeBundle = bundle.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const html = `<!doctype html>
<!-- Generated by scripts/build-standalone.mjs from components/hippo-run/*.ts. Do not edit by hand. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#0B0B1E">
<meta name="description" content="Hippo Tototo: Stomp the Beat. A one-button rhythm runner starring Toto the heavy little hippo.">
<title>Hippo Tototo — Stomp the Beat</title>
<style>
html,body{margin:0;height:100%;background:#0B0B1E;overflow:hidden}
body{overscroll-behavior:none;-webkit-tap-highlight-color:transparent}
canvas{width:100vw;height:100vh;height:100dvh;display:block;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;outline:none}
</style>
</head>
<body>
<canvas id="game" aria-label="Hippo Tototo: Stomp the Beat. Press Space or tap to play."></canvas>
<script>
${safeBundle}
</script>
</body>
</html>
`;

// Acceptance checks (spec §15).
const forbidden = [/https?:\/\//i, /<link[\s>]/i, /<img[\s>]/i, /<script[^>]*\ssrc\s*=/i];
for (const re of forbidden) {
  const m = html.match(re);
  if (m) {
    const at = html.indexOf(m[0]);
    fail(`forbidden pattern ${re} in output near: ${JSON.stringify(html.slice(Math.max(0, at - 60), at + 60))}`);
  }
}
const bytes = Buffer.byteLength(html, 'utf8');
if (bytes > MAX_BYTES) fail(`${OUT_FILE} is ${bytes} bytes (> ${MAX_BYTES})`);

writeFileSync(OUT_FILE, html);
console.log(
  `[build-standalone] wrote ${OUT_FILE.replace(ROOT + "/", "")} (${(bytes / 1024).toFixed(1)} KB, ${modules.length} modules: ${modules
    .map((m) => m.name)
    .join(', ')})`,
);
