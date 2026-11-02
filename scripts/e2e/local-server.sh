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

mkdir -p "$DIR"
# Koden (inte beroenden, bygge, lokala data eller hemligheter).
tar -C "$ROOT" \
  --exclude=./node_modules --exclude=./.next --exclude=./.data --exclude=./.git \
  --exclude=./.env.local --exclude=./tsconfig.tsbuildinfo \
  -cf - . | tar -C "$DIR" -xf -

# Turbopack följer inte en symlänk till node_modules utanför projektet: hårda länkar (snabbt,
# tar ingen plats) eller en kopia om katalogen ligger på ett annat filsystem.
if [ ! -d "$DIR/node_modules" ]; then
  cp -al "$ROOT/node_modules" "$DIR/node_modules" 2>/dev/null || cp -a "$ROOT/node_modules" "$DIR/node_modules"
fi

if [ ! -f "$DIR/.env.local" ]; then
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  cat > "$DIR/.env.local" <<ENV
DATABASE_URL=$DB
DEV_AUTH_SECRET=$SECRET
CRON_SECRET=e2e-cron-secret-$SECRET
MAIL_PROVIDER=outbox
ENV
  echo "Skrev $DIR/.env.local (databas $DB)."
fi

if [ "${E2E_PREPARE_ONLY:-0}" = "1" ]; then
  echo "Kopian är klar i $DIR."
  exit 0
fi
cd "$DIR"
exec npx next dev -p "$PORT"
