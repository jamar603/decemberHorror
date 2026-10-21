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
import { spawn, execFileSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfgFile = join(REPO, '.dev-bridge.json');
const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
const SERVER = process.env.DECEMBER_SERVER || cfg.server || 'wss://december.147-93-90-144.sslip.io/ws';
const TOKEN = process.env.DECEMBER_DEV_TOKEN || cfg.token;
// Clé privée de CE bridge : le token dev est commun à tous, seule cette clé donne accès à ton Claude
let KEY = process.env.DECEMBER_BRIDGE_KEY || cfg.key;
if (!KEY) { KEY = randomBytes(16).toString('hex'); try { writeFileSync(cfgFile, JSON.stringify({ ...cfg, key: KEY }, null, 2) + '\n'); } catch {} }
const HOST = cfg.host || `${userInfo().username}@${hostname()}`;
const QUEUE_FILE = join(REPO, '.dev-bridge-queue.json');
const SHOTS = join(REPO, '.devshots');
const BOARD = join(SHOTS, 'board.md');
const KEEP_DONE = 20; // historique des tâches terminées
const SESSION_FILE = join(REPO, '.dev-bridge-session.json');
const MAX_CTX = Number(cfg.maxContextTokens) || 150_000; // au-delà, nouvelle conversation automatique
const TIMEOUT_MS = (Number(cfg.timeoutMin) || 30) * 60_000;

// Config Claude prédéfinie (surchargeable dans .dev-bridge.json : model, effort, claudeArgs) :
// - headless (-p), sortie stream-json (événements + résultat), conversation reprise d'une tâche à l'autre (--resume)
// - permissions contournées : la tâche doit pouvoir tester, commit et push sans personne devant
// - seuls les réglages du projet (CLAUDE.md, .claude/) : pas de plugins, hooks ni MCP perso => moins de tokens, même comportement chez tous les devs
const CLAUDE_ARGS = cfg.claudeArgs || [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--model', cfg.model || 'opus', '--effort', cfg.effort || 'medium',
  '--permission-mode', 'bypassPermissions',
  '--setting-sources', 'project,local', '--strict-mcp-config',
];

if (!TOKEN) {
  console.error('Token dev manquant : crée .dev-bridge.json {"token":"..."} ou exporte DECEMBER_DEV_TOKEN');
  process.exit(1);
}

function buildPrompt(t, resumed) {
  return `[Demande envoyée depuis le jeu (mode dev) par ${t.from}]\n${t.prompt}\n\n` +
    (resumed ? `Cette conversation continue : tu as le contexte des demandes précédentes, mais le code a pu changer (relis avant de modifier).\n` : '') +
    `Capture d'écran du jeu au moment de la demande : ${t.shot} (lis-la avec l'outil Read).\n` +
    `AVANT de coder, lis .devshots/board.md : ce que font les autres devs/Claude en ce moment et ce qu'ils viennent de finir. ` +
    `Évite de toucher aux mêmes fichiers qu'une tâche en cours ; relis-le avant de pousser.\n` +
    `PLAN (obligatoire) : AVANT de coder, écris ton plan dans ${t.todoFile} au format {"items":[{"id":"1","text":"étape courte","status":"todo"}]} ` +
    `(3 à 8 étapes, la dernière = vérification + push). Si ce fichier existe déjà, il contient des étapes ajoutées par le dev : garde-les et complète. ` +
    `Passe chaque étape à "doing" puis "done" au fur et à mesure (Edit sur ce fichier). Relis ce fichier avant chaque nouvelle étape : le dev peut y ajouter des étapes (fais-les) ou en retirer (ne les recrée pas). ` +
    `Si l'écriture échoue parce que le fichier a changé, relis-le et réessaie.\n` +
    `Applique la modification, vérifie en local (npm run typecheck && npm run build), puis git pull --rebase origin main, commit et push sur main pour déployer (voir CLAUDE.md). ` +
    `Pas de branche. Ne pousse que tes propres modifications.\n` +
    `Termine par UNE phrase courte résumant ce que tu as changé (elle s'affiche dans le tableau des tâches de tous les devs).`;
}

// --- Conversation Claude (reprise d'une tâche à l'autre) ---
let session = { id: '', ctx: 0, turns: 0 };
try { session = { ...session, ...JSON.parse(readFileSync(SESSION_FILE, 'utf8')) }; } catch {}
const saveSession = () => { try { writeFileSync(SESSION_FILE, JSON.stringify(session)); } catch {} };
const publicSession = () => ({ ctx: session.ctx, max: MAX_CTX, turns: session.turns, active: !!session.id });
function resetSession(why) {
  if (current) current.t.noSave = true; // la tâche en cours ne doit pas ressusciter l'ancienne conversation
  if (!session.id && !session.ctx) return;
  session = { id: '', ctx: 0, turns: 0 };
  saveSession();
  console.log(`↺ nouvelle conversation (${why})`);
  changed();
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

const publicTasks = () => tasks.map(({ id, from, prompt, state, msg, at, started, ended, phase, activity, steps, files, commit, cost, todos }) => ({ id, from, prompt: prompt.slice(0, 600), state, msg, at, started, ended, phase, activity, steps, files, commit, cost, todos: todos?.filter((x) => !x.removed).map(({ id, text, status, by }) => ({ id, text, status, by })) }));
// les événements Claude arrivent en rafale : on regroupe les envois
let touchTimer;
const touch = () => { if (!touchTimer) touchTimer = setTimeout(() => { touchTimer = null; changed(); }, 400); };
function changed() {
  const done = tasks.filter((t) => t.state === 'done' || t.state === 'failed').sort((a, b) => (b.ended || 0) - (a.ended || 0));
  const drop = new Set(done.slice(KEEP_DONE));
  if (drop.size) tasks = tasks.filter((t) => !drop.has(t));
  try { writeFileSync(QUEUE_FILE, JSON.stringify(tasks)); } catch (e) { console.error('file de tâches non sauvée :', e.message); }
  const cur = JSON.stringify({ tasks: publicTasks(), session: publicSession() });
  if (cur !== lastSent && ws?.readyState === WebSocket.OPEN) { lastSent = cur; ws.send(JSON.stringify({ t: 'tasks', ...JSON.parse(cur) })); }
}
const short = (s) => s.replace(/\s+/g, ' ').slice(0, 60);

function finish(t, ok, msg) {
  t.state = ok ? 'done' : 'failed';
  t.msg = String(msg || '').replace(/\s+/g, ' ').trim().slice(-300);
  t.ended = Date.now();
  t.activity = undefined;
  current = null;
  console.log(ok ? '✓' : '✗', `[${t.id}] ${short(t.prompt)} — ${t.msg}`);
  changed();
  pump();
}

function pump() {
  if (current) return;
  const t = tasks.find((x) => x.state === 'pending');
  if (!t) return;
  if (t.fresh) resetSession('demandée avec la tâche');
  else if (session.ctx >= MAX_CTX) resetSession(`contexte ${Math.round(session.ctx / 1000)}k tokens ≥ limite`);
  t.state = 'running';
  t.started = Date.now();
  t.msg = '';
  t.todoFile ||= `.devshots/todo-${t.id}.json`; // tâches en file créées avant l'ajout du plan
  if (t.todos?.length) writeTodoFile(t);
  t.steps = []; t.files = []; t.phase = undefined; t.activity = 'Démarrage…'; t.commit = undefined; t.cost = undefined;
  console.log(`▶ [${t.id}] ${t.from} : ${short(t.prompt)}`);
  run(t, !!session.id && !cfg.claudeArgs);
  changed();
}

// chemin relatif au repo (ce qui s'affiche dans le journal)
const rel = (p) => { const s = String(p || ''); return (isAbsolute(s) ? relative(REPO, s) : s).replace(/\\/g, '/'); };

// action Claude -> étape lisible du journal
function describeTool(name, input = {}) {
  const f = rel(input.file_path || input.notebook_path || input.path);
  switch (name) {
    case 'Read': return { kind: 'read', phase: 'read', text: `Lit ${f}` };
    case 'Glob': return { kind: 'read', phase: 'read', text: `Cherche des fichiers ${input.pattern || ''}` };
    case 'Grep': return { kind: 'read', phase: 'read', text: `Cherche « ${String(input.pattern || '').slice(0, 50)} »` };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { kind: 'edit', phase: 'edit', text: `Modifie ${f}`, file: f };
    case 'Write': return { kind: 'edit', phase: 'edit', text: `Écrit ${f}`, file: f };
    case 'Bash': {
      const c = String(input.command || '').replace(/\s+/g, ' ').trim();
      if (/git\s+push/.test(c)) return { kind: 'git', phase: 'push', text: 'git push (déploiement)' };
      if (/git\s+commit/.test(c)) return { kind: 'git', phase: 'push', text: 'git commit' };
      if (/git\s+(pull|fetch|rebase)/.test(c)) return { kind: 'git', phase: 'push', text: `git ${c.match(/git\s+(\w+)/)[1]}` };
      if (/typecheck|npm run build|tsc|vitest|jest|npm (run )?test/.test(c)) return { kind: 'check', phase: 'check', text: `Vérifie : ${c.slice(0, 70)}` };
      if (/shot\.mjs|npm run dev/.test(c)) return { kind: 'check', phase: 'check', text: `Teste en local : ${c.slice(0, 70)}` };
      return { kind: 'run', text: `Commande : ${c.slice(0, 80)}` };
    }
    default: return null;
  }
}

// --- Plan (todo) de la tâche : fichier .devshots/todo-<id>.json écrit par Claude, fusionné ici avec les ajouts/retraits du dev ---
function readTodoFile(t) {
  let d;
  try { d = JSON.parse(readFileSync(join(REPO, t.todoFile), 'utf8')); } catch { return; }
  t.todos ||= [];
  let ch = false;
  for (const it of (Array.isArray(d?.items) ? d.items : []).slice(0, 40)) {
    const id = String(it?.id ?? '').slice(0, 20), text = String(it?.text ?? '').slice(0, 160);
    const status = ['todo', 'doing', 'done'].includes(it?.status) ? it.status : 'todo';
    if (!id || !text) continue;
    const cur = t.todos.find((x) => x.id === id);
    if (!cur) { t.todos.push({ id, text, status, by: 'claude' }); ch = true; }
    else if (!cur.removed && cur.status !== status) { cur.status = status; ch = true; }
  }
  if (ch) touch();
}
function writeTodoFile(t) {
  try {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(REPO, t.todoFile), JSON.stringify({ items: (t.todos || []).filter((x) => !x.removed).map(({ id, text, status, by }) => ({ id, text, status, by })) }, null, 2));
  } catch {}
}
function todoOp(m) {
  const t = tasks.find((x) => x.id === m.task);
  if (!t || (t.state !== 'pending' && t.state !== 'running')) return;
  t.todos ||= [];
  if (m.op === 'add') {
    const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!text || t.todos.filter((x) => !x.removed).length >= 40) return;
    t.todos.push({ id: `u${randomBytes(3).toString('hex')}`, text, status: 'todo', by: m.from });
  } else if (m.op === 'remove') {
    const it = t.todos.find((x) => x.id === m.id);
    if (!it || it.status !== 'todo') return; // ni en cours ni terminée
    it.removed = true;
  } else return;
  console.log(`~ ${m.from} : plan ${m.op} sur [${t.id}]`);
  writeTodoFile(t);
  changed();
}

