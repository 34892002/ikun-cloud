#!/bin/bash
#============================================================
#  ikun-cloud 部署脚本
#  从 dist/ 目录安装 ikun-cloud
#============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

# 定位 dist 目录（脚本所在目录的上级）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$(dirname "$SCRIPT_DIR")"

echo ""
echo "============================================================"
echo "  ikun-cloud 部署"
echo "============================================================"
echo ""

#============================================================
#  1. 检查依赖
#============================================================
info "检查运行环境..."

# Python
if command -v python3 &>/dev/null; then
  ok "Python: $(python3 --version)"
else
  warn "Python3 未安装，正在安装..."
  apt-get update -qq >/dev/null 2>&1 || fail "apt-get update 失败"
  apt-get install -y -qq python3 >/dev/null 2>&1 || fail "安装 python3 失败"
  ok "Python: $(python3 --version)"
fi

# Bun
if command -v bun &>/dev/null; then
  ok "Bun: $(bun --version)"
else
  # 检查是否已安装但未在 PATH
  if [[ -x /root/.bun/bin/bun ]]; then
    export PATH="/root/.bun/bin:$PATH"
    ok "Bun: $(bun --version)"
  else
    warn "Bun 未安装，正在安装..."
    apt-get update -qq >/dev/null 2>&1 || fail "apt-get update 失败"
    apt-get install -y -qq unzip >/dev/null 2>&1 || fail "安装 unzip 失败"

    # 直接从 GitHub 下载 bun，支持代理
    PROXY="${IKUN_GH_PROXY:-}"
    BUN_URL="${PROXY}https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip"
    TMP_DIR=$(mktemp -d)
    info "下载 bun..."
    wget -q "$BUN_URL" -O "$TMP_DIR/bun.zip" || fail "bun 下载失败，请检查网络"
    unzip -qo "$TMP_DIR/bun.zip" -d "$TMP_DIR" || fail "bun 解压失败"
    mkdir -p /root/.bun/bin
    mv "$TMP_DIR/bun-linux-x64/bun" /root/.bun/bin/bun
    chmod +x /root/.bun/bin/bun
    rm -rf "$TMP_DIR"

    export PATH="/root/.bun/bin:$PATH"
    grep -q '/root/.bun/bin' /root/.bashrc || echo 'export PATH=/root/.bun/bin:$PATH' >> /root/.bashrc
    ok "Bun: $(bun --version)"
  fi
fi

# 检查 tar.gz 包
for pkg in server.tar.gz web-dist.tar.gz ikun-ctl.tar.gz; do
  if [[ ! -f "$DIST_DIR/$pkg" ]]; then
    fail "未找到 $DIST_DIR/$pkg"
  fi
done
ok "所有部署包就绪"

#============================================================
#  2. 创建目录
#============================================================
info "创建目录..."

INSTALL_DIR="/opt/ikun-cloud"
DATA_DIR="/data/ikun-cloud"

mkdir -p "$INSTALL_DIR"
mkdir -p "$DATA_DIR"/{images,disks,vms,kernel}
ok "目录就绪"

#============================================================
#  3. 部署后端
#============================================================
info "部署后端..."

tar xzf "$DIST_DIR/server.tar.gz" -C "$INSTALL_DIR"
ok "后端已部署"

#============================================================
#  4. 部署前端
#============================================================
info "部署前端..."

mkdir -p "$INSTALL_DIR/web/dist"
tar xzf "$DIST_DIR/web-dist.tar.gz" -C "$INSTALL_DIR/web/dist"
ok "前端已部署"

#============================================================
#  5. 部署 ikun-ctl
#============================================================
info "部署 ikun-ctl..."

tar xzf "$DIST_DIR/ikun-ctl.tar.gz" -C "$INSTALL_DIR"
ln -sf "$INSTALL_DIR/ikun-ctl/ikun-ctl.py" /usr/local/bin/ikun-ctl
chmod +x "$INSTALL_DIR/ikun-ctl/ikun-ctl.py"
ok "ikun-ctl 已部署"

#============================================================
#  6. 初始化宿主机
#============================================================
info "初始化宿主机..."

ikun-ctl init 2>/dev/null || warn "ikun-ctl init 部分步骤失败，请手动检查"
ok "宿主机初始化完成"

#============================================================
#  汇总
#============================================================
echo ""
echo "============================================================"
echo -e "  ${GREEN}部署完成！${NC}"
echo "============================================================"
echo ""
echo "  项目路径: $INSTALL_DIR"
echo "  数据路径: $DATA_DIR"
echo ""
echo "  启动服务:"
echo "    cd $INSTALL_DIR/server"
echo "    nohup bun run start > /tmp/ikun-server.log 2>&1 &"
echo ""
echo "  验证:"
echo "    curl http://localhost:3000/"
echo ""
