#!/bin/bash
# 构建 ikun-cloud 基础镜像
# 用法: bash build-rootfs-v2.sh
set -o pipefail

LOG=/tmp/debootstrap.log
BUILD=/data/ikun-cloud/build
MIRRORS=(
  'https://deb.debian.org/debian'
  'https://mirrors.aliyun.com/debian'
  'https://mirrors.ustc.edu.cn/debian'
)
MIRROR_NAMES=('Debian 官方' '阿里云' 'USTC')
DEFAULT_MIRROR=0
ROOT_PASS='ikun123456'

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; echo "[INFO] $*" >> "$LOG"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; echo "[OK] $*" >> "$LOG"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; echo "[FAIL] $*" >> "$LOG"; exit 1; }

echo "=== 开始构建: $(date) ===" > "$LOG"
info "日志文件: $LOG"

# ---- 选择镜像源 ----
echo ""
echo "  选择镜像源:"
for i in "${!MIRROR_NAMES[@]}"; do
  echo "    [$((i+1))] ${MIRROR_NAMES[$i]}"
done
echo ""
read -p "  请选择 [1-${#MIRROR_NAMES[@]}, 默认 $((DEFAULT_MIRROR+1))]: " MIRROR_CHOICE
MIRROR_CHOICE=${MIRROR_CHOICE:-$((DEFAULT_MIRROR+1))}
if [[ "$MIRROR_CHOICE" =~ ^[0-9]+$ ]] && [[ "$MIRROR_CHOICE" -ge 1 ]] && [[ "$MIRROR_CHOICE" -le ${#MIRROR_NAMES[@]} ]]; then
  MIRROR="${MIRRORS[$((MIRROR_CHOICE-1))]}"
else
  MIRROR="${MIRRORS[$DEFAULT_MIRROR]}"
fi
info "镜像源: $MIRROR"

# ---- 清理上次残留 ----
umount "$BUILD/rootfs-mnt/proc" 2>/dev/null || true
umount "$BUILD/rootfs-mnt/sys" 2>/dev/null || true
umount "$BUILD/rootfs-mnt/dev" 2>/dev/null || true
umount "$BUILD/rootfs-mnt" 2>/dev/null || true
rm -rf "$BUILD"

# ---- 检查依赖 ----
info "检查依赖..."
for cmd in mkfs.ext4 mount umount chroot dpkg; do
  command -v $cmd &>/dev/null || fail "缺少命令: $cmd"
done
if ! command -v debootstrap &>/dev/null; then
  info "安装 debootstrap..."
  apt-get install -y -qq debootstrap >/dev/null 2>&1 || fail "debootstrap 安装失败"
fi
ok "依赖就绪"

# ---- 创建 rootfs 磁盘 ----
info "创建 2G rootfs 磁盘..."
mkdir -p "$BUILD"
dd if=/dev/zero of="$BUILD/rootfs.raw" bs=1M count=2048 status=progress 2>&1 | tee -a "$LOG"
[[ "${PIPESTATUS[0]}" -ne 0 ]] && fail "dd 失败"
mkfs.ext4 -F "$BUILD/rootfs.raw" >> "$LOG" 2>&1 || fail "mkfs.ext4 失败"
mkdir -p "$BUILD/rootfs-mnt"
mount -o loop "$BUILD/rootfs.raw" "$BUILD/rootfs-mnt" >> "$LOG" 2>&1 || fail "mount 失败"
ok "rootfs 磁盘已创建并挂载"

# ---- debootstrap ----
info "debootstrap 安装基础系统（可能需要几分钟）..."
debootstrap --variant=minbase \
  --include=systemd,systemd-sysv,openssh-server,iproute2,iputils-ping,curl,kmod,linux-image-amd64 \
  bookworm \
  "$BUILD/rootfs-mnt" \
  "$MIRROR" >> "$LOG" 2>&1 &
DEBOOT_PID=$!

# 动态显示进度
while kill -0 $DEBOOT_PID 2>/dev/null; do
  LAST_LINE=$(tail -1 "$LOG" 2>/dev/null)
  printf "\r${CYAN}[INFO]${NC} %-80s" "$LAST_LINE"
  sleep 1
done
wait $DEBOOT_PID
DEBOOT_STATUS=$?
printf "\r%-100s\r" " "
[[ "$DEBOOT_STATUS" -ne 0 ]] && fail "debootstrap 失败，请检查网络和镜像源"
echo "=== debootstrap 完成: $(date) ===" >> "$LOG"
ok "基础系统安装完成"

# ---- 挂载 proc/sys/dev ----
info "挂载 proc/sys/dev..."
mount -t proc proc "$BUILD/rootfs-mnt/proc" || fail "mount proc 失败"
mount -t sysfs sys "$BUILD/rootfs-mnt/sys" || fail "mount sys 失败"
mount -o bind /dev "$BUILD/rootfs-mnt/dev" || fail "mount dev 失败"

# ---- 配置 rootfs ----
info "配置 rootfs（密码、SSH、网络）..."
chroot "$BUILD/rootfs-mnt" /bin/bash -c "
  echo root:$ROOT_PASS | chpasswd
  sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
  sed -i 's/PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
  systemctl enable ssh systemd-networkd
  echo 'nameserver 8.8.8.8' > /etc/resolv.conf
  echo 'nameserver 114.114.114.114' >> /etc/resolv.conf
" >> "$LOG" 2>&1 || fail "rootfs 配置失败"
ok "rootfs 配置完成"

# ---- SSH 首次开机自动生成 host key ----
info "配置 SSH host key 自动生成..."
cat > "$BUILD/rootfs-mnt/etc/systemd/system/regen-ssh-keys.service" << 'SVCEOF'
[Unit]
Description=Regenerate SSH host keys on first boot
Before=ssh.service
ConditionPathExistsGlob=!/etc/ssh/ssh_host_*_key

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A
ExecStart=/bin/systemctl disable regen-ssh-keys.service
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SVCEOF
chroot "$BUILD/rootfs-mnt" systemctl enable regen-ssh-keys.service >> "$LOG" 2>&1
rm -f "$BUILD/rootfs-mnt/etc/ssh/ssh_host_*"

# ---- 网络配置（同时匹配 ens* 和 eth*）----
info "配置网络..."
cat > "$BUILD/rootfs-mnt/etc/systemd/network/10-ikun.network" << 'EOF'
[Match]
Name=en*

[Network]
DHCP=yes
DNS=8.8.8.8
DNS=114.114.114.114
EOF

# ---- 验证 ----
info "验证镜像..."
VERIFY_FAIL=0
for f in bin/bash sbin/init usr/sbin/sshd lib/modules; do
  if [[ ! -e "$BUILD/rootfs-mnt/$f" ]]; then
    echo -e "${RED}  缺少: $f${NC}"
    echo "ERROR: missing $f" >> "$LOG"
    VERIFY_FAIL=1
  fi
done
PKG_COUNT=$(chroot "$BUILD/rootfs-mnt" dpkg -l 2>/dev/null | grep -c '^ii')
info "已安装包数量: $PKG_COUNT"
if [[ "$PKG_COUNT" -lt 100 ]]; then
  echo -e "${RED}  包数量太少${NC}"
  VERIFY_FAIL=1
fi
[[ "$VERIFY_FAIL" -eq 1 ]] && fail "验证失败，详见 $LOG"

# ---- 卸载并保存 ----
info "卸载并保存镜像..."
umount "$BUILD/rootfs-mnt/proc" || fail "卸载 proc 失败"
umount "$BUILD/rootfs-mnt/sys" || fail "卸载 sys 失败"
umount "$BUILD/rootfs-mnt/dev" || fail "卸载 dev 失败"
umount "$BUILD/rootfs-mnt" || fail "卸载 rootfs 失败"

mkdir -p /data/ikun-cloud/images
cp "$BUILD/rootfs.raw" /data/ikun-cloud/images/debian12-custom.raw

IMG_SIZE=$(stat -c%s /data/ikun-cloud/images/debian12-custom.raw)
if [[ "$IMG_SIZE" -lt 100000000 ]]; then
  fail "镜像文件太小，可能构建失败"
fi

# 清理构建目录
rm -rf "$BUILD"

echo ""
echo -e "${GREEN}=== 构建完成 ===${NC}"
echo "  镜像: /data/ikun-cloud/images/debian12-custom.raw ($(du -h /data/ikun-cloud/images/debian12-custom.raw | cut -f1))"
echo "  密码: $ROOT_PASS"
echo "  日志: $LOG"
