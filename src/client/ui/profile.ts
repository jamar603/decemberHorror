// Profil local : statistiques, progression (XP / niveau), succès, amis et joueurs récents.
// Tout est en localStorage (pas de compte) ; le shell appelle les hooks track*() pendant la partie.
import { lang } from './i18n';

export interface Stats {
  since: number;
  games: number; hosted: number;
  time: number; // secondes en partie
  dist: number; // mètres parcourus
  maxFromSpawn: number;
  maxRoom: number; // plus grand nombre de joueurs vus ensemble
  met: number;
  chars: number[]; // personnages incarnés (indices)
  night: boolean; // a joué entre minuit et 5 h
}
export interface Person { name: string; at: number; friend?: boolean }
export interface LastGame { code: string; at: number; priv: boolean }

interface Achievement {
  id: string;
  name: Record<'fr' | 'en', string>;
  desc: Record<'fr' | 'en', string>;
  icon: string;
  progress: (s: Stats) => [number, number];
}
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first', icon: '☾', name: { fr: 'Premier pas', en: 'First step' }, desc: { fr: 'Entrer dans une partie', en: 'Enter a game' }, progress: (s) => [s.games, 1] },
  { id: 'host', icon: '⌂', name: { fr: 'Maître des lieux', en: 'Host' }, desc: { fr: 'Créer 5 parties', en: 'Create 5 games' }, progress: (s) => [s.hosted, 5] },
  { id: 'company', icon: '⚇', name: { fr: 'Pas seul', en: 'Not alone' }, desc: { fr: 'Croiser un autre survivant', en: 'Meet another survivor' }, progress: (s) => [s.met, 1] },
  { id: 'pack', icon: '⚉', name: { fr: 'La meute', en: 'The pack' }, desc: { fr: 'Être 4 dans la même partie', en: 'Be 4 in the same game' }, progress: (s) => [s.maxRoom, 4] },
  { id: 'far', icon: '⟟', name: { fr: 'Trop loin', en: 'Too far' }, desc: { fr: 'S’éloigner de 200 m du point de départ', en: 'Wander 200 m from the start' }, progress: (s) => [Math.floor(s.maxFromSpawn), 200] },
  { id: 'marathon', icon: '∞', name: { fr: 'Marathonien', en: 'Marathoner' }, desc: { fr: 'Parcourir 5 km au total', en: 'Walk 5 km in total' }, progress: (s) => [Math.floor(s.dist), 5000] },
  { id: 'insomnia', icon: '◔', name: { fr: 'Insomniaque', en: 'Insomniac' }, desc: { fr: 'Passer 1 heure dans la forêt', en: 'Spend 1 hour in the woods' }, progress: (s) => [Math.floor(s.time / 60), 60] },
  { id: 'chameleon', icon: '◐', name: { fr: 'Mille visages', en: 'A thousand faces' }, desc: { fr: 'Incarner les 10 personnages', en: 'Play all 10 characters' }, progress: (s) => [s.chars.length, 10] },
  { id: 'night', icon: '✶', name: { fr: 'Heure du loup', en: 'Hour of the wolf' }, desc: { fr: 'Jouer entre minuit et 5 h', en: 'Play between midnight and 5 am' }, progress: (s) => [s.night ? 1 : 0, 1] },
];
export const achName = (a: Achievement) => a.name[lang] ?? a.name.fr;
export const achDesc = (a: Achievement) => a.desc[lang] ?? a.desc.fr;

const K = { stats: 'december.stats', people: 'december.people', last: 'december.last' };
const read = <T>(k: string, d: T): T => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || 'null') }; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const fresh = (): Stats => ({ since: Date.now(), games: 0, hosted: 0, time: 0, dist: 0, maxFromSpawn: 0, maxRoom: 1, met: 0, chars: [], night: false });

export const stats: Stats = read(K.stats, fresh());
let people: Person[] = (() => { try { return JSON.parse(localStorage.getItem(K.people) || '[]'); } catch { return []; } })();

// --- Progression : 1 XP / 10 s de jeu, 1 XP / 20 m, 25 XP / partie, 50 XP / succès
export const isDone = (a: Achievement) => { const [v, max] = a.progress(stats); return v >= max; };
export function xp() {
  return Math.floor(stats.time / 10 + stats.dist / 20 + stats.games * 25 + ACHIEVEMENTS.filter(isDone).length * 50);
}
export function level() {
  const x = xp();
  let lvl = 1, need = 100, base = 0;
  while (x >= base + need) { base += need; lvl++; need = Math.round(need * 1.25); }
  return { lvl, cur: x - base, need };
}

// --- Hooks appelés par le shell
let onUnlock: (a: Achievement) => void = () => {};
export function onAchievement(fn: (a: Achievement) => void) { onUnlock = fn; }
let dirty = false;
function change(fn: () => void) {
  const before = new Set(ACHIEVEMENTS.filter(isDone).map((a) => a.id));
  fn();
  for (const a of ACHIEVEMENTS) if (!before.has(a.id) && isDone(a)) onUnlock(a);
  dirty = true;
}
export function flush() { if (dirty) { dirty = false; write(K.stats, stats); } }
setInterval(flush, 5000);
addEventListener('pagehide', flush);

export function trackGame(created: boolean, char: number) {
  change(() => {
    stats.games++;
    if (created) stats.hosted++;
    if (!stats.chars.includes(char)) stats.chars.push(char);
    const h = new Date().getHours();
    if (h < 5) stats.night = true;
  });
  flush();
}
export function trackChar(char: number) { if (!stats.chars.includes(char)) change(() => stats.chars.push(char)); }
export function trackMove(dt: number, moved: number, fromSpawn: number, roomSize: number) {
  // sans change() à chaque frame : on ne vérifie les succès qu'une fois par seconde
  stats.time += dt; stats.dist += Math.min(moved, 2);
  acc += dt;
  if (acc < 1) return;
  acc = 0;
  change(() => { stats.maxFromSpawn = Math.max(stats.maxFromSpawn, fromSpawn); stats.maxRoom = Math.max(stats.maxRoom, roomSize); });
}
let acc = 0;
export function trackMet(name: string) {
  const p = people.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (p) p.at = Date.now();
  else { people.unshift({ name, at: Date.now() }); change(() => stats.met++); }
  people = people.filter((x) => x.friend).concat(people.filter((x) => !x.friend).sort((a, b) => b.at - a.at).slice(0, 30));
  write(K.people, people);
}
export function resetProfile() {
  Object.assign(stats, fresh());
  dirty = true; flush();
}

// --- Amis
export const friends = () => people.filter((p) => p.friend).sort((a, b) => a.name.localeCompare(b.name));
export const recent = () => people.filter((p) => !p.friend).sort((a, b) => b.at - a.at);
export function setFriend(name: string, on: boolean) {
  name = name.trim().slice(0, 16);
  if (!name) return;
  const p = people.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (p) p.friend = on || undefined;
  else if (on) people.push({ name, at: 0, friend: true });
  write(K.people, people);
}

// --- Dernière partie (bouton « Continuer »)
export function lastGame(): LastGame | null {
  try { const g = JSON.parse(localStorage.getItem(K.last) || 'null'); return g?.code ? g : null; } catch { return null; }
}
export function setLastGame(g: LastGame) { write(K.last, g); }
