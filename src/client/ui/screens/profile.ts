// Profil : pseudo, personnage, niveau / XP, statistiques, succès.
import { ABILITIES, CHARACTERS, SKIN_TONES } from '../../../shared/characters';
import { duration, h, hex } from '../dom';
import { lang, t } from '../i18n';
import { ACHIEVEMENTS, achDesc, achName, isDone, level, resetProfile, stats, xp } from '../profile';
import { sheet } from '../widgets';
import type { ScreenDef } from '../types';

export const profile: ScreenDef = (ctx) => {
  const { game } = ctx;
  const body = h('div.profile');
  const paint = () => {
    const [ci, si] = game.look(), c = CHARACTERS[ci];
    const lv = level();
    const name = h('input.name-big', { maxlength: 16, placeholder: t('name.ph'), autocomplete: 'off', spellcheck: 'false', 'aria-label': t('name.label'), disabled: !!game.room }) as HTMLInputElement;
    name.value = game.name() === 'Inconnu' ? '' : game.name();
    name.addEventListener('input', () => game.setName(name.value));
    const done = ACHIEVEMENTS.filter(isDone).length;
    const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
    const stat = (label: string, value: string) => h('div.stat', h('strong', value), h('small', label));
    let confirmReset = false;
    const reset = h('button.btn.ghost.danger.small', { type: 'button', 'data-nav': '', onclick: () => {
      if (!confirmReset) { confirmReset = true; reset.textContent = t('prof.reset.confirm'); return; }
      resetProfile(); paint();
    } }, t('prof.reset'));

    body.replaceChildren(
      h('div.id-card',
        h('div.emblem', { style: `--top:${hex(c.top)};--skin:${hex(SKIN_TONES[si])}` }, h('span', String(lv.lvl))),
        h('div.id-main',
          h('label.signature', h('span', t('name.label')), name),
          h('p.dim', `${c.name} · ${ABILITIES[c.ability].label}`),
          h('div.xp',
            h('div.xp-top', h('strong', t('prof.level', { n: lv.lvl })), h('small', t('prof.xp', { xp: lv.cur, next: lv.need }))),
            h('div.xp-bar', h('i', { style: { width: `${(lv.cur / lv.need) * 100}%` } })),
            h('small.dim', `${xp()} XP · ${t('prof.since', { date: new Date(stats.since).toLocaleDateString(lang) })}`),
          ),
        ),
      ),
      h('h3', t('prof.stats')),
      h('div.stats',
        stat(t('prof.games'), String(stats.games)),
        stat(t('prof.hosted'), String(stats.hosted)),
        stat(t('prof.time'), duration(stats.time)),
        stat(t('prof.dist'), stats.dist >= 1000 ? `${nf.format(stats.dist / 1000)} km` : `${Math.round(stats.dist)} m`),
        stat(t('prof.met'), String(stats.met)),
        stat(t('prof.chars'), `${stats.chars.length}/${CHARACTERS.length}`),
      ),
      h('h3', t('prof.achievements', { n: done, total: ACHIEVEMENTS.length })),
      h('ul.achievements', ...ACHIEVEMENTS.map((a) => {
        const [v, max] = a.progress(stats), ok = v >= max;
        return h('li', { class: ok ? 'done' : '' },
          h('span.ach-icon', a.icon),
          h('div', h('strong', achName(a)), h('small', achDesc(a)),
            !ok && max > 1 && h('div.mini-bar', { title: `${v}/${max}` }, h('i', { style: { width: `${Math.min(1, v / max) * 100}%` } }))),
        );
      })),
      h('div.reset-row', reset),
    );
  };
  paint();
  return { el: sheet(ctx, t('prof.title'), [body]), layout: 'sheet' };
};
