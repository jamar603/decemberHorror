// Shell du jeu : rendu, contrôles, réseau, menu. Stable entre les versions.
// Le niveau (world.ts) est un module séparé, remplacé à chaud quand une nouvelle version sort.
import * as THREE from 'three';
import type { RoomInfo, VersionInfo } from '../shared/protocol';
import type { CreateWorld, World } from './world/types';
import { Net, type Snap } from './net';
import { Dev, devKeys, devToken, toast } from './dev';
import { createAvatar, type Avatar } from './avatar';
import { ABILITIES, CHARACTERS, SKIN_TONES, cleanLook, type Ability, type Look } from '../shared/characters';

const STATE_KEY = 'december.state'; // partie + position conservées pendant un rechargement de mise à jour
const NAME_KEY = 'december.name';
const LOOK_KEY = 'december.look';
const EYE = 1.6;
const INTERP_MS = 110; // retard d'affichage des autres joueurs (lissage du réseau)

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game') as HTMLCanvasElement;
const menu = $('menu');
const nameInput = $('name') as HTMLInputElement;
const codeInput = $('code') as HTMLInputElement;
const menuError = $('menu-error');
const hud = $('hud');

// --- Rendu ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
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

// --- Joueur local (1re personne, ZQSD/WASD : codes physiques, marchent en AZERTY comme en QWERTY) ---
const me = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0 };
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const locked = () => document.pointerLockElement === canvas;
canvas.addEventListener('click', () => { if (room && !dev.isOpen) canvas.requestPointerLock(); });
addEventListener('mousemove', (e) => {
  if (!locked()) return;
  me.yaw -= e.movementX * 0.0022;
  me.pitch = Math.max(-1.5, Math.min(1.5, me.pitch - e.movementY * 0.0022));
});
const fwd = new THREE.Vector3(), side = new THREE.Vector3(), wish = new THREE.Vector3();
function updatePlayer(dt: number) {
  wish.set(0, 0, 0);
  if (locked()) {
    fwd.set(-Math.sin(me.yaw), 0, -Math.cos(me.yaw));
    side.set(-fwd.z, 0, fwd.x);
    if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(fwd);
    if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(fwd);
    if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(side);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(side);
    const fast = myChar().ability === 'speed'; // capacité « Rapide » : +25 %
    if (wish.lengthSq()) wish.normalize().multiplyScalar((keys.has('ShiftLeft') ? 7 : 4) * (fast ? 1.25 : 1));
  }
  me.vel.lerp(wish, 1 - Math.exp(-12 * dt)); // inertie légère
  me.pos.addScaledVector(me.vel, dt);
  camera.position.set(me.pos.x, me.pos.y + EYE, me.pos.z);
  camera.rotation.set(me.pitch, me.yaw, 0);
}

// --- Autres joueurs : avatar du personnage choisi + pseudo, interpolés ---
interface Remote { group: THREE.Group; avatar: Avatar; buf: { t: number; x: number; y: number; z: number; yaw: number }[] }
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
  const avatar = createAvatar(cleanLook(l)); // ancien client sans look : personnage par défaut
  const group = avatar.group;
  group.add(label(name));
  group.visible = false; // jusqu'à la première position reçue
  scene.add(group);
  remotes.set(id, { group, avatar, buf: [] });
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
let restorePos: [number, number, number, number] | null = null;

const seedOf = (code: string) => { let h = 2166136261; for (const c of code) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const myShell = new URL(import.meta.url).pathname; // en prod : /assets/index-<hash>.js
const myName = () => nameInput.value.trim().slice(0, 16) || 'Inconnu';

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
  if (room) net.send({ t: 'join', code: room.code, pos: [me.pos.x, me.pos.y, me.pos.z, me.yaw], recreate: true });
};
net.onSnap = onSnap;
net.onMsg = (m) => {
  dev.onMsg(m);
  switch (m.t) {
    case 'welcome': if (m.dev) { dev.owned = new Set(m.owned ?? []); dev.enable(); } onVersion(m.version); break;
    case 'version': onVersion(m.version); break;
    case 'joined': {
      const first = room?.code !== m.room.code;
      room = m.room;
      seed = seedOf(room.code);
      clearRemotes();
      for (const p of m.players) addRemote(p.id, p.name, p.look);
      if (first && !restorePos && world) { me.pos.copy(world.spawn); me.yaw = world.spawnYaw; me.pitch = 0; }
      history.replaceState(null, '', `?room=${room.code}`);
      menu.hidden = true;
      menuError.textContent = '';
      break;
    }
    case 'roomError': menuError.textContent = m.msg; break;
    case 'join': addRemote(m.id, m.name, m.look); break;
    case 'leave': removeRemote(m.id); break;
  }
};

