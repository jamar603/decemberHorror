// Personnages jouables : 5 hommes / 5 femmes, chacun avec une capacité propre.
// La couleur de peau se choisit indépendamment du personnage (SKIN_TONES, du plus clair au plus foncé).
// Look réseau = [indice personnage, indice teinte] : ne JAMAIS réordonner ces tableaux (anciens clients connectés).

export type Ability = 'speed' | 'lockpick' | 'map' | 'crowbar' | 'hack';
export type Gender = 'm' | 'f';
export type Look = [number, number];

export interface CharacterDef {
  name: string;
  gender: Gender;
  ability: Ability;
  top: number; // couleur du haut
  bottom: number; // couleur du bas
  hair: number;
  hairStyle: 'short' | 'buzz' | 'long' | 'bun' | 'ponytail';
}

export const ABILITIES: Record<Ability, { label: string; short: string; desc: string }> = {
  speed: { label: 'Rapide', short: 'Rapide', desc: 'Court et marche plus vite que les autres.' },
  lockpick: { label: 'Crocheteur', short: 'Serrures', desc: 'Crochète les serrures.' },
  map: { label: 'Cartographe', short: 'Carte', desc: 'Possède une carte (touche M).' },
  crowbar: { label: 'Pied de biche', short: 'Levier', desc: 'Force les portes et les caisses.' },
  hack: { label: 'Informatique', short: 'Hacker', desc: 'Pirate les terminaux, relance l’électricité.' },
};

export const CHARACTERS: CharacterDef[] = [
  { name: 'Lucas', gender: 'm', ability: 'speed', top: 0x2f7d4a, bottom: 0x2a2f38, hair: 0x3b2a1e, hairStyle: 'short' },
  { name: 'Marcus', gender: 'm', ability: 'lockpick', top: 0x3a3f47, bottom: 0x1d2128, hair: 0x15110e, hairStyle: 'buzz' },
  { name: 'Théo', gender: 'm', ability: 'map', top: 0x8a6a3c, bottom: 0x4a5560, hair: 0xb48a4e, hairStyle: 'short' },
  { name: 'Victor', gender: 'm', ability: 'crowbar', top: 0x8c2f2a, bottom: 0x2e3b52, hair: 0x2a1d14, hairStyle: 'buzz' },
  { name: 'Samir', gender: 'm', ability: 'hack', top: 0x2b4f8c, bottom: 0x23262b, hair: 0x0f0c0a, hairStyle: 'short' },
  { name: 'Léa', gender: 'f', ability: 'speed', top: 0xd0663a, bottom: 0x2a2f38, hair: 0x6b3f22, hairStyle: 'ponytail' },
  { name: 'Inès', gender: 'f', ability: 'lockpick', top: 0x3d2f4a, bottom: 0x1b1d22, hair: 0x120d0b, hairStyle: 'long' },
  { name: 'Maya', gender: 'f', ability: 'map', top: 0x5f7a3a, bottom: 0x6b5a44, hair: 0xc9a066, hairStyle: 'bun' },
  { name: 'Nora', gender: 'f', ability: 'crowbar', top: 0x6e4a2c, bottom: 0x33404f, hair: 0x8e3b1f, hairStyle: 'ponytail' },
  { name: 'Chloé', gender: 'f', ability: 'hack', top: 0x7a3c78, bottom: 0x22252b, hair: 0x2b1b12, hairStyle: 'long' },
];

// Du plus clair au plus foncé
export const SKIN_TONES: number[] = [0xf7dfcc, 0xefc8a8, 0xe2b08a, 0xc99168, 0xab734c, 0x8c5636, 0x693b22, 0x472516];

export const DEFAULT_LOOK: Look = [0, 1];

/** Valide un look reçu du réseau / du stockage local. */
export function cleanLook(v: unknown): Look {
  if (!Array.isArray(v)) return [...DEFAULT_LOOK];
  const c = Number(v[0]), s = Number(v[1]);
  return [
    Number.isInteger(c) && c >= 0 && c < CHARACTERS.length ? c : DEFAULT_LOOK[0],
    Number.isInteger(s) && s >= 0 && s < SKIN_TONES.length ? s : DEFAULT_LOOK[1],
  ];
}

/** Salon : rôle (capacité) unique. Garde le personnage s'il est libre, sinon un libre du même genre, sinon de l'autre ; null = tous pris. */
export function freeRole(look: Look, taken: Set<Ability>): Look | null {
  const cur = CHARACTERS[look[0]];
  if (!taken.has(cur.ability)) return look;
  let i = CHARACTERS.findIndex((c) => c.gender === cur.gender && !taken.has(c.ability));
  if (i < 0) i = CHARACTERS.findIndex((c) => !taken.has(c.ability));
  return i < 0 ? null : [i, look[1]];
}
