// Shell du jeu : rendu, contrôles, réseau, menu. Stable entre les versions.
// Le niveau (world.ts) est un module séparé, remplacé à chaud quand une nouvelle version sort.
import * as THREE from 'three';
import type { LobbyState, RoomInfo, VersionInfo } from '../shared/protocol';
import type { CreateWorld, World } from './world/types';
import { Net, type Snap } from './net';
import { Dev, devKeys, devToken, toast } from './dev';
import { createAvatar, type Avatar } from './avatar';
import { ABILITIES, CHARACTERS, cleanLook, type Ability, type Look } from '../shared/characters';
import { Menu } from './ui/menu';
import type { GameApi } from './ui/types';
import { t } from './ui/i18n';
import { keyLabel, onSettings, settings, QUALITY_RATIO } from './ui/settings';
import { setLastGame, trackGame, trackMet, trackMove } from './ui/profile';

const STATE_KEY = 'december.state'; // partie + position conservées pendant un rechargement de mise à jour
const NAME_KEY = 'december.name';
const LOOK_KEY = 'december.look';
const EYE = 1.6;
const INTERP_MS = 110; // retard d'affichage des autres joueurs (lissage du réseau)

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game') as HTMLCanvasElement;
const hud = $('hud');

// --- Rendu ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
// densité de pixels : qualité × résolution de rendu (paramètres), plafonnée à 1.5
const applyPixelRatio = () => renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY_RATIO[settings.quality]) * settings.renderScale);
applyPixelRatio();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 300);
camera.rotation.order = 'YXZ';
function applySize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
applySize();
addEventListener('resize', applySize);

// --- Monde hot-swappable ---
let seed = 0;
let look: Look = cleanLook(null);
const myChar = () => CHARACTERS[look[0]];
const ctx = {
  scene, camera, renderer,
  get seed() { return seed; },
  get character() { return myChar(); },
  hasAbility: (a: Ability) => myChar().ability === a,
};
let world: World | null = null;
let worldUrl = '';
let swapQueue = Promise.resolve();
function swapWorld(create: CreateWorld, url = worldUrl) {
  swapQueue = swapQueue.then(async () => {
    try {
      const next = await create(ctx);
      world?.dispose();
      world = next; worldUrl = url;
    } catch (e) { console.error('world swap failed', e); }
  });
  return swapQueue;
}
async function loadWorldFrom(url: string) {
  const mod = await import(/* @vite-ignore */ url);
  await swapWorld(mod.createWorld, url);
}
addEventListener('world:hot', (e) => swapWorld((e as CustomEvent).detail));

