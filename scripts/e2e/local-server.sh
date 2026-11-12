#!/usr/bin/env bash
# Egen dev-server för e2e-testerna, med egen databas, utan att röra den vanliga dev-servern.
#
#   scripts/e2e/local-server.sh            # kopierar arbetskatalogen och startar next dev
#   E2E_PREPARE_ONLY=1 scripts/e2e/local-server.sh   # bara kopian (t.ex. för att uppdatera koden)
#
# Sedan, i en annan terminal (se docs/operations.md, avsnittet E2E-tester):
#   E2E_DATABASE_URL=postgres://postgres@127.0.0.1:54322/binderlab_e2e \
#   BASE_URL=http://localhost:3210 E2E_OUTBOX_DIR=../binderlab-e2e/.data/outbox \
#   E2E_RESET=1 npm run test:e2e
#
# Variabler: E2E_WORKDIR (kopians katalog, standard ../binderlab-e2e), E2E_PORT (3210),
# E2E_DATABASE_URL (binderlab_e2e på den lokala Postgres-servern).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${E2E_WORKDIR:-$ROOT/../binderlab-e2e}"
PORT="${E2E_PORT:-3210}"
DB="${E2E_DATABASE_URL:-postgres://postgres@127.0.0.1:54322/binderlab_e2e}"

DIR="$(mkdir -p "$DIR" && cd "$DIR" && pwd)"
if [ "$DIR" = "$ROOT" ]; then
  echo "E2E_WORKDIR får inte vara projektet självt." >&2
  exit 1
fi
MARKER="$DIR/.binderlab-e2e-kopia"
if [ -n "$(ls -A "$DIR")" ] && [ ! -f "$MARKER" ]; then
  echo "$DIR är inte tom och är ingen e2e-kopia (saknar $(basename "$MARKER")). Välj en annan E2E_WORKDIR." >&2
  exit 1
fi
# Bort med förra kopians kod, så att borttagna filer och routes inte ligger kvar och testas
# (behåller beroenden, bygget, lokala data och .env.local).
find "$DIR" -mindepth 1 -maxdepth 1 \
  ! -name node_modules ! -name .next ! -name .data ! -name .env.local ! -name "$(basename "$MARKER")" \
  -exec rm -rf {} +
touch "$MARKER"
# Koden (inte beroenden, bygge, lokala data eller hemligheter).
tar -C "$ROOT" \
  --exclude=./node_modules --exclude=./.next --exclude=./.data --exclude=./.git \
  --exclude=./.env.local --exclude=./tsconfig.tsbuildinfo \
  -cf - . | tar -C "$DIR" -xf -

# Turbopack följer inte en symlänk till node_modules utanför projektet: hårda länkar (snabbt,
# tar ingen plats) eller en kopia om katalogen ligger på ett annat filsystem. Görs om när
# package-lock.json har ändrats. OBS: kör aldrig npm install i kopian, de hårda länkarna
# delar filer med projektets node_modules.
LOCK_STAMP="$DIR/node_modules/.binderlab-e2e-lock"
if [ -d "$DIR/node_modules" ] && ! cmp -s "$ROOT/package-lock.json" "$LOCK_STAMP"; then
  rm -rf "$DIR/node_modules"
fi
if [ ! -d "$DIR/node_modules" ]; then
  cp -al "$ROOT/node_modules" "$DIR/node_modules" 2>/dev/null || cp -a "$ROOT/node_modules" "$DIR/node_modules"
  cp "$ROOT/package-lock.json" "$LOCK_STAMP"
fi

if [ ! -f "$DIR/.env.local" ]; then
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  cat > "$DIR/.env.local" <<ENV
DATABASE_URL=$DB
DEV_AUTH_SECRET=$SECRET
CRON_SECRET=e2e-cron-secret-$SECRET
MAIL_PROVIDER=outbox
# Fortnox: en falsk Fortnox som e2e/27-fortnox startar på den här porten. Aldrig riktiga Fortnox.
FORTNOX_CLIENT_ID=fake-client-id
FORTNOX_CLIENT_SECRET=fake-client-secret
FORTNOX_API_BASE_URL=http://127.0.0.1:4610
FORTNOX_AUTH_BASE_URL=http://127.0.0.1:4610
FORTNOX_REDIRECT_URI=http://localhost:$PORT/datakallor/fortnox/klar
# Aldrig riktiga Awish från e2e-servern.
AWISH_GRPC_ADDRESS=127.0.0.1:1
AWISH_WEB_BASE_URL=http://127.0.0.1:1
ENV
  echo "Skrev $DIR/.env.local (databas $DB)."
fi

if [ "${E2E_PREPARE_ONLY:-0}" = "1" ]; then
  echo "Kopian är klar i $DIR."
  exit 0
fi
cd "$DIR"
exec npx next dev -p "$PORT"
