// Accueil : logo, pseudo, actions principales.
import { h, timeAgo } from '../dom';
import { lang, t } from '../i18n';
import { ACHIEVEMENTS, isDone, lastGame, level, rank, rankName } from '../profile';
import type { ScreenDef } from '../types';

export const home: ScreenDef = (ctx) => {
  const { game } = ctx;
  const last = lastGame();
  const invite = new URLSearchParams(location.search).get('room')?.toUpperCase().slice(0, 5);

  const name = h('input#name', {
    maxlength: 16, placeholder: t('name.ph'), autocomplete: 'off', spellcheck: 'false', value: game.name() === 'Inconnu' ? '' : game.name(),
    'aria-label': t('name.label'),
  }) as HTMLInputElement;
  name.addEventListener('input', () => game.setName(name.value));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') (document.querySelector('[data-action="play"]') as HTMLElement)?.click(); });

  const item = (action: string, label: string, sub: string, onclick: () => void, disabled = false) =>
    h('li', h('button.nav-item', { type: 'button', 'data-nav': '', 'data-action': action, disabled, onclick },
      h('span.nav-label', { 'data-text': label }, label), h('small.nav-sub', sub)));

  // Carte joueur : rang, niveau, XP, succès → ouvre la progression
  const lv = level();
  const card = h('button.player-card', { type: 'button', 'data-nav': '', 'data-action': 'progress', onclick: () => ctx.go('profile', 'progress'), 'aria-label': t('home.progress') },
    h('span.pc-lvl', String(lv.lvl)),
    h('span.pc-main',
      h('strong', rankName(rank(lv.lvl))),
      h('span.xp-bar', h('i', { style: { width: `${(lv.cur / lv.need) * 100}%` } })),
      h('small', `${t('prof.level', { n: lv.lvl })} · ${ACHIEVEMENTS.filter(isDone).length}/${ACHIEVEMENTS.length} ${t('home.achievements').toLowerCase()}`)),
  );

  const status = h('span.net');
  const paintNet = () => { status.textContent = game.online ? t('net.online') : t('net.offline'); status.classList.toggle('on', game.online); };
  paintNet();

  const el = h('div.home',
    h('div.brand',
      h('h1.logo', { 'data-text': 'DECEMBER' }, 'DECEMBER'),
      h('p.tagline', t('tagline')),
    ),
    invite && h('div.invite',
      h('span', t('home.invite', { code: invite })),
      h('button.btn.primary', { type: 'button', 'data-nav': '', onclick: () => ctx.start('lobby', () => game.join(invite)) }, t('home.invite.go')),
    ),
    h('label.signature', h('span', t('name.label')), name),
    h('ul.nav-list',
      item('play', t('home.play'), t('home.play.sub'), () => ctx.quickPlay()),
      item('multi', t('home.multi'), t('home.multi.sub'), () => ctx.go('multi')),
      item('solo', t('home.solo'), t('home.solo.sub'), () => ctx.start('play', () => game.create(true))),
      item('continue', t('home.continue'),
        last ? t('home.continue.sub', { code: last.code, ago: timeAgo((Date.now() - last.at) / 1000, lang) }) : t('home.continue.none'),
        () => last && ctx.start('play', () => game.join(last.code, { recreate: true, priv: last.priv })), !last),
    ),
    h('ul.nav-row',
      ...([['character', 'home.character', undefined], ['profile', 'home.profile', undefined], ['profile', 'home.achievements', 'achievements'],
        ['settings', 'home.settings', undefined], ['credits', 'home.credits', undefined]] as const)
        .map(([id, k, a]) => h('li', h('button.link', { type: 'button', 'data-nav': '', 'data-action': a ?? id, onclick: () => ctx.go(id, a) }, t(k)))),
      h('li', h('button.link.danger', { type: 'button', 'data-nav': '', 'data-action': 'quit', onclick: () => ctx.go('quit') }, t('home.quit'))),
    ),
    h('footer.home-foot', status, h('span.hint', t('hint.nav'))),
    card, // en dernier dans le DOM (focus initial sur « Jouer »), affichée en haut à droite
  );
  return { el, layout: 'home', update: (ev) => { if (ev === 'net') paintNet(); } };
};
