#!/usr/bin/env bash
# despliegue.sh — Despliega/actualiza el WPlace Master Server en un host remoto
# Requisitos: ssh, rsync. Opcional: sshpass (para pasar contraseña sin interacción)
# Uso: ejecutar desde esta carpeta (wplace-masterserver/). Idempotente: sincroniza y reconstruye el servicio.

set -euo pipefail

# Opciones
SYNC_ONLY=0

# Parseo de argumentos
for arg in "$@"; do
  case "$arg" in
    -n|--no-restart|--sync-only)
      SYNC_ONLY=1
      ;;
    -h|--help)
      echo "Uso: $0 [-n|--sync-only]  -> Sincroniza archivos sin reiniciar/reconstruir contenedores"
      exit 0
      ;;
    *)
      echo "Opción desconocida: $arg" 1>&2
      exit 1
      ;;
  esac
done

# Colores simples
INFO="\033[1;34m[INFO]\033[0m"
WARN="\033[1;33m[WARN]\033[0m"
ERR="\033[1;31m[ERR ]\033[0m"
OK="\033[1;32m[ OK ]\033[0m"

# Ir al directorio del script
cd "$(dirname "$0")"

# Preguntas interactivas
read -r -p "IP o dominio del servidor (ej. 192.168.1.19): " SERVER_IP
SERVER_IP=${SERVER_IP:-"192.168.1.19"}
read -r -p "Usuario SSH [root]: " SSH_USER
SSH_USER=${SSH_USER:-"root"}
read -r -s -p "Contraseña SSH (se usará si hay sshpass, sino pedirá interacción): " SSH_PASS
printf "\n"
read -r -p "Ruta remota destino [/opt/wplace-masterserver]: " REMOTE_DIR
REMOTE_DIR=${REMOTE_DIR:-"/opt/wplace-masterserver"}

# Construir destino
REMOTE="${SSH_USER}@${SERVER_IP}"

# Detectar herramientas
HAS_SSHPASS=0
if command -v sshpass >/dev/null 2>&1; then HAS_SSHPASS=1; fi
if ! command -v rsync >/dev/null 2>&1; then echo -e "$WARN rsync no está instalado en local; intentaré fallback con tar/ssh"; fi
if ! command -v ssh >/dev/null 2>&1; then echo -e "$ERR ssh no está instalado en local"; exit 1; fi

# Helper para ejecutar comandos remotos
run_remote() {
  local CMD="$1"
  if [[ $HAS_SSHPASS -eq 1 ]]; then
    SSHPASS="sshpass -p ${SSH_PASS}"
  else
    SSHPASS=""
  fi
  # -o StrictHostKeyChecking=no para primera conexión
  ${SSHPASS} ssh -o StrictHostKeyChecking=no "${REMOTE}" "${CMD}"
}

# Crear directorio remoto
echo -e "$INFO Creando directorio remoto ${REMOTE_DIR}…"
run_remote "mkdir -p ${REMOTE_DIR}"

# El WPlace Master Server no requiere configuración adicional de API_KEYS
# La configuración se maneja a través de docker-compose.yml y .env si es necesario

# Sincronizar código (contenido de esta carpeta)
EXCLUDES=(
  "--exclude" ".git/"
  "--exclude" "__pycache__/"
  "--exclude" ".DS_Store"
  "--exclude" ".venv/"
  "--exclude" "node_modules/"
  "--exclude" "*.log"
)

REMOTE_HAS_RSYNC=0
if run_remote "command -v rsync >/dev/null 2>&1"; then REMOTE_HAS_RSYNC=1; fi

DO_RSYNC=0
if command -v rsync >/dev/null 2>&1 && [[ $REMOTE_HAS_RSYNC -eq 1 ]]; then DO_RSYNC=1; fi

if [[ $DO_RSYNC -eq 1 ]]; then
  RSYNC_BASE=(rsync -az --delete -e "ssh -o StrictHostKeyChecking=no")
  if [[ $HAS_SSHPASS -eq 1 ]]; then
    RSYNC_BASE=(sshpass -p "${SSH_PASS}" rsync -az --delete -e "ssh -o StrictHostKeyChecking=no")
  fi
  echo -e "$INFO Sincronizando (rsync) $(pwd)/ -> ${REMOTE}:${REMOTE_DIR} …"
  "${RSYNC_BASE[@]}" "${EXCLUDES[@]}" ./ "${REMOTE}:${REMOTE_DIR}/"
