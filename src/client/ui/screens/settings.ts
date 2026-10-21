// Paramètres : graphismes, audio, commandes, langue, accessibilité. Chaque réglage s'applique immédiatement.
import { h } from '../dom';
import { LANGS, t, type Lang } from '../i18n';
import { sound } from '../audio';
import { ACTIONS, keyLabel, resetSettings, setSetting, settings, type Action, type Quality, type Settings } from '../settings';
import { field, segmented, sheet, slider, tabs, toggle } from '../widgets';
import type { ScreenDef } from '../types';

type Tab = 'graphics' | 'audio' | 'controls' | 'language' | 'access';
const TAB_KEYS: Record<Tab, (keyof Settings)[]> = {
  graphics: ['quality', 'renderScale', 'fov', 'brightness', 'showFps'],
  audio: ['master', 'music', 'sfx'],
  controls: ['sensitivity', 'invertY', 'binds'],
  language: ['lang'],
  access: ['reduceMotion', 'highContrast', 'textScale', 'crosshair', 'grain'],
};
let lastTab: Tab = 'graphics';
const pct = (v: number) => `${Math.round(v * 100)} %`;

export const settingsScreen: ScreenDef = (ctx, arg) => {
  let stopCapture = () => {};
  const tb = tabs<Tab>([
    { id: 'graphics', label: t('set.graphics') },
    { id: 'audio', label: t('set.audio') },
    { id: 'controls', label: t('set.controls') },
    { id: 'language', label: t('set.language') },
    { id: 'access', label: t('set.access') },
  ], (arg as Tab) || lastTab, (id) => { stopCapture(); return render(id); }, (id) => { lastTab = id; });

  function render(id: Tab): Node {
    switch (id) {
      case 'graphics': return h('div.pane.fields',
        field(t('set.quality'), t('set.quality.sub'), segmented<Quality>(
          (['low', 'medium', 'high'] as const).map((q) => ({ value: q, label: t(`q.${q}`) })), settings.quality, t('set.quality'), (v) => setSetting('quality', v))),
        field(t('set.scale'), t('set.scale.sub'), slider({ label: t('set.scale'), min: 0.5, max: 1, step: 0.05, value: settings.renderScale, fmt: pct, onInput: (v) => setSetting('renderScale', v) })),
        field(t('set.fov'), null, slider({ label: t('set.fov'), min: 60, max: 100, step: 1, value: settings.fov, fmt: (v) => `${v}°`, onInput: (v) => setSetting('fov', v) })),
        field(t('set.brightness'), null, slider({ label: t('set.brightness'), min: 0.6, max: 1.6, step: 0.05, value: settings.brightness, fmt: pct, onInput: (v) => setSetting('brightness', v) })),
        field(t('set.fullscreen'), null, toggle(!!document.fullscreenElement, t('set.fullscreen'), (v) => {
          (v ? document.documentElement.requestFullscreen() : document.exitFullscreen()).catch(() => sound.error());
        })),
        field(t('set.fps'), null, toggle(settings.showFps, t('set.fps'), (v) => setSetting('showFps', v))),
      );
      case 'audio': return h('div.pane.fields',
        ...(['master', 'music', 'sfx'] as const).map((k) => field(t(`set.${k}`), null,
          slider({ label: t(`set.${k}`), min: 0, max: 1, step: 0.05, value: settings[k], fmt: pct, onInput: (v) => setSetting(k, v) }))),
        field('', null, h('button.btn', { type: 'button', 'data-nav': '', 'data-sound': 'none', onclick: () => { sound.start(); sound.stinger(); } }, `▶ ${t('set.audio.test')}`)),
      );
      case 'controls': return h('div.pane.fields',
        field(t('set.sens'), null, slider({ label: t('set.sens'), min: 0.2, max: 3, step: 0.05, value: settings.sensitivity, fmt: (v) => `×${v.toFixed(2)}`, onInput: (v) => setSetting('sensitivity', v) })),
        field(t('set.invert'), null, toggle(settings.invertY, t('set.invert'), (v) => setSetting('invertY', v))),
        h('h3', t('set.binds')),
        h('p.lead', t('set.binds.sub')),
        h('div.binds', ...ACTIONS.map((a) => bindButton(a))),
      );
      case 'language': return h('div.pane.fields',
        field(t('set.lang'), null, segmented<Lang>(
          (Object.keys(LANGS) as Lang[]).map((l) => ({ value: l, label: LANGS[l].label })), settings.lang, t('set.lang'),
          (v) => { setSetting('lang', v); ctx.refresh(); })),
      );
      case 'access': return h('div.pane.fields',
        field(t('set.motion'), t('set.motion.sub'), toggle(settings.reduceMotion, t('set.motion'), (v) => setSetting('reduceMotion', v))),
        field(t('set.contrast'), null, toggle(settings.highContrast, t('set.contrast'), (v) => setSetting('highContrast', v))),
        field(t('set.text'), null, segmented<number>([{ value: 1, label: 'A' }, { value: 1.15, label: 'A+' }, { value: 1.3, label: 'A++' }], settings.textScale, t('set.text'), (v) => setSetting('textScale', v))),
        field(t('set.crosshair'), null, toggle(settings.crosshair, t('set.crosshair'), (v) => setSetting('crosshair', v))),
        field(t('set.grain'), null, toggle(settings.grain, t('set.grain'), (v) => setSetting('grain', v))),
      );
    }
  }

  // Réaffectation : clic puis touche (Échap annule). Une touche déjà prise est échangée avec l'action qui l'avait.
  function bindButton(a: Action) {
    const key = h('kbd', keyLabel(settings.binds[a]));
    const b = h('button.bind', { type: 'button', 'data-nav': '' }, h('span', t(`bind.${a}`)), key);
    b.addEventListener('click', () => {
      stopCapture();
      b.classList.add('wait'); key.textContent = t('set.binds.wait');
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault(); e.stopPropagation();
        if (e.code !== 'Escape') {
          const binds = { ...settings.binds };
          const other = ACTIONS.find((x) => x !== a && binds[x] === e.code);
          if (other) binds[other] = binds[a];
          binds[a] = e.code;
          setSetting('binds', binds);
          sound.click();
        }
        stopCapture();
        tb.select('controls');
      };
      addEventListener('keydown', onKey, { capture: true });
      stopCapture = () => { removeEventListener('keydown', onKey, { capture: true }); b.classList.remove('wait'); key.textContent = keyLabel(settings.binds[a]); stopCapture = () => {}; };
    });
    return b;
  }

  const foot = [
    h('button.btn.ghost', { type: 'button', 'data-nav': '', onclick: () => { resetSettings(TAB_KEYS[tb.current]); ctx.refresh(); } }, `↺ ${t('set.reset')}`),
    h('span.spacer'),
    h('button.btn.primary', { type: 'button', 'data-nav': '', onclick: () => ctx.back() }, t('back')),
  ];
  return { el: sheet(ctx, t('set.title'), [tb.el], foot), layout: 'sheet', dispose: () => stopCapture() };
};
