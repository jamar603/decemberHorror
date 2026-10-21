// MODE DEV : capture d'écran (Impr. écran / F9) + prompt envoyé au bridge Claude d'un dev (npm run bridge).
// Activation : ouvrir le jeu avec ?dev=<token> (stocké ensuite dans localStorage).
// F10 : tableau des tâches de tous les devs (en cours / en attente / terminées).
// Le brouillon du prompt (texte + capture) survit aux rechargements de mise à jour.
import type { DevBridge, DevTask, DevTaskOp, ServerMsg } from '../shared/protocol';
import type { Net } from './net';

const KEY = 'december.devToken';
const DRAFT = 'december.devDraft'; // { prompt, target } — sessionStorage
const DRAFT_IMG = 'december.devDraftImg';
const toastBox = document.getElementById('toast')!;

export function devToken(): string | undefined {
  const url = new URL(location.href);
  const q = url.searchParams.get('dev');
  try {
    if (q !== null) {
      if (q) localStorage.setItem(KEY, q); else localStorage.removeItem(KEY);
      url.searchParams.delete('dev');
      history.replaceState(null, '', url);
    }
    return localStorage.getItem(KEY) || undefined;
  } catch { return q || undefined; }
}

export function toast(text: string, cls = '', ms = 4000) {
  const d = document.createElement('div');
  d.textContent = text;
  if (cls) d.className = cls;
  toastBox.append(d);
  if (ms) setTimeout(() => d.remove(), ms);
  return d;
}

