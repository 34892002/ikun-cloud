#!/bin/bash
#============================================================
#  ikun-cloud 一键安装菜单
#
#  用法:
#    bash <(curl -Ls https://raw.githubusercontent.com/34892002/ikun-cloud/main/script/menu.sh)
#
#============================================================
set -euo pipefail

# ---- 配置 ----
REPO_URL="https://github.com/34892002/ikun-cloud.git"
REPO_BRANCH="main"
DEFAULT_PROXY="https://ghfast.top/"
WORK_DIR="/tmp/ikun-cloud-src"

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

# ---- 全局变量 ----
GH_PROXY=""

#============================================================
#  前置检查
#============================================================
if [[ $EUID -ne 0 ]]; then
  fail "请以 root 权限运行此脚本"
fi

#============================================================
#  辅助函数
#============================================================

check_pvm()  { [[ "$(uname -r)" == *pvm* ]] || dpkg -l 2>/dev/null | grep -q "linux-image-.*pvm"; }
check_ch()   { command -v cloud-hypervisor &>/dev/null; }
check_swap() { swapon --show --noheadings 2>/dev/null | grep -q '/swapfile'; }
check_kvm()  { [[ -e /dev/kvm ]]; }

# 询问 GitHub 代理（全局只问一次）
ask_proxy() {
  if [[ -n "$GH_PROXY" ]]; then
    return 0
  fi

  echo ""
  echo "  GitHub 代理设置（国内服务器建议使用代理加速下载）"
  echo ""
  echo "    [1] 使用代理（默认: ${DEFAULT_PROXY}）"
  echo "    [2] 不使用代理（直连）"
  echo ""
  read -p "  请选择 [1/2, 默认 1]: " -n 1 -r PROXY_CHOICE
  echo ""

  if [[ "$PROXY_CHOICE" == "2" ]]; then
    GH_PROXY=""
    info "将直连 GitHub"
  else
    read -p "  代理地址 [直接回车使用默认]: " CUSTOM_PROXY
    if [[ -n "$CUSTOM_PROXY" ]]; then
      GH_PROXY="${CUSTOM_PROXY%/}/"
    else
      GH_PROXY="$DEFAULT_PROXY"
    fi
    info "使用代理: ${GH_PROXY}"
  fi

  # 导出给子脚本使用，避免重复询问
  export IKUN_GH_PROXY="$GH_PROXY"
}

