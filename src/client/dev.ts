// MODE DEV : capture d'écran (Impr. écran / F9) + prompt envoyé au bridge Claude d'un dev (npm run bridge).
// Activation : ouvrir le jeu avec ?dev=<token> (stocké ensuite dans localStorage).
// F10 : suivi des tâches (onglet « Mon Claude » : mes tâches, plan, journal ; onglet « Équipe » : qui fait quoi).
// Un mini-suivi reste affiché en bas à gauche pendant qu'une de mes tâches tourne.
// Le brouillon du prompt (texte + capture) survit aux rechargements de mise à jour.
import type { DevBridge, DevTask, DevTaskOp, ServerMsg } from '../shared/protocol';
import type { Net } from './net';

const KEY = 'december.devToken';
const KEYS = 'december.devKeys'; // clés des bridges dont on a le droit d'utiliser le Claude
const DRAFT = 'december.devDraft'; // { prompt, target } — sessionStorage
const DRAFT_IMG = 'december.devDraftImg';
const PHASES: [string, string][] = [['read', 'Lecture'], ['edit', 'Modif'], ['check', 'Vérif'], ['push', 'Push']];
const HISTORY = 'december.devHistory'; // derniers prompts envoyés (↑ dans la zone de texte)
const TARGET = 'december.devTarget';
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const toastBox = document.getElementById('toast')!;

