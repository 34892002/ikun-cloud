#!/bin/bash
#============================================================
#  ikun-cloud 构建脚本 (Linux/macOS)
#  产物输出到 dist/ 目录
#============================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$PROJECT_DIR/dist"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

echo ""
echo "============================================================"
echo "  ikun-cloud 构建"
echo "============================================================"
echo ""

# 清理旧产物
if [[ -d "$DIST_DIR" ]]; then
  echo "清理旧产物..."
  rm -rf "$DIST_DIR"
fi
mkdir -p "$DIST_DIR"

# ============================================================
#  1. 构建前端
# ============================================================
info "[1/3] 构建前端..."
cd "$PROJECT_DIR/web"

if [[ ! -d "node_modules" ]]; then
  info "  安装前端依赖..."
  bun install || fail "bun install 失败"
fi

info "  执行 bun run build..."
bun run build || fail "前端构建失败"

info "  打包前端产物..."
cd "$PROJECT_DIR/web/dist"
tar czf "$DIST_DIR/web-dist.tar.gz" -C . .
ok "web-dist.tar.gz"

# ============================================================
#  2. 打包后端（含 node_modules）
# ============================================================
info "[2/3] 打包后端..."
cd "$PROJECT_DIR/server"

if [[ ! -d "node_modules" ]]; then
  info "  安装后端依赖..."
  bun install || fail "bun install 失败"
fi

info "  打包 server 目录..."
cd "$PROJECT_DIR"
tar czf "$DIST_DIR/server.tar.gz" -C . server
ok "server.tar.gz"

# ============================================================
#  3. 打包 ikun-ctl
# ============================================================
info "[3/3] 打包 ikun-ctl..."
cd "$PROJECT_DIR"
tar czf "$DIST_DIR/ikun-ctl.tar.gz" -C . ikun-ctl
ok "ikun-ctl.tar.gz"

# ============================================================
#  4. 复制 script 目录
# ============================================================
if [[ -d "$PROJECT_DIR/script" ]]; then
  cp -r "$PROJECT_DIR/script" "$DIST_DIR/"
  ok "script/"
fi

# ============================================================
#  汇总
# ============================================================
echo ""
echo "============================================================"
echo -e "  ${GREEN}构建完成！${NC} 产物在 dist/ 目录:"
echo "============================================================"
echo ""
ls -lh "$DIST_DIR"/*.tar.gz
echo ""
