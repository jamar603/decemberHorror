// Lieux à explorer dans la forêt (chargés par world.ts, donc remplacés à chaud avec lui) :
// voiture abandonnée, campement, cabane + puits, mirador, chapelle en ruine + cimetière, cercle de pierres,
// poteaux électriques le long de la route. Géométrie procédurale fusionnée par lieu, collisions (rectangles locaux)
// et planchers (cabane, chapelle).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type SiteKind = 'car' | 'camp' | 'cabin' | 'tower' | 'chapel' | 'stones';
export interface Site { kind: SiteKind; x: number; z: number; yaw: number; r: number; flat: number; h: number }
type Rect = [number, number, number, number];                 // x0, z0, x1, z1 (repère local du lieu)
type Floor = [number, number, number, number, number];       // + hauteur du plancher

export interface SiteKit {
  hash: (a: number, b: number) => number;
  heightAt: (x: number, z: number) => number;
  roadX: (z: number) => number;
  patch: <M extends THREE.Material>(m: M, o?: { wind?: number }) => M;
  keep: <T extends { dispose(): void }>(o: T) => T;
}

// Emplacements le long de la route (z < 0 = devant le joueur au départ). Calculés avant le relief final :
// le terrain est aplani autour de chaque lieu (flat) et la forêt dégagée (r).
export function planSites(hash: SiteKit['hash'], roadX: SiteKit['roadX'], baseH: SiteKit['heightAt']): Site[] {
  const defs: [SiteKind, number, number, number, number][] = [   // type, z, écart à la route, dégagement, aplanissement
    ['car', -38, 4.8, 6, 0],
    ['camp', -95, 15, 10, 7],
    ['cabin', -175, 24, 15, 11],
    ['tower', -250, 26, 6, 3],
    ['chapel', -340, 34, 24, 18],
    ['stones', 125, 40, 14, 11],
  ];
  return defs.map(([kind, z0, off, r, flat], i) => {
    const z = z0 + (hash(i, 31) - 0.5) * 30;
    const side = kind === 'car' || hash(i * 13, 777) < 0.5 ? 1 : -1;
    const x = roadX(z) + side * (off + (kind === 'car' ? 0 : hash(i, 57) * 8));
    const yaw = kind === 'car' ? Math.PI / 2 + 0.3 : Math.atan2(roadX(z) - x, 0) + (hash(i, 91) - 0.5) * 0.5;   // face à la route
    let h = 0;
    for (const [dx, dz] of [[0, 0], [flat * 0.6, 0], [-flat * 0.6, 0], [0, flat * 0.6], [0, -flat * 0.6]]) h += baseH(x + dx, z + dz) / 5;
    return { kind, x, z, yaw, r, flat, h };
  });
}

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const WOOD = C(0.15, 0.1, 0.065), WOOD_OLD = C(0.19, 0.17, 0.14), STONE = C(0.19, 0.19, 0.18), MOSS = C(0.12, 0.15, 0.1);
const RUST = C(0.21, 0.075, 0.05), METAL = C(0.05, 0.05, 0.055), GLASS = C(0.015, 0.02, 0.03), ROOF = C(0.08, 0.085, 0.065);

