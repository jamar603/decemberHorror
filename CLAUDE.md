# December — jeu multijoueur navigateur (base minimale)

Prod : https://december.147-93-90-144.sslip.io — déployée automatiquement à chaque push sur `main`
(repo `tomDeprez/decemberHorror`). Plusieurs devs (et plusieurs Claude) travaillent en même temps sur ce repo.

État actuel : volontairement minimal. Menu (pseudo, créer une partie, rejoindre par code / lien `?room=CODE`),
un sol, les autres joueurs en capsules avec leur pseudo. Rien d'autre.

## RÈGLE N°1 — chaque modification part en prod

1. Tester en local : `npm run typecheck && npm run build` (doit passer sans erreur).
   Pour un changement visuel : `npm run dev` puis `node scripts/shot.mjs .devshots/check.png` et regarder l'image.
2. `git pull --rebase origin main` (d'autres devs poussent en parallèle ; résoudre les conflits s'il y en a).
3. `git add` des SEULS fichiers modifiés, `git commit -m "<type>: <ce qui change>"`, `git push origin main`.
4. GitHub Actions compile et déploie (~1 min). Les joueurs connectés reçoivent la mise à jour en live.

Ne jamais pousser un build cassé. Pas de branche.
Ne jamais commiter `.devshots/`, `.dev-bridge.json`, `.dev-bridge-queue.json`, ni de token.

## Demandes venant du jeu (bridge Claude)

Un dev en mode dev (`?dev=<token>`) fait F9 (capture + prompt) dans le jeu. Son bridge local (`npm run bridge`)
met la demande en file et lance `claude -p` (config prédéfinie dans `tools/dev-bridge.mjs`), UNE tâche à la fois.
Le prompt arrive préfixé par `[Demande envoyée depuis le jeu (mode dev) par <dev>]` avec une capture dans `.devshots/`.

**Coordination entre Claude** : `.devshots/board.md` contient en direct les tâches de TOUS les devs
(en cours, en attente, terminées + résumé). Le lire avant de coder et avant de pousser ; éviter les fichiers
qu'une autre tâche en cours modifie. Finir par une phrase courte qui résume le changement (affichée aux autres).
F10 dans le jeu affiche le même tableau.

## Architecture (mise à jour à chaud)

| Fichier | Rôle | Effet d'une modif en prod |
|---|---|---|
| `src/client/world/world.ts` | niveau, lumières, contenu | **hot-swap invisible** (aucun rechargement) |
| `src/client/main.ts`, `net.ts`, `dev.ts`, `style.css`, `index.html` | shell : rendu, contrôles, réseau, menu, autres joueurs | rechargement discret (partie + position conservées) |
| `server/index.ts` | serveur temps réel uWebSockets.js | redémarrage (~1 s), reconnexion silencieuse |
| `src/shared/protocol.ts` | protocole binaire/JSON | rester rétro-compatible (anciens clients encore connectés) |

=> Mettre le contenu dans `world.ts` autant que possible ; tout libérer dans `dispose()`.
Graine de carte par partie : `ctx.seed` (hash du code). Une partie vide vit 60 s ; après un redémarrage serveur,
les clients recréent leur partie avec le même code (`join.recreate`).

Réseau : positions en binaire (17 octets client→serveur, snapshots 20 Hz « dirty only »), interpolation 110 ms,
JSON pour le reste. Le serveur ne sert pas le statique : Apache le fait.
Perf : pixel ratio ≤ 1.5 ; géométrie répétée => `mergeGeometries` ou `InstancedMesh`.

## Commandes

- `npm run dev` — serveur (tsx watch) + Vite HMR → http://localhost:5173/?dev=dev (serveur lancé sous Node 22 via npx si ton Node local est trop récent pour uWS v20.51)
- `npm run typecheck`, `npm run build`
- `npm run bridge` — relie le jeu à Claude sur ta machine (config `.dev-bridge.json`)

## Infra (VPS partagé — NE PAS casser les autres services)

- Debian, Apache (80/443) héberge d'autres sites (dont Hollow House, `/opt/horror`, port 18030 : ne pas y toucher).
- December : vhost `zz-december*.conf`, cert Let's Encrypt, `december-game.service` (user `december`,
  127.0.0.1:18031, Node 22 privé dans `/opt/december/node`, MemoryMax 256M, CPUQuota 60%).
- Fichiers : `/opt/december/public` (statique), `/opt/december/app` (serveur), secrets dans `/etc/december-game.env`
  (`DEV_TOKENS="nom:token,..."` pour ajouter un dev, puis `systemctl restart december-game`).
- Le déploiement passe UNIQUEMENT par GitHub Actions (`.github/workflows/deploy.yml` → `deploy/remote-deploy.sh`).
