#!/bin/bash
#============================================================
#  ikun-cloud 环境安装脚本
#  适用环境: Debian 12/13 x86_64 云服务器
#  功能: PVM 内核(可选) + Cloud Hypervisor + Swap
#============================================================

# ---- 可修改常量 ----
KVER_PVM='6.6.69-opencloudos9.cubesandbox.pvm.host-gb85200d80fa2'
DEB_FILE='linux-image-6.6.69-opencloudos9.cubesandbox.pvm.host-gb85200d80fa2_6.6.69-gb85200d80fa2-1_amd64.deb'
DEB_RELEASE_URL="https://github.com/TencentCloud/CubeSandbox/releases/download/v0.4.0/${DEB_FILE}"
CH_VERSION='v52.0'
CH_RELEASE_URL="https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/${CH_VERSION}/cloud-hypervisor-static"
DEFAULT_GH_PROXY='https://ghfast.top/'
DEFAULT_SWAP_SIZE='2G'
SWAPPINESS=60

set -euo pipefail

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

#============================================================
#  前置检查
#============================================================
info "检查运行环境..."

if [[ $EUID -ne 0 ]]; then
  fail "请以 root 权限运行此脚本"
fi

ARCH=$(uname -m)
if [[ "$ARCH" != "x86_64" ]]; then
  fail "仅支持 x86_64 架构，当前: $ARCH"
fi

if ! grep -qiE 'debian|ubuntu' /etc/os-release 2>/dev/null; then
  warn "未检测到 Debian/Ubuntu，部分步骤可能不兼容"
fi

# ---- 安装基础依赖 ----
info "安装基础依赖..."
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq wget curl dpkg iproute2 iputils-ping >/dev/null 2>&1
ok "基础依赖就绪"

# ============================================================
#  交互配置
# ============================================================
echo ""
echo "============================================================"
echo "  ikun-cloud 环境安装"
echo "============================================================"
echo ""

# ---- GitHub 代理 ----
echo "  GitHub 代理设置"
echo ""
echo "    [1] 不使用代理（直连 GitHub）"
echo "    [2] 使用代理（默认: ${DEFAULT_GH_PROXY}）"
echo ""
read -p "  请选择 [1/2, 默认 1]: " -n 1 -r PROXY_CHOICE
echo ""

GH_PROXY=""
if [[ "$PROXY_CHOICE" == "2" ]]; then
  read -p "  代理地址 [直接回车使用默认: ${DEFAULT_GH_PROXY}]: " CUSTOM_PROXY
  if [[ -n "$CUSTOM_PROXY" ]]; then
    # 确保以 / 结尾
    GH_PROXY="${CUSTOM_PROXY%/}/"
  else
    GH_PROXY="$DEFAULT_GH_PROXY"
  fi
  info "使用代理: ${GH_PROXY}"
else
  GH_PROXY=""
  info "将直连 GitHub"
fi

DEB_URL="${GH_PROXY}${DEB_RELEASE_URL}"
CH_URL="${GH_PROXY}${CH_RELEASE_URL}"
echo ""

# ---- Swap 大小 ----
read -p "  Swap 大小 [直接回车使用默认 ${DEFAULT_SWAP_SIZE}]: " SWAP_INPUT
SWAP_SIZE="${SWAP_INPUT:-$DEFAULT_SWAP_SIZE}"
info "Swap 大小: ${SWAP_SIZE}"
echo ""

# ---- PVM 内核选择 ----
INSTALL_PVM=false
CURRENT_KVER=$(uname -r)

if [[ "$CURRENT_KVER" == *pvm* ]]; then
  ok "已运行 PVM 内核 ($CURRENT_KVER)，跳过内核安装"
  INSTALL_PVM=false