// Pièces d'un lieu, fusionnées en 2 maillages (opaque + lueurs)
class Parts {
  solid: THREE.BufferGeometry[] = [];
  glow: THREE.BufferGeometry[] = [];
  private e = new THREE.Euler(); private m = new THREE.Matrix4();
  constructor(private rnd: () => number) {}
  put(g: THREE.BufferGeometry, col: THREE.Color, p: [number, number, number], r: [number, number, number] = [0, 0, 0], glow = false) {
    const ng = g.index ? g.toNonIndexed() : g; if (ng !== g) g.dispose();
    ng.deleteAttribute('uv');
    ng.applyMatrix4(this.m.makeRotationFromEuler(this.e.set(r[0], r[1], r[2]))); ng.translate(p[0], p[1], p[2]);
    const n = ng.attributes.position.count, c = new Float32Array(n * 3), k = glow ? 1 : 0.8 + 0.35 * this.rnd();
    for (let i = 0; i < n; i++) c.set([col.r * k, col.g * k, col.b * k], i * 3);
    ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
    (glow ? this.glow : this.solid).push(ng);
  }
  box(w: number, h: number, d: number, col: THREE.Color, p: [number, number, number], r?: [number, number, number], glow = false) { this.put(new THREE.BoxGeometry(w, h, d), col, p, r, glow); }
  cyl(rt: number, rb: number, h: number, col: THREE.Color, p: [number, number, number], r?: [number, number, number], seg = 8, glow = false) { this.put(new THREE.CylinderGeometry(rt, rb, h, seg), col, p, r, glow); }
  cone(rad: number, h: number, seg: number, col: THREE.Color, p: [number, number, number], r?: [number, number, number]) { this.put(new THREE.ConeGeometry(rad, h, seg), col, p, r); }
  rock(s: [number, number, number], col: THREE.Color, p: [number, number, number], r?: [number, number, number], glow = false) {
    const g = new THREE.IcosahedronGeometry(1, 1); g.scale(s[0], s[1], s[2]); this.put(g, col, p, r, glow);
  }
  log(a: [number, number, number], b: [number, number, number], rad: number, col: THREE.Color) {   // cylindre entre deux points
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), L = d.length();
    const g = new THREE.CylinderGeometry(rad, rad, L, 7).toNonIndexed(); g.deleteAttribute('uv');
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    const mid = A.add(B).multiplyScalar(0.5); this.put(g, col, [mid.x, mid.y, mid.z]);
  }
}

