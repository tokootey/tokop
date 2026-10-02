@echo off
title Rent a Car
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Falta instalar Node.js. Descargalo de https://nodejs.org ^(boton LTS^), instalalo y volve a abrir este archivo.
  echo.
  pause
  exit /b
)
if not exist node_modules (
  echo Instalando por unica vez, puede tardar un minuto...
  call npm install --omit=dev
)
if not exist data\rentacar.db call npm run seed
echo.
echo La app se abre en el navegador: http://localhost:3000
echo Usuario: admin@rentacar.local   Contrasena: admin123
echo Para cerrarla, cerra esta ventana.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
call npm start
pause
