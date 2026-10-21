// Salon (et menu pause en partie) : code d'invitation, liens, joueurs présents, invitations.
import { ABILITIES, CHARACTERS, SKIN_TONES } from '../../../shared/characters';
import { h, hex } from '../dom';
import { t } from '../i18n';
import { sound } from '../audio';
import { copyButton, sheet } from '../widgets';
import type { ScreenDef } from '../types';

export const lobby: ScreenDef = (ctx, arg) => {
  const { game } = ctx;
  const room = game.room;
  if (!room) { queueMicrotask(() => ctx.go('home')); return { el: h('div'), layout: 'sheet' }; }
  const code = room.code;
  const link = game.link(code);
  const invite = () => t('lobby.invite.msg', { code, link });

  const roster = h('ul.roster');
  const count = h('h3');
  const paint = () => {
    const ps = game.players();
    count.textContent = t('lobby.players', { n: ps.length, max: room.max });
    roster.replaceChildren(...ps.map((p, i) => {
      const c = CHARACTERS[p.look[0]];
      return h('li', { class: p.me ? 'me' : '', style: { animationDelay: `${i * 60}ms` } },
        h('span.swatch', { style: { background: `linear-gradient(135deg, ${hex(c.top)} 0 50%, ${hex(SKIN_TONES[p.look[1]])} 50%)` } }),
        h('strong', p.name, p.me && h('small', ` (${t('lobby.you')})`)),
        h('small', `${c.name} · ${ABILITIES[c.ability].label}`),
      );
    }));
    if (ps.length < 2) roster.append(h('li.ghost', t('lobby.alone')));
  };
  paint();

  const share = navigator.share && h('button.btn', {
    type: 'button', 'data-nav': '',
    onclick: () => navigator.share({ title: 'December', text: invite(), url: link }).catch(() => {}),
  }, `⇪ ${t('lobby.share')}`);

  const body = h('div.lobby',
    h('div.lobby-code',
      h('small', `${t('lobby.code')} · ${room.priv ? t('lobby.private') : t('lobby.public')}`),
      h('div.code', ...code.split('').map((ch, i) => h('span', { style: { animationDelay: `${i * 80}ms` } }, ch))),
      h('div.actions', copyButton(t('lobby.copy'), () => code), copyButton(t('lobby.link'), () => link), share),
    ),
    h('div.lobby-cols',
      h('div', count, roster),
      h('div.invite-box',
        h('h3', t('lobby.invite')),
        h('p.lead', t('lobby.invite.desc')),
        h('blockquote', invite()),
        copyButton(t('lobby.invite.copy'), invite),
      ),
    ),
  );
  const foot = [
    h('button.btn.danger', { type: 'button', 'data-nav': '', 'data-sound': 'back', onclick: () => ctx.go('quit', 'room') }, t('lobby.leave')),
    h('span.spacer'),
    h('button.btn.ghost', { type: 'button', 'data-nav': '', onclick: () => ctx.go('settings') }, t('home.settings')),
    h('button.btn.ghost', { type: 'button', 'data-nav': '', onclick: () => ctx.go('profile') }, t('home.profile')),
    h('button.btn.primary.big', { type: 'button', 'data-nav': '', autofocus: true, 'data-sound': 'none', onclick: () => { sound.stinger(); game.play(); } }, `${arg === 'pause' ? t('lobby.resume') : t('lobby.enter')} ›`),
  ];
  return { el: sheet(ctx, `${t('lobby.title')} ${code}`, [body], foot), layout: 'sheet', update: (ev) => { if (ev === 'players') paint(); } };
};
