@echo off
cd /d "%~dp0"
echo ============================================
echo  WorkBuddy 签到 Worker 一键部署（Cloudflare）
echo ============================================
echo.
echo [1/3] 将打开浏览器登录 Cloudflare，请用你的账号登录...
echo       登录完成后回到此窗口，脚本自动继续。
echo.
npx --yes wrangler login
if errorlevel 1 ( echo 登录失败，请重试。 & pause & exit /b 1 )

echo.
echo [2/3] 写入 WORKBUDDY_TOKEN（取自本机 WorkBuddy accessToken）...
for /f "delims=" %%t in ('node get_token.cjs') do set TOKEN=%%t
if "%TOKEN%"=="" ( echo 读取 accessToken 失败，请确认 WorkBuddy 桌面端已登录。 & pause & exit /b 1 )
echo %TOKEN% | npx --yes wrangler secret put WORKBUDDY_TOKEN
if errorlevel 1 ( echo Secret 写入失败。 & pause & exit /b 1 )

echo.
echo [3/3] 部署 Worker...
npx --yes wrangler deploy
if errorlevel 1 ( echo 部署失败。 & pause & exit /b 1 )

echo.
echo 部署完成！之后每天北京 10:00 自动签到。
echo 注意：accessToken 约 55 天过期，过期后需重跑本脚本（或到 CF Dashboard 更新 Secret）。
echo.
pause