const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: (...k: string[]) => { try { for (const x of k) sessionStorage.removeItem(x); } catch {} },
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`;
}

export class Dev {
  enabled = false;
  bridges: DevBridge[] = [];
  private statusEl: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private badge: HTMLElement | null = null;
  private known = new Map<string, DevTask['state']>();

  constructor(private net: Net, private capture: () => Promise<string>, private onModal: (open: boolean) => void) {
    addEventListener('keyup', (e) => {
      // PrintScreen ne déclenche que keyup dans la plupart des navigateurs
      if (this.enabled && (e.code === 'PrintScreen' || e.code === 'F9')) { e.preventDefault(); this.shoot(); }
    });
    addEventListener('keydown', (e) => {
      if (this.enabled && e.code === 'F10') { e.preventDefault(); this.togglePanel(); }
    }, true);
    setInterval(() => { if (this.panel) this.render(); }, 5000); // durées "il y a…" vivantes
  }

  /** Une fenêtre dev est ouverte : la mise à jour du shell attend sa fermeture. */
  get isOpen() { return !!this.modal || !!this.panel; }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    const b = document.createElement('button');
    b.id = 'dev-badge';
    b.addEventListener('click', () => this.togglePanel());
    document.body.append(b);
    this.badge = b;
    this.updateBadge();
    const img = ss.get(DRAFT_IMG);
    if (img) this.shoot(img); // revient d'un rechargement : on rouvre le brouillon
  }

  onMsg(m: ServerMsg) {
    if (m.t === 'bridges') {
      this.bridges = m.bridges;
      this.notifyTransitions();
      if (this.modal) this.fillTargets();
      if (this.panel) this.render();
      this.updateBadge();
    }
    else if (m.t === 'devAck') toast(m.ok ? `✓ ${m.msg}` : `✗ ${m.msg}`, m.ok ? 'ok' : 'err', 6000);
    else if (m.t === 'devStatus') this.status(m.state, m.msg);
  }

  private status(state: string, msg: string) {
    const label: Record<string, string> = { building: 'Déploiement… (build)', deploying: 'Déploiement… (envoi)', done: 'Déployé ✓', failed: 'Échec du build ✗' };
    this.statusEl?.remove();
    const done = state === 'done' || state === 'failed';
    this.statusEl = toast(`${label[state] ?? state}${msg ? ' — ' + msg : ''}`, state === 'failed' ? 'err' : done ? 'ok' : '', done ? 6000 : 0);
  }

  private allTasks() { return this.bridges.flatMap((b) => b.tasks); }

  private notifyTransitions() {
    const first = !this.known.size;
    const next = new Map<string, DevTask['state']>();
    for (const t of this.allTasks()) {
      next.set(t.id, t.state);
      const prev = this.known.get(t.id);
      if (first || prev === t.state || !prev) continue;
      const p = `${t.from} : ${t.prompt.replace(/\s+/g, ' ').slice(0, 50)}`;
      if (t.state === 'running') toast(`▶ Claude démarre — ${p}`, '', 4000);
      else if (t.state === 'done') toast(`✓ Tâche terminée — ${p}`, 'ok', 6000);
      else if (t.state === 'failed') toast(`✗ Tâche échouée — ${p}${t.msg ? ' — ' + t.msg : ''}`, 'err', 8000);
    }
    this.known = next;
  }

  private updateBadge() {
    if (!this.badge) return;
    const ts = this.allTasks();
    const run = ts.filter((t) => t.state === 'running').length;
    const wait = ts.filter((t) => t.state === 'pending').length;
    this.badge.innerHTML = `DEV · F9 capture · F10 tâches${run || wait ? ` <b>${run ? `${run} ▶` : ''}${run && wait ? ' · ' : ''}${wait ? `${wait} en attente` : ''}</b>` : ''}`;
  }

  // ---------- Capture + prompt ----------
  async shoot(restored?: string) {
    if (this.modal) return;
    const img = restored ?? await this.capture();
    if (!restored) ss.set(DRAFT_IMG, img);
    const draft = restored ? JSON.parse(ss.get(DRAFT) || '{}') as { prompt?: string } : {};
    const m = document.createElement('div');
    m.id = 'dev-shot';
    m.innerHTML = `<div class="box">
      <img alt="capture" />
      <textarea placeholder="Décris la modification à faire…"></textarea>
      <div class="row"><select></select><button class="cancel">Annuler</button><button class="send">Envoyer à Claude</button></div>
      <div class="hint">Ctrl+Entrée pour envoyer · Échap pour annuler · une tâche à la fois par bridge, les suivantes attendent · F10 = tâches</div>
    </div>`;
    (m.querySelector('img') as HTMLImageElement).src = img;
    const ta = m.querySelector('textarea')!;
    const sel = m.querySelector('select')!;
    ta.value = draft.prompt ?? '';
    ta.addEventListener('input', () => ss.set(DRAFT, JSON.stringify({ prompt: ta.value })));
    const close = () => { m.remove(); this.modal = null; ss.del(DRAFT, DRAFT_IMG); this.onModal(this.isOpen); };
    const send = () => {
      const prompt = ta.value.trim();
      if (!prompt || !sel.value) { ta.focus(); return; }
      try { localStorage.setItem('december.devTarget', sel.value); } catch {}
      this.net.send({ t: 'devPrompt', bridge: sel.value, prompt, image: img });
      toast('Envoi à Claude…');
      close();
    };
    m.querySelector('.cancel')!.addEventListener('click', close);
    m.querySelector('.send')!.addEventListener('click', send);
    m.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
    });
    document.body.append(m);
    this.modal = m;
    this.fillTargets();
    this.onModal(true);
    ta.focus();
  }

  private fillTargets() {
    const sel = this.modal!.querySelector('select')!;
    let prev = sel.value;
    if (!prev) try { prev = localStorage.getItem('december.devTarget') || ''; } catch {}
    sel.innerHTML = '';
    if (!this.bridges.length) { sel.append(new Option('Aucun bridge connecté — lance `npm run bridge` sur ta machine', '')); return; }
    for (const b of this.bridges) {
      const n = b.tasks.filter((t) => t.state === 'pending' || t.state === 'running').length;
      sel.append(new Option(`Claude de ${b.dev} @ ${b.host}${n ? ` · ${n} en file` : ''}`, b.id));
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  // ---------- Tableau des tâches (F10) ----------
  togglePanel() {
    if (this.panel) { this.panel.remove(); this.panel = null; this.onModal(this.isOpen); return; }
    const p = document.createElement('aside');
    p.id = 'dev-tasks';
    p.addEventListener('click', (e) => this.panelClick(e));
    p.addEventListener('keydown', (e) => { if (e.code !== 'F10') e.stopPropagation(); if (e.key === 'Escape') this.togglePanel(); });
    document.body.append(p);
    this.panel = p;
    this.render();
    this.onModal(true);
  }

  private op(bridge: string, op: DevTaskOp, id?: string) { this.net.send({ t: 'devTask', bridge, op, id }); }

  private render() {
    const p = this.panel!;
    const scroll = p.querySelector('.list')?.scrollTop ?? 0;
    const row = (b: DevBridge, t: DevTask) => {
      const meta = t.state === 'running' ? `depuis ${ago(t.started ?? t.at)}` : t.state === 'pending' ? `en attente · ${ago(t.at)}` : `il y a ${ago(t.ended ?? t.at)}`;
      const icon = t.state === 'running' ? '<i class="spin"></i>' : t.state === 'pending' ? '<span class="ic wait">…</span>'
        : t.state === 'done' ? '<span class="ic ok">✓</span>' : '<span class="ic err">✗</span>';
      const del = t.state === 'running' ? '' : `<button data-del="${esc(t.id)}" data-bridge="${esc(b.id)}" title="Retirer">✕</button>`;
      return `<li class="task ${t.state}">${icon}<div class="body"><div class="p" title="${esc(t.prompt)}">${esc(t.prompt)}</div>
        <div class="meta">${meta}${t.msg ? ` · <em>${esc(t.msg)}</em>` : ''}</div></div>${del}</li>`;
    };
    const order = { running: 0, pending: 1, done: 2, failed: 2 };
    const blocks = this.bridges.map((b) => {
      const ts = [...b.tasks].sort((x, y) => order[x.state] - order[y.state] || (order[x.state] === 2 ? (y.ended ?? 0) - (x.ended ?? 0) : 0));
      const clear = ts.some((t) => order[t.state] === 2) ? `<button class="clear" data-bridge="${esc(b.id)}">Vider terminées</button>` : '';
      return `<h3>${esc(b.dev)} <small>@ ${esc(b.host)}</small>${clear}</h3>
        ${ts.length ? `<ul>${ts.map((t) => row(b, t)).join('')}</ul>` : '<p class="empty">Aucune tâche · F9 pour en ajouter une</p>'}`;
    }).join('');
    p.innerHTML = `<header><b>Tâches Claude (tous les devs)</b><button class="x" title="Fermer (F10)">✕</button></header>
      <div class="list">${blocks || '<p class="empty">Aucun bridge connecté — lance <code>npm run bridge</code> sur ta machine.</p>'}</div>`;
    p.querySelector('.list')!.scrollTop = scroll;
  }

  private panelClick(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (el.closest('.x')) return this.togglePanel();
    const clear = el.closest<HTMLElement>('.clear');
    if (clear) return this.op(clear.dataset.bridge!, 'clear');
    const del = el.closest<HTMLElement>('[data-del]');
    if (del) this.op(del.dataset.bridge!, 'delete', del.dataset.del);
  }
}
