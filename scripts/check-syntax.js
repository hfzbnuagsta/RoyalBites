// Memeriksa sintaks semua file JavaScript proyek (backend, script, test, frontend):  npm run check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/config/env.js';

const FOLDERS = ['src', 'scripts', 'test', 'public'];
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}
FOLDERS.forEach((folder) => walk(path.join(PROJECT_ROOT, folder)));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`GAGAL  ${path.relative(PROJECT_ROOT, file)}\n${result.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} file JavaScript lolos pemeriksaan sintaks.`);
process.exitCode = failed > 0 ? 1 : 0;
