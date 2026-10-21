// Capture headless du jeu local (npm run dev doit tourner) pour vérifier visuellement une modif.
//   node scripts/shot.mjs [sortie.png] ['[[x,z,yaw,pitch],...]']
// Navigateur : `npx playwright install chromium` une fois.
import { chromium } from 'playwright-core';

const out = process.argv[2] || '.devshots/local.png';
const views = JSON.parse(process.argv[3] || '[]');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.error('PAGEERR', e.message));
await p.goto('http://localhost:5173/');
await p.fill('#name', 'Bot');
await p.waitForTimeout(3000); // connexion au serveur
await p.click('#create');
await p.waitForTimeout(5000);
await p.screenshot({ path: out, timeout: 120000 });
let i = 1;
for (const [x, z, yaw, pitch] of views) {
  await p.evaluate(([x, z, yaw, pitch]) => Object.assign(window.__player.pos, { x, z }) && Object.assign(window.__player, { yaw, pitch: pitch || 0 }), [x, z, yaw, pitch]);
  await p.waitForTimeout(600);
  await p.screenshot({ path: out.replace(/\.png$/, `-${i++}.png`) });
}
await b.close();
console.log('ok', out);