export function devKeys(): string[] {
  const url = new URL(location.href);
  const q = url.searchParams.get('key');
  let keys: string[] = [];
  try { keys = JSON.parse(localStorage.getItem(KEYS) || '[]'); } catch {}
  if (q) {
    if (!keys.includes(q)) keys.push(q);
    try { localStorage.setItem(KEYS, JSON.stringify(keys)); } catch {}
    url.searchParams.delete('key');
    history.replaceState(null, '', url);
  }
  return keys;
}

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
  owned = new Set<string>();
  private flip = new Set<string>(); // tâches dont l'état déplié est inversé (les tâches en cours sont dépliées par défaut)
  private tab: 'me' | 'team' = 'me';
  private deploy: { state: string; msg: string; at: number } | null = null;
  private statusEl: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private badge: HTMLElement | null = null;
  private mini: HTMLElement | null = null;
  private lastHtml = '';
  private known = new Map<string, DevTask['state']>();

  constructor(private net: Net, private capture: () => Promise<string>, private onModal: (open: boolean) => void) {
    addEventListener('keyup', (e) => {
      // PrintScreen ne déclenche que keyup dans la plupart des navigateurs
      if (this.enabled && (e.code === 'PrintScreen' || e.code === 'F9')) { e.preventDefault(); this.shoot(); }
    });
    addEventListener('keydown', (e) => {
      if (this.enabled && e.code === 'F10') { e.preventDefault(); this.togglePanel(); }
    }, true);
    setInterval(() => { if (this.panel) this.render(); this.updateMini(); }, 3000); // durées vivantes
  }

  /** Une fenêtre dev est ouverte : la mise à jour du shell attend sa fermeture. */
  get isOpen() { return !!this.modal || !!this.panel; }

  private mine() { return this.bridges.filter((b) => !!b.owner && this.owned.has(b.owner)); }
  private isMine(b: DevBridge) { return !!b.owner && this.owned.has(b.owner); }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    const b = document.createElement('button');
    b.id = 'dev-badge';
    b.addEventListener('click', () => this.togglePanel());
    document.body.append(b);
    this.badge = b;
    const m = document.createElement('button');
    m.id = 'dev-mini';
    m.hidden = true;
    m.addEventListener('click', () => { if (!this.panel) this.togglePanel(); });
    document.body.append(m);
    this.mini = m;
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
    else if (m.t === 'devStatus') { this.deploy = { state: m.state, msg: m.msg, at: Date.now() }; this.status(m.state, m.msg); if (this.panel) this.render(); }
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
      else if (t.state === 'done') toast(`✓ Tâche terminée — ${p}${t.commit ? ' · ' + t.commit.slice(0, 60) : ''}`, 'ok', 7000);
      else if (t.state === 'failed') toast(`✗ Tâche échouée — ${p}${t.msg ? ' — ' + t.msg : ''}`, 'err', 8000);
    }
    this.known = next;
  }

  private updateBadge() {
    this.updateMini();
    if (!this.badge) return;
    const ts = this.allTasks();
    const run = ts.filter((t) => t.state === 'running').length;
    const wait = ts.filter((t) => t.state === 'pending').length;
    this.badge.innerHTML = `DEV · <kbd>F9</kbd> demande · <kbd>F10</kbd> suivi${run || wait ? ` <b>${run ? `${run} ▶` : ''}${run && wait ? ' · ' : ''}${wait ? `${wait} en attente` : ''}</b>` : ''}`;
  }

  // mini-suivi permanent de MES tâches (pas besoin d'ouvrir F10 pour voir où ça en est)
  private updateMini() {
    const m = this.mini;
    if (!m) return;
    const mine = this.mine().flatMap((b) => b.tasks);
    const cur = mine.find((t) => t.state === 'running');
    const wait = mine.filter((t) => t.state === 'pending').length;
    if (!cur && !wait || this.panel) { m.hidden = true; return; }
    const td = cur?.todos ?? [];
    const done = td.filter((x) => x.status === 'done').length;
    m.hidden = false;
    m.innerHTML = cur
      ? `<i class="spin"></i><span class="mt"><b>${esc(cur.activity || 'Démarrage…')}</b><small>${td.length ? `${done}/${td.length} étapes · ` : ''}${ago(cur.started ?? cur.at)}${wait ? ` · +${wait} en file` : ''}</small></span>`
      : `<span class="ic wait">…</span><span class="mt"><b>${wait} en attente</b></span>`;
  }

  // ---------- Capture + prompt (F9) ----------
  async shoot(restored?: string) {
    if (this.modal) return;
    const img = restored ?? await this.capture();
    if (!restored) ss.set(DRAFT_IMG, img);
    const draft = restored ? JSON.parse(ss.get(DRAFT) || '{}') as { prompt?: string } : {};
    const m = document.createElement('div');
    m.id = 'dev-shot';
    m.innerHTML = `<div class="box" role="dialog" aria-label="Nouvelle demande à Claude">
      <header><b>Nouvelle demande</b><span class="target"></span><button class="cancel" title="Annuler (Échap)">✕</button></header>
      <div class="stage"><canvas></canvas></div>
      <div class="tools"><span>Entoure ou souligne ce qui doit changer :</span><button class="undo" title="Annuler le dernier trait (Ctrl+Z)">↶ Trait</button><button class="wipe">Effacer</button></div>
      <textarea placeholder="Décris la modification à faire…  (↑ : tes derniers prompts)" aria-label="Description de la modification"></textarea>
      <div class="row"><select aria-label="Claude cible"></select>
        <label class="fresh"><input type="checkbox" /> Nouvelle conversation</label>
        <button class="send primary">Envoyer <kbd>Ctrl ↵</kbd></button></div>
      <div class="hint"></div>
    </div>`;
    const ta = m.querySelector('textarea')!;
    const sel = m.querySelector('select')!;
    const cv = m.querySelector('canvas')!;
    const strokes: [number, number][][] = [];
    // capture annotable : traits rouges à la souris
    const image = new Image();
    const ctx = cv.getContext('2d')!;
    const redraw = () => {
      ctx.drawImage(image, 0, 0, cv.width, cv.height);
      ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = Math.max(3, cv.width / 260); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const s of strokes) { ctx.beginPath(); s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (s.length === 1) ctx.lineTo(s[0][0] + .1, s[0][1]); ctx.stroke(); }
    };
    image.onload = () => { cv.width = image.naturalWidth; cv.height = image.naturalHeight; redraw(); };
    image.src = img;
    let drawing = false;
    const pt = (e: PointerEvent): [number, number] => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)]; };
    cv.addEventListener('pointerdown', (e) => { drawing = true; cv.setPointerCapture(e.pointerId); strokes.push([pt(e)]); redraw(); });
    cv.addEventListener('pointermove', (e) => { if (!drawing) return; strokes[strokes.length - 1].push(pt(e)); redraw(); });
    const stop = () => { drawing = false; };
    cv.addEventListener('pointerup', stop); cv.addEventListener('pointercancel', stop);
    m.querySelector('.undo')!.addEventListener('click', () => { strokes.pop(); redraw(); });
    m.querySelector('.wipe')!.addEventListener('click', () => { strokes.length = 0; redraw(); });

    ta.value = draft.prompt ?? '';
    ta.addEventListener('input', () => ss.set(DRAFT, JSON.stringify({ prompt: ta.value })));
    let hist = -1;
    const history = (): string[] => { try { return JSON.parse(localStorage.getItem(HISTORY) || '[]'); } catch { return []; } };
    const close = () => { m.remove(); this.modal = null; ss.del(DRAFT, DRAFT_IMG); this.onModal(this.isOpen); };
    const send = () => {
      const prompt = ta.value.trim();
      if (!prompt || !sel.value) { ta.focus(); return; }
      try {
        localStorage.setItem(TARGET, sel.value);
        localStorage.setItem(HISTORY, JSON.stringify([prompt, ...history().filter((x) => x !== prompt)].slice(0, 15)));
      } catch {}
      const out = strokes.length ? cv.toDataURL('image/jpeg', 0.85) : img;
      this.net.send({ t: 'devPrompt', bridge: sel.value, prompt, image: out, fresh: m.querySelector<HTMLInputElement>('.fresh input')!.checked });
      toast('Envoi à Claude…');
      close();
    };
    m.querySelector('.cancel')!.addEventListener('click', close);
    m.querySelector('.send')!.addEventListener('click', send);
    m.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
      else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.target !== ta) { strokes.pop(); redraw(); }
      else if (e.target === ta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const h = history();
        if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0 && hist + 1 < h.length) { e.preventDefault(); ta.value = h[++hist]; }
        else if (e.key === 'ArrowDown' && hist >= 0) { e.preventDefault(); ta.value = hist > 0 ? h[--hist] : (hist = -1, ''); }
        ta.dispatchEvent(new Event('input'));
      }
    });
    m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
    document.body.append(m);
    this.modal = m;
    this.fillTargets();
    this.onModal(true);
    ta.focus();
  }

  private fillTargets() {
    const m = this.modal!;
    const sel = m.querySelector('select')!;
    let prev = sel.value;
    if (!prev) try { prev = localStorage.getItem(TARGET) || ''; } catch {}
    sel.innerHTML = '';
    const mine = this.mine();
    const send = m.querySelector<HTMLButtonElement>('.send')!;
    const hint = m.querySelector('.hint')!;
    const target = m.querySelector('.target')!;
    send.disabled = !mine.length;
    if (!mine.length) {
      sel.hidden = true; target.textContent = '';
      hint.innerHTML = `<span class="warn">Aucun Claude à toi n'est connecté : lance <code>npm run bridge</code> et ouvre le lien affiché dans le terminal.</span>`;
      return;
    }
    for (const b of mine) sel.append(new Option(`${b.host}`, b.id));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    sel.hidden = mine.length < 2; // un seul Claude : inutile de proposer un choix
    const b = mine.find((x) => x.id === sel.value) ?? mine[0];
    const live = b.tasks.filter((t) => t.state === 'running' || t.state === 'pending').length;
    const se = b.session;
    target.innerHTML = `→ <b>${esc(b.host.split('@')[0])}</b>${live ? ` · ${live} tâche${live > 1 ? 's' : ''} avant` : ' · libre'}`;
    hint.textContent = `${se?.active ? `Conversation en cours (${Math.round(se.ctx / 1000)}k / ${Math.round(se.max / 1000)}k tokens) · ` : ''}Échap annule · une tâche à la fois, les suivantes attendent · F10 = suivi`;
    sel.onchange = () => this.fillTargets();
  }

  // ---------- Suivi (F10) ----------
  togglePanel() {
    if (this.panel) { this.panel.remove(); this.panel = null; this.lastHtml = ''; this.onModal(this.isOpen); this.updateMini(); return; }
    const p = document.createElement('aside');
    p.id = 'dev-tasks';
    p.addEventListener('click', (e) => this.panelClick(e));
    p.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      const inp = f.querySelector('input')!;
      const text = inp.value.trim();
      if (!text) return;
      this.net.send({ t: 'devTodo', bridge: f.dataset.bridge!, task: f.dataset.task!, op: 'add', text });
      inp.value = '';
    });
    p.addEventListener('keydown', (e) => { if (e.code !== 'F10') e.stopPropagation(); if (e.key === 'Escape') this.togglePanel(); });
    document.body.append(p);
    this.panel = p;
    if (!this.mine().length) this.tab = 'team';
    this.lastHtml = '';
    this.render();
    this.updateMini();
    this.onModal(true);
  }

  private op(bridge: string, op: DevTaskOp, id?: string) { this.net.send({ t: 'devTask', bridge, op, id }); }

  private taskCard(b: DevBridge, t: DevTask, mine: boolean) {
    const live = t.state === 'running' || t.state === 'pending';
    const expanded = this.flip.has(t.id) !== (t.state === 'running');
    const todos = t.todos ?? [];
    const doneN = todos.filter((x) => x.status === 'done').length;
    const meta = t.state === 'running' ? `depuis ${ago(t.started ?? t.at)}` : t.state === 'pending' ? `en attente · ${ago(t.at)}` : `il y a ${ago(t.ended ?? t.at)}`;
    const icon = t.state === 'running' ? '<i class="spin"></i>' : t.state === 'pending' ? '<span class="ic wait">…</span>'
      : t.state === 'done' ? '<span class="ic ok">✓</span>' : '<span class="ic err">✗</span>';
    const attr = `data-bridge="${esc(b.id)}" data-id="${esc(t.id)}"`;
    const actions = !mine ? '' : t.state === 'running' ? `<button data-act="cancel" ${attr}>Arrêter</button>`
      : t.state === 'pending' ? `<button data-act="cancel" ${attr}>Retirer</button>`
      : `<button data-act="retry" ${attr} title="Relancer le même prompt avec la même capture">Relancer</button><button data-act="delete" ${attr} title="Retirer de la liste">✕</button>`;
    let body = '';
    if (expanded) {
      const idx = PHASES.findIndex((x) => x[0] === t.phase);
      const phases = t.state === 'running' ? `<div class="phases">${PHASES.map(([k, l], i) => `<span class="${i === idx ? 'on' : i < idx ? 'past' : ''}">${l}</span>`).join('')}</div>` : '';
      const act = t.state === 'running' ? `<div class="act">${esc(t.activity || 'Démarrage…')}</div>` : '';
      const plan = todos.length || (live && mine) ? `<div class="plan">
        ${todos.length ? `<div class="pbar"><i style="width:${Math.round((doneN / todos.length) * 100)}%"></i></div>` : ''}
        <ul>${todos.map((x) => `<li class="td ${x.status}"><span class="ck">${x.status === 'done' ? '✓' : x.status === 'doing' ? '▶' : '○'}</span><span class="tx">${esc(x.text)}</span>${x.by !== 'claude' ? `<small>${esc(x.by)}</small>` : ''}${live && mine && x.status === 'todo' ? `<button data-act="todo-del" data-todo="${esc(x.id)}" ${attr} title="Retirer l'étape">✕</button>` : ''}</li>`).join('')}</ul>
        ${live && mine ? `<form class="todo-add" data-task="${esc(t.id)}" data-bridge="${esc(b.id)}"><input maxlength="160" placeholder="Ajouter une étape…" aria-label="Ajouter une étape" /><button>+</button></form>` : ''}</div>` : '';
      const steps = t.steps?.length ? `<details class="log"${this.openLogs.has(t.id) ? ' open' : ''}><summary>Journal (${t.steps.length})</summary><ol class="steps">${t.steps.slice(-40).map((s) => `<li class="${s.kind}"><time>${new Date(s.at).toLocaleTimeString('fr-FR')}</time> ${esc(s.text)}</li>`).join('')}</ol></details>` : '';
      const res = !live ? `${t.msg ? `<div class="res">${esc(t.msg)}</div>` : ''}${t.commit ? `<div class="commit">Commit : <code>${esc(t.commit)}</code></div>` : ''}${t.files?.length ? `<div class="files">${t.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}${t.cost ? `<div class="cost">Durée ${dur((t.ended ?? Date.now()) - (t.started ?? t.at))} · ${t.cost} $</div>` : ''}` : '';
      body = `<div class="tb">${phases}${act}${plan}${res}${steps}</div>`;
    }
    return `<li class="task ${t.state}${expanded ? ' expanded' : ''}"><div class="th" data-toggle="${esc(t.id)}">${icon}<div class="tt"><div class="p">${esc(t.prompt)}</div>
      <div class="meta">${meta}${todos.length ? ` · ${doneN}/${todos.length} étapes` : ''}${t.state !== 'running' && !expanded && t.msg ? ` · <em>${esc(t.msg.slice(0, 90))}</em>` : ''}${mine ? '' : ` · <b>${esc(b.host.split('@')[0])}</b>`}</div></div><div class="acts">${actions}</div></div>${body}</li>`;
  }
  private openLogs = new Set<string>();

  private render() {
    const p = this.panel;
    if (!p) return;
    const mineB = this.mine();
    const team = this.bridges;
    const working = team.filter((b) => b.tasks.some((t) => t.state === 'running')).length;
    const dep = this.deploy && Date.now() - this.deploy.at < 120_000
      ? `<div class="dep ${this.deploy.state}">${({ building: '⚙ Build en cours…', deploying: '⬆ Déploiement…', done: '✓ Déployé en prod', failed: '✗ Échec du build' } as Record<string, string>)[this.deploy.state] ?? this.deploy.state}${this.deploy.msg ? ' — ' + esc(this.deploy.msg) : ''}</div>` : '';
    let content = '';
    if (this.tab === 'me') {
      content = mineB.length ? mineB.map((b) => {
        const se = b.session;
        const order = { running: 0, pending: 1, done: 2, failed: 2 };
        const ts = [...b.tasks].sort((x, y) => order[x.state] - order[y.state] || (order[x.state] === 2 ? (y.ended ?? 0) - (x.ended ?? 0) : (x.at - y.at)));
        const liveT = ts.filter((t) => order[t.state] < 2);
        const past = ts.filter((t) => order[t.state] === 2);
        const pct = se ? Math.min(100, Math.round((se.ctx / (se.max || 1)) * 100)) : 0;
        const conv = se ? `<div class="conv"><div class="cbar" title="Contexte de la conversation Claude"><i style="width:${pct}%"></i></div>
          <span>${se.active ? `Conversation : ${Math.round(se.ctx / 1000)}k / ${Math.round(se.max / 1000)}k tokens · ${se.turns} tâche${se.turns > 1 ? 's' : ''}` : 'Conversation vide : la prochaine tâche repart de zéro'}</span>
          ${se.active ? `<button data-act="reset" data-bridge="${esc(b.id)}">Nouvelle conversation</button>` : ''}</div>` : '';
        return `${conv}
          <ul class="tasks">${liveT.length ? liveT.map((t) => this.taskCard(b, t, true)).join('') : '<li class="empty">Rien en cours.</li>'}</ul>
          ${past.length ? `<h4>Terminées <button class="link" data-act="clear" data-bridge="${esc(b.id)}">Vider</button></h4><ul class="tasks">${past.slice(0, 8).map((t) => this.taskCard(b, t, true)).join('')}</ul>` : ''}`;
      }).join('') : `<p class="empty">Aucun Claude à toi n'est connecté.<br>Lance <code>npm run bridge</code> et ouvre le lien affiché dans le terminal.</p>`;
      content += `<button class="newtask" data-act="new">+ Nouvelle demande <kbd>F9</kbd></button>`;
    } else {
      const who = (b: DevBridge) => esc(b.host.split('@')[0]);
      const touched = new Map<string, Set<string>>();
      for (const b of team) for (const t of b.tasks) if (t.state === 'running') for (const f of t.files ?? []) (touched.get(f) ?? touched.set(f, new Set()).get(f)!).add(b.host.split('@')[0]);
      const clash = [...touched].filter(([, s]) => s.size > 1).map(([f, s]) => `<div class="warn">⚠ <code>${esc(f)}</code> modifié en même temps par ${[...s].map(esc).join(' et ')}</div>`).join('');
      const blocks = team.map((b) => {
        const liveT = b.tasks.filter((t) => t.state === 'running' || t.state === 'pending').sort((x, y) => (x.state === 'running' ? 0 : 1) - (y.state === 'running' ? 0 : 1));
        const busy = liveT.some((t) => t.state === 'running');
        return `<section class="blk"><div class="who"><span class="dot ${busy ? 'busy' : ''}"></span><b>${who(b)}</b><small title="${esc(b.host)}">${esc(b.host.split('@')[1] ?? '')}</small>${this.isMine(b) ? '<em>toi</em>' : ''}</div>
          ${liveT.length ? `<ul class="tasks">${liveT.map((t) => this.taskCard(b, t, this.isMine(b))).join('')}</ul>` : '<div class="idle">Inactif</div>'}</section>`;
      }).join('');
      const feed = team.flatMap((b) => b.tasks.flatMap((t) => [
        ...(t.steps ?? []).filter((s) => s.kind !== 'note').map((s) => ({ at: s.at, who: who(b), text: s.text })),
        ...(t.ended ? [{ at: t.ended, who: who(b), text: `${t.state === 'done' ? '✓ terminé' : '✗ échoué'} : ${t.prompt.replace(/\s+/g, ' ').slice(0, 50)}` }] : []),
      ])).sort((x, y) => y.at - x.at).slice(0, 10)
        .map((e) => `<li><time>${new Date(e.at).toLocaleTimeString('fr-FR')}</time> <b>${e.who}</b> ${esc(e.text)}</li>`).join('');
      content = `${clash}${blocks || '<p class="empty">Aucun bridge connecté.</p>'}${feed ? `<h4>Fil en direct</h4><ul class="feed">${feed}</ul>` : ''}`;
    }
    const html = `<header><div class="tabs" role="tablist">
        <button role="tab" aria-selected="${this.tab === 'me'}" data-tab="me">Mon Claude</button>
        <button role="tab" aria-selected="${this.tab === 'team'}" data-tab="team">Équipe${working ? ` <b>${working} ▶</b>` : ''}</button></div>
        <button class="x" title="Fermer (F10 / Échap)" aria-label="Fermer">✕</button></header>${dep}
      <div class="list">${content}</div>`;
    const sig = html;
    if (sig === this.lastHtml) return; // rien de changé : pas de re-rendu (pas de clignotement)
    this.lastHtml = sig;
    const scroll = p.querySelector('.list')?.scrollTop ?? 0;
    const ae = document.activeElement as HTMLInputElement | null;
    const typing = ae && p.contains(ae) && ae.closest('.todo-add') ? { task: (ae.closest('.todo-add') as HTMLElement).dataset.task, value: ae.value } : null;
    p.innerHTML = html;
    p.querySelector('.list')!.scrollTop = scroll;
    p.querySelectorAll<HTMLElement>('.steps').forEach((el) => { el.scrollTop = el.scrollHeight; });
    p.querySelectorAll<HTMLDetailsElement>('details.log').forEach((d) => d.addEventListener('toggle', () => {
      const id = d.closest<HTMLElement>('.task')?.querySelector<HTMLElement>('[data-toggle]')?.dataset.toggle;
      if (id) { if (d.open) this.openLogs.add(id); else this.openLogs.delete(id); }
    }));
    if (typing) {
      const inp = p.querySelector<HTMLInputElement>(`.todo-add[data-task="${CSS.escape(typing.task ?? '')}"] input`);
      if (inp) { inp.value = typing.value; inp.focus(); }
    }
  }

  private panelClick(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (el.closest('.x')) return this.togglePanel();
    const tab = el.closest<HTMLElement>('[data-tab]');
    if (tab) { this.tab = tab.dataset.tab as 'me' | 'team'; this.lastHtml = ''; return this.render(); }
    const a = el.closest<HTMLElement>('[data-act]');
    if (a) {
      const act = a.dataset.act!, bridge = a.dataset.bridge!, id = a.dataset.id;
      if (act === 'new') { this.togglePanel(); return void this.shoot(); }
      if (act === 'todo-del') return this.net.send({ t: 'devTodo', bridge, task: id!, op: 'remove', id: a.dataset.todo });
      if (act === 'delete' || act === 'cancel' || act === 'retry') return this.op(bridge, act, id);
      if (act === 'clear' || act === 'reset') return this.op(bridge, act);
    }
    if (el.closest('.plan, .log, form, .tb')) return; // interactions dans le détail : ne pas replier
    const th = el.closest<HTMLElement>('[data-toggle]');
    if (th) { const id = th.dataset.toggle!; if (!this.flip.delete(id)) this.flip.add(id); this.lastHtml = ''; this.render(); }
  }
}
