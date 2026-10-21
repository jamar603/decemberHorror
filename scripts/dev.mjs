// Dev local : serveur (tsx watch) + Vite (HMR). Ouvre http://localhost:5173/?dev=dev
import { spawn } from 'node:child_process';

const env = { ...process.env, NODE_ENV: 'development', DEV_TOKENS: process.env.DEV_TOKENS || 'local:dev', DEPLOY_TOKEN: 'local' };
const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
const procs = [run('npx', ['tsx', 'watch', 'server/index.ts']), run('npx', ['vite'])];
const stop = () => { procs.forEach((p) => p.kill()); process.exit(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