// --- Menu ---
$('create').addEventListener('click', () => { hello(); net.send({ t: 'create' }); });
$('join').addEventListener('click', () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!code) { codeInput.focus(); return; }
  hello();
  net.send({ t: 'join', code });
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
$('copy').addEventListener('click', () => {
  navigator.clipboard?.writeText(`${location.origin}/?room=${room?.code}`).then(() => toast('Lien copié', 'ok', 2000), () => {});
});
$('quit').addEventListener('click', () => {
  net.send({ t: 'leaveRoom' });
  room = null;
  clearRemotes();
  history.replaceState(null, '', '/');
  menu.hidden = false;
});

// --- Choix du personnage + teinte de peau (menu) ---
const charList = $('chars'), skinList = $('skins'), charInfo = $('char-info');
let preview: Avatar | null = null;
function renderPicker() {
  charList.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === look[0])));
  skinList.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === look[1])));
  const ab = ABILITIES[myChar().ability];
  charInfo.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = `${myChar().name} · ${ab.label}`;
  charInfo.append(strong, document.createTextNode(` — ${ab.desc}`));
  if (preview) { scene.remove(preview.group); preview.dispose(); }
  preview = createAvatar(look);
  scene.add(preview.group);
}
function setLook(l: Look) {
  look = cleanLook(l);
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch {}
  renderPicker();
  if (!room) hello(); // re-hello hors partie : le serveur met à jour le look
}
CHARACTERS.forEach((c, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = c.gender;
  b.title = `${c.name} — ${ABILITIES[c.ability].label}`;
  const n = document.createElement('span'); n.textContent = c.name;
  const a = document.createElement('small'); a.textContent = ABILITIES[c.ability].short;
  b.append(n, a);
  b.addEventListener('click', () => setLook([i, look[1]]));
  charList.append(b);
});
SKIN_TONES.forEach((t, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.style.background = `#${t.toString(16).padStart(6, '0')}`;
  b.setAttribute('aria-label', `Teinte de peau ${i + 1} sur ${SKIN_TONES.length}`);
  b.addEventListener('click', () => setLook([look[0], i]));
  skinList.append(b);
});
const previewDir = new THREE.Vector3();
function updatePreview(dt: number) {
  if (!preview) return;
  preview.group.visible = !room;
  if (room) return;
  // à droite du panneau, face caméra, tourne doucement sur lui-même
  const d = 3.2, half = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
  previewDir.set(Math.min(half * 0.5, 1.9), -1.75, -d).applyEuler(camera.rotation);
  preview.group.position.copy(camera.position).add(previewDir);
  preview.group.rotation.y += dt * 0.5;
  preview.animate(0, dt);
}

// --- Carte (capacité « Cartographe », touche M) ---
const mapCanvas = $('map') as HTMLCanvasElement;
const mapG = mapCanvas.getContext('2d')!;
let mapOpen = false;
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || !room || dev.isOpen || document.activeElement instanceof HTMLInputElement) return;
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
let last = performance.now(), netAcc = 0, menuYaw = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (room) updatePlayer(dt);
  else { // menu : la caméra tourne lentement
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
  hud.textContent = room ? `${myChar().name} (${ABILITIES[myChar().ability].label}) · Partie ${room.code} · ${remotes.size + 1} joueur${remotes.size ? 's' : ''}${net.open ? '' : ' · reconnexion…'}` : '';
  $('room-bar').hidden = !room || locked();
  renderer.render(scene, camera);
  if (captureResolve) { captureResolve(grab()); captureResolve = null; }
});

// --- Démarrage ---
(async () => {
  try { nameInput.value = localStorage.getItem(NAME_KEY) || ''; look = cleanLook(JSON.parse(localStorage.getItem(LOOK_KEY) || 'null')); } catch {}
  renderPicker();
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) codeInput.value = urlRoom.toUpperCase().slice(0, 5);

  let restored: { room: RoomInfo | null; pos: [number, number, number, number]; pitch: number; at: number } | null = null;
  try { restored = JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); sessionStorage.removeItem(STATE_KEY); } catch {}
  if (restored?.room && Date.now() - restored.at < 60_000) {
    // revient d'un rechargement de mise à jour : on retourne directement dans la partie
    room = restored.room;
    seed = seedOf(room.code);
    restorePos = restored.pos;
    me.pos.set(restorePos[0], restorePos[1], restorePos[2]);
    me.yaw = restorePos[3]; me.pitch = restored.pitch;
    menu.hidden = true;
  }

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
