// Le monde : remplacé à chaud en prod (aucun rechargement). Mettre le contenu du jeu ici.
// Tout ce qui est ajouté à la scène doit être libéré dans dispose().
//
// Carte : vallée boisée de nuit dans le brouillard, relief généré par la graine de la partie (ctx.seed), route de terre
// sinueuse, forêt d'épicéas à perte de vue (près : épicéas détaillés branche par branche qui ondulent au vent, sous-bois,
// rochers moussus, troncs couchés ; loin : silhouettes), montagnes enneigées en fond, ciel étoilé + lune.
// Brouillard « de hauteur » calculé dans les shaders (épais dans les vallées, sommets qui émergent) + nappes de brume
// qui dérivent autour du joueur. Lieux à explorer (voiture, campement, cabane, mirador, chapelle, menhirs) : sites.ts.
// Le joueur suit le relief et bute contre les murs (update).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CreateWorld } from './types';
import { planSites, buildSites } from './sites';
// Herbes et buissons extraits de « a forest (3) with a road at night for game » — dasy444, CC-BY 4.0 (https://sketchfab.com/dasy444)
import kitUrl from './assets/forest-kit.glb?url';

// ---------- bruit déterministe (graine de la partie) ----------
function makeNoise(seed: number) {
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const vnoise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x: number, y: number, oct: number) => {
    let s = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, y * f); f *= 2.03; amp *= 0.5; }
    return s;
  };
  const ridged = (x: number, y: number, oct: number) => {
    let s = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { const n = 1 - Math.abs(vnoise(x * f, y * f) * 2 - 1); s += amp * n * n; f *= 2.1; amp *= 0.5; }
    return s;
  };
  return { hash, vnoise, fbm, ridged };
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const NEAR = 900;      // terrain détaillé (m) autour du centre
const FAR = 9000;      // terrain lointain (montagnes)
const SPRUCE_R = 190;  // épicéas détaillés ; au-delà : silhouettes
const ROAD_HALF = 3;   // demi-largeur de la route
const FOG = new THREE.Color(0x161d29);   // brume éclairée par la lune
const FOG_B = 1 / 24;  // décroissance du brouillard avec l'altitude (1/m)
const FOG_K = 0.0085;  // densité au niveau de la route

// Fonctions GLSL partagées (bruit de valeur)
const GLSL_NOISE = `float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(gh(i), gh(i+vec2(1,0)), f.x), mix(gh(i+vec2(0,1)), gh(i+vec2(1,1)), f.x), f.y); }
`;
// Brouillard de hauteur : intégrale analytique d'une densité exp(-b·y) le long du rayon caméra → fragment,
// modulée par un bruit lent (nappes plus ou moins épaisses qui dérivent).
const GLSL_FOG = `{ vec3 rd = vWp - cameraPosition; float d = length(rd), k = rd.y * ${FOG_B.toFixed(5)};
  float e = abs(k) < 1e-3 ? 1.0 : (1.0 - exp(-k)) / k;
  float patchy = 0.45 + 1.0 * gn(vWp.xz / 85.0 + vec2(uTime * 0.025, uTime * 0.011));
  float fa = ${FOG_K.toFixed(5)} * patchy * exp(-cameraPosition.y * ${FOG_B.toFixed(5)}) * d * e + 0.00011 * d;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFog, 1.0 - exp(-fa)); }`;