else
  echo -e "$WARN rsync no disponible en remoto/local; usando fallback tar/ssh"
  # Construir exclusiones para tar
  TAR_EXCLUDES=(--exclude .git --exclude __pycache__ --exclude .DS_Store --exclude .venv --exclude node_modules --exclude '*.log')
  if [[ $HAS_SSHPASS -eq 1 ]]; then
    SSHPASS_BIN=(sshpass -p "${SSH_PASS}")
  else
    SSHPASS_BIN=()
  fi
  echo -e "$INFO Empaquetando y copiando con tar…"
  tar czf - "${TAR_EXCLUDES[@]}" . | "${SSHPASS_BIN[@]}" ssh -o StrictHostKeyChecking=no "${REMOTE}" "mkdir -p ${REMOTE_DIR} && tar xzf - -C ${REMOTE_DIR}"
fi

echo -e "$OK Código sincronizado"

# Si se solicitó solo sincronizar, salir ahora
if [[ $SYNC_ONLY -eq 1 ]]; then
  echo -e "$OK Sincronización completada (sync-only). No se reiniciaron/actualizaron contenedores ni se tocó .env."
  exit 0
fi

# Crear .env básico para WPlace Master Server si no existe
echo -e "$INFO Verificando configuración .env remota"
if ! run_remote "test -f ${REMOTE_DIR}/.env"; then
  echo -e "$INFO Creando .env básico para WPlace Master Server"
  run_remote "cat > ${REMOTE_DIR}/.env <<'EOF_ENV'
# WPlace Master Server Configuration
REDIS_URL=redis://redis:6379
DATABASE_URL=postgresql://wplace:wplace123@postgres:5432/wplace_master
PYTHONUNBUFFERED=1
EOF_ENV"
  echo -e "$OK .env creado"
else
  echo -e "$OK .env ya existe, no se modificará"
fi

# Asegurar docker y docker compose
echo -e "$INFO Comprobando Docker en remoto"
if ! run_remote "docker --version >/dev/null 2>&1"; then
  echo -e "$ERR Docker no está instalado en el servidor. Instálalo y vuelve a ejecutar este script."
  exit 1
fi
if ! run_remote "docker compose version >/dev/null 2>&1"; then
  echo -e "$WARN Docker Compose plugin no detectado. Intentando usar 'docker-compose'"
  if ! run_remote "docker-compose version >/dev/null 2>&1"; then
    echo -e "$ERR No hay docker compose disponible (ni plugin ni binario). Instálalo y vuelve a ejecutar."
    exit 1
  fi
  COMPOSE_CMD="docker-compose"
else
  COMPOSE_CMD="docker compose"
fi

# Levantar/actualizar servicios
echo -e "$INFO Construyendo y levantando servicios en remoto… (BuildKit desactivado para compatibilidad)"
run_remote "cd ${REMOTE_DIR} && DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 ${COMPOSE_CMD} up -d --build"
echo -e "$OK Despliegue completado"

# Health check básico
echo -e "$INFO Verificando healthcheck…"
if run_remote "curl -fsS http://localhost:8008/health >/dev/null"; then
  echo -e "$OK Master Server API saludable en http://${SERVER_IP}:8008/"
  echo -e "$OK Dashboard UI disponible en http://${SERVER_IP}:3004/"
else
  echo -e "$WARN No se pudo verificar /health. Revisa logs con: cd ${REMOTE_DIR} && ${COMPOSE_CMD} logs -f server"
fi

# Tips finales
cat <<EOF

🎉 WPlace Master Server desplegado exitosamente!
====================================================

📊 Servicios disponibles:
- Dashboard UI: http://${SERVER_IP}:3004
- API Server:   http://${SERVER_IP}:8008
- API Docs:     http://${SERVER_IP}:8008/docs
- Health Check: http://${SERVER_IP}:8008/health

📋 Siguientes pasos:
- Configura tu firewall para permitir los puertos 3004 y 8008
- Si necesitas acceso público, configura un proxy reverso (Nginx/Traefik)
- Para conectar slaves, usa la URL: ws://${SERVER_IP}:8008/ws/slave

🔧 Comandos útiles:
- Ver logs del servidor: ssh ${SSH_USER}@${SERVER_IP} "cd ${REMOTE_DIR} && ${COMPOSE_CMD} logs -f server"
- Ver logs de la UI:     ssh ${SSH_USER}@${SERVER_IP} "cd ${REMOTE_DIR} && ${COMPOSE_CMD} logs -f ui"
- Ver todos los logs:    ssh ${SSH_USER}@${SERVER_IP} "cd ${REMOTE_DIR} && ${COMPOSE_CMD} logs -f"
- Reiniciar servicios:   ssh ${SSH_USER}@${SERVER_IP} "cd ${REMOTE_DIR} && ${COMPOSE_CMD} restart"
- Para actualizar:       vuelve a ejecutar este script desde tu máquina local

📚 Documentación adicional en README.md y USAGE.md
EOF