// événement stream-json : journal d'activité, résultat final et taille réelle du contexte (usage du dernier message)
function onEvent(t, st, ev) {
  if (ev.type === 'assistant' && ev.message) {
    const u = ev.message.usage;
    if (u) st.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    for (const c of ev.message.content || []) {
      let step = null;
      if (c.type === 'tool_use') step = describeTool(c.name, c.input);
      else if (c.type === 'text' && c.text?.trim()) step = { kind: 'note', text: c.text.replace(/\s+/g, ' ').trim().slice(0, 140) };
      if (!step) continue;
      (t.steps ||= []).push({ at: Date.now(), kind: step.kind, text: step.text });
      if (t.steps.length > 80) t.steps.shift();
      if (step.phase) t.phase = step.phase;
      if (step.file && !(t.files ||= []).includes(step.file)) t.files.push(step.file);
      if (step.kind !== 'note') t.activity = step.text;
      touch();
    }
  } else if (ev.type === 'result') st.result = ev;
}

function run(t, resume) {
  const args = resume ? [...CLAUDE_ARGS, '--resume', session.id] : CLAUDE_ARGS;
  // prompt par stdin : pas de souci de guillemets/longueur sous Windows ; shell => trouve claude.cmd / claude.exe
  const proc = spawn('claude', args, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  current = { t, proc };
  let out = '', err = '', buf = '';
  const st = { result: null, ctx: 0 };
  proc.stdout.on('data', (d) => {
    out += d; buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { onEvent(t, st, JSON.parse(line)); } catch {}
    }
  });
  proc.stderr.on('data', (d) => (err += d));
  const poll = setInterval(() => readTodoFile(t), 1000);
  const timer = setTimeout(() => { err = `délai dépassé (${TIMEOUT_MS / 60_000} min)`; proc.kill(); }, TIMEOUT_MS);
  proc.on('error', (e) => { clearTimeout(timer); clearInterval(poll); if (current?.t === t) finish(t, false, `claude introuvable : ${e.message}`); });
  proc.on('close', (code) => {
    clearTimeout(timer); clearInterval(poll);
    readTodoFile(t);
    if (current?.t !== t) return;
    if (t.cancelled) return finish(t, false, `Annulée par ${t.cancelled}`);
    let r = st.result;
    if (!r) try { r = JSON.parse(out); } catch {} // claudeArgs perso en sortie json simple
    const ok = r && !r.is_error && code === 0;
    if (ok) {
      if (r.session_id && !cfg.claudeArgs && !t.noSave) { session = { id: r.session_id, ctx: st.ctx || session.ctx, turns: session.turns + 1 }; saveSession(); }
      t.cost = typeof r.total_cost_usd === 'number' ? Math.round(r.total_cost_usd * 100) / 100 : undefined;
      if (t.files.length || t.phase === 'push') try { t.commit = execFileSync('git', ['log', '-1', '--format=%h %s'], { cwd: REPO, encoding: 'utf8' }).trim().slice(0, 200); } catch {}
      return finish(t, true, r.result || 'terminée');
    }
    // conversation reprise introuvable/corrompue : on repart de zéro, une seule fois
    if (resume && !t.retried && (!r || /no conversation|session/i.test(`${r.result || ''}${err}`))) {
      t.retried = true;
      resetSession('conversation introuvable');
      t.noSave = false;
      console.log(`↻ [${t.id}] relance sans reprise`);
      return run(t, false);
    }
    finish(t, false, r?.result || err.trim().split('\n').pop() || `claude code ${code}`);
  });
  proc.stdin.end(buildPrompt(t, resume));
}

