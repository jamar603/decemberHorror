// Profil : identité (pseudo, personnage, rang), progression (niveaux, rangs, sources d'XP), statistiques, succès.
import { ABILITIES, CHARACTERS, SKIN_TONES } from '../../../shared/characters';
import { duration, h, hex } from '../dom';
import { lang, t } from '../i18n';
import { ACHIEVEMENTS, RANKS, achDesc, achName, isDone, level, rank, rankName, resetProfile, stats, xp } from '../profile';
import { confirmDialog, sheet, tabs } from '../widgets';
import type { MenuCtx, ScreenDef } from '../types';

type Tab = 'overview' | 'progress' | 'stats' | 'achievements';
const TABS: Tab[] = ['overview', 'progress', 'stats', 'achievements'];

export const profile: ScreenDef = (ctx, arg) => {
  const tb = tabs<Tab>(TABS.map((id) => ({ id, label: t(`prof.tab.${id}`) })), TABS.includes(arg as Tab) ? (arg as Tab) : 'overview', (id) => {
    if (id === 'overview') return overview(ctx, () => tb.select('overview'));
    if (id === 'progress') return progress();
    if (id === 'stats') return statsPane();
    return achievementsPane();
  });
  return { el: sheet(ctx, t('prof.title'), [tb.el]), layout: 'sheet' };
};

const stat = (label: string, value: string) => h('div.stat', h('strong', value), h('small', label));

function xpBlock() {
  const lv = level();
  return h('div.xp',
    h('div.xp-top', h('strong', t('prof.level', { n: lv.lvl })), h('small', t('prof.xp', { xp: lv.cur, next: lv.need }))),
    h('div.xp-bar', h('i', { style: { width: `${(lv.cur / lv.need) * 100}%` } })),
    h('small.dim', `${xp()} XP · ${t('prof.since', { date: new Date(stats.since).toLocaleDateString(lang) })}`),
  );
}

function overview(ctx: MenuCtx, repaint: () => void) {
  const { game } = ctx;
  const [ci, si] = game.look(), c = CHARACTERS[ci];
  const lv = level();
  const name = h('input.name-big', { maxlength: 16, placeholder: t('name.ph'), autocomplete: 'off', spellcheck: 'false', 'aria-label': t('name.label'), disabled: !!game.room }) as HTMLInputElement;
  name.value = game.name() === 'Inconnu' ? '' : game.name();
  name.addEventListener('input', () => game.setName(name.value));
  const done = ACHIEVEMENTS.filter(isDone).length;
  const reset = h('button.btn.ghost.danger.small', {
    type: 'button', 'data-nav': '',
    onclick: async () => {
      if (!(await confirmDialog({ title: t('prof.reset'), desc: t('prof.reset.desc'), yes: t('prof.reset.yes'), danger: true }))) return;
      resetProfile(); repaint();
    },
  }, t('prof.reset'));
  return h('div.profile',
    h('div.id-card',
      h('div.emblem', { style: `--top:${hex(c.top)};--skin:${hex(SKIN_TONES[si])}` }, h('span', String(lv.lvl))),
      h('div.id-main',
        h('label.signature', h('span', t('name.label')), name),
        h('p.rank', h('em', rankName(rank(lv.lvl))), h('span.dim', ` · ${c.name} · ${ABILITIES[c.ability].label}`)),
        xpBlock(),
      ),
    ),
    h('div.stats.compact',
      stat(t('prof.games'), String(stats.games)),
      stat(t('prof.time'), duration(stats.time)),
      stat(t('prof.achievements.short'), `${done}/${ACHIEVEMENTS.length}`),
    ),
    h('div.actions.profile-links',
      h('button.btn', { type: 'button', 'data-nav': '', onclick: () => ctx.go('character') }, t('home.character')),
      h('button.btn.ghost', { type: 'button', 'data-nav': '', onclick: () => ctx.go('multi', 'friends') }, t('multi.friends')),
    ),
    h('div.reset-row', reset),
  );
}

function progress() {
  const lv = level();
  const next = RANKS.find((r) => r.lvl > lv.lvl);
  return h('div.profile',
    xpBlock(),
    h('h3', t('prof.ranks')),
    h('ol.rank-track', ...RANKS.map((r, i) => h('li', { class: lv.lvl >= r.lvl ? 'reached' : '', style: { animationDelay: `${i * 70}ms` } },
      h('span.rank-lvl', String(r.lvl)), h('strong', rankName(r)),
      h('small', lv.lvl >= r.lvl ? t('prof.rank.reached') : t('prof.rank.at', { n: r.lvl })),
    ))),
    next && h('p.lead', t('prof.rank.next', { name: rankName(next), n: next.lvl - lv.lvl })),
    h('h3', t('prof.xp.sources')),
    h('ul.xp-sources',
      h('li', h('strong', '+1'), t('prof.xp.time')),
      h('li', h('strong', '+1'), t('prof.xp.dist')),
      h('li', h('strong', '+25'), t('prof.xp.game')),
      h('li', h('strong', '+50'), t('prof.xp.ach')),
    ),
  );
}

function statsPane() {
  const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  return h('div.profile',
    h('div.stats',
      stat(t('prof.games'), String(stats.games)),
      stat(t('prof.hosted'), String(stats.hosted)),
      stat(t('prof.time'), duration(stats.time)),
      stat(t('prof.dist'), stats.dist >= 1000 ? `${nf.format(stats.dist / 1000)} km` : `${Math.round(stats.dist)} m`),
      stat(t('prof.far'), `${Math.round(stats.maxFromSpawn)} m`),
      stat(t('prof.met'), String(stats.met)),
      stat(t('prof.maxroom'), String(stats.maxRoom)),
      stat(t('prof.chars'), `${stats.chars.length}/${CHARACTERS.length}`),
    ),
    h('h3', t('prof.played')),
    h('div.played', ...CHARACTERS.map((c, i) => h('span', { class: stats.chars.includes(i) ? 'tag on' : 'tag' }, c.name))),
  );
}

function achievementsPane() {
  const done = ACHIEVEMENTS.filter(isDone).length;
  return h('div.profile',
    h('div.ach-head', h('h3', t('prof.achievements', { n: done, total: ACHIEVEMENTS.length })),
      h('div.xp-bar.wide', h('i', { style: { width: `${(done / ACHIEVEMENTS.length) * 100}%` } }))),
    h('ul.achievements', ...ACHIEVEMENTS.map((a) => {
      const [v, max] = a.progress(stats), ok = v >= max;
      return h('li', { class: ok ? 'done' : '' },
        h('span.ach-icon', a.icon),
        h('div', h('strong', achName(a)), h('small', achDesc(a)),
          !ok && max > 1 && h('div.mini-bar', { title: `${v}/${max}` }, h('i', { style: { width: `${Math.min(1, v / max) * 100}%` } })),
          !ok && max > 1 && h('small.dim', `${Math.min(v, max)} / ${max}`)),
      );
    })),
  );
}
