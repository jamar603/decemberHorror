// Dev local : serveur (tsx watch) + Vite (HMR). Ouvre http://localhost:5173/?dev=dev
import { spawn } from 'node:child_process';

const env = { ...process.env, NODE_ENV: 'development', DEV_TOKENS: process.env.DEV_TOKENS || 'local:dev', DEPLOY_TOKEN: 'local' };
const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
// uWebSockets.js v20.51 (le seul compatible glibc du VPS) : Node 18/20/22/23 seulement => sinon serveur lancé sous Node 22 via npx
const ok = [18, 20, 22, 23].includes(Number(process.versions.node.split('.')[0]));
const server = ok ? run('npx', ['tsx', 'watch', 'server/index.ts']) : run('npx', ['-y', 'node@22', 'node_modules/tsx/dist/cli.mjs', 'watch', 'server/index.ts']);
const procs = [server, run('npx', ['vite'])];
const stop = () => { procs.forEach((p) => p.kill()); process.exit(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