function enqueue(m) {
  mkdirSync(SHOTS, { recursive: true });
  const ext = m.image.slice(11, m.image.indexOf(';')).replace('jpeg', 'jpg');
  const id = randomBytes(4).toString('hex');
  const shot = `.devshots/${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.${ext}`;
  writeFileSync(join(REPO, shot), Buffer.from(m.image.split(',')[1], 'base64'));
  tasks.push({ id, todoFile: `.devshots/todo-${id}.json`, from: m.from, prompt: m.prompt, shot, state: 'pending', at: Date.now(), fresh: !!m.fresh });
  const pos = tasks.filter((t) => t.state === 'pending').length - (current ? 0 : 1);
  reply(m.reqId, true, pos > 0 ? `Ajouté à la file (${pos} avant) · F10 pour voir` : 'Claude démarre · F10 pour voir');
  changed();
  pump();
}

function applyOp(m) {
  if (m.op === 'clear') tasks = tasks.filter((x) => x.state === 'pending' || x.state === 'running');
  else if (m.op === 'delete') tasks = tasks.filter((x) => x.id !== m.id || x.state === 'running');
  else if (m.op === 'reset') resetSession(`demandée par ${m.from}`);
  else if (m.op === 'cancel') {
    if (current?.t.id === m.id) { current.t.cancelled = m.from; current.proc.kill(); return console.log(`~ ${m.from} : annule [${m.id}]`); }
    tasks = tasks.filter((x) => x.id !== m.id || x.state !== 'pending');
  } else if (m.op === 'retry') {
    const o = tasks.find((x) => x.id === m.id && (x.state === 'done' || x.state === 'failed'));
    if (!o) return;
    const id = randomBytes(4).toString('hex');
    tasks.push({ id, todoFile: `.devshots/todo-${id}.json`, from: m.from, prompt: o.prompt, shot: o.shot, state: 'pending', at: Date.now() });
    changed();
    return pump();
  }
  else return;
  console.log(`~ ${m.from} : ${m.op} ${m.id ?? ''}`);
  changed();
}

