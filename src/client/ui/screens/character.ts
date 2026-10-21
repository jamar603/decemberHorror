// Personnage : 10 survivants, rôle + capacité spéciale, couleur de peau. Avatar 3D en aperçu à droite.
import { ABILITIES, CHARACTERS, SKIN_TONES, type Ability } from '../../../shared/characters';
import { h, hex } from '../dom';
import { t, type Key } from '../i18n';
import { keyLabel, settings } from '../settings';
import { trackChar } from '../profile';
import { sheet } from '../widgets';
import { takenRoles } from './lobby';
import type { ScreenDef } from '../types';

// Capacités déjà branchées dans le jeu (les autres attendent le contenu des prochains niveaux)
const LIVE: Partial<Record<Ability, () => string>> = {
  speed: () => t('char.passive'),
  map: () => t('char.key', { key: keyLabel(settings.binds.map) }),
};

export const character: ScreenDef = (ctx) => {
  const { game } = ctx;
  // le serveur n'accepte un changement de personnage qu'hors partie ou dans un salon d'avant-partie (rôle unique)
  const locked = !!game.room && game.room.phase !== 'lobby';
  const grid = h('div.char-grid', { role: 'radiogroup', 'aria-label': t('char.title') });
  const skins = h('div.skins', { role: 'radiogroup', 'aria-label': t('char.skin') });
  const detail = h('div.char-detail', { 'aria-live': 'polite' });

  const cards = CHARACTERS.map((c, i) => h('button.char-card', {
    type: 'button', role: 'radio', 'data-nav': '', class: c.gender, disabled: locked,
    style: `--top:${hex(c.top)};--hair:${hex(c.hair)}`,
    onclick: () => { game.setLook([i, game.look()[1]]); trackChar(i); paint(); },
  },
  h('span.portrait', h('i.hair'), h('i.head'), h('i.body')),
  h('span.cname', c.name),
  h('small', ABILITIES[c.ability].short)));
  grid.append(...cards);
  const swatches = SKIN_TONES.map((tone, i) => h('button.skin', {
    type: 'button', role: 'radio', 'data-nav': '', disabled: locked, style: { background: hex(tone) },
    'aria-label': `${t('char.skin')} ${i + 1} / ${SKIN_TONES.length}`,
    onclick: () => { game.setLook([game.look()[0], i]); paint(); },
  }));
  skins.append(...swatches);

  function paint() {
    const [ci, si] = game.look();
    const taken = takenRoles(ctx);
    const allTaken = taken.size >= Object.keys(ABILITIES).length; // plus de joueurs que de rôles : doublons permis
    cards.forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === ci));
      const by = taken.get(CHARACTERS[i].ability);
      b.disabled = locked || (!!by && !allTaken && i !== ci);
      b.title = by ? t('lobby.role.taken', { name: by }) : '';
    });
    swatches.forEach((b, i) => b.setAttribute('aria-checked', String(i === si)));
    const c = CHARACTERS[ci], ab = ABILITIES[c.ability], live = LIVE[c.ability];
    detail.replaceChildren(
      h('div.char-head',
        h('h3', c.name),
        h('span.tag', t(`gender.${c.gender}` as Key)),
      ),
      h('p.role', h('small', t('char.role')), h('strong', t(`role.${c.ability}` as Key))),
      h('p.lore', `« ${t(`role.${c.ability}.lore` as Key)} »`),
      h('div.ability',
        h('small', t('char.ability')),
        h('strong', ab.label),
        h('p', ab.desc),
        h('span', { class: `status ${live ? 'live' : 'soon'}` }, live ? `● ${t('char.live')} · ${live()}` : `◌ ${t('char.soon')}`),
      ),
    );
    detail.classList.remove('swap'); void detail.offsetWidth; detail.classList.add('swap');
  }
  paint();

  const el = sheet(ctx, t('char.title'), [
    grid,
    h('div.skin-row', h('small', t('char.skin')), skins),
    detail,
  ], [h('span.spacer'), h('button.btn.primary.big', { type: 'button', 'data-nav': '', onclick: () => ctx.back() }, t('char.confirm'))]);
  return { el, layout: 'split', preview: true, update: (ev) => { if (ev === 'players') paint(); } };
};
