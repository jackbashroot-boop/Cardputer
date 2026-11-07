@echo off
rem Double-click installer for Windows.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 install.py %*
  goto done
)
where python >nul 2>nul
if %errorlevel%==0 (
  python install.py %*
  goto done
)
echo Python 3 was not found. Install it from https://www.python.org/downloads/
echo Remember to tick "Add Python to PATH" in the installer.
:done
pause