// --- Joueur local (1re personne, touches physiques configurables : marchent en AZERTY comme en QWERTY) ---
const me = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0 };
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const locked = () => document.pointerLockElement === canvas;
const lock = () => { try { (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch {} };
canvas.addEventListener('click', () => { if (room && !dev.isOpen && !menu.visible) lock(); });
addEventListener('mousemove', (e) => {
  if (!locked()) return;
  const k = 0.0022 * settings.sensitivity;
  me.yaw -= e.movementX * k;
  me.pitch = Math.max(-1.5, Math.min(1.5, me.pitch - e.movementY * k * (settings.invertY ? -1 : 1)));
});
const fwd = new THREE.Vector3(), side = new THREE.Vector3(), wish = new THREE.Vector3();
function updatePlayer(dt: number) {
  wish.set(0, 0, 0);
  if (locked()) {
    fwd.set(-Math.sin(me.yaw), 0, -Math.cos(me.yaw));
    side.set(-fwd.z, 0, fwd.x);
    const b = settings.binds;
    if (keys.has(b.forward) || keys.has('ArrowUp')) wish.add(fwd);
    if (keys.has(b.back) || keys.has('ArrowDown')) wish.sub(fwd);
    if (keys.has(b.right) || keys.has('ArrowRight')) wish.add(side);
    if (keys.has(b.left) || keys.has('ArrowLeft')) wish.sub(side);
    const fast = myChar().ability === 'speed'; // capacité « Rapide » : +25 %
    if (wish.lengthSq()) wish.normalize().multiplyScalar((keys.has(b.sprint) ? 7 : 4) * (fast ? 1.25 : 1));
  }
  me.vel.lerp(wish, 1 - Math.exp(-12 * dt)); // inertie légère
  me.pos.addScaledVector(me.vel, dt);
  camera.position.set(me.pos.x, me.pos.y + EYE, me.pos.z);
  camera.rotation.set(me.pitch, me.yaw, 0);
}

// --- Autres joueurs : avatar du personnage choisi + pseudo, interpolés ---
interface Remote { name: string; look: Look; group: THREE.Group; avatar: Avatar; buf: { t: number; x: number; y: number; z: number; yaw: number }[] }
const remotes = new Map<number, Remote>();
function label(text: string) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 36px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(text, 128, 32);
  g.fillStyle = '#fff'; g.fillText(text, 128, 32);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false }));
  s.scale.set(1.6, 0.4, 1);
  s.position.y = 2.2;
  return s;
}
function addRemote(id: number, name: string, l?: Look) {
  if (id === net.id || remotes.has(id)) return;
  const look = cleanLook(l); // ancien client sans look : personnage par défaut
  const avatar = createAvatar(look);
  const group = avatar.group;
  group.add(label(name));
  group.visible = false; // jusqu'à la première position reçue
  scene.add(group);
  remotes.set(id, { name, look, group, avatar, buf: [] });
  trackMet(name);
  menu.emit('players');
}
function removeRemote(id: number) {
  const r = remotes.get(id);
  if (!r) return;
  scene.remove(r.group);
  r.group.traverse((o) => {
    if (o instanceof THREE.Sprite) { o.material.map?.dispose(); o.material.dispose(); }
  });
  r.avatar.dispose();
  remotes.delete(id);
  menu.emit('players');
}
function setRemoteLook(id: number, l: Look) {
  const r = remotes.get(id);
  if (!r) return;
  const { buf, group } = r, vis = group.visible, pos = group.position.clone(), yaw = group.rotation.y;
  removeRemote(id); addRemote(id, r.name, l);
  const n = remotes.get(id)!;
  n.buf = buf; n.group.visible = vis; n.group.position.copy(pos); n.group.rotation.y = yaw;
}
function clearRemotes() { for (const id of [...remotes.keys()]) removeRemote(id); }
function onSnap(list: Snap[]) {
  const t = performance.now();
  for (const s of list) {
    const r = remotes.get(s.id);
    if (!r) continue;
    r.buf.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw });
    if (r.buf.length > 10) r.buf.shift();
  }
}
const prevPos = new THREE.Vector3();
function updateRemotes(dt: number) {
  const t = performance.now() - INTERP_MS;
  for (const r of remotes.values()) {
    const b = r.buf;
    if (!b.length) continue;
    while (b.length > 2 && b[1].t <= t) b.shift();
    const a = b[0], c = b[1] ?? a;
    const k = c.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (c.t - a.t))) : 1;
    let dy = c.yaw - a.yaw;
    dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
    prevPos.copy(r.group.position);
    r.group.position.set(a.x + (c.x - a.x) * k, a.y + (c.y - a.y) * k, a.z + (c.z - a.z) * k);
    if (dt > 0 && r.group.visible) r.avatar.animate(Math.hypot(r.group.position.x - prevPos.x, r.group.position.z - prevPos.z) / dt, dt);
    r.group.rotation.y = a.yaw + dy * k;
    r.group.visible = true;
  }
}

// --- Réseau ---
const net = new Net(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const dev = new Dev(net, captureFrame, (open) => {
  if (open) document.exitPointerLock?.();
  else if (shellPending) reloadPreservingState(); // mise à jour reportée pendant que le dev écrivait
});
let shellPending = false;
let room: RoomInfo | null = null;
let lobby: LobbyState | null = null; // salon d'avant-partie (hôte, phase, joueurs prêts)
let restorePos: [number, number, number, number] | null = null;

const seedOf = (code: string) => { let h = 2166136261; for (const c of code) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const myShell = new URL(import.meta.url).pathname; // en prod : /assets/index-<hash>.js
let playerName = '';
const myName = () => playerName.trim().slice(0, 16) || 'Inconnu';

function onVersion(v: VersionInfo | null) {
  if (!v || import.meta.env.DEV) return;
  if (v.shell !== myShell) {
    // ne pas couper un dev en train d'écrire un prompt : on recharge à la fermeture
    if (dev.isOpen) { shellPending = true; return; }
    return reloadPreservingState();
  }
  if (v.world !== worldUrl) loadWorldFrom(v.world).then(() => { if (dev.enabled) toast('Mise à jour appliquée ✓', 'ok', 3000); });
}

function reloadPreservingState() {
  try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ room, pos: [me.pos.x, me.pos.y, me.pos.z, me.yaw], pitch: me.pitch, at: Date.now() })); } catch {}
  location.reload();
}

