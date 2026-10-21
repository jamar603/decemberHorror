import type * as THREE from 'three';

// Fourni par le shell (stable) au module monde (hot-swappable).
export interface WorldCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Graine de la partie (dérivée du code) : chaque partie a sa propre carte. */
  seed: number;
}

export interface World {
  spawn: THREE.Vector3;
  spawnYaw: number;
  update(dt: number, time: number, player: THREE.Vector3): void;
  dispose(): void;
}

export type CreateWorld = (ctx: WorldCtx) => Promise<World>;
