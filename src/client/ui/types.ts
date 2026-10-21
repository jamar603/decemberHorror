// Contrat entre le menu (ui/) et le shell du jeu (main.ts).
// Ajouter une fonctionnalité : une méthode dans GameApi (implémentée dans main.ts) + un écran dans screens/.
import type { RoomInfo, RoomListing } from '../../shared/protocol';
import type { Look } from '../../shared/characters';

export interface PlayerView { id: number; name: string; look: Look; me?: boolean; host?: boolean; ready?: boolean }

export interface GameApi {
  readonly room: RoomInfo | null;
  readonly online: boolean;
  players(): PlayerView[]; // joueurs de la partie, soi compris
  name(): string;
  setName(n: string): void;
  look(): Look;
  setLook(l: Look): void;
  create(priv: boolean, lobby?: boolean): void; // lobby : salon d'avant-partie (rôles, prêt, lancement par l'hôte)
  join(code: string, opts?: { recreate?: boolean; priv?: boolean }): void;
  play(): void; // fermer le menu et capturer la souris
  leave(): void;
  listRooms(): void;
  link(code?: string): string;
  // --- Salon d'avant-partie (room.phase === 'lobby')
  readonly isHost: boolean;
  setReady(on: boolean): void;
  start(): void; // hôte uniquement : le serveur fait entrer tout le salon dans le monde
  /** Invitation directe d'un ami (notification en jeu). Nécessite des comptes joueurs côté serveur : absent pour l'instant,
   *  le menu retombe alors sur le partage du lien d'invitation. */
  inviteFriend?(name: string, code: string): void;
}

export type ScreenId = 'home' | 'multi' | 'lobby' | 'character' | 'settings' | 'profile' | 'credits' | 'quit' | 'bye';
export type Layout = 'home' | 'sheet' | 'split' | 'modal' | 'full';
export type GameEvent = 'rooms' | 'players' | 'room' | 'net';
/** Après une création / jonction : « play » entre directement dans le monde, « lobby » montre le salon. */
export type Intent = 'play' | 'lobby';

export interface MenuCtx {
  game: GameApi;
  rooms: RoomListing[] | null; // dernière liste des parties publiques reçue
  go(id: ScreenId, arg?: string): void;
  back(): void;
  reset(id: ScreenId): void; // repartir d'un écran racine
  refresh(): void; // re-rendre l'écran courant (langue changée…)
  error(msg: string): void;
  start(intent: Intent, action: () => void): void; // lance une création / jonction et attend « joined »
  quickPlay(): void;
  busy: boolean;
}

export interface ScreenView {
  el: HTMLElement;
  layout: Layout;
  title?: string;
  preview?: boolean; // affiche l'avatar 3D à droite
  update?(ev: GameEvent): void; // l'état du jeu a changé
  dispose?(): void;
}
export type ScreenDef = (ctx: MenuCtx, arg?: string) => ScreenView;
