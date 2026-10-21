// Serveur temps réel : uWebSockets.js (C++), protocole binaire pour les positions.
// En prod, Apache sert les fichiers statiques et proxy /ws et /api ici (127.0.0.1 uniquement).
// Parties ("rooms") : rejointes par code (lien ?room=CODE). Chaque partie = 1 topic uWS.
import uWS from 'uWebSockets.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  B_POS, B_SNAP, POS_BYTES, SNAP_ENTRY, TICK_HZ, MAX_PLAYERS, ROOM_MAX, CODE_LEN,
  type ClientMsg, type ServerMsg, type VersionInfo, type BridgeMsg, type ToBridgeMsg, type DevBridge, type RoomInfo,
} from '../src/shared/protocol';

const PORT = Number(process.env.PORT || 18031);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = process.env.PUBLIC_DIR || 'dist';
const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN || '';
// DEV_TOKENS="tom:secret1,alice:secret2"
const DEV_TOKENS = new Map(
  (process.env.DEV_TOKENS || (process.env.NODE_ENV === 'production' ? '' : 'local:dev'))
    .split(',').filter(Boolean).map((p) => { const [n, t] = p.split(':'); return [t, n] as [string, string]; }),
);
const MAX_ROOMS = 100;
const EMPTY_ROOM_TTL = 60_000; // une partie vide survit 1 min (rechargement, reconnexion)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function safeEq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function devName(token?: string): string | null {
  if (!token) return null;
  for (const [t, n] of DEV_TOKENS) if (safeEq(t, token)) return n;
  return null;
}
const clean = (s: unknown, n: number, fallback: string) =>
  String(s ?? '').replace(/[^\p{L}\p{N} _'!?.-]/gu, '').trim().slice(0, n) || fallback;

let version: VersionInfo | null = null;
function loadVersion() {
  try { version = JSON.parse(readFileSync(join(PUBLIC_DIR, 'version.json'), 'utf8')); } catch { version = null; }
}
loadVersion();

interface Player {
  kind: 'player';
  id: number; name: string; dev: string | null; hello: boolean; room: Room | null;
  x: number; y: number; z: number; yaw: number; dirty: boolean; lastCreate: number;
}
interface Bridge extends DevBridge { kind: 'bridge'; authed: boolean }
type Data = Player | Bridge;
type WS = uWS.WebSocket<Data>;

interface Room { code: string; members: Set<WS>; emptySince: number }

const players = new Map<number, WS>();
const rooms = new Map<string, Room>();
const bridges = new Map<string, WS>();
const pending = new Map<string, { ws: WS; t: number }>();
let nextId = 1;
const dec = new TextDecoder();

const send = (ws: WS, m: ServerMsg | ToBridgeMsg) => ws.send(JSON.stringify(m), false);
const toRoom = (r: Room, m: ServerMsg) => app.publish(`r:${r.code}`, JSON.stringify(m), false);
const broadcastAll = (m: ServerMsg) => app.publish('all', JSON.stringify(m), false);
const bridgeList = (): DevBridge[] => [...bridges.values()].map((b) => {
  const d = b.getUserData() as Bridge;
  return { id: d.id, dev: d.dev, host: d.host, tasks: d.tasks };
});
// Les devs (jeu) et les bridges (sessions Claude) voient le même tableau de tâches
function boardChanged() {
  const list = bridgeList();
  app.publish('dev', JSON.stringify({ t: 'bridges', bridges: list } satisfies ServerMsg), false);
  app.publish('bridges', JSON.stringify({ t: 'board', bridges: list } satisfies ToBridgeMsg), false);
}
const roomInfo = (r: Room): RoomInfo => ({ code: r.code, players: r.members.size, max: ROOM_MAX });

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function createRoom(code: string): Room | null {
  if (rooms.size >= MAX_ROOMS) return null;
  const r: Room = { code, members: new Set(), emptySince: Date.now() };
  rooms.set(code, r);
  return r;
}

function leaveRoom(ws: WS, p: Player) {
  const r = p.room;
  if (!r) return;
  r.members.delete(ws);
  p.room = null;
  ws.unsubscribe(`r:${r.code}`);
  if (!r.members.size) r.emptySince = Date.now();
  toRoom(r, { t: 'leave', id: p.id });
}

function enterRoom(ws: WS, p: Player, r: Room, pos?: number[]) {
  if (p.room === r) return;
  if (r.members.size >= ROOM_MAX) return send(ws, { t: 'roomError', msg: 'Partie pleine' });
  leaveRoom(ws, p);
  if (pos && pos.length === 4 && pos.every(Number.isFinite)) [p.x, p.y, p.z, p.yaw] = pos;
  const list = [...r.members].map((w) => w.getUserData() as Player).map((o) => ({ id: o.id, name: o.name }));
  r.members.add(ws);
  p.room = r;
  p.dirty = true;
  ws.subscribe(`r:${r.code}`);
  send(ws, { t: 'joined', room: roomInfo(r), players: list });
  const full = snapshot(r, true); if (full) ws.send(full, true);
  toRoom(r, { t: 'join', id: p.id, name: p.name });
}

function snapshot(r: Room, all: boolean): ArrayBuffer | null {
  const list: Player[] = [];
  for (const ws of r.members) {
    const p = ws.getUserData() as Player;
    if (all || p.dirty) list.push(p);
  }
  if (!list.length) return null;
  const buf = new ArrayBuffer(3 + list.length * SNAP_ENTRY);
  const v = new DataView(buf);
  v.setUint8(0, B_SNAP); v.setUint16(1, list.length, true);
  let o = 3;
  for (const p of list) {
    v.setUint16(o, p.id, true);
    v.setFloat32(o + 2, p.x, true); v.setFloat32(o + 6, p.y, true);
    v.setFloat32(o + 10, p.z, true); v.setFloat32(o + 14, p.yaw, true);
    o += SNAP_ENTRY;
    if (!all) p.dirty = false;
  }
  return buf;
}

function onPlayerMsg(ws: WS, p: Player, raw: ArrayBuffer, isBinary: boolean) {
  if (isBinary) {
    if (raw.byteLength !== POS_BYTES || !p.room) return;
    const v = new DataView(raw);
    if (v.getUint8(0) !== B_POS) return;
    const x = v.getFloat32(1, true), y = v.getFloat32(5, true), z = v.getFloat32(9, true), yaw = v.getFloat32(13, true);
    if (![x, y, z, yaw].every(Number.isFinite)) return;
    p.x = x; p.y = y; p.z = z; p.yaw = yaw; p.dirty = true;
    return;
  }
  // Les gros messages (screenshots) sont réservés aux devs
  if (raw.byteLength > 4096 && !p.dev) return ws.end(1009, 'too big');
  let m: ClientMsg;
  try { m = JSON.parse(dec.decode(raw)); } catch { return; }

  if (m.t === 'hello') {
    // re-hello autorisé hors partie : le joueur change son pseudo dans le menu
    if (p.hello) { if (!p.room) p.name = clean(m.name, 16, 'Inconnu'); return; }
    p.hello = true;
    p.name = clean(m.name, 16, 'Inconnu');
    p.dev = devName(m.dev);
    ws.subscribe('all');
    if (p.dev) ws.subscribe('dev');
    send(ws, { t: 'welcome', id: p.id, version, dev: !!p.dev });
    if (p.dev) send(ws, { t: 'bridges', bridges: bridgeList() });
    return;
  }
  if (!p.hello) return;

  switch (m.t) {
    case 'create': {
      const now = Date.now();
      if (now - p.lastCreate < 3000) return send(ws, { t: 'roomError', msg: 'Doucement…' });
      p.lastCreate = now;
      const r = createRoom(newCode());
      if (!r) return send(ws, { t: 'roomError', msg: 'Trop de parties en cours' });
      return enterRoom(ws, p, r);
    }
    case 'join': {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
      let r = rooms.get(code);
      // Serveur redémarré pendant un déploiement : la partie est recréée à l'identique
      if (!r && m.recreate && code.length === CODE_LEN) r = createRoom(code) ?? undefined;
      if (!r) return send(ws, { t: 'roomError', msg: 'Code introuvable' });
      return enterRoom(ws, p, r, m.pos);
    }
    case 'leaveRoom':
      return leaveRoom(ws, p);
    case 'devPrompt': {
      if (!p.dev) return;
      const b = bridges.get(String(m.bridge));
      if (!b) return send(ws, { t: 'devAck', ok: false, msg: 'Bridge introuvable (déconnecté ?)' });
      const prompt = String(m.prompt || '').slice(0, 8000);
      const image = String(m.image || '');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 6_000_000)
        return send(ws, { t: 'devAck', ok: false, msg: 'Image invalide' });
      const reqId = randomBytes(8).toString('hex');
      pending.set(reqId, { ws, t: Date.now() });
      return send(b, { t: 'prompt', reqId, from: p.dev, prompt, image });
    }
    case 'devTask': {
      if (!p.dev || !['delete', 'clear'].includes(m.op)) return;
      const b = bridges.get(String(m.bridge));
      if (!b) return send(ws, { t: 'devAck', ok: false, msg: 'Bridge introuvable (déconnecté ?)' });
      return send(b, { t: 'taskOp', from: p.dev, op: m.op, id: m.id === undefined ? undefined : String(m.id) });
    }
  }
}

function onBridgeMsg(ws: WS, b: Bridge, raw: ArrayBuffer) {
  let m: BridgeMsg;
  try { m = JSON.parse(dec.decode(raw)); } catch { return; }
  if (!b.authed) {
    const dev = m.t === 'bridgeHello' ? devName(m.token) : null;
    if (!dev || m.t !== 'bridgeHello') return ws.end(4001, 'unauthorized');
    b.authed = true; b.dev = dev; b.host = String(m.host).slice(0, 40);
    bridges.set(b.id, ws);
    ws.subscribe('bridges');
    boardChanged();
    return;
  }
  if (m.t === 'tasks') {
    b.tasks = (Array.isArray(m.tasks) ? m.tasks : []).slice(0, 80).map((t) => ({ ...t, prompt: String(t.prompt ?? '').slice(0, 600), msg: String(t.msg ?? '').slice(0, 600) }));
    boardChanged();
  } else if (m.t === 'delivered') {
    const req = pending.get(m.reqId);
    pending.delete(m.reqId);
    if (req && players.get((req.ws.getUserData() as Player).id) === req.ws) send(req.ws, { t: 'devAck', ok: m.ok, msg: m.msg });
  }
}

function readBody(res: uWS.HttpResponse, cb: (body: string) => void) {
  let chunks: Buffer[] = [];
  let size = 0;
  res.onData((ab, last) => {
    size += ab.byteLength;
    if (size > 16_384) { chunks = []; return; }
    chunks.push(Buffer.from(ab.slice(0)));
    if (last) cb(Buffer.concat(chunks).toString('utf8'));
  });
}

const app = uWS.App()
  .ws<Data>('/ws', {
    compression: uWS.DISABLED,
    maxPayloadLength: 6 * 1024 * 1024,
    maxBackpressure: 1024 * 1024,
    idleTimeout: 60,
    sendPingsAutomatically: true,
    upgrade: (res, req, ctx) => {
      const isBridge = req.getQuery('bridge') === '1';
      const data: Data = isBridge
        ? { kind: 'bridge', authed: false, id: randomBytes(6).toString('hex'), dev: '', host: '', tasks: [] }
        : { kind: 'player', id: 0, name: '', dev: null, hello: false, room: null, x: 0, y: 0, z: 0, yaw: 0, dirty: false, lastCreate: 0 };
      res.upgrade(data, req.getHeader('sec-websocket-key'), req.getHeader('sec-websocket-protocol'),
        req.getHeader('sec-websocket-extensions'), ctx);
    },
    open: (ws) => {
      const d = ws.getUserData();
      if (d.kind === 'bridge') return;
      if (players.size >= MAX_PLAYERS) return ws.end(4003, 'full');
      while (players.has(nextId)) nextId = (nextId % 65000) + 1;
      d.id = nextId++;
      players.set(d.id, ws);
    },
    message: (ws, raw, isBinary) => {
      const d = ws.getUserData();
      if (d.kind === 'bridge') onBridgeMsg(ws, d, raw);
      else onPlayerMsg(ws, d, raw, isBinary);
    },
    close: (ws) => {
      const d = ws.getUserData();
      if (d.kind === 'bridge') {
        if (bridges.delete(d.id)) boardChanged();
        return;
      }
      if (players.get(d.id) !== ws) return;
      players.delete(d.id);
      const r = d.room;
      if (r) {
        r.members.delete(ws);
        if (!r.members.size) r.emptySince = Date.now();
        toRoom(r, { t: 'leave', id: d.id });
      }
    },
  })
  .get('/api/health', (res) => {
    res.cork(() => res.end(JSON.stringify({ ok: true, players: players.size, rooms: rooms.size, bridges: bridges.size, version: version?.v })));
  })
  // Appelé par la pipeline GitHub Actions : notifie les devs (toast "correction...") et pousse la nouvelle version
  .post('/api/deploy', (res, req) => {
    const token = req.getHeader('x-deploy-token');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    readBody(res, (body) => {
      if (aborted) return;
      if (!DEPLOY_TOKEN || !safeEq(token, DEPLOY_TOKEN)) return res.cork(() => res.writeStatus('401').end('no'));
      let m: { state?: string; msg?: string } = {};
      try { m = JSON.parse(body); } catch {}
      const state = (['building', 'deploying', 'done', 'failed'].includes(m.state!) ? m.state : 'building') as 'building' | 'deploying' | 'done' | 'failed';
      if (state === 'done') {
        loadVersion();
        if (version) broadcastAll({ t: 'version', version });
      }
      app.publish('dev', JSON.stringify({ t: 'devStatus', state, msg: String(m.msg || '').slice(0, 200) } satisfies ServerMsg), false);
      res.cork(() => res.end('ok'));
    });
  })
  .any('/*', (res) => { res.cork(() => res.writeStatus('404').end()); });

// Tick réseau : par partie, n'envoie que les joueurs qui ont bougé, en un seul publish binaire.
let tick = 0;
setInterval(() => {
  tick++;
  const now = Date.now();
  for (const r of rooms.values()) {
    if (!r.members.size) {
      if (now - r.emptySince > EMPTY_ROOM_TTL) rooms.delete(r.code);
      continue;
    }
    const snap = snapshot(r, false);
    if (snap) app.publish(`r:${r.code}`, snap, true);
  }
  if (tick % 100 === 0) for (const [k, v] of pending) if (now - v.t > 30_000) pending.delete(k);
}, 1000 / TICK_HZ);

app.listen(HOST, PORT, (ok) => {
  if (!ok) { console.error('listen failed', PORT); process.exit(1); }
  console.log(`december server ws://${HOST}:${PORT}/ws version=${version?.v ?? 'dev'} devs=${DEV_TOKENS.size}`);
});
