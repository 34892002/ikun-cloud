# PVM 内核安装指南（Debian）

> 在 Debian 13 上安装 PVM 宿主机内核，使 Cloud Hypervisor 能够创建 VM。

---

## 前置条件

- Debian 13 (trixie) x86_64 云服务器
- root 权限
- SSH 密钥登录（安装过程会重启，密码登录可能中断）

---

## 安装步骤

### 1. 下载 PVM 内核

```bash
wget -q 'https://ghfast.top/https://github.com/TencentCloud/CubeSandbox/releases/download/v0.4.0/linux-image-6.6.69-opencloudos9.cubesandbox.pvm.host-gb85200d80fa2_6.6.69-gb85200d80fa2-1_amd64.deb' \
  -O /tmp/pvm-kernel.deb
```

### 2. 安装内核

```bash
dpkg -i /tmp/pvm-kernel.deb
```

### 3. 设置 GRUB 默认启动 PVM 内核

```bash
KVER='6.6.69-opencloudos9.cubesandbox.pvm.host-gb85200d80fa2'
echo "GRUB_DEFAULT=\"Advanced options for Debian GNU/Linux>Debian GNU/Linux, with Linux $KVER\"" \
  > /etc/default/grub.d/99-pvm.cfg
update-grub
```

### 4. 运行官方 GRUB 配置脚本

```bash
curl -sL https://cnb.cool/CubeSandbox/CubeSandbox/-/git/raw/master/deploy/pvm/grub/host_grub_config.sh | bash
```

### 5. 配置开机自动加载 kvm_pvm 模块

```bash
echo 'kvm_pvm' > /etc/modules-load.d/kvm-pvm.conf
```

### 6. 配置网络恢复（防止重启后失联）

PVM 内核的网卡名可能与原内核不同（如 `ens5` → `eth0`），需要自动检测。

```bash
cat > /usr/local/bin/ikun-net-restore.sh << 'EOF'
#!/bin/bash
sleep 3

# 拉起所有物理网卡（排除 lo、tap、bridge、docker、veth、flannel、cni）
for IFACE in $(ip -o link show | awk -F': ' '{print $2}' | grep -vE 'lo|tap|ikun-br|docker|veth|br-|flannel|cni'); do
  ip link set $IFACE up 2>/dev/null
done

# 等网卡 up
sleep 2

# 找到能拿到 IP 的网卡做 DHCP
for IFACE in $(ip -o link show | awk -F': ' '{print $2}' | grep -vE 'lo|tap|ikun-br|docker|veth|br-|flannel|cni'); do
  dhclient -v $IFACE 2>/dev/null &
done
wait

# 确保 bridge 存在
if ! ip link show ikun-br0 &>/dev/null; then
  ip link add ikun-br0 type bridge
  ip addr add 10.100.0.1/24 dev ikun-br0
fi
ip link set ikun-br0 up

# 开启转发 + NAT
echo 1 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -C POSTROUTING -s 10.100.0.0/24 -j MASQUERADE 2>/dev/null || \\
  iptables -t nat -A POSTROUTING -s 10.100.0.0/24 -j MASQUERADE

# 记录结果
echo "[ikun-net] $(date) 完成" > /tmp/ikun-net.log
ip -o addr show | grep 'inet ' | grep -v '127.0.0.1' >> /tmp/ikun-net.log
EOF

chmod +x /usr/local/bin/ikun-net-restore.sh

cat > /etc/systemd/system/ikun-net-restore.service << 'SERVICE'
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
SERVICE

systemctl enable ikun-net-restore.service
```

### 7. 配置 nbd 模块开机加载

```bash
echo 'nbd' > /etc/modules-load.d/nbd.conf
echo 'options nbd max_part=8' > /etc/modprobe.d/nbd.conf
```

### 8. 重启

```bash
reboot
```

---

## 验证

```bash
# 确认内核版本（应包含 pvm）
uname -r
# 期望: 6.6.69-opencloudos9.cubesandbox.pvm.host-gb85200d80fa2

# 加载 PVM 模块
modprobe kvm_pvm

# 确认 /dev/kvm 存在
ls -la /dev/kvm

# 确认模块已加载
lsmod | grep kvm
# 期望: kvm_pvm ...
```

---

## 踩坑记录

### 坑 1: GRUB_DEFAULT=0 不生效

**现象**: `grub-set-default` 设置了 saved_entry，但重启还是进旧内核。

**原因**: `/etc/default/grub` 中 `GRUB_DEFAULT=0` 优先级高于 `grubenv` 中的 `saved_entry`。

**解决**: 用 `/etc/default/grub.d/99-pvm.cfg` 覆盖，设为 `"Advanced options>..."` 格式。

### 坑 2: GRUB_DEFAULT="1>6" 不生效

**现象**: 数字索引格式的 submenu>entry 不被识别。

**解决**: 用菜单标题格式：`"Advanced options for Debian GNU/Linux>Debian GNU/Linux, with Linux <版本>"`。

### 坑 3: 重启后网络断开

**现象**: PVM 内核启动后 SSH 连不上。

**原因**: PVM 内核的网卡名与原内核不同（如 `ens5` → `eth0`），`/etc/network/interfaces` 或 systemd-networkd 配置的网卡名不匹配。

**解决**: 使用 `ikun-net-restore.service` 自动检测网卡名并恢复网络。

### 坑 4: insmod kvm-pvm.ko 失败

**现象**: `Invalid module format`。

**原因**: PVM 模块是为 PVM 内核编译的，与当前运行内核版本不匹配。

**解决**: 必须重启进入 PVM 内核后才能 `modprobe kvm_pvm`。

---

## 文件清单

| 文件 | 说明 |
|------|------|
| `/boot/vmlinuz-6.6.69-*pvm*` | PVM 内核 |
| `/lib/modules/6.6.69-*pvm*/kernel/arch/x86/kvm/kvm-pvm.ko` | PVM KVM 模块 |
| `/etc/modules-load.d/kvm-pvm.conf` | 开机自动加载 kvm_pvm |
| `/etc/modules-load.d/nbd.conf` | 开机自动加载 nbd |
| `/etc/default/grub.d/99-pvm.cfg` | GRUB 默认启动 PVM 内核 |
| `/usr/local/bin/ikun-net-restore.sh` | 网络恢复脚本 |
| `/etc/systemd/system/ikun-net-restore.service` | 网络恢复服务 |