export function buildSites(kit: SiteKit, sites: Site[]) {
  const group = new THREE.Group();
  const solidMat = kit.patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  const glowMat = kit.patch(new THREE.MeshBasicMaterial({ vertexColors: true }));
  type Flicker = { light: THREE.Light; base: number; mode: 'fire' | 'lamp' | 'dying' };
  const flickers: Flicker[] = [];
  const placed: { s: Site; cos: number; sin: number; rects: Rect[]; floors: Floor[] }[] = [];

  for (const [si, s] of sites.entries()) {
    let a = 1013 + si * 7919;
    const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const P = new Parts(rnd), rects: Rect[] = [], floors: Floor[] = [], lights: THREE.Object3D[] = [];
    const light = (l: THREE.Light, pos: [number, number, number], mode: Flicker['mode']) => { l.position.set(...pos); lights.push(l); flickers.push({ light: l, base: l.intensity, mode }); return l; };

    if (s.kind === 'car') {
      // berline rouillée, portière ouverte, un phare qui grésille encore
      P.box(4.2, 0.75, 1.8, RUST, [0, 0.7, 0]);
      P.box(1.1, 0.12, 1.7, RUST, [1.5, 1.12, 0], [0, 0, -0.08]);
      P.box(2.0, 0.65, 1.6, RUST, [-0.35, 1.4, 0]);
      P.box(1.9, 0.42, 1.64, GLASS, [-0.35, 1.42, 0]);
      P.box(0.05, 0.45, 1.5, GLASS, [0.67, 1.42, 0], [0, 0, -0.35]);
      P.box(0.12, 0.2, 1.9, METAL, [2.15, 0.45, 0]); P.box(0.12, 0.2, 1.9, METAL, [-2.15, 0.45, 0]);
      for (const [wx, wz, wy] of [[1.35, 0.85, 0.36], [1.35, -0.85, 0.36], [-1.35, 0.85, 0.36], [-1.35, -0.85, 0.24]]) P.cyl(0.36, 0.36, 0.25, METAL, [wx, wy, wz], [Math.PI / 2, 0, 0], 12);
      P.box(1.0, 0.6, 0.06, RUST, [-0.05, 1.0, 1.3], [0, -0.75, 0]);              // portière ouverte
      P.box(0.06, 0.14, 0.3, C(1, 0.92, 0.7), [2.11, 0.85, 0.6], undefined, true);  // phare allumé
      P.box(0.06, 0.14, 0.3, METAL, [2.11, 0.85, -0.6]);                           // phare cassé
      P.box(0.5, 0.3, 0.4, C(0.1, 0.09, 0.07), [-1.0, 0.0, 1.9], [0.2, 0.7, 0]);   // valise tombée
      const spot = new THREE.SpotLight(0xffe2b0, 90, 45, 0.33, 0.6, 2);
      light(spot, [2.2, 0.85, 0.6], 'dying'); spot.target.position.set(16, -0.5, 3); lights.push(spot.target);
      rects.push([-2.2, -1.0, 2.2, 1.0]);
    } else if (s.kind === 'camp') {
      // feu de camp encore rougeoyant, tentes (une effondrée), bancs, sac abandonné
      for (let i = 0; i < 11; i++) { const an = (i / 11) * Math.PI * 2; P.rock([0.28, 0.2, 0.25], MOSS, [Math.cos(an) * 0.95, 0.08, Math.sin(an) * 0.95], [0, an, 0]); }
      P.cyl(0.8, 0.8, 0.04, C(0.05, 0.045, 0.04), [0, 0.02, 0], undefined, 14);
      for (const an of [0.2, 1.3, 2.4]) P.cyl(0.08, 0.08, 1.1, C(0.035, 0.03, 0.025), [0, 0.15, 0], [0, an, Math.PI / 2]);
      for (let i = 0; i < 7; i++) P.rock([0.08, 0.05, 0.08], C(1, 0.38 + rnd() * 0.15, 0.08), [(rnd() - 0.5) * 0.9, 0.08, (rnd() - 0.5) * 0.9], undefined, true);
      P.cone(1.7, 2.0, 4, C(0.11, 0.14, 0.09), [4, 1.0, -1.6], [0, Math.PI / 4 + 0.3, 0]);
      P.box(0.9, 1.0, 0.02, C(0.01, 0.01, 0.01), [3.6, 0.5, -0.65], [0, 0.3, 0]);   // entrée sombre
      P.cone(1.8, 0.7, 4, C(0.24, 0.07, 0.06), [-3.3, 0.33, 2.2], [0.15, 0.6, 0.12]);
      P.cyl(0.22, 0.22, 2.4, WOOD, [0, 0.22, -2.4], [0, 0, Math.PI / 2]);
      P.cyl(0.22, 0.22, 2.4, WOOD, [2.3, 0.22, 1.3], [0, 1.1, Math.PI / 2]);
      P.box(0.35, 0.5, 0.25, C(0.15, 0.12, 0.08), [-1.6, 0.22, -1.2], [0.3, 0.4, 0]);
      P.log([-0.6, 0, 0.4], [0, 1.3, 0], 0.025, METAL); P.log([0.6, 0, 0.4], [0, 1.3, 0], 0.025, METAL); P.log([0, 0, -0.7], [0, 1.3, 0], 0.025, METAL);
      P.cyl(0.18, 0.15, 0.25, METAL, [0, 0.85, 0]);                                // marmite suspendue
      light(new THREE.PointLight(0xff7a2a, 28, 24, 2), [0, 0.6, 0], 'fire');
      rects.push([2.8, -2.8, 5.2, -0.4]);
    } else if (s.kind === 'cabin') {
      // cabane en rondins (on peut entrer), toit en partie effondré, lanterne allumée à l'intérieur, puits
      P.box(6.6, 4, 5.6, STONE, [0, -1.7, 0]);
      P.box(6, 0.1, 5, WOOD_OLD, [0, 0.35, 0]);
      for (let i = 0; i < 8; i++) {
        const y = 0.55 + i * 0.3;
        P.cyl(0.16, 0.16, 6.6, WOOD, [0, y, -2.5], [0, 0, Math.PI / 2]);
        P.cyl(0.16, 0.16, 5.6, WOOD, [-3, y + 0.15, 0], [Math.PI / 2, 0, 0]);
        P.cyl(0.16, 0.16, 5.6, WOOD, [3, y + 0.15, 0], [Math.PI / 2, 0, 0]);
        const gaps: [number, number][] = [];   // porte, fenêtre
        if (i < 7) gaps.push([-0.5, 0.5]);
        if (i >= 3 && i <= 5) gaps.push([-2.2, -1.2]);
        let x0 = -3.3;
        for (const [g0, g1] of [...gaps.sort((p, q) => p[0] - q[0]), [3.3, 3.3]]) {
          if (g0 - x0 > 0.05) P.cyl(0.16, 0.16, g0 - x0, WOOD, [(x0 + g0) / 2, y, 2.5], [0, 0, Math.PI / 2]);
          x0 = g1;
        }
      }
      for (let k = 0; k < 5; k++) for (const z of [-2.5, 2.5]) P.box(6 * (1 - k / 5), 0.25, 0.22, WOOD_OLD, [0, 3.0 + k * 0.25, z]);   // pignons
      P.box(3.7, 0.12, 6.4, ROOF, [-1.7, 3.5, 0], [0, 0, 0.37]);
      P.box(3.7, 0.12, 3.6, ROOF, [1.7, 3.5, -1.4], [0, 0, -0.37]);                // pan droit à moitié effondré
      P.box(3.2, 0.12, 2.4, ROOF, [4.3, 0.9, 1.6], [0.2, 0, -1.0]);                // morceau tombé contre le mur
      P.box(0.8, 4.8, 0.8, STONE, [-3.45, 2.2, -1.4]);
      P.box(0.95, 2.0, 0.06, WOOD_OLD, [0.67, 1.4, 3.04], [0, -1.2, 0]);           // porte entrouverte
      P.box(1.0, 0.9, 0.04, C(0.75, 0.45, 0.18), [-1.7, 1.6, 2.42], undefined, true);  // fenêtre éclairée
      P.box(0.06, 0.9, 0.1, WOOD, [-1.7, 1.6, 2.5]); P.box(1.0, 0.06, 0.1, WOOD, [-1.7, 1.6, 2.5]);
      P.box(1.4, 0.3, 0.7, WOOD_OLD, [0, 0.15, 2.95]);                             // marche
      P.box(1.2, 0.08, 0.8, WOOD, [-1.2, 1.15, -1.2]);
      for (const [lx, lz] of [[-0.6, -0.4], [-0.6, 0.4], [0.6, -0.4], [0.6, 0.4]]) P.box(0.07, 0.75, 0.07, WOOD, [-1.2 + lx * 0.9, 0.77, -1.2 + lz * 0.8]);
      P.box(0.45, 0.06, 0.45, WOOD, [0.1, 0.62, -0.6], [1.4, 0.4, 0]);             // chaise renversée
      P.box(1.9, 0.4, 0.9, C(0.12, 0.1, 0.08), [1.8, 0.6, -1.8]);
      P.box(0.15, 0.25, 0.15, C(1, 0.72, 0.35), [-1.2, 1.32, -1.2], undefined, true);
      light(new THREE.PointLight(0xffa050, 7, 14, 2), [-1.2, 1.7, -1.2], 'lamp');
      // puits
      P.cyl(0.9, 0.95, 0.8, STONE, [5.5, 0.4, 3.5], undefined, 14); P.cyl(0.74, 0.74, 0.02, C(0, 0, 0), [5.5, 0.81, 3.5], undefined, 14);
      P.cyl(0.07, 0.07, 1.9, WOOD, [4.65, 1.3, 3.5]); P.cyl(0.07, 0.07, 1.9, WOOD, [6.35, 1.3, 3.5]);
      P.cyl(0.05, 0.05, 1.8, WOOD, [5.5, 1.9, 3.5], [0, 0, Math.PI / 2]);
      P.box(2.1, 0.06, 0.8, ROOF, [5.5, 2.4, 3.2], [0.5, 0, 0]); P.box(2.1, 0.06, 0.8, ROOF, [5.5, 2.4, 3.8], [-0.5, 0, 0]);
      P.cyl(0.14, 0.11, 0.25, METAL, [5.5, 1.3, 3.5]);
      rects.push([-3.3, -2.75, 3.3, -2.25], [-3.25, -2.75, -2.75, 2.75], [2.75, -2.75, 3.25, 2.75], [-3.3, 2.25, -0.5, 2.75], [0.5, 2.25, 3.3, 2.75],
        [-3.9, -1.85, -3.0, -0.95], [4.55, 2.55, 6.45, 4.45]);
      floors.push([-2.85, -2.35, 2.85, 2.35, 0.4], [-0.7, 2.35, 0.7, 3.3, 0.3]);
    } else if (s.kind === 'tower') {
      // mirador de chasse
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        P.log([lx * 1.35, -0.5, lz * 1.35], [lx * 1.05, 6, lz * 1.05], 0.1, WOOD);
        rects.push([lx * 1.25 - 0.25, lz * 1.25 - 0.25, lx * 1.25 + 0.25, lz * 1.25 + 0.25]);
      }
      for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
        P.log([ax * 1.3, 0.6, az * 1.3], [bx * 1.1, 5.2, bz * 1.1], 0.05, WOOD_OLD);
        P.log([bx * 1.3, 0.6, bz * 1.3], [ax * 1.1, 5.2, az * 1.1], 0.05, WOOD_OLD);
      }
      P.box(2.6, 0.15, 2.6, WOOD_OLD, [0, 6, 0]);
      P.box(2.6, 0.9, 0.06, WOOD_OLD, [0, 6.5, -1.27]); P.box(0.06, 0.9, 2.6, WOOD_OLD, [-1.27, 6.5, 0]); P.box(0.06, 0.9, 2.6, WOOD_OLD, [1.27, 6.5, 0]);
      P.box(0.9, 0.9, 0.06, WOOD_OLD, [-0.85, 6.5, 1.27]);
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P.cyl(0.05, 0.05, 2.0, WOOD, [lx * 1.22, 7.0, lz * 1.22]);
      P.cone(2.1, 1.1, 4, ROOF, [0, 8.5, 0], [0, Math.PI / 4, 0]);
      for (const lx of [-0.3, 0.3]) P.log([lx, 0, 2.6], [lx, 6.1, 1.3], 0.04, WOOD);
      for (let i = 1; i < 14; i++) { const t = i / 14; P.cyl(0.025, 0.025, 0.6, WOOD, [0, t * 6.1, 2.6 - t * 1.3], [0, 0, Math.PI / 2]); }
      P.log([0.9, 5.9, 1.3], [0.9, 4.4, 1.35], 0.012, C(0.14, 0.12, 0.09));           // corde qui pend
    } else if (s.kind === 'chapel') {
      // chapelle en ruine (murs écroulés, poutres calcinées, bougies sur l'autel) + cimetière
      P.box(7.6, 3, 12.2, STONE, [0, -1.45, -0.25]);
      P.box(7.4, 0.2, 12, C(0.15, 0.15, 0.14), [0, 0.05, -0.25]);
      const ruin = () => (rnd() < 0.35 ? 1.2 + rnd() * 2.2 : rnd() * 0.5);
      for (let z = -5.75; z <= 5.25; z += 1) for (const x of [-3.5, 3.5]) { const H = Math.max(1.4, 4.6 - ruin()); P.box(0.6, H, 1.02, rnd() < 0.3 ? MOSS : STONE, [x, H / 2, z]); }
      for (let x = -3; x <= 3; x += 1) {
        const gable = 4.6 + (3.5 - Math.abs(x)) * 0.7;
        const Hb = Math.max(1.4, gable - ruin()); P.box(1.02, Hb, 0.6, STONE, [x, Hb / 2, -6]);
        if (Math.abs(x) < 0.9) continue;   // porte
        const Hf = Math.abs(x) < 2 ? gable : Math.max(1.4, gable - ruin()); P.box(1.02, Hf, 0.6, STONE, [x, Hf / 2, 5.5]);
      }
      P.box(1.8, 0.6, 0.6, STONE, [0, 3.3, 5.5]); P.box(1.8, 2.4, 0.6, STONE, [0, 4.8, 5.5]);   // linteau + pignon
      P.box(0.16, 1.3, 0.16, METAL, [0, 7.0, 5.5]); P.box(0.75, 0.15, 0.16, METAL, [0, 7.25, 5.5]);
      for (const z of [-4, -1.5, 1]) P.cyl(0.13, 0.13, 7.6, C(0.04, 0.035, 0.03), [0, 4.4, z], [0, 0, Math.PI / 2 + (rnd() - 0.5) * 0.1]);
      P.log([-3.2, 4.3, 3.2], [1.5, 0.2, 2.2], 0.14, C(0.04, 0.035, 0.03));        // poutre tombée
      P.box(2, 1, 0.8, STONE, [0, 0.6, -5]);
      for (let i = 0; i < 6; i++) { const cx = -0.8 + i * 0.32, ch = 0.12 + rnd() * 0.2; P.cyl(0.03, 0.03, ch, C(0.85, 0.8, 0.7), [cx, 1.1 + ch / 2, -5 + (rnd() - 0.5) * 0.4]); P.rock([0.02, 0.04, 0.02], C(1, 0.75, 0.35), [cx, 1.13 + ch, -5], undefined, true); }
      for (let r = 0; r < 4; r++) for (const sx of [-1.6, 1.6]) {
        const over = rnd() < 0.3, rot: [number, number, number] = over ? [Math.PI / 2, (rnd() - 0.5) * 0.6, 0] : [0, (rnd() - 0.5) * 0.4, 0];
        P.box(2.2, 0.45, 0.5, WOOD, [sx, over ? 0.4 : 0.45, -2.8 + r * 1.8], rot);
      }
      for (let i = 0; i < 9; i++) P.rock([0.3 + rnd() * 0.4, 0.2 + rnd() * 0.25, 0.3 + rnd() * 0.4], STONE, [(rnd() - 0.5) * 6, 0.15, (rnd() - 0.5) * 10]);
      // cimetière
      for (let i = 0; i < 14; i++) {
        const gx = 5.6 + (i % 3) * 2.1 + (rnd() - 0.5) * 0.5, gz = -4.5 + Math.floor(i / 3) * 2.1 + (rnd() - 0.5) * 0.5, tilt: [number, number, number] = [(rnd() - 0.5) * 0.35, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.3];
        if (rnd() < 0.25) { P.box(0.1, 1.1, 0.1, WOOD_OLD, [gx, 0.5, gz], tilt); P.box(0.55, 0.09, 0.09, WOOD_OLD, [gx, 0.75, gz], tilt); }
        else { const th = 0.6 + rnd() * 0.5; P.box(0.6, th, 0.16, rnd() < 0.5 ? MOSS : STONE, [gx, th / 2, gz], tilt); P.cyl(0.3, 0.3, 0.16, STONE, [gx, th, gz], [Math.PI / 2 + tilt[0], tilt[1], tilt[2]], 10); }
        P.rock([0.5, 0.18, 0.95], C(0.07, 0.06, 0.045), [gx, 0, gz + 1.0]);
      }
      for (let k = 0; k < 30; k++) {   // grille rouillée, poteaux manquants
        const t = k / 30, [fx, fz] = t < 0.25 ? [4.6 + t * 4 * 7, -5.8] : t < 0.5 ? [11.6, -5.8 + (t - 0.25) * 4 * 11] : t < 0.75 ? [11.6 - (t - 0.5) * 4 * 7, 5.2] : [4.6, 5.2 - (t - 0.75) * 4 * 11];
        if (rnd() < 0.2) continue;
        P.cyl(0.025, 0.025, 1.2, METAL, [fx, 0.55, fz], [(rnd() - 0.5) * 0.3, 0, (rnd() - 0.5) * 0.3], 5);
      }
      rects.push([-3.8, -6.3, -3.2, 5.8], [3.2, -6.3, 3.8, 5.8], [-3.8, -6.3, 3.8, -5.7], [-3.8, 5.2, -0.6, 5.8], [0.6, 5.2, 3.8, 5.8], [-1, -5.4, 1, -4.6]);
      floors.push([-3.2, -5.7, 3.2, 5.2, 0.15]);
    } else if (s.kind === 'stones') {
      // cercle de menhirs, dalle tachée au centre, bougies froides
      for (let i = 0; i < 9; i++) {
        const an = (i / 9) * Math.PI * 2, R = 7, x = Math.cos(an) * R, z = Math.sin(an) * R, H = 2 + rnd() * 1.6;
        if (i === 4) { P.rock([0.6, 0.5, H], MOSS, [x, 0.3, z], [0, an, 0.1]); continue; }   // menhir tombé
        P.rock([0.65, H, 0.45], rnd() < 0.5 ? MOSS : STONE, [x, H * 0.75, z], [(rnd() - 0.5) * 0.15, an, (rnd() - 0.5) * 0.15]);
        rects.push([x - 0.6, z - 0.6, x + 0.6, z + 0.6]);
      }
      P.box(2.2, 0.5, 1.2, STONE, [0, 0.25, 0]); P.box(1.2, 0.02, 0.6, C(0.13, 0.015, 0.015), [0.1, 0.51, 0]);
      for (const [cx, cz] of [[-1.2, -0.7], [1.2, -0.7], [-1.2, 0.7], [1.2, 0.7]]) { P.cyl(0.04, 0.04, 0.25, C(0.8, 0.8, 0.75), [cx, 0.13, cz]); P.rock([0.025, 0.05, 0.025], C(0.6, 0.8, 1), [cx, 0.3, cz], undefined, true); }
      rects.push([-1.1, -0.6, 1.1, 0.6]);
    }

    const g = new THREE.Group();
    if (P.solid.length) { const geo = kit.keep(mergeGeometries(P.solid)!); P.solid.forEach((p) => p.dispose()); g.add(new THREE.Mesh(geo, solidMat)); }
    if (P.glow.length) { const geo = kit.keep(mergeGeometries(P.glow)!); P.glow.forEach((p) => p.dispose()); g.add(new THREE.Mesh(geo, glowMat)); }
    if (lights.length) g.add(...lights);
    const y = s.kind === 'car' ? kit.heightAt(s.x, s.z) + 0.05 : s.h;
    g.position.set(s.x, y, s.z); g.rotation.y = s.yaw;
    if (s.kind === 'car') g.rotation.z = 0.06;   // légèrement dans le fossé
    group.add(g);
    placed.push({ s, cos: Math.cos(s.yaw), sin: Math.sin(s.yaw), rects, floors });
  }

  // poteaux électriques + câbles le long de la route
  const poles: [number, number][] = [];
  {
    let a = 4242; const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
    const P = new Parts(rnd), wire: number[] = [];
    let prev: THREE.Vector3[] | null = null;
    for (let z = -460; z <= 460; z += 42) {
      const x = kit.roadX(z) - 6.5, y = kit.heightAt(x, z), lean = (rnd() - 0.5) * 0.08;
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.r)) { prev = null; continue; }
      poles.push([x, z]);
      P.cyl(0.11, 0.15, 9, WOOD, [x, y + 4.3, z], [lean, 0, lean * 0.5]);
      P.box(0.12, 0.12, 1.8, WOOD, [x + lean * 8.2 * 0.5, y + 8.2, z]);
      const tops = [-0.8, 0.8].map((o) => new THREE.Vector3(x + lean * 4, y + 8.35, z + o));
      for (const t of tops) P.cyl(0.04, 0.05, 0.15, C(0.2, 0.25, 0.2), [t.x, t.y - 0.05, t.z]);
      if (prev) for (let w = 0; w < 2; w++) {   // chaînette
        const A = prev[w], B = tops[w];
        for (let k = 0; k < 10; k++) {
          const t0 = k / 10, t1 = (k + 1) / 10, sag = (t: number) => 4 * t * (1 - t) * 1.3;
          wire.push(A.x + (B.x - A.x) * t0, A.y + (B.y - A.y) * t0 - sag(t0), A.z + (B.z - A.z) * t0, A.x + (B.x - A.x) * t1, A.y + (B.y - A.y) * t1 - sag(t1), A.z + (B.z - A.z) * t1);
        }
      }
      prev = tops;
    }
    const geo = kit.keep(mergeGeometries(P.solid)!); P.solid.forEach((p) => p.dispose()); group.add(new THREE.Mesh(geo, solidMat));
    const wg = kit.keep(new THREE.BufferGeometry()); wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    group.add(new THREE.LineSegments(wg, kit.patch(new THREE.LineBasicMaterial({ color: 0x050607 }))));
  }

  const R = 0.35;   // rayon du joueur
  const toLocal = (q: (typeof placed)[number], x: number, z: number) => { const dx = x - q.s.x, dz = z - q.s.z; return [dx * q.cos - dz * q.sin, dx * q.sin + dz * q.cos]; };
  return {
    group,
    /** zone à garder libre d'arbres/rochers */
    blocked: (x: number, z: number) => placed.some((q) => Math.hypot(x - q.s.x, z - q.s.z) < q.s.r) || poles.some(([px, pz]) => Math.abs(px - x) + Math.abs(pz - z) < 2.5),
    collide(p: THREE.Vector3) {
      for (const q of placed) {
        if (!q.rects.length || Math.hypot(p.x - q.s.x, p.z - q.s.z) > q.s.r + 4) continue;
        let [lx, lz] = toLocal(q, p.x, p.z), hit = false;
        for (const [x0, z0, x1, z1] of q.rects) {
          if (lx < x0 - R || lx > x1 + R || lz < z0 - R || lz > z1 + R) continue;
          const pen = [lx - (x0 - R), x1 + R - lx, lz - (z0 - R), z1 + R - lz], m = Math.min(...pen);
          if (m === pen[0]) lx = x0 - R; else if (m === pen[1]) lx = x1 + R; else if (m === pen[2]) lz = z0 - R; else lz = z1 + R;
          hit = true;
        }
        if (hit) { p.x = q.s.x + lx * q.cos + lz * q.sin; p.z = q.s.z - lx * q.sin + lz * q.cos; }
      }
      for (const [px, pz] of poles) {
        const dx = p.x - px, dz = p.z - pz, d = Math.hypot(dx, dz);
        if (d < 0.5 && d > 1e-4) { p.x = px + dx / d * 0.5; p.z = pz + dz / d * 0.5; }
      }
    },
    floor(p: THREE.Vector3) {
      for (const q of placed) {
        if (!q.floors.length) continue;
        const [lx, lz] = toLocal(q, p.x, p.z);
        for (const [x0, z0, x1, z1, y] of q.floors) if (lx > x0 && lx < x1 && lz > z0 && lz < z1) p.y = Math.max(p.y, q.s.h + y);
      }
    },
    update(time: number) {
      for (const [i, f] of flickers.entries()) {
        const t = time + i * 17;
        if (f.mode === 'fire') f.light.intensity = f.base * (0.7 + 0.18 * Math.sin(t * 11.3) * Math.sin(t * 7.1) + 0.12 * Math.sin(t * 23.7));
        else if (f.mode === 'lamp') f.light.intensity = f.base * (0.85 + 0.1 * Math.sin(t * 5.3) + (Math.sin(t * 0.37) > 0.97 ? -0.6 : 0));
        else f.light.intensity = f.base * (Math.sin(t * 0.8) * Math.sin(t * 2.3) > 0.55 ? (Math.sin(t * 61) > 0 ? 0.15 : 0.6) : 1);   // phare qui grésille
      }
    },
  };
}
