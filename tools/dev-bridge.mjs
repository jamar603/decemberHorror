#!/usr/bin/env node
// Bridge local : relie le jeu (mode dev) à Claude Code sur CETTE machine (Windows, macOS, Linux ; pas de tmux).
//
//   npm run bridge                     (config dans .dev-bridge.json, voir README)
//
// - chaque prompt envoyé depuis le jeu (F9) est mis en file (.dev-bridge-queue.json, survit aux redémarrages)
// - UNE tâche à la fois : `claude -p` en mode headless avec une config prédéfinie (CLAUDE_ARGS ci-dessous)
// - tableau partagé : le serveur renvoie les tâches de TOUS les bridges ; on l'écrit dans .devshots/board.md
//   et chaque Claude le lit avant de coder (et pendant) pour voir ce que font les autres devs
// - la capture est sauvée dans .devshots/ (gitignoré) et son chemin ajouté au prompt
import WebSocket from 'ws';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfgFile = join(REPO, '.dev-bridge.json');
const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
const SERVER = process.env.DECEMBER_SERVER || cfg.server || 'wss://december.147-93-90-144.sslip.io/ws';
const TOKEN = process.env.DECEMBER_DEV_TOKEN || cfg.token;
const HOST = cfg.host || `${userInfo().username}@${hostname()}`;
const QUEUE_FILE = join(REPO, '.dev-bridge-queue.json');
const SHOTS = join(REPO, '.devshots');
const BOARD = join(SHOTS, 'board.md');
const KEEP_DONE = 20; // historique des tâches terminées
const TIMEOUT_MS = (Number(cfg.timeoutMin) || 30) * 60_000;

// Config Claude prédéfinie (surchargeable dans .dev-bridge.json : model, effort, claudeArgs) :
// - headless (-p), sortie JSON (résultat + erreur), pas de session sauvegardée
// - permissions contournées : la tâche doit pouvoir tester, commit et push sans personne devant
// - seuls les réglages du projet (CLAUDE.md, .claude/) : pas de plugins, hooks ni MCP perso => moins de tokens, même comportement chez tous les devs
const CLAUDE_ARGS = cfg.claudeArgs || [
  '-p', '--output-format', 'json', '--no-session-persistence',
  '--model', cfg.model || 'opus', '--effort', cfg.effort || 'medium',
  '--permission-mode', 'bypassPermissions',
  '--setting-sources', 'project,local', '--strict-mcp-config',
];

if (!TOKEN) {
  console.error('Token dev manquant : crée .dev-bridge.json {"token":"..."} ou exporte DECEMBER_DEV_TOKEN');
  process.exit(1);
}

function buildPrompt(t) {
  return `[Demande envoyée depuis le jeu (mode dev) par ${t.from}]\n${t.prompt}\n\n` +
    `Capture d'écran du jeu au moment de la demande : ${t.shot} (lis-la avec l'outil Read).\n` +
    `AVANT de coder, lis .devshots/board.md : ce que font les autres devs/Claude en ce moment et ce qu'ils viennent de finir. ` +
    `Évite de toucher aux mêmes fichiers qu'une tâche en cours ; relis-le avant de pousser.\n` +
    `Applique la modification, vérifie en local (npm run typecheck && npm run build), puis git pull --rebase origin main, commit et push sur main pour déployer (voir CLAUDE.md). ` +
    `Pas de branche. Ne pousse que tes propres modifications.\n` +
    `Termine par UNE phrase courte résumant ce que tu as changé (elle s'affiche dans le tableau des tâches de tous les devs).`;
}

// --- File de tâches ---
// tâche : { id, from, prompt, shot, state, msg, at, started, ended }
let tasks = [];
try { tasks = JSON.parse(readFileSync(QUEUE_FILE, 'utf8')); } catch {}
// bridge coupé pendant une tâche : elle repart en tête de file
for (const t of tasks) if (t.state === 'running') Object.assign(t, { state: 'pending', started: undefined });
let current = null; // { t, proc }
let lastSent = '';
let ws;

const publicTasks = () => tasks.map(({ id, from, prompt, state, msg, at, started, ended }) => ({ id, from, prompt: prompt.slice(0, 600), state, msg, at, started, ended }));
function changed() {
  const done = tasks.filter((t) => t.state === 'done' || t.state === 'failed').sort((a, b) => (b.ended || 0) - (a.ended || 0));
  const drop = new Set(done.slice(KEEP_DONE));
  if (drop.size) tasks = tasks.filter((t) => !drop.has(t));
  try { writeFileSync(QUEUE_FILE, JSON.stringify(tasks)); } catch (e) { console.error('file de tâches non sauvée :', e.message); }
  const cur = JSON.stringify(publicTasks());
  if (cur !== lastSent && ws?.readyState === WebSocket.OPEN) { lastSent = cur; ws.send(JSON.stringify({ t: 'tasks', tasks: JSON.parse(cur) })); }
}
const short = (s) => s.replace(/\s+/g, ' ').slice(0, 60);

function finish(t, ok, msg) {
  t.state = ok ? 'done' : 'failed';
  t.msg = String(msg || '').replace(/\s+/g, ' ').trim().slice(-300);
  t.ended = Date.now();
  current = null;
  console.log(ok ? '✓' : '✗', `[${t.id}] ${short(t.prompt)} — ${t.msg}`);
  changed();
  pump();
}

