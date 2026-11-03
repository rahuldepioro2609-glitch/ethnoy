#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dev_root="$repo_root/.local-dev"
cert_root="$dev_root/certs"

if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to generate local development certificates." >&2
  exit 1
fi

if [[ -L "$dev_root" || -L "$cert_root" ]]; then
  echo "Refusing to write certificates through a symlink: $cert_root" >&2
  exit 1
fi

targets=(
  "$cert_root/ca/ca.crt"
  "$cert_root/ca/ca.key"
  "$cert_root/postgres/server.crt"
  "$cert_root/postgres/server.key"
  "$cert_root/nginx/fullchain.pem"
  "$cert_root/nginx/privkey.pem"
)

existing=()
for target in "${targets[@]}"; do
  if [[ -L "$target" ]]; then
    echo "Refusing to overwrite a symlink: $target" >&2
    exit 1
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    existing+=("$target")
  fi
done

if ((${#existing[@]})); then
  echo "Development certificate files already exist:"
  printf '  %s\n' "${existing[@]}"
  if [[ ! -t 0 ]]; then
    echo "Refusing to overwrite certificates without interactive confirmation." >&2
    exit 1
  fi
  read -r -p "Replace the listed certificate files? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "No certificates were changed."; exit 1 ;;
  esac
fi

for directory in ca postgres nginx; do
  target_dir="$cert_root/$directory"
  if [[ -L "$target_dir" ]]; then
    echo "Refusing to write certificates through a symlink: $target_dir" >&2
    exit 1
  fi
done

mkdir -p "$cert_root/ca" "$cert_root/postgres" "$cert_root/nginx"
chmod 755 "$cert_root" "$cert_root/postgres" "$cert_root/nginx"
chmod 700 "$cert_root/ca"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -keyout "$work_dir/ca.key" \
  -out "$work_dir/ca.crt" \
  -subj "/CN=ELTNOY LOCAL DEVELOPMENT CA - NOT FOR PRODUCTION" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

for service in postgres nginx; do
  openssl req -new -newkey rsa:2048 -sha256 -nodes \
    -keyout "$work_dir/$service.key" \
    -out "$work_dir/$service.csr" \
    -subj "/CN=$service ELTNOY LOCAL DEVELOPMENT ONLY"

  if [[ "$service" == postgres ]]; then
    san="DNS:postgres"
    eku="serverAuth"
  else
    san="DNS:localhost,IP:127.0.0.1,IP:::1"
    eku="serverAuth"
  fi

  cat > "$work_dir/$service.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=$eku
subjectAltName=$san
EOF

  openssl x509 -req -sha256 -days 825 \
    -in "$work_dir/$service.csr" \
    -CA "$work_dir/ca.crt" \
    -CAkey "$work_dir/ca.key" \
    -CAcreateserial \
    -extfile "$work_dir/$service.ext" \
    -out "$work_dir/$service.crt"
done

install -m 644 "$work_dir/ca.crt" "$cert_root/ca/ca.crt"
install -m 600 "$work_dir/ca.key" "$cert_root/ca/ca.key"
install -m 644 "$work_dir/postgres.crt" "$cert_root/postgres/server.crt"
install -m 600 "$work_dir/postgres.key" "$cert_root/postgres/server.key"
install -m 600 "$work_dir/nginx.key" "$cert_root/nginx/privkey.pem"
cat "$work_dir/nginx.crt" "$work_dir/ca.crt" > "$cert_root/nginx/fullchain.pem"
chmod 644 "$cert_root/nginx/fullchain.pem"

cat <<EOF

Generated LOCAL DEVELOPMENT ONLY certificates (not for production):
  CA certificate:       $cert_root/ca/ca.crt
  CA private key:       $cert_root/ca/ca.key (mode 600; keep private)
  PostgreSQL cert:      $cert_root/postgres/server.crt (SAN DNS:postgres)
  PostgreSQL key:       $cert_root/postgres/server.key (mode 600)
  Nginx full chain:     $cert_root/nginx/fullchain.pem (SAN DNS:localhost)
  Nginx private key:    $cert_root/nginx/privkey.pem (mode 600)

Compose environment paths:
  POSTGRES_TLS_DIR=./.local-dev/certs/postgres
  POSTGRES_CA_FILE=./.local-dev/certs/ca/ca.crt
  TLS_CERT_DIR=./.local-dev/certs/nginx
EOF
