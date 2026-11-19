@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  把本机最新令牌同步到 Cloudflare
echo ============================================
echo.
node sync-token.js
if errorlevel 1 (
  echo.
  echo [失败] 同步没成功，请把上面的提示发给我。
  pause
  exit /b 1
)
echo.
echo [完成] 云端已是最新令牌，可以关窗口了。
pause
