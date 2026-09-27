@echo off
rem Starts the TeslaCam viewer and opens it in your web browser.
rem The first start downloads what it needs (Python and a few parts, a couple of minutes).
cd /d "%~dp0"
set "UV=%USERPROFILE%\.local\bin\uv.exe"
where uv >nul 2>nul && set "UV=uv"
if "%UV%"=="uv" goto run
if exist "%UV%" goto run
echo First start: downloading uv, which sets up Python for the viewer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:UV_NO_MODIFY_PATH=1; irm https://astral.sh/uv/install.ps1 | iex"
if exist "%UV%" goto run
echo The download didn't work. Check the internet connection and try again.
pause
exit /b 1
:run
"%UV%" run --quiet --no-project --python 3.12 --with-requirements requirements.txt server.py %*
if errorlevel 1 pause
