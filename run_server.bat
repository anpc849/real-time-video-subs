@echo off
setlocal
cd /d %~dp0server
set PYTHONIOENCODING=utf-8

:: 1. Check if custom PYTHON path is provided
if defined PYTHON (
    echo Using PYTHON from environment: %PYTHON%
    "%PYTHON%" -m rtsubs.server
    goto :end
)

:: 2. Check default miniconda environment
if exist "%USERPROFILE%\miniconda3\envs\rtsubs\python.exe" (
    "%USERPROFILE%\miniconda3\envs\rtsubs\python.exe" -m rtsubs.server
    goto :end
)

:: 3. Check default anaconda environment
if exist "%USERPROFILE%\anaconda3\envs\rtsubs\python.exe" (
    "%USERPROFILE%\anaconda3\envs\rtsubs\python.exe" -m rtsubs.server
    goto :end
)

:: 4. Fallback to active python in PATH
echo Using system / active virtual environment python...
python -m rtsubs.server

:end
if errorlevel 1 (
    echo.
    echo Server stopped with error.
    pause
)
