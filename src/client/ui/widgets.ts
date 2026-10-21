// Composants réutilisables des écrans : cadre, onglets, réglages (curseur, interrupteur, choix), copie.
import { h } from './dom';
import { t } from './i18n';
import { sound } from './audio';
import type { MenuCtx } from './types';

/** Cadre standard d'un écran : retour + titre + contenu (+ pied). */
export function sheet(ctx: MenuCtx, title: string, body: Node[], foot?: Node[]) {
  return h('section.sheet', { 'aria-label': title },
    h('header.sheet-head',
      h('button.back', { type: 'button', 'data-sound': 'back', onclick: () => ctx.back(), 'aria-label': t('back') }, h('span.arrow', '‹'), t('back')),
      h('h2.sheet-title', title),
    ),
    h('div.sheet-body', body),
    foot && h('footer.sheet-foot', foot),
  );
}

/** Onglets accessibles (flèches gauche/droite). Retourne l'élément ; le contenu est rendu par render(id). */
export function tabs<T extends string>(items: { id: T; label: string }[], active: T, render: (id: T) => Node, onChange?: (id: T) => void) {
  const bar = h('div.tabs', { role: 'tablist' });
  const panel = h('div.tab-panel', { role: 'tabpanel' });
  let cur = active;
  const btns = items.map((it) => h('button.tab', {
    type: 'button', role: 'tab', 'data-nav': '',
    onclick: () => select(it.id),
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); e.stopPropagation();
      const i = items.findIndex((x) => x.id === cur), n = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
      select(n.id); btns[items.indexOf(n)].focus();
    },
  }, it.label));
  bar.append(...btns);
  function select(id: T) {
    cur = id;
    btns.forEach((b, i) => { b.setAttribute('aria-selected', String(items[i].id === id)); b.tabIndex = items[i].id === id ? 0 : -1; });
    panel.replaceChildren(render(id));
    panel.classList.remove('swap'); void panel.offsetWidth; panel.classList.add('swap');
    onChange?.(id);
  }
  select(active);
  return { el: h('div.tabs-wrap', bar, panel), select, get current() { return cur; } };
}

export function field(label: string, sub: string | null, control: Node) {
  return h('div.field', h('div.field-label', h('span', label), sub && h('small', sub)), h('div.field-ctl', control));
}

export function slider(opts: { min: number; max: number; step: number; value: number; fmt: (v: number) => string; label: string; onInput: (v: number) => void }) {
  const out = h('output', opts.fmt(opts.value));
  const input = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, 'aria-label': opts.label }) as HTMLInputElement;
  input.value = String(opts.value);
  const paint = () => input.style.setProperty('--p', `${((+input.value - opts.min) / (opts.max - opts.min)) * 100}%`);
  paint();
  input.addEventListener('input', () => { const v = +input.value; out.textContent = opts.fmt(v); paint(); opts.onInput(v); });
  input.addEventListener('change', () => sound.hover());
  return h('div.slider', input, out);
}

export function toggle(value: boolean, label: string, onChange: (v: boolean) => void) {
  const b = h('button.toggle', { type: 'button', role: 'switch', 'aria-label': label, 'data-nav': '' }, h('span.knob'), h('span.state'));
  const set = (v: boolean) => { b.setAttribute('aria-checked', String(v)); b.lastElementChild!.textContent = v ? t('on') : t('off'); };
  set(value);
  b.addEventListener('click', () => { value = !value; set(value); onChange(value); });
  return b;
}

export function segmented<T extends string | number>(options: { value: T; label: string }[], value: T, label: string, onChange: (v: T) => void) {
  const wrap = h('div.seg', { role: 'radiogroup', 'aria-label': label });
  const btns = options.map((o) => h('button', {
    type: 'button', role: 'radio', 'data-nav': '',
    onclick: () => { value = o.value; paint(); onChange(o.value); },
  }, o.label));
  const paint = () => btns.forEach((b, i) => b.setAttribute('aria-checked', String(options[i].value === value)));
  paint();
  wrap.append(...btns);
  return wrap;
}

/** Bouton qui copie un texte et affiche « Copié » brièvement. */
export function copyButton(label: string, text: () => string, cls = '') {
  const b = h(`button.btn${cls ? '.' + cls : ''}` as 'button', { type: 'button', 'data-nav': '' }, label);
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); } catch { return sound.error(); }
    b.textContent = `✓ ${t('lobby.copied')}`; b.classList.add('ok');
    setTimeout(() => { b.textContent = label; b.classList.remove('ok'); }, 1600);
  });
  return b;
}

export function empty(text: string) { return h('p.empty', text); }