else
  # 检查 KVM 是否已可用
  if [[ -e /dev/kvm ]]; then
    echo "  检测到 /dev/kvm 已存在（KVM 已可用）"
    echo ""
    echo "    [1] 跳过 PVM 内核（使用现有 KVM）"
    echo "    [2] 安装 PVM 内核（替换现有内核）"
    echo ""
    read -p "  请选择 [1/2, 默认 1]: " -n 1 -r PVM_CHOICE
    echo ""
    if [[ "$PVM_CHOICE" == "2" ]]; then
      INSTALL_PVM=true
    else
      INSTALL_PVM=false
      info "跳过 PVM 内核安装"
    fi
  else
    echo "  未检测到 /dev/kvm"
    echo ""
    echo "    [1] 安装 PVM 内核（推荐，提供 KVM 支持）"
    echo "    [2] 跳过（不安装 PVM 内核）"
    echo ""
    read -p "  请选择 [1/2, 默认 1]: " -n 1 -r PVM_CHOICE
    echo ""
    if [[ "$PVM_CHOICE" == "2" ]]; then
      INSTALL_PVM=false
      warn "跳过 PVM 内核安装，VM 可能无法运行"
    else
      INSTALL_PVM=true
    fi
  fi
fi
echo ""

# ============================================================
#  根据选择计算步骤数
# ============================================================
STEPS=2  # Swap + Cloud Hypervisor
STEP_LABELS=()
STEP_LABELS+=("Swap")
if $INSTALL_PVM; then
  STEPS=$((STEPS + 2))  # PVM + 网络恢复
  STEP_LABELS+=("PVM 内核" "网络恢复")
fi
STEP_LABELS+=("nbd 模块" "Cloud Hypervisor")
STEPS=$((STEPS + 1))  # nbd

STEP_NUM=0
next_step() {
  STEP_NUM=$((STEP_NUM + 1))
  echo "[$STEP_NUM/$STEPS] $1"
}

#============================================================
#  1. Swap 配置
#============================================================
info "$(next_step "配置 Swap (${SWAP_SIZE})")"

if swapon --show | grep -q '/swapfile'; then
  ok "Swap 已存在，跳过"
else
  if [[ -f /swapfile ]]; then
    rm -f /swapfile
  fi
  fallocate -l ${SWAP_SIZE} /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  # 避免重复写入 fstab
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "Swap 已启用: $(swapon --show | grep swapfile | awk '{print $3}')"
fi

# 设置 swappiness，避免 OOM 杀 VM 进程
sysctl vm.swappiness=${SWAPPINESS} >/dev/null
echo "vm.swappiness = ${SWAPPINESS}" > /etc/sysctl.d/99-z-ikun.conf
ok "swappiness = ${SWAPPINESS}"

