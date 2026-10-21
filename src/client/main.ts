// Shell du jeu : rendu, contrôles, réseau, menu. Stable entre les versions.
// Le niveau (world.ts) est un module séparé, remplacé à chaud quand une nouvelle version sort.
import * as THREE from 'three';
import type { RoomInfo, VersionInfo } from '../shared/protocol';
import type { CreateWorld, World } from './world/types';
import { Net, type Snap } from './net';
import { Dev, devToken, toast } from './dev';

const STATE_KEY = 'december.state'; // partie + position conservées pendant un rechargement de mise à jour
const NAME_KEY = 'december.name';
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
const ctx = { scene, camera, renderer, get seed() { return seed; } };
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
    if (wish.lengthSq()) wish.normalize().multiplyScalar(keys.has('ShiftLeft') ? 7 : 4);
  }
  me.vel.lerp(wish, 1 - Math.exp(-12 * dt)); // inertie légère
  me.pos.addScaledVector(me.vel, dt);
  camera.position.set(me.pos.x, me.pos.y + EYE, me.pos.z);
  camera.rotation.set(me.pitch, me.yaw, 0);
}

// --- Autres joueurs : capsule colorée + pseudo, interpolés ---
interface Remote { group: THREE.Group; buf: { t: number; x: number; y: number; z: number; yaw: number }[] }
const remotes = new Map<number, Remote>();
const capsule = new THREE.CapsuleGeometry(0.35, 1.1, 4, 12);
const nose = new THREE.BoxGeometry(0.2, 0.12, 0.25);
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
function addRemote(id: number, name: string) {
  if (id === net.id || remotes.has(id)) return;
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(((id * 0.618) % 1), 0.6, 0.55) });
  const body = new THREE.Mesh(capsule, mat);
  body.position.y = 0.9;
  const n = new THREE.Mesh(nose, mat);
  n.position.set(0, 1.5, -0.38); // indique la direction du regard
  const group = new THREE.Group();
  group.add(body, n, label(name));
  group.visible = false; // jusqu'à la première position reçue
  scene.add(group);
  remotes.set(id, { group, buf: [] });
}
function removeRemote(id: number) {
  const r = remotes.get(id);
  if (!r) return;
  scene.remove(r.group);
  r.group.traverse((o) => {
    if (o instanceof THREE.Sprite) { o.material.map?.dispose(); o.material.dispose(); }
    else if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
  });
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
function updateRemotes() {
  const t = performance.now() - INTERP_MS;
  for (const r of remotes.values()) {
    const b = r.buf;
    if (!b.length) continue;
    while (b.length > 2 && b[1].t <= t) b.shift();
    const a = b[0], c = b[1] ?? a;
    const k = c.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (c.t - a.t))) : 1;
    let dy = c.yaw - a.yaw;
    dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
    r.group.position.set(a.x + (c.x - a.x) * k, a.y + (c.y - a.y) * k, a.z + (c.z - a.z) * k);
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
  net.send({ t: 'hello', name: myName(), dev: devToken() });
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
    case 'welcome': if (m.dev) dev.enable(); onVersion(m.version); break;
    case 'version': onVersion(m.version); break;
    case 'joined': {
      const first = room?.code !== m.room.code;
      room = m.room;
      seed = seedOf(room.code);
      clearRemotes();
      for (const p of m.players) addRemote(p.id, p.name);
      if (first && !restorePos && world) { me.pos.copy(world.spawn); me.yaw = world.spawnYaw; me.pitch = 0; }
      history.replaceState(null, '', `?room=${room.code}`);
      menu.hidden = true;
      menuError.textContent = '';
      break;
    }
    case 'roomError': menuError.textContent = m.msg; break;
    case 'join': addRemote(m.id, m.name); break;
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
  updateRemotes();
  world?.update(dt, now / 1000, me.pos);
  netAcc += dt;
  if (room && netAcc >= 0.05) { netAcc = 0; net.sendPos(me.pos.x, me.pos.y, me.pos.z, me.yaw); }
  hud.textContent = room ? `Partie ${room.code} · ${remotes.size + 1} joueur${remotes.size ? 's' : ''}${net.open ? '' : ' · reconnexion…'}` : '';
  $('room-bar').hidden = !room || locked();
  renderer.render(scene, camera);
  if (captureResolve) { captureResolve(grab()); captureResolve = null; }
});

// --- Démarrage ---
(async () => {
  try { nameInput.value = localStorage.getItem(NAME_KEY) || ''; } catch {}
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
