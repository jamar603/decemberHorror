// Écrit dist/version.json : le client compare son shell / son monde avec ce fichier.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
let v = process.env.GITHUB_SHA;
if (!v) { try { v = execSync('git rev-parse HEAD').toString().trim(); } catch { v = String(Date.now()); } }
const version = { v: v.slice(0, 12), shell: '/' + manifest['index.html'].file, world: '/' + manifest['src/client/world/world.ts'].file };
writeFileSync('dist/version.json', JSON.stringify(version));
rmSync('dist/.vite', { recursive: true, force: true });
console.log('version', version);
