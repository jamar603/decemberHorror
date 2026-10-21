#!/usr/bin/env bash
# Exécuté sur le VPS (utilisateur december) par GitHub Actions après l'upload dans /opt/december/incoming.
# Ordre pensé pour les joueurs connectés :
#   1. nouveaux assets ajoutés (les anciens restent : un joueur sur l'ancienne version continue de charger)
#   2. serveur redémarré seulement s'il a changé (les clients se reconnectent sans rien afficher)
#   3. index.html + version.json basculés en dernier (mv atomique)
#   4. le serveur notifie les clients -> hot-swap du monde, ou rechargement discret si le shell a changé
set -euo pipefail
ROOT=/opt/december
IN=$ROOT/incoming
SHA=${1:-?}
TOKEN=$(grep '^DEPLOY_TOKEN=' /etc/december-game.env | cut -d= -f2-)

mkdir -p "$ROOT/public/assets" "$ROOT/app"
rsync -a "$IN/dist/assets/" "$ROOT/public/assets/"

if ! diff -rq "$IN/server" "$ROOT/app" >/dev/null 2>&1; then
  rsync -a --delete "$IN/server/" "$ROOT/app/"
  sudo /usr/bin/systemctl restart december-game
  for _ in $(seq 1 30); do curl -fsS -m 1 http://127.0.0.1:18031/api/health >/dev/null 2>&1 && break; sleep 0.2; done
  echo "serveur redémarré"
fi

for f in index.html version.json; do
  cp "$IN/dist/$f" "$ROOT/public/.$f.tmp" && mv -f "$ROOT/public/.$f.tmp" "$ROOT/public/$f"
done

# Purge des vieux bundles hashés (non référencés depuis 3 jours)
find "$ROOT/public/assets" -maxdepth 1 -type f -mtime +3 -delete || true

curl -fsS -m 5 -X POST http://127.0.0.1:18031/api/deploy -H "x-deploy-token: $TOKEN" \
  -d "{\"state\":\"done\",\"msg\":\"${SHA:0:7}\"}" >/dev/null || true
echo "déployé ${SHA:0:7}"