export const createWorld: CreateWorld = async (ctx) => {
  const root = new THREE.Group();
  const N = makeNoise(ctx.seed | 0);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(o: T) => { disposables.push(o); return o; };
  const uTime = { value: 0 }, uFog = { value: FOG };
  const aniso = ctx.renderer.capabilities.getMaxAnisotropy();

  // Brouillard + vent + grain du sol injectés dans les matériaux standards
  const patch = <M extends THREE.Material>(mat: M, o: { wind?: number; grain?: boolean } = {}) => {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime; sh.uniforms.uFog = uFog;
      const wind = o.wind ? `
        { vec4 ip = vec4(0.0, 0.0, 0.0, 1.0);
          #ifdef USE_INSTANCING
          ip = instanceMatrix * ip;
          #endif
          float sw = sin(uTime * 1.1 + ip.x * 0.09 + ip.z * 0.06) + 0.45 * sin(uTime * 2.9 + ip.z * 0.21 + ip.x * 0.13);
          float yy = transformed.y * transformed.y;
          transformed.x += sw * ${o.wind.toFixed(4)} * yy; transformed.z += sw * ${(o.wind * 0.55).toFixed(4)} * yy; }` : '';
      sh.vertexShader = 'uniform float uTime;\nvarying vec3 vWp;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>' + wind)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { vec4 wp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          #endif
          vWp = (modelMatrix * wp).xyz; }`);
      let frag = 'uniform float uTime;\nuniform vec3 uFog;\nvarying vec3 vWp;\n' + GLSL_NOISE + sh.fragmentShader;
      if (o.grain) frag = frag.replace('#include <color_fragment>', `#include <color_fragment>
        { float d = length(cameraPosition - vWp), k = 1.0 - smoothstep(20.0, 70.0, d);
          float g1 = gn(vWp.xz * 2.3), g2 = gn(vWp.xz * 9.0), g3 = gh(floor(vWp.xz * 22.0));
          diffuseColor.rgb *= mix(1.0, 0.7 + 0.35 * g1 + 0.2 * g2 + 0.15 * step(0.93, g3), k); }`);
      sh.fragmentShader = frag.replace('#include <fog_fragment>', GLSL_FOG);
    };
    return keep(mat);
  };
  const tint = (g: THREE.BufferGeometry, r: number, gg: number, b: number) => {
    const c = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < c.length; i += 3) c.set([r, gg, b], i);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g;
  };

  // ---------- relief ----------
  const roadX = (z: number) => Math.sin(z / 95 + 1.3) * 38 + Math.sin(z / 41) * 11;   // tracé de la route
  const hills = (x: number, z: number) => (N.fbm(x / 210, z / 210, 4) - 0.5) * 46 + (N.fbm(x / 55 + 7, z / 55, 3) - 0.5) * 7;
  const mountains = (x: number, z: number) => {
    const r = Math.hypot(x, z);
    const m = smooth(380, 1300, r + (N.vnoise(x / 400, z / 400) - 0.5) * 300);
    return m * (N.ridged(x / 900, z / 900, 5) * 900 + 60) + smooth(1500, 4000, r) * 250;
  };
  const rawH = (x: number, z: number) => hills(x, z) + mountains(x, z);
  const roadH = (z: number) => { const x = roadX(z); return hills(x, z) * 0.85; };  // chaussée adoucie
  const h0 = roadH(0);   // la route au point d'apparition est à y = 0
  const baseHeight = (x: number, z: number) => {
    let h = rawH(x, z);
    const d = Math.abs(x - roadX(z));
    if (d < 16) h += (roadH(z) - h) * smooth(16, ROAD_HALF + 1, d);   // déblai/remblai le long de la route
    return h - h0;
  };
  const sites = planSites(N.hash, roadX, baseHeight);   // lieux à explorer : terrain aplani autour
  const heightAt = (x: number, z: number) => {
    let h = baseHeight(x, z);
    for (const s of sites) {
      if (!s.flat) continue;
      const d = Math.hypot(x - s.x, z - s.z);
      if (d < s.flat + 8) h += (s.h - h) * smooth(s.flat + 8, s.flat, d);
    }
    return h;
  };
  const roadDist = (x: number, z: number) => Math.abs(x - roadX(z));
  const forestN = (x: number, z: number) => N.fbm(x / 120 + 1, z / 120, 3);   // densité de la forêt (= graine des épicéas)

  // ---------- sol (couleurs par sommet + détail dans le shader) ----------
  const colorAt = (x: number, z: number, h: number, slope: number, far: boolean, out: THREE.Color) => {
    const n1 = N.fbm(x / 30, z / 30, 3), n2 = N.vnoise(x / 6, z / 6);
    out.setRGB(0.045 + 0.03 * n1, 0.05 + 0.035 * n1, 0.03 + 0.015 * n2);                  // aiguilles, mousse, humus
    if (n2 > 0.62) out.lerp(new THREE.Color(0.075, 0.06, 0.04), 0.6);                      // feuilles mortes, terre
    const rock = smooth(0.45, 0.8, slope);
    out.lerp(new THREE.Color(0.11, 0.11, 0.105).multiplyScalar(0.8 + 0.4 * n1), rock);     // affleurements
    const rd = roadDist(x, z);
    if (!far) {
      out.multiplyScalar(1 - 0.45 * smooth(0.36, 0.52, forestN(x, z)) * smooth(ROAD_HALF + 2, ROAD_HALF + 6, rd));   // ombre des sous-bois
      if (rd < ROAD_HALF + 1.5) {
        const ruts = Math.abs(rd - 1.1) < 0.35 ? 0.75 : 1;                                // ornières
        out.lerp(new THREE.Color(0.1, 0.085, 0.065).multiplyScalar(ruts * (0.85 + 0.3 * n2)), smooth(ROAD_HALF + 1.5, ROAD_HALF - 0.5, rd));
      }
    }
    if (far) out.lerp(new THREE.Color(0.02, 0.03, 0.022), smooth(0.55, 0.3, slope) * smooth(520, 340, h)); // canopée lointaine
    const snow = smooth(330, 520, h + (n1 - 0.5) * 120) * smooth(0.85, 0.55, slope);
    out.lerp(new THREE.Color(0.55, 0.6, 0.7), snow);                                        // neige en altitude (décembre)
  };
  function terrainMesh(size: number, seg: number, far: boolean, yOff: number) {
    const g = new THREE.PlaneGeometry(size, size, seg, seg); g.rotateX(-Math.PI / 2);
    const P = g.attributes.position as THREE.BufferAttribute, col = new Float32Array(P.count * 3), c = new THREE.Color(), e = size / seg;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), z = P.getZ(i), h = heightAt(x, z);
      const slope = Math.min(1, Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e));
      P.setY(i, h + yOff); colorAt(x, z, h + h0, slope, far, c); col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
    const mat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97 }), { grain: !far });
    const m = new THREE.Mesh(g, mat); keep(g);
    return m;
  }
  const ground = terrainMesh(NEAR, 300, false, 0);
  const farGround = terrainMesh(FAR, 220, true, -1.5);   // passe sous le terrain proche
  root.add(ground, farGround);

  // ---------- ciel de nuit : dégradé, étoiles, lune ----------
  const skyMat = keep(new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { seed: { value: (ctx.seed % 1000) / 7 }, uFog },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: `varying vec3 vD; uniform float seed; uniform vec3 uFog;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164)) + seed) * 43758.5453); }
      void main(){
        float y = max(vD.y, 0.0);
        vec3 c = mix(vec3(0.06, 0.075, 0.105), vec3(0.01, 0.015, 0.03), pow(y, 0.45));       // halo d'horizon → zénith
        vec3 q = floor(vD * 420.0); float s = h(q);
        c += vec3(0.85, 0.9, 1.0) * step(0.9975, s) * (0.4 + 0.6 * h(q + 3.1)) * smoothstep(0.08, 0.35, y);   // étoiles
        c = mix(uFog, c, smoothstep(-0.02, 0.22, vD.y));                                       // brume sur l'horizon
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(5000, 32, 16)), skyMat); sky.renderOrder = -1; sky.frustumCulled = false;
  const canvasTex = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; draw(cv.getContext('2d')!);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; return keep(t);
  };
  const moonTex = canvasTex(256, 256, (g) => {
    const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    r.addColorStop(0, 'rgba(245,248,255,1)'); r.addColorStop(0.17, 'rgba(235,242,255,1)'); r.addColorStop(0.2, 'rgba(170,190,230,0.35)');
    r.addColorStop(0.45, 'rgba(120,140,190,0.1)'); r.addColorStop(1, 'rgba(100,120,170,0)');
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9; i++) {   // mers lunaires
      const a = i * 2.4, d = 8 + (i * 7) % 14; g.fillStyle = 'rgba(150,160,185,0.35)';
      g.beginPath(); g.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 4 + (i % 3) * 3, 0, Math.PI * 2); g.fill();
    }
  });
  const moonDir = new THREE.Vector3(-0.45, 0.42, -0.79).normalize();
  const moonMat = keep(new THREE.SpriteMaterial({ map: moonTex, fog: false, depthWrite: false, transparent: true }));
  const moon = new THREE.Sprite(moonMat); moon.scale.setScalar(1100); moon.position.copy(moonDir).multiplyScalar(4500);
  root.add(sky, moon);

  // ---------- lumières ----------
  const hemi = new THREE.HemisphereLight(0x50627f, 0x06070a, 0.6);
  const moonLight = new THREE.DirectionalLight(0xb4c4ff, 1.15);
  moonLight.position.copy(moonDir).multiplyScalar(200);
  root.add(hemi, moonLight);

  // ---------- outils de placement ----------
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
  type Inst = { x: number; z: number; y: number; s: number; sy: number; yaw: number; tilt: number; tint: number };
  const scatter = (step: number, r0: number, r1: number, salt: number, accept: (x: number, z: number, n: number) => boolean) => {
    const out: Inst[] = [];
    const k0 = Math.floor(-r1 / step), k1 = Math.ceil(r1 / step);
    for (let i = k0; i <= k1; i++) for (let j = k0; j <= k1; j++) {
      const x = (i + N.hash(i * 7 + salt, j)) * step, z = (j + N.hash(i, j * 13 + salt)) * step, r = Math.hypot(x, z);
      if (r < r0 || r > r1) continue;
      const n = N.fbm(x / 120 + salt, z / 120, 3);
      if (!accept(x, z, n)) continue;
      const hr = N.hash(i + salt, j + 99);
      out.push({ x, z, y: heightAt(x, z), s: hr, sy: N.hash(j, i + salt), yaw: N.hash(i * 3, j * 5 + salt) * Math.PI * 2, tilt: (N.hash(i + 1, j + salt) - 0.5) * 0.08, tint: N.hash(i * 11, j + salt) });
    }
    return out;
  };
  const slopeAt = (x: number, z: number) => Math.hypot(heightAt(x + 2, z) - heightAt(x - 2, z), heightAt(x, z + 2) - heightAt(x, z - 2)) / 4;
  const S = buildSites({ hash: N.hash, heightAt, roadX, patch, keep }, sites);
  root.add(S.group);
  const clearing = (x: number, z: number) => Math.hypot(x - roadX(0), z) < 9 || S.blocked(x, z);   // départ, lieux, poteaux
  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[], size: (t: Inst) => number, opts: { sink?: number; tint?: [number, number] } = {}) => {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    list.forEach((t, k) => {
      const h = size(t);
      _e.set(t.tilt, t.yaw, t.tilt * 0.7); _q.setFromEuler(_e);
      _p.set(t.x, t.y - (opts.sink ?? 0.15) * h, t.z); _s.set(h * (0.85 + 0.3 * t.sy), h, h * (0.85 + 0.3 * t.sy));
      _m.compose(_p, _q, _s); im.setMatrixAt(k, _m);
      const [a, b] = opts.tint ?? [0.75, 1.15]; im.setColorAt(k, _c.setScalar(a + (b - a) * t.tint));
    });
    im.count = list.length; root.add(im);
    return im;
  };

  // ---------- épicéas détaillés (procéduraux) ----------
  // Texture de branche : rameau principal, rameaux secondaires, milliers d'aiguilles (fond transparent)
  const branchTex = canvasTex(1024, 512, (g) => {
    let a = 9127;
    const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const W = 1024, H = 512, cy = H / 2;
    g.lineCap = 'round';
    const needles = (x0: number, y0: number, x1: number, y1: number, len: number) => {
      const n = Math.hypot(x1 - x0, y1 - y0) / 1.6, base = Math.atan2(y1 - y0, x1 - x0);
      for (let i = 0; i < n; i++) {
        const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        const an = base + (rnd() < 0.5 ? -1 : 1) * (0.55 + rnd() * 0.75), l = len * (0.6 + 0.5 * rnd()) * (1 - 0.45 * t);
        g.strokeStyle = `hsl(${100 + rnd() * 40},${26 + rnd() * 24}%,${12 + rnd() * 20}%)`; g.lineWidth = 2 + rnd() * 1.6;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(an) * l, y + Math.sin(an) * l); g.stroke();
      }
    };
    const stem = (x0: number, y0: number, x1: number, y1: number, w: number) => { g.strokeStyle = '#2b2219'; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
    stem(0, cy, W - 30, cy, 9);
    for (let i = 0; i < 22; i++) {
      const x = 30 + i * (W - 110) / 22 + rnd() * 16, side = i % 2 ? 1 : -1;
      const env = Math.sin(Math.PI * (0.12 + 0.82 * x / W)), L = H * 0.4 * env * (0.7 + 0.3 * rnd());
      const ex = x + L * 0.75, ey = cy + side * L * 0.66;
      stem(x, cy, ex, ey, 4); needles(x, cy, ex, ey, 40);
    }
    needles(0, cy, W - 20, cy, 48);
  });
  branchTex.generateMipmaps = true;

  // Un épicéa = étages de branches (cartes croisées, tombantes) + tronc + cœur sombre (masse du feuillage)
  const spruceFoliage = (tiers: number, width: number, salt: number) => {
    const cards: THREE.BufferGeometry[] = [];
    for (let t = 0; t < tiers; t++) {
      const f = t / (tiers - 1), y = 0.13 + f * 0.85, r = width * Math.pow(1 - f, 0.9) + 0.035;
      const K = Math.max(4, Math.round(5 + 7 * (1 - f))), droop = 0.22 + 0.32 * (1 - f);
      for (let k = 0; k < K; k++) {
        const h = N.hash(t * 31 + salt, k * 17 + salt);
        const p = new THREE.PlaneGeometry(1, 1); p.translate(0.5, 0, 0); p.scale(r * (0.95 + 0.3 * h), r * 0.78, 1);
        p.rotateX(Math.PI / 2 - 0.45 + (h - 0.5) * 0.5); p.rotateZ(-droop - (h - 0.5) * 0.15);
        p.rotateY((k + (t % 2) * 0.5 + (h - 0.5) * 0.5) / K * Math.PI * 2); p.translate(0, y, 0);
        const uv = p.attributes.uv, col = new Float32Array(uv.count * 3);
        for (let i = 0; i < uv.count; i++) { const v = (0.4 + 0.6 * uv.getX(i)) * (0.62 + 0.38 * f); col.set([v, v, v], i * 3); }
        p.setAttribute('color', new THREE.BufferAttribute(col, 3)); cards.push(p);
      }
    }
    const g = mergeGeometries(cards)!; cards.forEach((c) => c.dispose());
    // normales « bombées » vers l'extérieur et le haut : éclairage doux et volumique du feuillage
    const P = g.attributes.position, Nn = g.attributes.normal;
    for (let i = 0; i < P.count; i++) { _p.set(P.getX(i), 0.45, P.getZ(i)).normalize(); Nn.setXYZ(i, _p.x, _p.y, _p.z); }
    return keep(g);
  };
  const spruceSolid = (width: number) => {
    const trunk = tint(new THREE.CylinderGeometry(0.011, 0.028, 0.96, 7, 1, true).translate(0, 0.48, 0), 0.2, 0.15, 0.11);
    const core = tint(new THREE.ConeGeometry(width * 0.42, 0.8, 9, 1, true).translate(0, 0.16 + 0.4, 0), 0.035, 0.055, 0.04);
    const g = mergeGeometries([trunk, core])!; trunk.dispose(); core.dispose(); return keep(g);
  };
  const needleMat = patch(new THREE.MeshStandardMaterial({ map: branchTex, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, vertexColors: true, roughness: 0.9 }), { wind: 0.011 });
  const solidMat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), { wind: 0.011 });
  const variants = [
    { tiers: 15, width: 0.3, salt: 11 },   // épicéa classique
    { tiers: 13, width: 0.24, salt: 23 },  // élancé
    { tiers: 17, width: 0.36, salt: 37 },  // vieux sujet, large
  ].map((v) => ({ fol: spruceFoliage(v.tiers, v.width, v.salt), sol: spruceSolid(v.width) }));

  // forêt dense avec clairières, pas sur la route ni les pentes rocheuses
  const spruces = scatter(4.6, 0, SPRUCE_R, 1, (x, z, n) => n > 0.38 && roadDist(x, z) > ROAD_HALF + 2.5 && !clearing(x, z) && slopeAt(x, z) < 0.7);
  const spruceH = (t: Inst) => 11 + t.s * 17;
  variants.forEach((v, i) => {
    const list = spruces.filter((t) => Math.floor(t.sy * 3) === i);
    instanced(v.sol, solidMat, list, spruceH, { sink: 0.02, tint: [0.75, 1.1] });
    instanced(v.fol, needleMat, list, spruceH, { sink: 0.02, tint: [0.6, 1.1] });
  });
  // jeunes épicéas en lisière (route, clairières)
  const young = scatter(7, 0, SPRUCE_R, 2, (x, z, n) => n > 0.28 && n < 0.45 && roadDist(x, z) > ROAD_HALF + 1.8 && !clearing(x, z));
  instanced(variants[1].sol, solidMat, young, (t) => 2.5 + t.s * 5, { sink: 0.02 });
  instanced(variants[1].fol, needleMat, young, (t) => 2.5 + t.s * 5, { sink: 0.02, tint: [0.8, 1.2] });

  // silhouettes d'épicéas (cônes étagés) jusqu'au pied des montagnes
  const lodGeo = keep((() => {
    const parts = [0, 1, 2, 3].map((k) => tint(new THREE.ConeGeometry(0.3 - k * 0.06, 0.36, 7, 1, true).translate(0, 0.24 + k * 0.2, 0), 0.04 + 0.015 * k, 0.065 + 0.02 * k, 0.05 + 0.012 * k));
    parts.push(tint(new THREE.CylinderGeometry(0.012, 0.025, 0.25, 5, 1, true).translate(0, 0.125, 0), 0.15, 0.11, 0.08));
    const g = mergeGeometries(parts)!; parts.forEach((p) => p.dispose());
    const P = g.attributes.position, Nn = g.attributes.normal;
    for (let i = 0; i < P.count; i++) { _p.set(P.getX(i), 0.5, P.getZ(i)).normalize(); Nn.setXYZ(i, _p.x, _p.y, _p.z); }
    return g;
  })());
  const treeline = (x: number, z: number, n: number) => heightAt(x, z) + h0 < 380 + (n - 0.5) * 150 && slopeAt(x, z) < 0.65;
  const midTrees = scatter(6.5, SPRUCE_R - 15, 650, 1, (x, z, n) => n > 0.36 && roadDist(x, z) > ROAD_HALF + 2.5 && !clearing(x, z) && treeline(x, z, n));
  instanced(lodGeo, solidMat, midTrees, (t) => 12 + t.s * 14, { sink: 0.03, tint: [0.6, 1.15] });
  const farTrees = scatter(11, 640, 1700, 7, (x, z, n) => n > 0.3 && treeline(x, z, n));
  instanced(lodGeo, solidMat, farTrees, (t) => 15 + t.s * 12, { sink: 0.03, tint: [0.6, 1.1] });

  // ---------- sous-bois (kit) ----------
  const gltf = await new GLTFLoader().loadAsync(kitUrl);
  gltf.scene.updateMatrixWorld(true);
  const proto: Record<string, THREE.Mesh> = {};
  gltf.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) proto[(m.name || m.parent?.name || '').replace('proto_', '')] = m; });
  const byName = (k: string) => Object.entries(proto).find(([n]) => n.includes(k))?.[1];
  const bake = (m: THREE.Mesh) => {   // pied à y = 0, centré, hauteur 1
    const g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld); g.computeBoundingBox();
    const b = g.boundingBox!, c = b.getCenter(new THREE.Vector3()), k = 1 / (b.max.y - b.min.y);
    g.translate(-c.x, -b.min.y, -c.z); g.scale(k, k, k); g.computeBoundingSphere(); return keep(g);
  };
  const kitMat = byName('grass')!.material as THREE.MeshStandardMaterial;
  kitMat.transparent = false; kitMat.alphaTest = 0.45; kitMat.alphaToCoverage = true; kitMat.side = THREE.DoubleSide;
  if (kitMat.map) { kitMat.map.anisotropy = aniso; keep(kitMat.map); }
  const underMat = patch(kitMat, { wind: 0.05 });
  // buissons et arbustes
  const bushes = scatter(4.5, 0, 230, 3, (x, z, n) => n > 0.25 && roadDist(x, z) > ROAD_HALF + 0.8 && !clearing(x, z) && N.vnoise(x / 9, z / 9) > 0.45);
  instanced(bake(byName('treeB')!), underMat, bushes, (t) => 1.1 + t.s * 2.2, { sink: 0.08, tint: [0.3, 0.55] });
  // herbes et fougères (près du centre, très dense)
  const grass = scatter(1.1, 0, 100, 4, (x, z) => roadDist(x, z) > ROAD_HALF - 0.3 && !clearing(x, z) && N.vnoise(x / 4, z / 4) > 0.3);
  instanced(bake(byName('grass')!), underMat, grass, (t) => 0.35 + t.s * 0.6, { sink: 0.05, tint: [0.45, 0.85] });

  // rochers moussus (géométrie procédurale bosselée)
  const rockG = keep((() => {
    const g = new THREE.IcosahedronGeometry(1, 3), P = g.attributes.position as THREE.BufferAttribute, col = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
      _p.fromBufferAttribute(P, i); const n = N.fbm(_p.x * 1.7 + 5, _p.z * 1.7 + _p.y, 3);
      _p.multiplyScalar(0.75 + 0.5 * n); _p.y *= 0.62; P.setXYZ(i, _p.x, _p.y, _p.z);
      const moss = smooth(0.0, 0.5, _p.y) * (0.5 + n);   // mousse sur le dessus
      col.set([0.12 - 0.06 * moss, 0.12 - 0.02 * moss, 0.11 - 0.06 * moss], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
  })());
  const rockMat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  const rocks = scatter(14, 0, 330, 5, (x, z, n) => roadDist(x, z) > ROAD_HALF + 1 && !clearing(x, z) && N.hash(Math.floor(x), Math.floor(z)) > 0.45 && n > 0.2);
  instanced(rockG, rockMat, rocks, (t) => 0.5 + t.s * t.s * 2.6, { sink: 0.35, tint: [0.7, 1.2] });
  // troncs couchés, à plat dans la pente
  const logG = keep(tint(new THREE.CylinderGeometry(0.035, 0.045, 1, 9).translate(0, 0.5, 0), 0.09, 0.07, 0.055));
  const logMat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  const logs = scatter(24, 0, 300, 6, (x, z, n) => n > 0.4 && roadDist(x, z) > ROAD_HALF + 3 && !clearing(x, z));
  const logIm = new THREE.InstancedMesh(logG, logMat, Math.max(1, logs.length));
  logs.forEach((t, k) => {
    const L = 7 + t.s * 9, ax = Math.cos(t.yaw), az = Math.sin(t.yaw);
    const yA = heightAt(t.x - ax * L / 2, t.z - az * L / 2), yB = heightAt(t.x + ax * L / 2, t.z + az * L / 2);
    _e.set(0, -t.yaw, -Math.PI / 2 + Math.atan2(yB - yA, L), 'YZX'); _q.setFromEuler(_e);
    _p.set(t.x - ax * L / 2, yA + 0.3, t.z - az * L / 2); _s.set(L * 0.9, L, L * 0.9);   // (cylindre de hauteur 1 = longueur)
    _m.compose(_p, _q, _s); logIm.setMatrixAt(k, _m); logIm.setColorAt(k, _c.setScalar(0.7 + 0.4 * t.tint));
  });
  logIm.count = logs.length; root.add(logIm);

  // ---------- nappes de brume qui dérivent autour du joueur ----------
  const mistTex = canvasTex(256, 256, (g) => {
    for (let i = 0; i < 60; i++) {
      const x = 128 + (N.hash(i, 1) - 0.5) * 120, y = 128 + (N.hash(i, 2) - 0.5) * 60, r = 30 + N.hash(i, 3) * 60;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.09)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    }
  });
  const MIST_BOX = 150;
  const mist = Array.from({ length: 44 }, (_, i) => {
    const mat = keep(new THREE.SpriteMaterial({ map: mistTex, color: 0x6f7c92, transparent: true, depthWrite: false, fog: false, opacity: 0 }));
    const sp = new THREE.Sprite(mat); sp.scale.set(40 + N.hash(i, 5) * 40, 14 + N.hash(i, 6) * 10, 1); root.add(sp);
    return { sp, mat, x: (N.hash(i, 7) - 0.5) * MIST_BOX, z: (N.hash(i, 8) - 0.5) * MIST_BOX, up: 1.5 + N.hash(i, 9) * 6, a: 0.25 + N.hash(i, 10) * 0.35 };
  });
  const wrap = (v: number) => ((v % MIST_BOX) + MIST_BOX * 1.5) % MIST_BOX - MIST_BOX / 2;

  ctx.scene.add(root);
  // portée de vue : montagnes jusqu'à ~6 km (restaurée dans dispose)
  const cam0 = { near: ctx.camera.near, far: ctx.camera.far };
  ctx.camera.near = 0.15; ctx.camera.far = 6000; ctx.camera.updateProjectionMatrix();
  ctx.scene.background = FOG.clone();
  ctx.scene.fog = new THREE.FogExp2(FOG, 0.009);   // pour les objets du shell (joueurs) ; le décor a son brouillard de hauteur

  const sx = roadX(0) + 1.2;
  return {
    spawn: new THREE.Vector3(sx, heightAt(sx, 0), 0),
    spawnYaw: 0,
    update(_dt, time, player) {
      S.collide(player);                         // murs, voiture, menhirs, poteaux
      player.y = heightAt(player.x, player.z);   // le joueur suit le relief
      S.floor(player);                           // planchers (cabane, chapelle)
      S.update(time);
      uTime.value = time;
      const wx = time * 0.7, wz = time * 0.25;   // la brume dérive avec le vent
      for (const m of mist) {
        const x = player.x + wrap(m.x + wx - player.x), z = player.z + wrap(m.z + wz - player.z);
        m.sp.position.set(x, heightAt(x, z) + m.up, z);
        const d = Math.hypot(x - player.x, z - player.z);
        m.mat.opacity = m.a * smooth(5, 22, d) * smooth(MIST_BOX / 2, MIST_BOX / 2 - 20, d);
      }
    },
    dispose() {
      ctx.scene.remove(root);
      ctx.camera.near = cam0.near; ctx.camera.far = cam0.far; ctx.camera.updateProjectionMatrix();
      root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
      for (const d of disposables) d.dispose();
      gltf.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    },
  };
};

if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (mod) window.dispatchEvent(new CustomEvent('world:hot', { detail: mod.createWorld }));
  });
}
