// Protocole réseau partagé client/serveur.
// Binaire pour le temps réel (positions), JSON pour le reste (parties, dev, versions).
// Rester rétro-compatible : d'anciens clients restent connectés pendant un déploiement.

export const TICK_HZ = 20;
export const MAX_PLAYERS = 200; // total serveur
export const ROOM_MAX = 12; // par partie
export const CODE_LEN = 5;

// Messages binaires (premier octet = type)
export const B_POS = 1; // client -> serveur : [u8 type][f32 x][f32 y][f32 z][f32 yaw]
export const B_SNAP = 2; // serveur -> client : [u8 type][u16 n] puis n * ([u16 id][f32 x][f32 y][f32 z][f32 yaw])
export const POS_BYTES = 1 + 16;
export const SNAP_ENTRY = 2 + 16;

export interface VersionInfo {
  v: string; // identifiant de build (sha git)
  shell: string; // hash du point d'entrée principal (si change => rechargement)
  world: string; // URL du module monde hot-swappable
}

/** Tâche envoyée à Claude depuis le jeu. Chaque bridge (un par dev) exécute sa file une tâche à la fois. */
export interface DevTask {
  id: string;
  from: string; // dev qui a envoyé le prompt
  prompt: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  msg?: string; // résumé du résultat (fin de réponse de Claude) ou raison de l'échec
  at: number; // mise en file
  started?: number;
  ended?: number;
}
// allow : autres devs autorisés à utiliser ce Claude (par défaut aucun : seul le propriétaire du token)
export interface DevBridge { id: string; dev: string; host: string; tasks: DevTask[]; allow?: string[] }
export type DevTaskOp = 'delete' | 'clear';

export interface RoomInfo { code: string; players: number; max: number }

export type ClientMsg =
  | { t: 'hello'; name: string; dev?: string }
  // recreate : après un redémarrage serveur, le client recrée sa partie avec le même code
  | { t: 'join'; code: string; pos?: [number, number, number, number]; recreate?: boolean }
  | { t: 'create' }
  | { t: 'leaveRoom' }
  | { t: 'devPrompt'; bridge: string; prompt: string; image: string }
  | { t: 'devTask'; bridge: string; op: DevTaskOp; id?: string };

export type ServerMsg =
  | { t: 'welcome'; id: number; version: VersionInfo | null; dev: boolean; me?: string }
  | { t: 'joined'; room: RoomInfo; players: { id: number; name: string }[] }
  | { t: 'roomError'; msg: string }
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number }
  | { t: 'version'; version: VersionInfo }
  | { t: 'devStatus'; state: 'building' | 'deploying' | 'done' | 'failed'; msg: string }
  | { t: 'bridges'; bridges: DevBridge[] }
  | { t: 'devAck'; ok: boolean; msg: string };

// Messages bridge <-> serveur
export type BridgeMsg =
  | { t: 'bridgeHello'; token: string; host: string; allow?: string[] }
  | { t: 'delivered'; reqId: string; ok: boolean; msg: string }
  | { t: 'tasks'; tasks: DevTask[] };
export type ToBridgeMsg =
  | { t: 'prompt'; reqId: string; from: string; prompt: string; image: string }
  | { t: 'taskOp'; from: string; op: DevTaskOp; id?: string }
  // tableau partagé : les tâches de TOUS les bridges, pour que chaque Claude voie ce que font les autres
  | { t: 'board'; bridges: DevBridge[] };
