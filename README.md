# December

Base multijoueur minimale dans le navigateur (Three.js + uWebSockets.js), avec dev en live :
capture dans le jeu → prompt → Claude Code d'un dev → push → mise à jour à chaud chez les joueurs.

**Jouer :** https://december.147-93-90-144.sslip.io

## Démarrer en dev (Node 22 conseillé)

```bash
npm install
npm run dev            # http://localhost:5173/?dev=dev
```

## Envoyer des prompts à Claude depuis le jeu

1. Récupérer ton token dev auprès de l'admin.
2. Ouvrir le jeu une fois avec `https://december.147-93-90-144.sslip.io/?dev=<token>` (mémorisé ensuite).
3. Créer `.dev-bridge.json` à la racine (gitignoré) :
   ```json
   { "token": "<token>" }
   ```
   Options : `"model"` (défaut `opus`), `"effort"` (défaut `medium`), `"timeoutMin"` (défaut 30), `"claudeArgs"` (remplace tout).
4. Lancer le bridge : `npm run bridge` (Windows, macOS, Linux ; Claude Code doit être installé et connecté).
5. Dans le jeu : **F9** (ou Impr. écran) → capture + prompt → Envoyer. **F10** : tâches de tous les devs.

Le bridge exécute une tâche à la fois (`claude -p`), les suivantes attendent. Chaque Claude lit
`.devshots/board.md` pour voir ce que font les autres. GitHub Actions déploie après chaque push.

Contrôles : clic pour capturer la souris, ZQSD/WASD, Maj courir, Échap libérer la souris.
