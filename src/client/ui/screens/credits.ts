// Crédits : générique qui défile (pause au survol / focus, molette pour parcourir).
import { h } from '../dom';
import { lang, t } from '../i18n';
import { sheet } from '../widgets';
import type { ScreenDef } from '../types';

const L = (fr: string, en: string) => (lang === 'fr' ? fr : en);

export const credits: ScreenDef = (ctx) => {
  const block = (title: string, lines: string[]) => h('div.credit', h('small', title), ...lines.map((l) => h('p', l)));
  const roll = h('div.roll', { tabindex: 0 },
    h('h1.logo.small', { 'data-text': 'DECEMBER' }, 'DECEMBER'),
    h('p.tagline', t('tagline')),
    block(L('Une création collective', 'A collective creation'), ['Tom Deprez', L('et tous les devs qui poussent sur main', 'and every dev pushing to main')]),
    block(L('Développement assisté', 'Assisted development'), ['Claude Code — Anthropic']),
    block(L('Moteur 3D', '3D engine'), ['three.js — MIT']),
    block(L('Réseau temps réel', 'Real-time networking'), ['uWebSockets.js — Apache 2.0']),
    block(L('Modèles 3D', '3D models'), ['« a forest (3) with a road at night for game »', 'dasy444 — CC-BY 4.0 (sketchfab.com/dasy444)']),
    block(L('Typographies', 'Typefaces'), ['IM Fell English SC — Igino Marini, OFL', 'Special Elite — Astigmatic, Apache 2.0']),
    block(L('Son', 'Sound'), [L('Ambiance entièrement synthétisée en temps réel (Web Audio)', 'Ambience fully synthesized in real time (Web Audio)')]),
    block(L('Remerciements', 'Thanks'), [L('À celles et ceux qui marchent encore dans la forêt.', 'To those still walking in the woods.')]),
    h('p.the-end', L('Ne restez pas seuls.', 'Don’t stay alone.')),
  );
  return { el: sheet(ctx, t('credits.title'), [h('div.roll-wrap', roll)]), layout: 'sheet' };
};
