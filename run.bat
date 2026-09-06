@echo off
chcp 65001 >nul
cd /d "%~dp0"
python -c "import yt_dlp" 2>nul || python -m pip install -U yt-dlp
python yt_subs.py %*
pause
