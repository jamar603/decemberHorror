// Avatar low-poly d'un personnage (autres joueurs + aperçu du menu).
// Géométries partagées par tous les avatars ; seuls les matériaux (peau, tenue, cheveux) sont propres à chacun.
import * as THREE from 'three';
import { CHARACTERS, SKIN_TONES, type Look } from '../shared/characters';

const box = (w: number, h: number, d: number, y = 0) => new THREE.BoxGeometry(w, h, d).translate(0, y, 0);
// Membres : pivot en haut (épaule / hanche) pour pouvoir les balancer à la marche
const G = {
  leg: box(0.17, 0.82, 0.2, -0.41),
  legF: box(0.15, 0.82, 0.18, -0.41),
  shoe: box(0.18, 0.08, 0.28, -0.84).translate(0, 0, -0.04),
  torso: box(0.5, 0.62, 0.26),
  torsoF: box(0.42, 0.6, 0.24),
  hips: box(0.44, 0.16, 0.25),
  arm: box(0.13, 0.66, 0.15, -0.33),
  armF: box(0.11, 0.62, 0.13, -0.31),
  hand: box(0.11, 0.11, 0.12, -0.7),
  neck: box(0.12, 0.08, 0.12),
  head: new THREE.SphereGeometry(0.16, 14, 10).scale(0.95, 1.1, 1),
  nose: box(0.04, 0.06, 0.05),
  eye: box(0.035, 0.03, 0.02),
  hairShort: new THREE.SphereGeometry(0.17, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(0.97, 1.05, 1.03),
  hairBuzz: new THREE.SphereGeometry(0.163, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(0.97, 1.1, 1.02),
  hairLong: box(0.3, 0.38, 0.08, -0.17),
  bun: new THREE.SphereGeometry(0.085, 10, 8),
  tail: box(0.08, 0.3, 0.07, -0.15),
};
const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
const shoeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });

export interface Avatar {
  group: THREE.Group;
  /** phase de marche (0 = immobile) */
  animate(speed: number, dt: number): void;
  dispose(): void;
}

export function createAvatar(look: Look): Avatar {
  const ch = CHARACTERS[look[0]] ?? CHARACTERS[0];
  const f = ch.gender === 'f';
  const skin = new THREE.MeshStandardMaterial({ color: SKIN_TONES[look[1]] ?? SKIN_TONES[0], roughness: 0.7 });
  const top = new THREE.MeshStandardMaterial({ color: ch.top, roughness: 0.85 });
  const bottom = new THREE.MeshStandardMaterial({ color: ch.bottom, roughness: 0.9 });
  const hair = new THREE.MeshStandardMaterial({ color: ch.hair, roughness: 0.8 });
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(g, m); o.position.set(x, y, z); return o;
  };

  const group = new THREE.Group();
  const hipY = 0.9;
  const legs = [-1, 1].map((s) => {
    const l = new THREE.Group();
    l.position.set(s * (f ? 0.1 : 0.11), hipY, 0);
    l.add(mesh(f ? G.legF : G.leg, bottom), mesh(G.shoe, shoeMat));
    return l;
  });
  const torsoY = hipY + 0.08 + 0.31;
  const arms = [-1, 1].map((s) => {
    const a = new THREE.Group();
    a.position.set(s * (f ? 0.28 : 0.32), torsoY + 0.27, 0);
    a.add(mesh(f ? G.armF : G.arm, top), mesh(G.hand, skin));
    return a;
  });
  const headY = torsoY + 0.31 + 0.04 + 0.17;
  const head = new THREE.Group();
  head.position.y = headY;
  // -Z = devant (même convention que la caméra)
  head.add(
    mesh(G.head, skin),
    mesh(G.nose, skin, 0, -0.01, -0.16),
    mesh(G.eye, eyeMat, -0.055, 0.03, -0.145),
    mesh(G.eye, eyeMat, 0.055, 0.03, -0.145),
  );
  switch (ch.hairStyle) {
    case 'short': head.add(mesh(G.hairShort, hair, 0, 0.01, 0.01)); break;
    case 'buzz': head.add(mesh(G.hairBuzz, hair, 0, 0.01, 0.005)); break;
    case 'long': head.add(mesh(G.hairShort, hair, 0, 0.01, 0.01), mesh(G.hairLong, hair, 0, 0.04, 0.12)); break;
    case 'bun': head.add(mesh(G.hairShort, hair, 0, 0.01, 0.01), mesh(G.bun, hair, 0, 0.13, 0.13)); break;
    case 'ponytail': head.add(mesh(G.hairShort, hair, 0, 0.01, 0.01), mesh(G.tail, hair, 0, 0.06, 0.18)); break;
  }
  group.add(
    ...legs, ...arms, head,
    mesh(G.hips, bottom, 0, hipY + 0.04, 0),
    mesh(f ? G.torsoF : G.torso, top, 0, torsoY, 0),
    mesh(G.neck, skin, 0, torsoY + 0.35, 0),
  );
  group.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });

  let phase = 0, amp = 0;
  return {
    group,
    animate(speed, dt) {
      amp += (Math.min(speed / 4, 1.4) - amp) * Math.min(1, dt * 10);
      phase += dt * (4 + speed * 1.6);
      const s = Math.sin(phase) * 0.6 * amp;
      legs[0].rotation.x = s; legs[1].rotation.x = -s;
      arms[0].rotation.x = -s * 0.8; arms[1].rotation.x = s * 0.8;
    },
    dispose() { skin.dispose(); top.dispose(); bottom.dispose(); hair.dispose(); },
  };
}
