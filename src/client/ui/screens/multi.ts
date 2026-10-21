// Multijoueur : créer un salon, rejoindre par code / lien, parcourir les parties publiques, amis.
import { ROOM_MAX, CODE_LEN, type RoomListing } from '../../../shared/protocol';
import { h, timeAgo } from '../dom';
import { lang, t } from '../i18n';
import { friends, recent, setFriend } from '../profile';
import { empty, segmented, sheet, tabs } from '../widgets';
import type { MenuCtx, ScreenDef } from '../types';

type Tab = 'create' | 'join' | 'servers' | 'friends';
const CODE_RE = /(?:room=)?([A-HJ-NP-Z2-9]{5})\b/i;
let lastTab: Tab = 'create';

export const multi: ScreenDef = (ctx, arg) => {
  let poll = 0;
  const onRooms = new Set<() => void>();
  const tb = tabs<Tab>([
    { id: 'create', label: t('multi.create') },
    { id: 'join', label: t('multi.join') },
    { id: 'servers', label: t('multi.servers') },
    { id: 'friends', label: t('multi.friends') },
  ], (arg as Tab) || lastTab, (id) => {
    onRooms.clear();
    if (id === 'create') return createTab(ctx);
    if (id === 'join') return joinTab(ctx);
    if (id === 'servers') return serversTab(ctx, onRooms);
    return friendsTab(ctx, onRooms);
  }, (id) => {
    lastTab = id;
    clearInterval(poll);
    if (id === 'servers' || id === 'friends') { ctx.game.listRooms(); poll = window.setInterval(() => ctx.game.listRooms(), 4000); }
  });
  return {
    el: sheet(ctx, t('multi.title'), [tb.el]),
    layout: 'sheet',
    update: (ev) => { if (ev === 'rooms') onRooms.forEach((f) => f()); },
    dispose: () => clearInterval(poll),
  };
};

function createTab(ctx: MenuCtx) {
  let priv = false;
  const sub = h('span', t('create.public.sub'));
  return h('div.pane.create-pane',
    h('h3', t('create.title')),
    h('p.lead', t('create.desc', { max: ROOM_MAX })),
    segmented<'pub' | 'priv'>([
      { value: 'pub', label: `◉ ${t('create.public')}` },
      { value: 'priv', label: `◎ ${t('create.private')}` },
    ], 'pub', t('create.title'), (v) => { priv = v === 'priv'; sub.textContent = priv ? t('create.private.sub') : t('create.public.sub'); }),
    h('p.hint-line', sub),
    h('ol.steps', h('li', t('create.step1')), h('li', t('create.step2')), h('li', t('create.step3'))),
    h('button.btn.primary.big', { type: 'button', 'data-nav': '', onclick: () => ctx.start('lobby', () => ctx.game.create(priv, true)) }, t('create.go')),
  );
}

