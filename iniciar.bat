@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Calendario de guardias - servidor
where python >nul 2>nul
if %errorlevel%==0 (
  python servidor.py
) else (
  where py >nul 2>nul
  if %errorlevel%==0 (
    py -3 servidor.py
  ) else (
    echo No encuentro Python en esta PC. Hace falta Python 3.9 o mas nuevo.
  )
)
echo.
echo El servidor se cerro. Tocá una tecla para salir.
pause >nul
