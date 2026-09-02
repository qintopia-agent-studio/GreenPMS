#!/usr/bin/env bash
set -euo pipefail

container="${POSTGRES_CONTAINER:-qintopia-postgres}"
migration_user="${MIGRATION_DATABASE_USER:-${POSTGRES_USER:-qintopia_migrator}}"
migration_password="${MIGRATION_DATABASE_PASSWORD:-${POSTGRES_PASSWORD:-qintopia_migrator}}"
runtime_user="${RUNTIME_DATABASE_USER:-qintopia_runtime}"
runtime_password="${RUNTIME_DATABASE_PASSWORD:-qintopia_runtime}"
host_port="${POSTGRES_HOST_PORT:-55432}"
run_id="$$_$(date +%s)_${RANDOM}"
database="qintopia_cold_start_${run_id}"
port="$((42000 + RANDOM % 10000))"
workdir="$(mktemp -d)"
cookie_jar="$workdir/cookies.txt"
app_log="$workdir/app.log"
app_pid=""
app_container=""

cleanup() {
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" >/dev/null 2>&1 || true
    wait "$app_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$app_container" ]]; then
    docker rm -f "$app_container" >/dev/null 2>&1 || true
  fi
  docker exec "$container" dropdb -U "$migration_user" --if-exists "$database" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

docker exec "$container" createdb -U "$migration_user" "$database"
migration_database_url="postgres://$migration_user:$migration_password@127.0.0.1:$host_port/$database"
runtime_database_url="postgres://$runtime_user:$runtime_password@127.0.0.1:$host_port/$database"

if [[ -n "${VERIFY_APP_IMAGE:-}" ]]; then
  docker run --rm --init \
    --add-host host.docker.internal:host-gateway \
    -e "DATABASE_URL=postgres://$runtime_user:$runtime_password@host.docker.internal:$host_port/$database" \
    -e "MIGRATION_DATABASE_URL=postgres://$migration_user:$migration_password@host.docker.internal:$host_port/$database" \
    -e "RUNTIME_DATABASE_PASSWORD=$runtime_password" \
    -e "STAFF_PROFILE_MANIFEST_NAME=unconfigured" \
    "$VERIFY_APP_IMAGE" npm run db:migrate
  docker run --rm --init \
    --add-host host.docker.internal:host-gateway \
    -e "DATABASE_URL=postgres://$migration_user:$migration_password@host.docker.internal:$host_port/$database" \
    "$VERIFY_APP_IMAGE" npm run db:seed
  app_container="qintopia-cold-start-${run_id//_/-}"
  docker run --detach --init --name "$app_container" \
    --add-host host.docker.internal:host-gateway \
    -p "127.0.0.1:$port:4100" \
    -e "DATABASE_URL=postgres://$runtime_user:$runtime_password@host.docker.internal:$host_port/$database" \
    -e "STAFF_PROFILE_MANIFEST_NAME=demo" \
    -e PORT=4100 \
    -e "WEB_ORIGIN=http://127.0.0.1:$port" \
    -e SESSION_COOKIE_SECURE=false \
    -e LOG_LEVEL=warn \
    "$VERIFY_APP_IMAGE" >/dev/null
else
  DATABASE_URL="$runtime_database_url" MIGRATION_DATABASE_URL="$migration_database_url" RUNTIME_DATABASE_PASSWORD="$runtime_password" STAFF_PROFILE_MANIFEST_NAME=unconfigured npm run db:migrate
  DATABASE_URL="$migration_database_url" npm run db:seed
  npm run build

  DATABASE_URL="$runtime_database_url" STAFF_PROFILE_MANIFEST_NAME=demo PORT="$port" WEB_ORIGIN="http://127.0.0.1:$port" SESSION_COOKIE_SECURE=false LOG_LEVEL=warn \
    node --import tsx apps/api/src/main.ts >"$app_log" 2>&1 &
  app_pid="$!"
fi

ready=false
for _ in {1..60}; do
  if curl --fail --silent --show-error "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  if [[ -n "$app_container" ]]; then
    docker logs "$app_container" >&2 || true
  else
    sed -n '1,200p' "$app_log" >&2
  fi
  printf 'Cold-start API did not become ready on port %s.\n' "$port" >&2
  exit 1
fi

curl --fail --silent --show-error "http://127.0.0.1:$port/health/live" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$port/" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$port/api/v1/openapi.json" >/dev/null
curl --fail --silent --show-error -c "$cookie_jar" -H 'Content-Type: application/json' \
  -d '{"username":"operator","password":"demo-pass-2026"}' "http://127.0.0.1:$port/api/v1/auth/login" >/dev/null
curl --fail --silent --show-error -b "$cookie_jar" "http://127.0.0.1:$port/api/v1/me" >/dev/null

printf 'Cold start verified: migrations, seed, demo login, Web, OpenAPI, liveness, and readiness on isolated database %s.\n' "$database"
