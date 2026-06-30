@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  ikun-cloud 本地构建脚本 (Win10)
REM  产物输出到 dist/ 目录，用户手动上传到服务器
REM ============================================================

set PROJECT_DIR=%~dp0
set DIST_DIR=%PROJECT_DIR%dist

echo.
echo ============================================================
echo  ikun-cloud 本地构建
echo ============================================================
echo.

REM 清理旧产物
if exist "%DIST_DIR%" (
    echo 清理旧产物...
    rmdir /s /q "%DIST_DIR%"
)
mkdir "%DIST_DIR%"

REM ============================================================
REM  1. 构建前端
REM ============================================================
echo [1/3] 构建前端...
cd /d "%PROJECT_DIR%web"

if not exist "node_modules" (
    echo   安装前端依赖...
    call bun install
    if errorlevel 1 (
        echo   [FAIL] bun install 失败
        exit /b 1
    )
)

echo   执行 bun run build...
call bun run build
if errorlevel 1 (
    echo   [FAIL] 前端构建失败
    exit /b 1
)

echo   打包前端产物...
cd /d "%PROJECT_DIR%web\dist"
tar czf "%DIST_DIR%\web-dist.tar.gz" -C . .
echo   [OK] web-dist.tar.gz

REM ============================================================
REM  2. 打包后端（含 node_modules）
REM ============================================================
echo [2/3] 打包后端...
cd /d "%PROJECT_DIR%server"

if not exist "node_modules" (
    echo   安装后端依赖...
    call bun install
    if errorlevel 1 (
        echo   [FAIL] bun install 失败
        exit /b 1
    )
)

echo   打包 server 目录...
cd /d "%PROJECT_DIR%"
tar czf "%DIST_DIR%\server.tar.gz" -C . server
echo   [OK] server.tar.gz

REM ============================================================
REM  3. 打包 ikun-ctl
REM ============================================================
echo [3/3] 打包 ikun-ctl...
cd /d "%PROJECT_DIR%"
tar czf "%DIST_DIR%\ikun-ctl.tar.gz" -C . ikun-ctl
echo   [OK] ikun-ctl.tar.gz

REM ============================================================
REM  4. 复制 script 目录
REM ============================================================
if exist "%PROJECT_DIR%script" (
    echo 复制 script 目录...
    xcopy /e /i /q "%PROJECT_DIR%script" "%DIST_DIR%\script" >nul
    echo   [OK] script/
)

REM ============================================================
REM  汇总
REM ============================================================
echo.
echo ============================================================
echo  构建完成！产物在 dist/ 目录:
echo ============================================================
echo.
dir /b "%DIST_DIR%"
echo.

endlocal
