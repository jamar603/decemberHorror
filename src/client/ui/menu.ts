// Menu principal : pile d'écrans, transitions, navigation clavier, effets d'ambiance (brouillard, grain, lueur).
// Chaque écran vit dans screens/<nom>.ts et s'enregistre dans SCREENS : en ajouter un = un fichier + une ligne.
import './menu.css';
import '@fontsource/im-fell-english-sc';
import '@fontsource/special-elite';
import type { RoomListing } from '../../shared/protocol';
import { h } from './dom';
import { t } from './i18n';
import { sound } from './audio';
import { onSettings, settings } from './settings';
import { achName, onAchievement } from './profile';
import type { GameApi, GameEvent, Intent, MenuCtx, ScreenDef, ScreenId, ScreenView } from './types';
import { home } from './screens/home';
import { multi } from './screens/multi';
import { lobby } from './screens/lobby';
import { character } from './screens/character';
import { settingsScreen } from './screens/settings';
import { profile } from './screens/profile';
import { credits } from './screens/credits';
import { quit, bye } from './screens/quit';

const SCREENS: Record<ScreenId, ScreenDef> = {
  home, multi, lobby, character, settings: settingsScreen, profile, credits, quit, bye,
};

export class Menu {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  private errBox: HTMLElement;
  private stack: { id: ScreenId; arg?: string }[] = [];
  private view: ScreenView | null = null;
  private intent: Intent | null = null;
  private quick = 0; // timer de « Jouer » (recherche d'une partie publique)
  private ctx: MenuCtx;

  constructor(root: HTMLElement, private game: GameApi) {
    this.root = root;
    root.replaceChildren(
      h('div.fx', { 'aria-hidden': 'true' },
        h('div.glow'), h('div.fog.f1'), h('div.fog.f2'), h('div.fog.f3'), h('div.vignette'), h('div.grain'), h('div.scan')),
      this.stage = h('div.stage'),
      this.errBox = h('p.menu-error', { role: 'alert' }),
      h('div.loader'),
      h('div.curtain'),
    );
    const self = this;
    this.ctx = {
      game,
      rooms: null,
      busy: false,
      go: (id, arg) => this.go(id, arg),
      back: () => this.back(),
      reset: (id) => this.reset(id),
      refresh: () => this.refresh(),
      error: (msg) => this.error(msg),
      start: (intent, action) => {
        if (!game.online) return this.error(t('err.offline'));
        this.intent = intent; self.ctx.busy = true; this.root.classList.add('busy');
        action();
      },
      quickPlay: () => this.quickPlay(),
    };
    this.bindInput();
    onSettings((s) => {
      const b = document.body.classList;
      b.toggle('reduce-motion', s.reduceMotion);
      b.toggle('high-contrast', s.highContrast);
      b.toggle('no-grain', !s.grain);
      document.documentElement.style.setProperty('--ui-scale', String(s.textScale));
    });
    onAchievement((a) => this.achievement(a.icon, achName(a)));
  }

  get visible() { return !this.root.hidden; }
  /** L'avatar 3D est affiché à droite (écran Personnage). */
  get preview() { return this.visible && !!this.view?.preview && innerWidth > 860; }

  // --- Navigation
  go(id: ScreenId, arg?: string, replace = false) {
    if (replace) this.stack.pop();
    this.stack.push({ id, arg });
    this.mount();
  }
  /** Repart d'un écran racine (accueil, salon). */
  reset(id: ScreenId, arg?: string) { this.stack = [{ id, arg }]; this.mount(); }
  back() {
    if (this.stack.length > 1) { this.stack.pop(); return this.mount(true); }
    if (this.game.room) this.close(); // racine en partie (salon) : retour au jeu
  }
  /** Re-rend l'écran courant (changement de langue…). */
  refresh() { this.mount(false, true); }

  private mount(isBack = false, instant = false) {
    const { id, arg } = this.stack[this.stack.length - 1];
    this.view?.dispose?.();
    const view = this.view = SCREENS[id](this.ctx, arg);
    const el = h('div.screen', { class: `layout-${view.layout}${isBack ? ' back' : ''}`, 'data-screen': id }, view.el);
    this.root.dataset.screen = id;
    this.error('');
    for (const old of [...this.stage.children] as HTMLElement[]) { // navigation rapide : plusieurs écrans peuvent être en sortie
      if (instant || settings.reduceMotion) { old.remove(); continue; }
      old.classList.add('leaving');
      old.inert = true;
      setTimeout(() => old.remove(), 320);
    }
    this.stage.append(el);
    if (!instant) requestAnimationFrame(() => (el.querySelector('[autofocus]') as HTMLElement ?? el.querySelector('[data-nav]:not([disabled])') as HTMLElement)?.focus({ preventScroll: true }));
  }

