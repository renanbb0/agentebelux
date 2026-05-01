/**
 * Roda todos os tests/*.test.js sequencialmente.
 * Falha (exit 1) se qualquer um falhar.
 *
 * Filtragem opcional via tests/_categories.md (categoria "skip"):
 *   - Tests marcados como `skip` no _categories.md são pulados.
 *   - Sem _categories.md, todos rodam.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const CATEGORIES_FILE = path.join(TESTS_DIR, '_categories.md');

function loadSkipList() {
  if (!fs.existsSync(CATEGORIES_FILE)) return new Set();
  const lines = fs.readFileSync(CATEGORIES_FILE, 'utf8').split(/\r?\n/);
  const skipped = new Set();
  for (const line of lines) {
    // Formato esperado: "- foo.test.js — skip — motivo"
    const match = line.match(/^-\s+([\w-]+\.test\.js)\s+—\s+skip\b/);
    if (match) skipped.add(match[1]);
  }
  return skipped;
}

function collectTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

const skipList = loadSkipList();
const files = collectTestFiles(TESTS_DIR)
  .map((p) => path.relative(TESTS_DIR, p))
  .sort();

const results = [];
for (const relFile of files) {
  const file = relFile.replace(/\\/g, '/');
  const baseName = path.basename(file);
  if (skipList.has(file) || skipList.has(baseName)) {
    process.stdout.write(`⏭  ${file} (skip via _categories.md)\n`);
    results.push({ file, status: 'skipped' });
    continue;
  }

  const fullPath = path.join(TESTS_DIR, relFile);
  process.stdout.write(`\n▶ ${file}\n`);
  const startedAt = Date.now();
  const res = spawnSync('node', [fullPath], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  const elapsed = Date.now() - startedAt;
  if (res.status === 0) {
    process.stdout.write(`✓ ${file} (${elapsed}ms)\n`);
    results.push({ file, status: 'pass', ms: elapsed });
  } else {
    process.stdout.write(`✗ ${file} (exit=${res.status}, ${elapsed}ms)\n`);
    results.push({ file, status: 'fail', exit: res.status, ms: elapsed });
  }
}

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
const skip = results.filter((r) => r.status === 'skipped').length;

process.stdout.write(`\n────────────────────────────────────\n`);
process.stdout.write(`${pass} passaram, ${fail} falharam, ${skip} pulados\n`);

if (fail > 0) {
  process.stdout.write(`\nFalhas:\n`);
  for (const r of results.filter((r) => r.status === 'fail')) {
    process.stdout.write(`  - ${r.file} (exit=${r.exit})\n`);
  }
}

process.exit(fail === 0 ? 0 : 1);