# 从 GitHub 克隆仓库
clone_repo() {
  ask_proxy

  # 构造克隆地址
  # 代理: https://ghfast.top/https://github.com/user/repo.git
  # 直连: https://github.com/user/repo.git
  local CLONE_URL
  if [[ -n "$GH_PROXY" ]]; then
    CLONE_URL="${GH_PROXY}${REPO_URL}"
  else
    CLONE_URL="$REPO_URL"
  fi

  info "克隆地址: $CLONE_URL"

  # 禁止 git 弹出认证提示，直接失败
  export GIT_TERMINAL_PROMPT=0

  if [[ -d "$WORK_DIR/.git" ]]; then
    info "检测到已有源码目录，更新中..."
    cd "$WORK_DIR"
    git pull --ff-only 2>/dev/null && ok "源码已更新" || {
      warn "更新失败，重新克隆..."
      cd /tmp
      rm -rf "$WORK_DIR"
      git clone --depth 1 -b "$REPO_BRANCH" "$CLONE_URL" "$WORK_DIR" 2>&1 || fail "git clone 失败，请检查网络或代理"
      ok "源码已克隆"
    }
  else
    rm -rf "$WORK_DIR"
    info "克隆仓库..."
    git clone --depth 1 -b "$REPO_BRANCH" "$CLONE_URL" "$WORK_DIR" 2>&1 || fail "git clone 失败，请检查网络或代理"
    ok "源码已克隆到 $WORK_DIR"
  fi

  unset GIT_TERMINAL_PROMPT

  # 确保脚本可执行
  chmod +x "$WORK_DIR"/script/*.sh 2>/dev/null || true
  chmod +x "$WORK_DIR"/build.sh 2>/dev/null || true
}

# 安装基础依赖
install_base_deps() {
  info "检查基础依赖..."
  apt-get update -qq >/dev/null 2>&1

  local NEEDED=()
  command -v git   &>/dev/null || NEEDED+=(git)
  command -v curl  &>/dev/null || NEEDED+=(curl)
  command -v wget  &>/dev/null || NEEDED+=(wget)

  if [[ ${#NEEDED[@]} -gt 0 ]]; then
    apt-get install -y -qq "${NEEDED[@]}" >/dev/null 2>&1
    ok "已安装: ${NEEDED[*]}"
  else
    ok "基础依赖就绪"
  fi
}

# 安装 bun
install_bun() {
  if command -v bun &>/dev/null; then
    ok "bun: $(bun --version)"
    return 0
  fi

  if [[ -x /root/.bun/bin/bun ]]; then
    export PATH="/root/.bun/bin:$PATH"
    ok "bun: $(bun --version)"
    return 0
  fi

  info "安装 bun..."
  apt-get install -y -qq unzip >/dev/null 2>&1
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  export PATH="/root/.bun/bin:$PATH"
  grep -q '/root/.bun/bin' /root/.bashrc 2>/dev/null || echo 'export PATH=/root/.bun/bin:$PATH' >> /root/.bashrc
  ok "bun: $(bun --version)"
}

# 启动 ikun-cloud 服务
start_service() {
  local INSTALL_DIR="/opt/ikun-cloud"
  if [[ ! -d "$INSTALL_DIR/server" ]]; then
    warn "未找到 $INSTALL_DIR/server，跳过启动"
    return 1
  fi

  # 确保 bun 在 PATH
  if ! command -v bun &>/dev/null && [[ -x /root/.bun/bin/bun ]]; then
    export PATH="/root/.bun/bin:$PATH"
  fi

  # 杀掉旧进程
  if pgrep -f "bun.*run.*start" >/dev/null 2>&1; then
    pkill -f "bun.*run.*start" 2>/dev/null || true
    sleep 1
  fi

  cd "$INSTALL_DIR/server"
  nohup bun run start > /tmp/ikun-server.log 2>&1 &
  local PID=$!
  sleep 2

  if kill -0 $PID 2>/dev/null; then
    ok "ikun-cloud 服务已启动 (PID: $PID)"
  else
    warn "服务可能启动失败，请检查: tail -f /tmp/ikun-server.log"
  fi
}

#============================================================
#  显示菜单
#============================================================
show_menu() {
  echo ""
  echo -e "${BOLD}============================================================${NC}"
  echo -e "${BOLD}          ikun-cloud 一键安装${NC}"
  echo -e "${BOLD}============================================================${NC}"
  echo ""
  echo "  当前状态:"

  local PVM_STATUS="[未安装]" CH_STATUS="[未安装]" SWAP_STATUS="[未启用]" KVM_STATUS="[不可用]"
  check_pvm  && PVM_STATUS="[已安装]"
  check_ch   && CH_STATUS="[已安装]"
  check_swap && SWAP_STATUS="[已启用]"
  check_kvm  && KVM_STATUS="[可用]"

  echo "    PVM 内核         $PVM_STATUS"
  echo "    Cloud Hypervisor  $CH_STATUS"
  echo "    Swap             $SWAP_STATUS"
  echo "    KVM              $KVM_STATUS"
  echo ""
  echo "  [1] 安装 PVM 内核"
  echo "  [2] 安装 ikun-cloud"
  echo "  [3] 制作 Debian 基础镜像"
  echo "  [4] 调整 Swap"
  echo ""
  echo "  [0] 退出"
  echo ""
}

#============================================================
#  选项 1: 安装 PVM 内核
#============================================================
do_install_pvm() {
  echo ""
  echo "============================================================"
  echo "  安装 PVM 内核 + Cloud Hypervisor"
  echo "============================================================"

  install_base_deps
  clone_repo

  echo ""
  bash "$WORK_DIR/script/install-core.sh"

  if check_pvm && ! check_kvm; then
    warn "PVM 内核已安装，需要重启生效"
    read -p "  现在重启吗？[y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      reboot
    fi
  fi
}

#============================================================
#  选项 2: 安装 ikun-cloud
#============================================================
do_install_ikun() {
  echo ""
  echo "============================================================"
  echo "  安装 ikun-cloud"
  echo "============================================================"

  # ---- 安装依赖 + 克隆 ----
  install_base_deps
  install_bun
  clone_repo

  # ---- 检查运行环境 ----
  local NEED_ENV=false
  if ! check_pvm && ! check_kvm; then NEED_ENV=true; fi
  if ! check_ch; then NEED_ENV=true; fi
  if ! check_swap; then NEED_ENV=true; fi

  if $NEED_ENV; then
    echo ""
    warn "运行环境不完整，需要先安装 PVM / Cloud Hypervisor / Swap"
    echo ""
    bash "$WORK_DIR/script/install-core.sh"

    # 安装 PVM 后可能需要重启
    if check_pvm && ! check_kvm; then
      echo ""
      warn "PVM 内核已安装，需要重启后继续"
      echo ""
      echo "  重启后请重新运行本脚本，再次选择 [2] 即可继续安装"
      echo ""
      read -p "  现在重启吗？[Y/n] " -n 1 -r
      echo ""
      if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        reboot
      fi
      return 0
    fi
  fi

  # ---- 构建 ----
  echo ""
  info "开始构建 ikun-cloud..."
  cd "$WORK_DIR"
  bash build.sh

  # ---- 部署 ----
  echo ""
  info "开始部署..."
  bash "$WORK_DIR/dist/script/install-ikun.sh"

  # ---- 启动 ----
  echo ""
  start_service

  # ---- 完成 ----
  echo ""
  echo "============================================================"
  echo -e "  ${GREEN}ikun-cloud 安装完成！${NC}"
  echo "============================================================"
  echo ""
  echo "  管理面板: http://<服务器IP>:3000"
  echo "  默认管理员: admin / admin123"
  echo ""
}

#============================================================
#  选项 3: 制作 Debian 基础镜像
#============================================================
do_build_image() {
  echo ""
  echo "============================================================"
  echo "  制作 Debian 基础镜像"
  echo "============================================================"

  install_base_deps
  clone_repo

  echo ""
  bash "$WORK_DIR/script/build-rootfs-v2.sh"
}

#============================================================
#  选项 4: 调整 Swap
#============================================================
do_adjust_swap() {
  echo ""
  echo "============================================================"
  echo "  调整 Swap"
  echo "============================================================"

  echo ""
  echo "  当前状态:"
  free -h | head -2
  echo ""
  swapon --show 2>/dev/null || echo "  无 Swap"
  echo ""

  echo "  [1] 设置 Swap（默认 2G）"
  echo "  [2] 关闭 Swap"
  echo ""
  read -p "  请选择 [1/2, 默认 1]: " -n 1 -r SWAP_ACTION
  echo ""

  if [[ "$SWAP_ACTION" == "2" ]]; then
    if check_swap; then
      swapoff /swapfile 2>/dev/null || true
      rm -f /swapfile
      sed -i '/\/swapfile/d' /etc/fstab 2>/dev/null || true
      ok "Swap 已关闭"
    else
      ok "Swap 未启用，无需操作"
    fi
    return 0
  fi

  local DEFAULT_SIZE="2G"
  read -p "  Swap 大小 [直接回车使用默认 ${DEFAULT_SIZE}]: " SWAP_SIZE
  SWAP_SIZE="${SWAP_SIZE:-$DEFAULT_SIZE}"

  if ! [[ "$SWAP_SIZE" =~ ^[0-9]+[MmGg]$ ]]; then
    fail "格式无效，请使用如 1G、512M"
  fi

  # 关闭旧 Swap
  if check_swap; then
    swapoff /swapfile 2>/dev/null || true
    rm -f /swapfile
  fi

  fallocate -l "$SWAP_SIZE" /swapfile || fail "创建 swapfile 失败"
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl vm.swappiness=60 >/dev/null
  echo "vm.swappiness = 60" > /etc/sysctl.d/99-z-ikun.conf

  ok "Swap 已启用: $SWAP_SIZE"
  swapon --show | grep swapfile
}

#============================================================
#  主循环
#============================================================
while true; do
  show_menu
  read -p "  请选择 [0-4]: " -n 1 -r CHOICE
  echo ""

  case "$CHOICE" in
    1) do_install_pvm   ;;
    2) do_install_ikun  ;;
    3) do_build_image   ;;
    4) do_adjust_swap   ;;
    0) echo ""; ok "退出"; exit 0 ;;
    *) warn "无效选择"   ;;
  esac

  echo ""
  read -p "  按回车返回主菜单..." -r || true
done