#============================================================
#  2. PVM 内核（可选）
#============================================================
if $INSTALL_PVM; then
  info "$(next_step "安装 PVM 内核")"

  if ! dpkg -l | grep -q "linux-image-${KVER_PVM}"; then
    info "下载 PVM 内核 deb 包..."
    wget -q "$DEB_URL" -O /tmp/pvm-kernel.deb
    dpkg -i /tmp/pvm-kernel.deb
    rm -f /tmp/pvm-kernel.deb
    ok "PVM 内核已安装"
  else
    ok "PVM 内核 deb 已安装，等待重启生效"
  fi

  # GRUB 配置
  info "配置 GRUB 默认启动 PVM 内核..."
  mkdir -p /etc/default/grub.d
  echo "GRUB_DEFAULT=\"Advanced options for Debian GNU/Linux>Debian GNU/Linux, with Linux ${KVER_PVM}\"" \
    > /etc/default/grub.d/99-pvm.cfg
  update-grub >/dev/null 2>&1

  # 官方 GRUB 脚本
  info "运行官方 GRUB 配置脚本..."
  curl -sL https://cnb.cool/CubeSandbox/CubeSandbox/-/git/raw/master/deploy/pvm/grub/host_grub_config.sh | bash >/dev/null 2>&1

  # kvm_pvm 模块
  echo 'kvm_pvm' > /etc/modules-load.d/kvm-pvm.conf
  ok "PVM 内核 + GRUB 配置完成"

  #============================================================
  #  网络恢复服务（仅 PVM 安装时配置）
  #============================================================
  info "$(next_step "配置网络恢复服务")"

  NET_BACKUP_DIR="/data/ikun-cloud/net-backup"
  mkdir -p "$NET_BACKUP_DIR"

  # ---- 列出物理网卡 ----
  IFACES=()
  for IFACE in $(ip -o link show | awk -F': ' '{print $2}' | grep -vE 'lo|tap|ikun-br|docker|veth|br-|flannel|cni|vnet'); do
    IFACES+=("$IFACE")
  done

  if [[ ${#IFACES[@]} -eq 0 ]]; then
    fail "未检测到物理网卡"
  fi

  # ---- 测试每个网卡是否能出网 ----
  echo ""
  echo "  检测网卡外网连通性..."
  echo ""
  VALID_IFACES=()
  for IFACE in "${IFACES[@]}"; do
    ip link set "$IFACE" up 2>/dev/null
    sleep 1
    if curl -s --connect-timeout 5 --interface "$IFACE" ip.sb >/dev/null 2>&1; then
      echo "    ✓ $IFACE  可出网 ($(ip -4 addr show "$IFACE" | grep -oP 'inet \K[\d.]+'))"
      VALID_IFACES+=("$IFACE")
    else
      echo "    ✗ $IFACE  不通"
    fi
  done
  echo ""

  if [[ ${#VALID_IFACES[@]} -eq 0 ]]; then
    fail "没有网卡能出网，请检查网络"
  fi

  # ---- 让用户选择 ----
  SELECTED_IFACE=""
  if [[ ${#VALID_IFACES[@]} -eq 1 ]]; then
    SELECTED_IFACE="${VALID_IFACES[0]}"
    info "自动选择: $SELECTED_IFACE"
  else
    echo "  选择要保护的网卡:"
    for i in "${!VALID_IFACES[@]}"; do
      echo "    [$((i+1))] ${VALID_IFACES[$i]}"
    done
    echo ""
    while true; do
      read -p "  请选择 [1-${#VALID_IFACES[@]}]: " CHOICE
      if [[ "$CHOICE" =~ ^[0-9]+$ ]] && [[ "$CHOICE" -ge 1 ]] && [[ "$CHOICE" -le ${#VALID_IFACES[@]} ]]; then
        SELECTED_IFACE="${VALID_IFACES[$((CHOICE-1))]}"
        break
      fi
      echo "  无效选择，请重试"
    done
  fi
  echo ""

  # ---- 备份网卡配置 ----
  info "备份 $SELECTED_IFACE 的网络配置..."

  IP_MODE="dhcp"
  IFACE_IP=$(ip -4 addr show "$SELECTED_IFACE" | grep -oP 'inet \K[\d.]+' | head -1)
  IFACE_GW=$(ip route show dev "$SELECTED_IFACE" | grep 'default' | awk '{print $3}' | head -1)
  IFACE_MASK_CIDR=$(ip -4 addr show "$SELECTED_IFACE" | grep -oP 'inet \K[\d.]+/[0-9]+' | head -1 | cut -d'/' -f2)

  cidr_to_mask() {
    local cidr=$1
    local mask=""
    local full_octets=$((cidr / 8))
    local partial=$((cidr % 8))
    for i in 1 2 3 4; do
      if [[ $i -le $full_octets ]]; then
        mask="${mask}255"
      elif [[ $i -eq $((full_octets + 1)) ]]; then
        mask="${mask}$((256 - 2 ** (8 - partial)))"
      else
        mask="${mask}0"
      fi
      [[ $i -lt 4 ]] && mask="${mask}."
    done
    echo "$mask"
  }

  IFACE_MASK=$(cidr_to_mask "$IFACE_MASK_CIDR")

  if grep -q "$SELECTED_IFACE" /var/lib/dhcp/dhclient.*.leases 2>/dev/null || \
     grep -qiE 'dhcp' /etc/network/interfaces 2>/dev/null || \
     networkctl status "$SELECTED_IFACE" 2>/dev/null | grep -qiE 'dhcp'; then
    IP_MODE="dhcp"
  else
    IP_MODE="static"
  fi

  # 备份网卡配置
  {
    echo "IFACE=$SELECTED_IFACE"
    echo "MODE=$IP_MODE"
    echo "IP=$IFACE_IP"
    echo "MASK=$IFACE_MASK"
    echo "MASK_CIDR=$IFACE_MASK_CIDR"
    echo "GW=$IFACE_GW"
    echo "BACKUP_TIME=$(date)"
  } > "$NET_BACKUP_DIR/iface.conf"

  # 备份 DNS
  cp /etc/resolv.conf "$NET_BACKUP_DIR/resolv.conf.bak"

  ok "已备份: $SELECTED_IFACE ($IP_MODE)"
  if [[ "$IP_MODE" == "static" ]]; then
    echo "         IP: $IFACE_IP/$IFACE_MASK_CIDR  GW: $IFACE_GW"
  fi
  echo "         DNS: $(grep '^nameserver' /etc/resolv.conf | awk '{print $2}' | tr '\n' ' ')"

  # ---- 写入恢复脚本 ----
  cat > /usr/local/bin/ikun-net-restore.sh << 'NETEOF'
#!/bin/bash
# ikun-cloud 网络恢复脚本
# 逻辑: ping 不通 → 逐个网卡用备份配置试 → 通了就 disable 服务
LOG=/tmp/ikun-net-restore.log
exec > >(tee -a "$LOG") 2>&1
echo "[ikun-net] $(date) 开始"

NET_BACKUP_DIR="/data/ikun-cloud/net-backup"
CONF="$NET_BACKUP_DIR/iface.conf"

if [[ ! -f "$CONF" ]]; then
  echo "[ikun-net] 未找到备份配置，跳过"
  exit 0
fi

source "$CONF"

# 恢复 DNS
dns_restore() {
  if [[ -f "$NET_BACKUP_DIR/resolv.conf.bak" ]]; then
    cp "$NET_BACKUP_DIR/resolv.conf.bak" /etc/resolv.conf
    echo "[ikun-net] DNS 已恢复"
  fi
}

# ---- ping 测试函数（通一个就行）----
check_net() {
  ping -c 1 -W 3 1.1.1.1 &>/dev/null || ping -c 1 -W 3 6.6.6.6 &>/dev/null
}

# ---- 应用配置函数（用 systemd-networkd 做 DHCP）----
apply_config() {
  local iface=$1
  if [[ "$MODE" == "dhcp" ]]; then
    cat > /etc/systemd/network/99-ikun-restore.network << EOF
[Match]
Name=$iface

[Network]
DHCP=yes
EOF
    systemctl restart systemd-networkd
    sleep 8
  else
    ip addr add "${IP}/${MASK_CIDR}" dev "$iface" 2>/dev/null
    sleep 1
    ip route add default via "$GW" dev "$iface" 2>/dev/null
  fi
}

# ---- 清理函数 ----
flush_iface() {
  local iface=$1
  rm -f /etc/systemd/network/99-ikun-restore.network
  ip addr flush dev "$iface" 2>/dev/null
  ip route flush dev "$iface" 2>/dev/null
  systemctl restart systemd-networkd 2>/dev/null
}

sleep 3

# 1. 拉起所有物理网卡
for IFACE in $(ip -o link show | awk -F': ' '{print $2}' | grep -vE 'lo|tap|ikun-br|docker|veth|br-|flannel|cni|vnet'); do
  ip link set "$IFACE" up 2>/dev/null
done

sleep 3

# 2. 直接 ping 看通不通
if check_net; then
  echo "[ikun-net] 网络正常，无需恢复"
  dns_restore
  systemctl disable ikun-net-restore.service 2>/dev/null
  exit 0
fi

# 3. 逐个网卡尝试恢复
for IFACE in $(ip -o link show | awk -F': ' '{print $2}' | grep -vE 'lo|tap|ikun-br|docker|veth|br-|flannel|cni|vnet'); do
  echo "[ikun-net] 尝试恢复: $IFACE ($MODE)"
  apply_config "$IFACE"

  if check_net; then
    echo "[ikun-net] ✓ $IFACE 恢复成功，外网已通"
    dns_restore
    systemctl disable ikun-net-restore.service 2>/dev/null
    exit 0
  fi

  echo "[ikun-net] ✗ $IFACE 不通，清理"
  flush_iface "$IFACE"
done

# 4. 全部失败
systemctl start systemd-networkd 2>/dev/null
echo "[ikun-net] ✗ 所有网卡恢复失败，请手动处理"
NETEOF

  chmod +x /usr/local/bin/ikun-net-restore.sh

  cat > /etc/systemd/system/ikun-net-restore.service << 'SVCEOF'
[Unit]
Description=ikun-cloud network restore
After=network-pre.target
Before=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ikun-net-restore.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SVCEOF

  systemctl daemon-reload
  systemctl enable ikun-net-restore.service >/dev/null 2>&1
  ok "网络恢复服务已配置"
fi

#============================================================
#  nbd 模块
#============================================================
info "$(next_step "配置 nbd 模块")"

echo 'nbd' > /etc/modules-load.d/nbd.conf
echo 'options nbd max_part=8' > /etc/modprobe.d/nbd.conf
ok "nbd 模块已配置"

#============================================================
#  Cloud Hypervisor
#============================================================
info "$(next_step "安装 Cloud Hypervisor")"

INSTALLED_CH_VER=$(cloud-hypervisor --version 2>&1 | head -1 | grep -oP 'v[\d.]+' || echo '')
if [[ "$INSTALLED_CH_VER" == "${CH_VERSION}" ]]; then
  ok "Cloud Hypervisor 已安装: $(cloud-hypervisor --version 2>&1)"
else
  if [[ -n "$INSTALLED_CH_VER" ]]; then
    info "检测到旧版本 $INSTALLED_CH_VER，升级到 ${CH_VERSION}..."
  fi
  mkdir -p /usr/local/bin
  wget -q "$CH_URL" -O /usr/local/bin/cloud-hypervisor
  chmod +x /usr/local/bin/cloud-hypervisor
  setcap cap_net_admin+ep /usr/local/bin/cloud-hypervisor
  ok "Cloud Hypervisor 已安装: $(cloud-hypervisor --version 2>&1)"
fi

#============================================================
#  汇总
#============================================================
echo ""
echo "============================================================"
echo -e "  ${GREEN}环境安装完成！${NC}"
echo "============================================================"
echo ""
echo "  已安装组件:"
if $INSTALL_PVM; then
  echo "    - PVM 内核:        ${KVER_PVM}"
else
  echo "    - PVM 内核:        跳过"
fi
echo "    - Cloud Hypervisor: $(cloud-hypervisor --version 2>&1 | head -1 || echo '未安装')"
echo "    - Swap:            $(swapon --show --noheadings | awk '{print $3}' || echo '无')"
echo ""

if $INSTALL_PVM; then
  CURRENT_KVER=$(uname -r)
  if [[ "$CURRENT_KVER" != *pvm* ]]; then
    echo -e "  ${YELLOW}⚠ 需要重启以加载 PVM 内核！${NC}"
    echo ""
    read -p "  现在重启吗？[y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      info "正在重启..."
      reboot
    else
      echo "  请稍后手动执行: reboot"
    fi
  else
    ok "PVM 内核已加载，无需重启"
  fi
else
  ok "无需重启"
fi