function joinTab(ctx: MenuCtx) {
  const pre = new URLSearchParams(location.search).get('room') ?? '';
  const input = h('input.code-input', {
    maxlength: CODE_LEN, placeholder: '·····', autocomplete: 'off', spellcheck: 'false', autofocus: true,
    'aria-label': t('join.title'), value: pre.toUpperCase().slice(0, CODE_LEN),
  }) as HTMLInputElement;
  const go = () => {
    const code = input.value.trim().toUpperCase();
    if (code.length !== CODE_LEN) { input.focus(); input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake'); return ctx.error(t('err.code')); }
    ctx.start('lobby', () => ctx.game.join(code));
  };
  input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return h('div.pane.join-pane',
    h('h3', t('join.title')),
    h('p.lead', t('join.desc')),
    input,
    h('div.actions',
      h('button.btn.primary.big', { type: 'button', 'data-nav': '', onclick: go }, t('join.go')),
      h('button.btn', {
        type: 'button', 'data-nav': '',
        onclick: async () => {
          const txt = await navigator.clipboard?.readText().catch(() => '') ?? '';
          const m = txt.match(CODE_RE);
          if (!m) return ctx.error(t('join.paste.err'));
          input.value = m[1].toUpperCase();
          ctx.error('');
        },
      }, t('join.paste')),
    ),
  );
}

function serversTab(ctx: MenuCtx, onRooms: Set<() => void>) {
  const list = h('div.server-list', { role: 'table' });
  const fr = new Set(friends().map((f) => f.name.toLowerCase()));
  const paint = () => {
    const rooms = ctx.rooms;
    if (!rooms) return list.replaceChildren(h('p.empty.loading', t('servers.loading')));
    if (!rooms.length) return list.replaceChildren(empty(t('servers.empty')));
    list.replaceChildren(
      h('div.srv.head', { role: 'row' }, h('span', t('servers.code')), h('span', t('servers.players')), h('span', t('servers.age')), h('span')),
      ...rooms.map((r) => serverRow(ctx, r, fr)),
    );
  };
  onRooms.add(paint);
  paint();
  return h('div.pane',
    h('div.pane-head', h('h3', t('servers.title')), h('button.btn.small', { type: 'button', 'data-nav': '', onclick: () => ctx.game.listRooms() }, `↻ ${t('servers.refresh')}`)),
    list,
  );
}

function serverRow(ctx: MenuCtx, r: RoomListing, fr: Set<string>) {
  const full = r.players >= r.max;
  const hasFriend = r.names.some((n) => fr.has(n.toLowerCase()));
  return h('div.srv', { role: 'row', class: hasFriend ? 'friend' : '' },
    h('span.mono', r.code),
    h('span.players',
      h('span.bar', h('i', { style: { width: `${(r.players / r.max) * 100}%` } })),
      h('span', `${r.players}/${r.max}`),
      h('small.names', r.names.slice(0, 4).join(', ') + (r.names.length > 4 ? '…' : '')),
    ),
    h('span.dim', timeAgo(r.age, lang)),
    h('span', hasFriend && h('em.tag', t('servers.friend')),
      h('span.tag', { class: r.phase === 'lobby' ? 'tag phase-lobby' : 'tag' }, r.phase === 'lobby' ? t('lobby.phase.lobby') : t('servers.live')),
      h('button.btn.small', { type: 'button', 'data-nav': '', disabled: full, onclick: () => ctx.start('lobby', () => ctx.game.join(r.code)) }, full ? t('servers.full') : t('join.go'))),
  );
}

function friendsTab(ctx: MenuCtx, onRooms: Set<() => void>) {
  const box = h('div.friends');
  const where = (name: string) => ctx.rooms?.find((r) => r.names.some((n) => n.toLowerCase() === name.toLowerCase()));
  // champ hors de paint() : la liste se redessine à chaque actualisation des serveurs sans perdre la saisie
  const add = h('input', { maxlength: 16, placeholder: t('friends.add.ph'), autocomplete: 'off', 'aria-label': t('friends.add.ph') }) as HTMLInputElement;
  const doAdd = () => { if (add.value.trim()) { setFriend(add.value, true); add.value = ''; paint(); } };
  add.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
  const paint = () => {
    const fl = friends(), rl = recent();
    box.replaceChildren(
      h('h3', t('friends.title')),
      fl.length ? h('ul.people', ...fl.map((p) => {
        const r = where(p.name);
        return h('li', { class: r ? 'online' : '' },
          h('span.dot'), h('strong', p.name),
          h('small', r ? t('friends.online', { code: r.code }) : t('friends.offline')),
          h('span.acts',
            r && h('button.btn.small.primary', { type: 'button', 'data-nav': '', onclick: () => ctx.start('lobby', () => ctx.game.join(r.code)) }, t('friends.join')),
            h('button.btn.small.ghost', { type: 'button', 'data-nav': '', 'aria-label': `${t('friends.remove')} ${p.name}`, onclick: () => { setFriend(p.name, false); paint(); } }, '✕')),
        );
      })) : empty(t('friends.empty')),
      h('h3', t('friends.recent')),
      rl.length ? h('ul.people', ...rl.slice(0, 12).map((p) => h('li',
        h('span.dot.off'), h('strong', p.name), h('small', t('friends.met', { ago: timeAgo((Date.now() - p.at) / 1000, lang) })),
        h('span.acts', h('button.btn.small.ghost', { type: 'button', 'data-nav': '', title: t('friends.star'), 'aria-label': `${t('friends.star')} : ${p.name}`, onclick: () => { setFriend(p.name, true); paint(); } }, '☆')),
      ))) : empty(t('friends.recent.empty')),
    );
  };
  onRooms.add(paint);
  paint();
  return h('div.pane', h('div.add-friend', add, h('button.btn', { type: 'button', 'data-nav': '', onclick: doAdd }, `+ ${t('friends.add')}`)), box);
}