function hello() {
  try { localStorage.setItem(NAME_KEY, myName()); } catch {}
  net.send({ t: 'hello', name: myName(), dev: devToken(), keys: devKeys(), look });
}

net.onOpen = () => {
  hello();
  // reconnexion (redémarrage serveur au déploiement) : on revient dans la même partie, au même endroit
  if (room) net.send({ t: 'join', code: room.code, pos: [me.pos.x, me.pos.y, me.pos.z, me.yaw], recreate: true, private: room.priv, lobby: room.phase === 'lobby' });
  menu.emit('net');
};
net.onSnap = onSnap;
net.onMsg = (m) => {
  dev.onMsg(m);
  switch (m.t) {
    case 'welcome': if (m.dev) { dev.owned = new Set(m.owned ?? []); dev.enable(); } onVersion(m.version); break;
    case 'version': onVersion(m.version); break;
    case 'joined': {
      const first = room?.code !== m.room.code;
      if (first) lobby = null;
      room = m.room;
      seed = seedOf(room.code);
      clearRemotes();
      for (const p of m.players) addRemote(p.id, p.name, p.look);
      if (first && !restorePos && world) { me.pos.copy(world.spawn); me.yaw = world.spawnYaw; me.pitch = 0; }
      history.replaceState(null, '', `?room=${room.code}`);
      setLastGame({ code: room.code, at: Date.now(), priv: !!room.priv });
      if (first && !restorePos) { trackGame(creating, look[0]); spawnAt.copy(me.pos); menu.onJoined(); }
      creating = false;
      menu.emit('players');
      break;
    }
    case 'roomError': creating = false; menu.onRoomError(m.msg); break;
    case 'rooms': menu.onRooms(m.rooms); break;
    case 'join': addRemote(m.id, m.name, m.look); break;
    case 'leave': removeRemote(m.id); break;
    case 'look':
      if (m.id === net.id) applyLook(m.look); else setRemoteLook(m.id, m.look);
      menu.emit('players');
      break;
    case 'lobby': {
      const started = room?.phase === 'lobby' && m.lobby.phase === 'live';
      lobby = m.lobby;
      if (room) room.phase = m.lobby.phase;
      menu.emit('players');
      if (started) menu.onStarted(); // l'hôte a lancé la partie : tout le salon entre dans le monde
      break;
    }
  }
};

// --- Menu (ui/) : le shell expose GameApi, le menu ne touche jamais directement au réseau ---
let creating = false;
const spawnAt = new THREE.Vector3();
let nameTimer = 0;
const api: GameApi = {
  get room() { return room; },
  get online() { return net.open; },
  players: () => [
    { id: net.id, name: myName(), look, me: true },
    ...[...remotes.entries()].map(([id, r]) => ({ id, name: r.name, look: r.look })),
  ].map((p) => ({ ...p, host: lobby?.host === p.id, ready: !!lobby?.ready.includes(p.id) })),
  get isHost() { return !!room && lobby?.host === net.id; },
  setReady(on) { net.send({ t: 'ready', ready: on }); },
  start() { net.send({ t: 'start' }); },
  name: myName,
  setName(n) {
    playerName = n.slice(0, 16);
    try { localStorage.setItem(NAME_KEY, playerName.trim()); } catch {}
    clearTimeout(nameTimer);
    nameTimer = window.setTimeout(() => { if (!room) hello(); }, 300); // re-hello hors partie : le serveur met à jour le pseudo
  },
  look: () => look,
  setLook,
  create(priv, inLobby) { creating = true; hello(); net.send({ t: 'create', private: priv, lobby: inLobby }); },
  join(code, o) { hello(); net.send({ t: 'join', code: code.trim().toUpperCase(), recreate: o?.recreate, private: o?.priv }); },
  play() { menu.close(); lock(); },
  leave() {
    if (room) setLastGame({ code: room.code, at: Date.now(), priv: !!room.priv });
    net.send({ t: 'leaveRoom' });
    room = null;
    lobby = null;
    mapOpen = false;
    clearRemotes();
    history.replaceState(null, '', '/');
    menu.onLeft();
  },
  listRooms() { net.send({ t: 'listRooms' }); },
  link: (code = room?.code ?? '') => `${location.origin}/?room=${code}`,
};
const menu = new Menu($('menu'), api);