  // --- Ouverture / fermeture
  open(id: ScreenId = this.game.room ? 'lobby' : 'home', arg?: string) {
    document.exitPointerLock?.();
    this.root.hidden = false;
    this.root.classList.remove('closing');
    sound.setInGame(false);
    this.reset(id, arg);
  }
  close() {
    this.view?.dispose?.(); this.view = null;
    this.root.classList.add('closing');
    sound.setInGame(true);
    setTimeout(() => { if (this.root.classList.contains('closing')) { this.root.hidden = true; this.stage.replaceChildren(); } }, settings.reduceMotion ? 0 : 650);
  }

  // --- Événements du jeu
  onJoined() {
    const intent = this.intent;
    this.intent = null; this.ctx.busy = false; this.root.classList.remove('busy');
    clearTimeout(this.quick); this.quick = 0;
    if (intent === 'lobby') { sound.success(); this.reset('lobby'); }
    else if (intent === 'play' || this.visible) { sound.stinger(); this.game.play(); }
  }
  onLeft() { this.open('home'); }
  onRoomError(msg: string) {
    this.intent = null; this.ctx.busy = false; this.root.classList.remove('busy');
    if (!this.visible) this.open();
    this.error(msg);
  }
  onRooms(rooms: RoomListing[]) {
    this.ctx.rooms = rooms;
    if (this.quick) { // « Jouer » : la partie publique la plus peuplée qui a de la place, sinon on en crée une
      clearTimeout(this.quick); this.quick = 0;
      const r = rooms.find((x) => x.players < x.max);
      this.ctx.start('play', () => (r ? this.game.join(r.code) : this.game.create(false)));
      return;
    }
    this.emit('rooms');
  }
  emit(ev: GameEvent) { if (this.visible) this.view?.update?.(ev); }

  private quickPlay() {
    if (!this.game.online) return this.error(t('err.offline'));
    this.root.classList.add('busy'); this.ctx.busy = true;
    this.game.listRooms();
    // ancien serveur sans liste : on crée une partie publique
    this.quick = window.setTimeout(() => { this.quick = 0; this.ctx.start('play', () => this.game.create(false)); }, 1500);
  }

  error(msg: string) {
    this.errBox.textContent = msg;
    this.errBox.classList.toggle('on', !!msg);
    if (msg) sound.error();
  }

  private achievement(icon: string, name: string) {
    sound.success();
    const el = h('div.achievement', h('span.ach-icon', icon), h('div', h('small', t('ach.unlocked')), h('strong', name)));
    document.body.append(el);
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 5000);
  }

  // --- Clavier / souris : flèches pour naviguer, Échap pour revenir, sons au survol
  private bindInput() {
    addEventListener('keydown', (e) => {
      if (!this.visible || e.defaultPrevented) return;
      const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
      if (e.key === 'Escape') {
        if (typing) return (e.target as HTMLElement).blur();
        e.preventDefault();
        if (this.stack.length > 1 || this.game.room) { sound.back(); this.back(); }
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && !(e.target instanceof HTMLInputElement)) {
        const items = [...this.stage.querySelectorAll<HTMLElement>('.screen:not(.leaving) [data-nav]:not([disabled])')].filter((x) => x.offsetParent);
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLElement);
        const n = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1 + (i < 0 ? 1 : 0))) % items.length];
        n.focus();
      }
    });
    let lastHover: Element | null = null;
    const hoverable = 'button:not([disabled]), [data-nav], input[type=range]';
    this.root.addEventListener('pointerover', (e) => {
      const el = (e.target as Element).closest(hoverable);
      if (el && el !== lastHover) sound.hover();
      lastHover = el;
    });
    this.root.addEventListener('focusin', (e) => {
      if ((e.target as Element).matches(':focus-visible') && (e.target as Element).closest(hoverable)) sound.hover();
    });
    this.root.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('button:not([disabled])') as HTMLElement | null;
      if (!b) return;
      const s = b.dataset.sound;
      if (s === 'back') sound.back(); else if (s !== 'none') sound.click();
    });
  }
}