function pump() {
  if (current) return;
  const t = tasks.find((x) => x.state === 'pending');
  if (!t) return;
  t.state = 'running';
  t.started = Date.now();
  t.msg = '';
  console.log(`▶ [${t.id}] ${t.from} : ${short(t.prompt)}`);
  // prompt par stdin : pas de souci de guillemets/longueur sous Windows ; shell => trouve claude.cmd / claude.exe
  const proc = spawn('claude', CLAUDE_ARGS, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  current = { t, proc };
  let out = '', err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => { err = `délai dépassé (${TIMEOUT_MS / 60_000} min)`; proc.kill(); }, TIMEOUT_MS);
  proc.on('error', (e) => { clearTimeout(timer); if (current?.t === t) finish(t, false, `claude introuvable : ${e.message}`); });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (current?.t !== t) return;
    let r = null;
    try { r = JSON.parse(out); } catch {}
    if (r && !r.is_error && code === 0) finish(t, true, r.result || 'terminée');
    else finish(t, false, r?.result || err.trim().split('\n').pop() || `claude code ${code}`);
  });
  proc.stdin.end(buildPrompt(t));
  changed();
}

function enqueue(m) {
  mkdirSync(SHOTS, { recursive: true });
  const ext = m.image.slice(11, m.image.indexOf(';')).replace('jpeg', 'jpg');
  const id = randomBytes(4).toString('hex');
  const shot = `.devshots/${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.${ext}`;
  writeFileSync(join(REPO, shot), Buffer.from(m.image.split(',')[1], 'base64'));
  tasks.push({ id, from: m.from, prompt: m.prompt, shot, state: 'pending', at: Date.now() });
  const pos = tasks.filter((t) => t.state === 'pending').length - (current ? 0 : 1);
  reply(m.reqId, true, pos > 0 ? `Ajouté à la file (${pos} avant) · F10 pour voir` : 'Claude démarre · F10 pour voir');
  changed();
  pump();
}

function applyOp(m) {
  if (m.op === 'clear') tasks = tasks.filter((x) => x.state === 'pending' || x.state === 'running');
  else if (m.op === 'delete') tasks = tasks.filter((x) => x.id !== m.id || x.state === 'running');
  else return;
  console.log(`~ ${m.from} : ${m.op} ${m.id ?? ''}`);
  changed();
}

// Tableau de tous les devs, lu par Claude (fichier local, réécrit à chaque changement)
function writeBoard(bridges) {
  const fmt = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const lines = ['# Tableau des tâches (tous les devs) — mis à jour en direct par le bridge', ''];
  for (const s of [['running', 'En cours'], ['pending', 'En attente'], ['done', 'Terminées récemment'], ['failed', 'Échouées récemment']]) {
    const list = bridges.flatMap((b) => b.tasks.filter((t) => t.state === s[0]).map((t) => ({ ...t, dev: b.dev })))
      .sort((a, b) => (b.ended || b.started || b.at) - (a.ended || a.started || a.at)).slice(0, 15);
    lines.push(`## ${s[1]}`, ...(list.length ? list.map((t) => `- [${t.dev}] ${fmt(t.ended || t.started || t.at)} — ${t.prompt.replace(/\s+/g, ' ').slice(0, 200)}${t.msg ? `\n  → ${t.msg}` : ''}`) : ['- (rien)']), '');
  }
  try { mkdirSync(SHOTS, { recursive: true }); writeFileSync(BOARD, lines.join('\n')); } catch {}
}

const reply = (reqId, ok, msg) => { console.log(ok ? '✓' : '✗', msg); ws?.send(JSON.stringify({ t: 'delivered', reqId, ok, msg })); };

function connect() {
  ws = new WebSocket(`${SERVER}?bridge=1`);
  // le serveur ping toutes les ~30 s : sans ping depuis 90 s, la connexion est morte (veille, réseau)
  let watchdog;
  const heartbeat = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ws.terminate(), 90_000); };
  ws.on('ping', heartbeat);
  ws.on('open', () => {
    heartbeat();
    ws.send(JSON.stringify({ t: 'bridgeHello', token: TOKEN, host: HOST, allow: Array.isArray(cfg.allow) ? cfg.allow.map(String) : [] }));
    console.log(`Bridge connecté à ${SERVER} — repo ${REPO}`);
    console.log(`  claude ${CLAUDE_ARGS.join(' ')}`);
    const n = tasks.filter((t) => t.state === 'pending').length;
    if (n) console.log(`  ${n} tâche(s) en file reprise(s)`);
    lastSent = '';
    changed();
    pump();
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'prompt') { console.log(`→ prompt de ${m.from} : ${short(m.prompt)}`); enqueue(m); }
    else if (m.t === 'taskOp') applyOp(m);
    else if (m.t === 'board') writeBoard(m.bridges);
  });
  ws.on('close', (code, reason) => {
    clearTimeout(watchdog);
    if (code === 4001) { console.error('Token refusé par le serveur.'); process.exit(1); }
    console.log(`déconnecté (${code} ${reason}), reconnexion…`);
    setTimeout(connect, 2000);
  });
  ws.on('error', (e) => console.error('ws:', e.message));
}
connect();
