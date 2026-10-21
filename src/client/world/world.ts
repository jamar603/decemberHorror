// Le monde : remplacé à chaud en prod (aucun rechargement). Mettre le contenu du jeu ici.
// Tout ce qui est ajouté à la scène doit être libéré dans dispose().
import * as THREE from 'three';
import type { CreateWorld } from './types';

export const createWorld: CreateWorld = async (ctx) => {
  const root = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x55606b, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  const grid = new THREE.GridHelper(200, 100, 0x2f363d, 0x3c444c);
  grid.position.y = 0.01;

  const hemi = new THREE.HemisphereLight(0xdfe8f0, 0x30343a, 1.6);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(20, 40, 10);
  root.add(floor, grid, hemi, sun);

  ctx.scene.add(root);
  ctx.scene.background = new THREE.Color(0x9bb0c4);
  ctx.scene.fog = new THREE.Fog(0x9bb0c4, 40, 120);

  return {
    spawn: new THREE.Vector3(0, 0, 0),
    spawnYaw: 0,
    update() {},
    dispose() {
      ctx.scene.remove(root);
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      grid.dispose();
    },
  };
};

if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (mod) window.dispatchEvent(new CustomEvent('world:hot', { detail: mod.createWorld }));
  });
}
