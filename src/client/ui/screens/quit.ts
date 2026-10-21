// Confirmation de sortie (du jeu, ou de la partie en cours si arg = 'room') + écran d'au revoir.
import { h } from '../dom';
import { t } from '../i18n';
import { sound } from '../audio';
import type { ScreenDef } from '../types';

export const quit: ScreenDef = (ctx, arg) => {
  const room = ctx.game.room;
  const leaveRoom = arg === 'room' && !!room;
  const yes = () => {
    if (leaveRoom) return ctx.game.leave(); // le shell rouvre l'accueil
    if (room) ctx.game.leave();
    sound.fadeOut();
    window.close(); // ne marche que pour un onglet ouvert par script : sinon écran d'au revoir
    ctx.go('bye');
  };
  const el = h('div.dialog', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'quit-title' },
    h('div.sigil', '✕'),
    h('h2#quit-title', leaveRoom ? t('lobby.leave') : t('quit.title')),
    h('p', room ? t('quit.desc.room', { code: room.code }) : t('quit.desc')),
    h('div.actions',
      h('button.btn.ghost', { type: 'button', 'data-nav': '', autofocus: true, 'data-sound': 'back', onclick: () => ctx.back() }, t('quit.no')),
      h('button.btn.danger.solid', { type: 'button', 'data-nav': '', onclick: yes }, leaveRoom ? t('lobby.leave') : t('quit.yes')),
    ),
  );
  return { el, layout: 'modal' };
};

export const bye: ScreenDef = (ctx) => {
  const el = h('div.bye',
    h('h2', t('bye.title')),
    h('p', t('bye.desc')),
    h('button.btn.ghost', { type: 'button', 'data-nav': '', onclick: () => { sound.fadeIn(); ctx.reset('home'); } }, t('bye.back')),
  );
  return { el, layout: 'full' };
};
