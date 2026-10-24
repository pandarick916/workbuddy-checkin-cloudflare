@echo off
REM 取 WorkBuddy 登录令牌并复制到剪贴板（5.6.0+ 加密信封版，自动解密，无需手动操作）
REM 前提：本机已安装并至少登录过一次 WorkBuddy 桌面端；Node.js 在 PATH 中。
node "%~dp0get_token.cjs" --clip
if errorlevel 1 (
  echo.
  echo 失败：请确认 WorkBuddy 已安装登录，或改用 decrypt_workbuddy_token.py --auto
  pause
  exit /b 1
)
echo.
echo accessToken 已复制到剪贴板。
echo 接着运行： wrangler secret put WORKBUDDY_TOKEN   （提示处 Ctrl+V 粘贴，回车）
pause