// Tableau de tous les devs, lu par Claude (fichier local, réécrit à chaque changement)
function writeBoard(bridges) {
  const fmt = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const lines = ['# Tableau des tâches (tous les devs) — mis à jour en direct par le bridge', ''];
  for (const s of [['running', 'En cours'], ['pending', 'En attente'], ['done', 'Terminées récemment'], ['failed', 'Échouées récemment']]) {
    const list = bridges.flatMap((b) => b.tasks.filter((t) => t.state === s[0]).map((t) => ({ ...t, dev: b.dev, host: b.host })))
      .sort((a, b) => (b.ended || b.started || b.at) - (a.ended || a.started || a.at)).slice(0, 15);
    lines.push(`## ${s[1]}`, ...(list.length ? list.map((t) => `- [${t.host}] ${fmt(t.ended || t.started || t.at)} — ${t.prompt.replace(/\s+/g, ' ').slice(0, 200)}${t.activity ? `\n  ▶ ${t.activity}` : ''}${t.files?.length ? `\n  fichiers touchés : ${t.files.join(', ')}` : ''}${t.msg ? `\n  → ${t.msg}` : ''}`) : ['- (rien)']), '');
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
    ws.send(JSON.stringify({ t: 'bridgeHello', token: TOKEN, host: HOST, key: KEY }));
    console.log(`Bridge connecté à ${SERVER} — repo ${REPO}`);
    console.log(`  Ouvre une fois ce lien pour accéder à TON Claude (ne le partage pas) :\n  ${SERVER.replace(/^ws/, 'http').replace(/\/ws$/, '/')}?dev=${TOKEN}&key=${KEY}`);
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
    else if (m.t === 'todoOp') todoOp(m);
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
