@echo off
cd /d "%~dp0"
title RFFA Draft Room
py server.py
if errorlevel 1 (
  echo.
  echo Could not start with "py". Trying "python"...
  python server.py
)
pause
