// Salon (et menu pause en partie) : code d'invitation, joueurs présents, invitations.
// Salon d'avant-partie (room.phase === 'lobby') : rôles uniques, « prêt », lancement par l'hôte.
import { ABILITIES, CHARACTERS, SKIN_TONES, type Ability } from '../../../shared/characters';
import { h, hex } from '../dom';
import { t, type Key } from '../i18n';
import { sound } from '../audio';
import { friends } from '../profile';
import { confirmDialog, copyButton, sheet } from '../widgets';
import type { MenuCtx, PlayerView, ScreenDef } from '../types';

export const ROLE_ICON: Record<Ability, string> = { speed: '»', lockpick: '⚿', map: '⌖', crowbar: '⚒', hack: '⌨' };
const ROLES = Object.keys(ABILITIES) as Ability[];

export const lobby: ScreenDef = (ctx, arg) => {
  const { game } = ctx;
  const room = game.room;
  if (!room) { queueMicrotask(() => ctx.go('home')); return { el: h('div'), layout: 'sheet' }; }
  const code = room.code;
  const link = game.link(code);
  const invite = () => t('lobby.invite.msg', { code, link });
  const pre = () => game.room?.phase === 'lobby';

  // --- Joueurs
  const roster = h('ul.roster');
  const count = h('h3');
  const paintRoster = (ps: PlayerView[]) => {
    count.textContent = t('lobby.players', { n: ps.length, max: room.max });
    roster.replaceChildren(...ps.map((p, i) => {
      const c = CHARACTERS[p.look[0]];
      const state = pre() && (p.host ? h('em.tag.host', `♛ ${t('lobby.host')}`) : p.ready ? h('em.tag.ready', `✓ ${t('lobby.ready')}`) : h('span.tag', t('lobby.waiting')));
      return h('li', { class: [p.me && 'me', p.ready && 'is-ready'].filter(Boolean).join(' '), style: { animationDelay: `${i * 60}ms` } },
        h('span.swatch', { style: { background: `linear-gradient(135deg, ${hex(c.top)} 0 50%, ${hex(SKIN_TONES[p.look[1]])} 50%)` } }),
        h('strong', p.name, p.me && h('small', ` (${t('lobby.you')})`), !pre() && p.host && h('small.crown', ' ♛')),
        h('small', `${ROLE_ICON[c.ability]} ${c.name} · ${ABILITIES[c.ability].label}`),
        state && h('span.state', state),
      );
    }));
    if (ps.length < 2) roster.append(h('li.ghost', t('lobby.alone')));
  };

  // --- Rôles (un par capacité, uniques dans le salon)
  const roles = h('div.role-grid', { role: 'radiogroup', 'aria-label': t('lobby.roles') });
  const paintRoles = (ps: PlayerView[]) => {
    const me = ps.find((p) => p.me)!;
    const holders = new Map<Ability, PlayerView>();
    for (const p of ps) if (!p.me) holders.set(CHARACTERS[p.look[0]].ability, p);
    const allTaken = ROLES.every((a) => holders.has(a)); // plus de joueurs que de rôles : doublons permis
    roles.replaceChildren(...ROLES.map((a) => {
      const mine = CHARACTERS[me.look[0]].ability === a;
      const by = holders.get(a);
      const blocked = !!by && !mine && !allTaken;
      return h('button.role-card', {
        type: 'button', role: 'radio', 'data-nav': '', 'aria-checked': String(mine), disabled: blocked,
        onclick: () => {
          if (mine) return;
          // même genre que le personnage actuel si possible, teinte de peau conservée
          const g = CHARACTERS[me.look[0]].gender;
          let i = CHARACTERS.findIndex((c) => c.ability === a && c.gender === g);
          if (i < 0) i = CHARACTERS.findIndex((c) => c.ability === a);
          game.setLook([i, me.look[1]]);
        },
      },
      h('span.role-icon', ROLE_ICON[a]),
      h('strong', t(`role.${a}` as Key)),
      h('small', ABILITIES[a].desc),
      h('span.role-state', mine ? `● ${t('lobby.role.mine')}` : by ? t('lobby.role.taken', { name: by.name }) : `◌ ${t('lobby.role.free')}`));
    }));
  };

  // --- Invitations : lien / message ; invitation directe quand le serveur aura des comptes joueurs
  const friendList = h('ul.people.invite-friends');
  const paintFriends = () => {
    const fl = friends();
    const here = new Set(game.players().map((p) => p.name.toLowerCase()));
    if (!fl.length) return friendList.replaceChildren(h('li.ghost', t('lobby.friends.none')));
    friendList.replaceChildren(...fl.slice(0, 8).map((f) => h('li',
      h('span.dot', { class: here.has(f.name.toLowerCase()) ? 'in' : '' }), h('strong', f.name),
      h('small', here.has(f.name.toLowerCase()) ? t('lobby.friend.here') : ''),
      h('span.acts', here.has(f.name.toLowerCase()) ? null
        : game.inviteFriend
          ? h('button.btn.small', { type: 'button', 'data-nav': '', onclick: () => game.inviteFriend!(f.name, code) }, t('lobby.friend.invite'))
          : copyButton(t('lobby.friend.invite'), () => t('lobby.invite.msg.to', { name: f.name, code, link }), 'small')),
    )));
  };

  const paint = () => {
    const ps = game.players();
    paintRoster(ps);
    if (pre()) paintRoles(ps);
    paintFriends();
    paintFoot(ps);
  };

  const share = navigator.share && h('button.btn', {
    type: 'button', 'data-nav': '',
    onclick: () => navigator.share({ title: 'December', text: invite(), url: link }).catch(() => {}),
  }, `⇪ ${t('lobby.share')}`);

  const inviteBox = h('div.invite-box',
    h('h3', t('lobby.invite')),
    h('p.lead', t('lobby.invite.desc')),
    h('blockquote', invite()),
    h('div.actions', copyButton(t('lobby.invite.copy'), invite), share),
    h('h3', t('lobby.friends')),
    friendList,
    !game.inviteFriend && h('p.hint-line', t('lobby.friends.soon')),
  );

  const body = h('div.lobby', { class: pre() ? 'pre' : '' },
    h('div.lobby-code',
      h('small', `${t('lobby.code')} · ${room.priv ? t('lobby.private') : t('lobby.public')}${pre() ? ` · ${t('lobby.phase.lobby')}` : ''}`),
      h('div.code', ...code.split('').map((ch, i) => h('span', { style: { animationDelay: `${i * 80}ms` } }, ch))),
      h('div.actions', copyButton(t('lobby.copy'), () => code), copyButton(t('lobby.link'), () => link)),
    ),
    pre()
      ? h('div.lobby-cols.three',
        h('div', count, roster),
        h('div', h('h3', t('lobby.roles')), h('p.lead', t('lobby.roles.desc')), roles),
        inviteBox)
      : h('div.lobby-cols', h('div', count, roster), inviteBox),
  );

  // --- Pied : quitter · paramètres · prêt / lancer (salon) ou entrer / reprendre (partie en cours)
  const foot = h('div.foot-actions');
  const leave = h('button.btn.danger', { type: 'button', 'data-nav': '', 'data-sound': 'back', onclick: () => ctx.go('quit', 'room') }, t('lobby.leave'));
  const settingsBtn = h('button.btn.ghost', { type: 'button', 'data-nav': '', onclick: () => ctx.go('settings') }, t('home.settings'));
  const profileBtn = h('button.btn.ghost', { type: 'button', 'data-nav': '', onclick: () => ctx.go('profile') }, t('home.profile'));
  function paintFoot(ps: PlayerView[]) {
    if (!pre()) {
      foot.replaceChildren(leave, h('span.spacer'), settingsBtn, profileBtn,
        h('button.btn.primary.big', { type: 'button', 'data-nav': '', autofocus: true, 'data-sound': 'none', onclick: () => { sound.stinger(); game.play(); } },
          `${arg === 'pause' ? t('lobby.resume') : t('lobby.enter')} ›`));
      return;
    }
    const me = ps.find((p) => p.me)!;
    const others = ps.filter((p) => !p.me);
    const waiting = others.filter((p) => !p.ready && !p.host);
    const status = h('span.lobby-status', game.isHost
      ? (waiting.length ? t('lobby.status.waiting', { n: waiting.length }) : others.length ? t('lobby.status.all') : t('lobby.status.solo'))
      : me.ready ? t('lobby.status.host') : t('lobby.status.notready'));
    const main = game.isHost
      ? h('button.btn.primary.big', {
        type: 'button', 'data-nav': '', 'data-sound': 'none',
        onclick: async () => {
          if (waiting.length && !(await confirmDialog({ title: t('lobby.start.confirm'), desc: t('lobby.start.confirm.desc', { n: waiting.length }), yes: t('lobby.start'), icon: '☾' }))) return;
          game.start();
        },
      }, `${t('lobby.start')} ›`)
      : h('button.btn.big', { type: 'button', 'data-nav': '', class: me.ready ? 'ok' : 'primary', onclick: () => game.setReady(!me.ready) },
        me.ready ? `✓ ${t('lobby.ready')}` : t('lobby.ready.go'));
    foot.replaceChildren(leave, status, h('span.spacer'), settingsBtn, main);
  }

  paint();
  return {
    el: sheet(ctx, `${t('lobby.title')} ${code}`, [body], [foot]),
    layout: 'sheet',
    update: (ev) => {
      if (ev !== 'players') return;
      if (pre() !== body.classList.contains('pre')) return ctx.refresh(); // salon → partie lancée (ou l'inverse après reconnexion)
      paint();
    },
  };
};

// Valeur utilisée par l'écran Personnage pour marquer les rôles pris
export function takenRoles(ctx: MenuCtx): Map<Ability, string> {
  const m = new Map<Ability, string>();
  if (ctx.game.room?.phase !== 'lobby') return m;
  for (const p of ctx.game.players()) if (!p.me) m.set(CHARACTERS[p.look[0]].ability, p.name);
  return m;
}
