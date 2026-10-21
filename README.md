# December

Base multijoueur minimale dans le navigateur (Three.js + uWebSockets.js), avec dev en live :
capture dans le jeu → prompt → Claude Code d'un dev → push → mise à jour à chaud chez les joueurs.

**Jouer :** https://december.147-93-90-144.sslip.io

## Démarrer en dev (Node 22 conseillé)

```bash
npm install
npm run dev            # http://localhost:5173/?dev=dev
```

## Connecter ton Claude au jeu (à faire une fois par dev)

Chaque dev fait tourner **son propre** Claude Code sur sa machine. Le jeu lui envoie tes prompts ; il code,
teste, commit et push sur `main` ; GitHub Actions déploie.

### 1. Prérequis

- **Node.js 22** (https://nodejs.org) et **git**.
- **Accès en écriture au repo** `tomDeprez/decemberHorror` : demande à l'admin de t'ajouter comme collaborateur.
- **Git doit pouvoir pousser sans te poser de question** (Claude pousse tout seul, personne ne tape de mot de passe) :
  ```bash
  gh auth login          # GitHub CLI : https://cli.github.com
  gh auth setup-git
  ```
  Vérifie : `git ls-remote origin` doit répondre sans demander d'identifiants.

### 2. Installer et connecter Claude Code

```bash
# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
# macOS / Linux
curl -fsSL https://claude.ai/install.sh | bash
```

Puis, **dans le dossier du repo**, lance `claude` une fois :
- connecte-toi (compte Claude Pro/Max ou clé API) ;
- accepte de faire confiance au dossier ;
- quitte (`/exit`).

Vérifie que le mode headless marche : `claude -p "réponds OK"` doit afficher `OK`.

### 3. Récupérer le projet

```bash
git clone https://github.com/tomDeprez/decemberHorror.git
cd decemberHorror
npm install
```

### 4. Ton token dev

Demande un token à l'admin. Il l'ajoute sur le serveur (`DEV_TOKENS="tom:xxx,alice:yyy"` dans
`/etc/december-game.env`, puis `systemctl restart december-game`). Ton nom apparaît dans le tableau des tâches.

Crée `.dev-bridge.json` à la racine du repo (gitignoré, **ne jamais le commiter**) :
```json
{ "token": "<ton token>" }
```
Options : `"model"` (défaut `opus`), `"effort"` (défaut `medium`), `"timeoutMin"` (défaut 30),
`"claudeArgs"` (remplace toute la ligne de commande Claude).

### 5. Lancer le bridge

```bash
npm run bridge
```
Laisse ce terminal ouvert : c'est lui qui reçoit tes prompts et lance Claude. Il doit afficher
`Bridge connecté à wss://december.147-93-90-144.sslip.io/ws`. `Token refusé` = token faux ou pas encore ajouté.

### 6. Activer le mode dev dans le jeu

Ouvre une fois `https://december.147-93-90-144.sslip.io/?dev=<ton token>` (mémorisé ensuite dans le navigateur).
Le badge orange `DEV · F9 capture · F10 tâches` apparaît en haut à gauche.

### 7. Utiliser

- **F9** (ou Impr. écran) : capture + prompt → choisis *Claude de <toi>* → Envoyer (Ctrl+Entrée).
- **F10** : tâches de **tous** les devs (en cours, en attente, terminées + résumé).

Ton bridge exécute **une tâche à la fois** (`claude -p`), les suivantes attendent. Chaque Claude lit
`.devshots/board.md` (tâches de tous les devs, en direct) pour éviter de modifier les mêmes fichiers qu'un autre.

Problèmes courants :
- tâche « échouée » avec `claude introuvable` : `claude` n'est pas dans le PATH du terminal du bridge (rouvre-le) ;
- tâche terminée mais rien en prod : git n'a pas pu pousser (voir étape 1) ;
- rien dans la liste « Envoyer à » : le bridge n'est pas lancé ou pas connecté.

Contrôles : clic pour capturer la souris, ZQSD/WASD, Maj courir, Échap libérer la souris.