$('copy').addEventListener('click', () => {
  navigator.clipboard?.writeText(api.link()).then(() => toast(t('toast.copied'), 'ok', 2000), () => {});
});
$('quit').addEventListener('click', () => menu.open('quit', 'room'));
$('open-menu').addEventListener('click', () => menu.open('lobby', 'pause'));
// Échap (souris déjà libérée) : menu pause
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && room && !menu.visible && !locked() && !dev.isOpen) menu.open('lobby', 'pause');
});

// --- Paramètres appliqués au rendu / HUD ---
const crosshair = $('crosshair');
function paintRoomBar() {
  const b = settings.binds;
  $('bar-hint').textContent = t('bar.hint', {
    keys: [b.forward, b.left, b.back, b.right].map(keyLabel).join(''), sprint: keyLabel(b.sprint), map: keyLabel(b.map),
  });
  $('open-menu').textContent = t('bar.menu'); $('copy').textContent = t('bar.copy'); $('quit').textContent = t('bar.quit');
}
onSettings((s) => {
  applyPixelRatio();
  camera.fov = s.fov; camera.updateProjectionMatrix();
  canvas.style.filter = s.brightness === 1 ? '' : `brightness(${s.brightness})`;
  paintRoomBar();
});

// --- Personnage + teinte de peau : aperçu 3D (écran Personnage du menu) ---
let preview: Avatar | null = null;
function refreshPreview() {
  if (preview) { scene.remove(preview.group); preview.dispose(); }
  preview = createAvatar(look);
  scene.add(preview.group);
}
function setLook(l: Look) {
  // salon d'avant-partie : le serveur valide (rôle unique) puis renvoie « look » à tout le salon
  if (room?.phase === 'lobby') return net.send({ t: 'role', look: cleanLook(l) });
  applyLook(l);
  if (!room) hello(); // re-hello hors partie : le serveur met à jour le look
}
function applyLook(l: Look) {
  look = cleanLook(l);
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch {}
  refreshPreview();
}
const previewDir = new THREE.Vector3();
// lumière d'aperçu toujours dans la scène (intensité 0 hors écran Personnage : pas de recompilation des shaders)
const previewLight = new THREE.PointLight(0xffe6d6, 0, 7, 2);
scene.add(previewLight);
function updatePreview(dt: number) {
  previewLight.intensity = 0;
  if (!preview) return;
  preview.group.visible = !room && menu.preview;
  if (!preview.group.visible) return;
  // à droite du panneau, face caméra, tourne doucement sur lui-même
  const d = 3.2, half = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
  previewDir.set(Math.min(half * 0.5, 2.2), -1.75, -d).applyEuler(camera.rotation);
  preview.group.position.copy(camera.position).add(previewDir);
  previewLight.position.copy(camera.position).lerp(preview.group.position, 0.45);
  previewLight.position.y += 0.6;
  previewLight.intensity = 5;
  preview.group.rotation.y += dt * 0.5;
  preview.animate(0, dt);
}

// --- Carte (capacité « Cartographe », touche M) ---
const mapCanvas = $('map') as HTMLCanvasElement;
const mapG = mapCanvas.getContext('2d')!;
let mapOpen = false;
addEventListener('keydown', (e) => {
  if (e.code !== settings.binds.map || !room || dev.isOpen || menu.visible || document.activeElement instanceof HTMLInputElement) return;
  if (myChar().ability !== 'map') return toast('Seul le Cartographe a une carte', 'err', 2000);
  mapOpen = !mapOpen;
});
function drawMap() {
  mapCanvas.hidden = !(mapOpen && room && myChar().ability === 'map');
  if (mapCanvas.hidden) return;
  const S = mapCanvas.width, R = S / 2, scale = R / 60; // rayon affiché : 60 m
  mapG.clearRect(0, 0, S, S);
  mapG.save();
  mapG.beginPath(); mapG.arc(R, R, R - 2, 0, Math.PI * 2); mapG.clip();
  mapG.fillStyle = 'rgba(12,16,20,.82)'; mapG.fillRect(0, 0, S, S);
  mapG.translate(R, R); mapG.rotate(me.yaw); // haut de la carte = direction du regard
  mapG.strokeStyle = 'rgba(255,255,255,.08)'; mapG.lineWidth = 1;
  for (let g = -60; g <= 60; g += 10) {
    const ox = (g - (me.pos.x % 10)) * scale, oz = (g - (me.pos.z % 10)) * scale;
    mapG.beginPath(); mapG.moveTo(ox, -S); mapG.lineTo(ox, S); mapG.moveTo(-S, oz); mapG.lineTo(S, oz); mapG.stroke();
  }
  mapG.fillStyle = '#e0a43a';
  for (const r of remotes.values()) {
    if (!r.group.visible) continue;
    mapG.beginPath();
    mapG.arc((r.group.position.x - me.pos.x) * scale, (r.group.position.z - me.pos.z) * scale, 4, 0, Math.PI * 2);
    mapG.fill();
  }
  mapG.fillStyle = '#c9d4de'; mapG.font = 'bold 12px system-ui'; mapG.textAlign = 'center';
  mapG.fillText('N', 0, -R + 16);
  mapG.restore();
  mapG.fillStyle = '#fff'; // soi-même : flèche fixe vers le haut
  mapG.beginPath(); mapG.moveTo(R, R - 7); mapG.lineTo(R + 5, R + 5); mapG.lineTo(R - 5, R + 5); mapG.fill();
}

