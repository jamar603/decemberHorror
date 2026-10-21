// Le monde : remplacé à chaud en prod (aucun rechargement). Mettre le contenu du jeu ici.
// Tout ce qui est ajouté à la scène doit être libéré dans dispose().
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CreateWorld } from './types';
// « a forest (3) with a road at night for game » — dasy444, CC-BY 4.0 (https://sketchfab.com/dasy444)
// allégé : maillages fusionnés par matériau, textures WebP 1024, géométrie quantifiée
import forestUrl from './assets/forest-road-night.glb?url';

const FOREST_SCALE = 5; // le modèle fait ~15 m de large : arbres ~15 m après mise à l'échelle

export const createWorld: CreateWorld = async (ctx) => {
  const root = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x1b2128, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;

  // nuit : clair de lune froid, ciel et brouillard bleu nuit
  const hemi = new THREE.HemisphereLight(0x6f86a8, 0x0b0d10, 0.9);
  const moon = new THREE.DirectionalLight(0xb7c8ff, 0.8);
  moon.position.set(-20, 40, 15);
  root.add(floor, hemi, moon);

  const gltf = await new GLTFLoader().loadAsync(forestUrl);
  const forest = gltf.scene;
  forest.scale.setScalar(FOREST_SCALE);
  // pose le sol du modèle à y = 0 au point d'apparition
  forest.updateMatrixWorld(true);
  const hit = new THREE.Raycaster(new THREE.Vector3(0, 500, 0), new THREE.Vector3(0, -1, 0)).intersectObject(forest, true)[0];
  if (hit) forest.position.y = -hit.point.y;
  floor.position.y = new THREE.Box3().setFromObject(forest).min.y - 0.05; // le sol plat ne sert qu'autour du décor
  forest.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; }
  });
  root.add(forest);

  ctx.scene.add(root);
  ctx.scene.background = new THREE.Color(0x0a0f18);
  ctx.scene.fog = new THREE.Fog(0x0a0f18, 15, 90);

  return {
    spawn: new THREE.Vector3(0, 0, 0),
    spawnYaw: 0,
    update() {},
    dispose() {
      ctx.scene.remove(root);
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      forest.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
    },
  };
};

if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (mod) window.dispatchEvent(new CustomEvent('world:hot', { detail: mod.createWorld }));
  });
}
