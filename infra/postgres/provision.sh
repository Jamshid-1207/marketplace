#!/bin/sh
# Идемпотентно приводит Postgres к services.txt (SD-01, п. 5; ADR-0004, п. 1).
# Запускается при каждом docker compose up; повторный запуск ничего не меняет.
set -eu

LIST=/provision/services.txt

grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$LIST" | while read -r name; do
  case "$name" in
    *[!a-z0-9_]*)
      echo "provision: недопустимое имя сервиса '$name'" >&2
      exit 1
      ;;
  esac

  var="$(echo "$name" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD"
  eval "pass=\${$var:-}"
  if [ -z "$pass" ]; then
    echo "provision: не задан $var" >&2
    exit 1
  fi
  role="${name}_svc"

  # Пароль выравнивается при каждом запуске: источник истины — .env
  psql -v ON_ERROR_STOP=1 -q -v role="$role" -v pass="$pass" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role', :'pass') \gexec
SQL

  for db in "${name}_db" "${name}_db_shadow"; do
    psql -v ON_ERROR_STOP=1 -q -v db="$db" -v role="$role" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'role') \gexec
-- по умолчанию Postgres разрешает подключаться к любой базе любому пользователю
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'db') \gexec
SQL
  done

  echo "provision: $name ok"
done
