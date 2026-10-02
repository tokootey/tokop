#!/bin/bash
# Doble clic en Mac (si macOS lo bloquea: clic derecho > Abrir).
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Falta instalar Node.js: https://nodejs.org (boton LTS)"; read -r -p "Enter para salir"; exit 1; fi
[ -d node_modules ] || npm install --omit=dev
[ -f data/rentacar.db ] || npm run seed
echo "Usuario: admin@rentacar.local   Contrasena: admin123"
(sleep 3; open http://localhost:3000) &
npm start