// --- Capture d'écran (mode dev) : lue juste après le rendu, même frame ---
let captureResolve: ((s: string) => void) | null = null;
function captureFrame(): Promise<string> { return new Promise((r) => { captureResolve = r; }); }
function grab() {
  const w = Math.min(1280, canvas.width);
  const h = Math.round((canvas.height / canvas.width) * w);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.drawImage(canvas, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.85);
}

// --- Boucle ---
let last = performance.now(), netAcc = 0, menuYaw = 0, wasOnline = false, fps = 60;
const lastPos = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (room) {
    lastPos.copy(me.pos);
    updatePlayer(dt);
    if (locked()) trackMove(dt, Math.hypot(me.pos.x - lastPos.x, me.pos.z - lastPos.z), Math.hypot(me.pos.x - spawnAt.x, me.pos.z - spawnAt.z), remotes.size + 1);
  } else { // menu : la caméra tourne lentement
    menuYaw += dt * 0.08;
    camera.position.set(0, 3, 0);
    camera.rotation.set(-0.15, menuYaw, 0);
  }
  updateRemotes(dt);
  updatePreview(dt);
  drawMap();
  world?.update(dt, now / 1000, me.pos);
  netAcc += dt;
  if (room && netAcc >= 0.05) { netAcc = 0; net.sendPos(me.pos.x, me.pos.y, me.pos.z, me.yaw); }
  if (net.open !== wasOnline) { wasOnline = net.open; menu.emit('net'); }
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  const info = room && !menu.visible
    ? t('hud.room', { char: myChar().name, ability: ABILITIES[myChar().ability].label, code: room.code, n: remotes.size + 1 }) + (net.open ? '' : ` · ${t('hud.reconnect')}`)
    : '';
  hud.textContent = [info, settings.showFps ? `${Math.round(fps)} FPS` : ''].filter(Boolean).join(' · ');
  $('room-bar').hidden = !room || locked() || menu.visible;
  crosshair.hidden = !settings.crosshair || !room || menu.visible;
  renderer.render(scene, camera);
  if (captureResolve) { captureResolve(grab()); captureResolve = null; }
});

// --- Démarrage ---
(async () => {
  try { playerName = localStorage.getItem(NAME_KEY) || ''; look = cleanLook(JSON.parse(localStorage.getItem(LOOK_KEY) || 'null')); } catch {}
  refreshPreview();

  let restored: { room: RoomInfo | null; pos: [number, number, number, number]; pitch: number; at: number } | null = null;
  try { restored = JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); sessionStorage.removeItem(STATE_KEY); } catch {}
  if (restored?.room && Date.now() - restored.at < 60_000) {
    // revient d'un rechargement de mise à jour : on retourne directement dans la partie
    room = restored.room;
    seed = seedOf(room.code);
    restorePos = restored.pos;
    me.pos.set(restorePos[0], restorePos[1], restorePos[2]);
    me.yaw = restorePos[3]; me.pitch = restored.pitch;
    if (room.phase === 'lobby') menu.open('lobby'); else menu.root.hidden = true;
  } else menu.open('home');

  if (import.meta.env.DEV) {
    const mod = await import('./world/world');
    await swapWorld(mod.createWorld, 'dev');
    Object.assign(window, { __player: me });
  } else {
    const v: VersionInfo = await fetch('/version.json', { cache: 'no-store' }).then((r) => r.json());
    await loadWorldFrom(v.world);
  }
  net.connect();
  restorePos = null;
})();
