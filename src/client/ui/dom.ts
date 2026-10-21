// Mini-helper DOM : h('button.primary', { onclick }, 'Texte'). Pas de framework, pas de innerHTML (pas d'injection).
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string };

export function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}` | `${K}#${string}`,attrs?: Attrs | Child, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const [head, ...cls] = sel.split('.');
  const [tag, id] = head.split('#');
  const el = document.createElement(tag as K);
  if (id) el.id = id;
  if (cls.length) el.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) kids.unshift(attrs as Child);
  else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'style') typeof v === 'string' ? (el.style.cssText = v) : Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

function append(el: Node, kids: Child[]) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export function timeAgo(sec: number, lang: string) {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (sec < 60) return rtf.format(-Math.round(sec), 'second');
  if (sec < 3600) return rtf.format(-Math.round(sec / 60), 'minute');
  if (sec < 86400) return rtf.format(-Math.round(sec / 3600), 'hour');
  return rtf.format(-Math.round(sec / 86400), 'day');
}

export function duration(sec: number) {
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60);
  return hh ? `${hh} h ${String(mm).padStart(2, '0')}` : `${mm} min`;
}
