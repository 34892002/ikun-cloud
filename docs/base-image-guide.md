# ikun-cloud 基础镜像制作与部署指南

> 在 PVM 云服务器上部署 Cloud Hypervisor、制作 VM 基础镜像、创建和管理虚拟机的完整指南。

---

## 1. 整体流程

```
安装依赖 + 部署 CH + 下载内核
        ↓
debootstrap 构建 rootfs（含内核模块）
        ↓
配置 rootfs（密码、SSH、网络、首次开机服务）
        ↓
验证镜像（关键文件、包数量、/lib/modules/）
        ↓
ikun-ctl create 创建 VM（支持 JSON 配置文件）
        ↓
ikun-ctl start 启动 VM → SSH 登录
```

---

## 2. 环境准备

### 2.1 安装依赖

```bash
apt-get install -y python3 qemu-utils genisoimage iproute2 iptables curl debootstrap
```

### 2.2 安装 Cloud Hypervisor

```bash
# 官方预编译二进制（v52.0，国内用代理）
wget https://ghfast.top/https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v52.0/cloud-hypervisor-static \
  -O /usr/local/bin/cloud-hypervisor
chmod +x /usr/local/bin/cloud-hypervisor
setcap cap_net_admin+ep /usr/local/bin/cloud-hypervisor
```

### 2.3 下载 PVM guest 内核

```bash
mkdir -p /data/ikun-cloud/kernel
wget 'https://ghfast.top/https://github.com/TencentCloud/CubeSandbox/releases/download/v0.4.0/vmlinux-pvm' \
  -O /data/ikun-cloud/kernel/vmlinux-pvm
```

### 2.4 部署 ikun-ctl

```bash
scp ikun-ctl/ikun-ctl.py root@server:/usr/local/bin/ikun-ctl
chmod +x /usr/local/bin/ikun-ctl
```

### 2.5 初始化

```bash
ikun-ctl init
```

自动创建目录结构、网桥 `ikun-br0`、NAT 规则。

### 2.6 添加 Swap（必须）

debootstrap 构建 rootfs 时内存消耗大，**2GB 内存的服务器必须加 swap**，否则会被 OOM kill：

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
# 开机自动挂载
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 3. 构建基础镜像

### 3.1 为什么不用 cloud image

| 方案 | 问题 |
|------|------|
| Ubuntu/Debian cloud image (qcow2) | 需要 EFI 固件引导，hypervisor-fw 有 bug，edk2 下载困难 |
| cloud image + 分区表 | CH 的 qcow2 backing 嵌套深度限制，分区表增加复杂度 |
| **debootstrap + 无分区 ext4** | ✅ 最简单，直接内核引导，无 EFI 依赖 |

### 3.2 一键构建

使用 `build-rootfs-v2.sh` 一键完成构建：

```bash
bash build-rootfs-v2.sh
```

或手动执行：

```bash
# 创建 rootfs 磁盘（2GB）
dd if=/dev/zero of=/data/ikun-cloud/build/rootfs.raw bs=1M count=2048
mkfs.ext4 -F /data/ikun-cloud/build/rootfs.raw
mkdir -p /data/ikun-cloud/build/rootfs-mnt
mount -o loop /data/ikun-cloud/build/rootfs.raw /data/ikun-cloud/build/rootfs-mnt

# debootstrap 一步搞定：基础系统 + SSH + 内核模块
# ⚠️ 必须包含 linux-image-amd64，否则 virtio-net 不探测（见坑 13）
debootstrap --variant=minbase \
  --include=systemd,systemd-sysv,openssh-server,iproute2,iputils-ping,curl,kmod,linux-image-amd64 \
  bookworm \
  /data/ikun-cloud/build/rootfs-mnt \
  https://mirrors.aliyun.com/debian
```

**⚠️ 必须用国内镜像**，`deb.debian.org` 在国内服务器上极慢。

### 3.3 配置 rootfs

```bash
# 挂载虚拟文件系统
mount -t proc proc /data/ikun-cloud/build/rootfs-mnt/proc
mount -t sysfs sys /data/ikun-cloud/build/rootfs-mnt/sys
mount -o bind /dev /data/ikun-cloud/build/rootfs-mnt/dev

# 配置密码、SSH、DNS
chroot /data/ikun-cloud/build/rootfs-mnt /bin/bash -c '
  echo root:ikun123456 | chpasswd
  sed -i "s/#PermitRootLogin.*/PermitRootLogin yes/" /etc/ssh/sshd_config
  sed -i "s/PermitRootLogin.*/PermitRootLogin yes/" /etc/ssh/sshd_config
  systemctl enable ssh systemd-networkd
  echo "nameserver 8.8.8.8" > /etc/resolv.conf
  echo "nameserver 114.114.114.114" >> /etc/resolv.conf
'
```

### 3.4 首次开机自动生成 SSH host key

所有 VM 共用基础镜像，不处理的话 SSH 指纹都一样。添加 systemd 服务让每台 VM 首次开机自动生成新 key：

```bash
cat > /data/ikun-cloud/build/rootfs-mnt/etc/systemd/system/regen-ssh-keys.service << 'EOF'
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
EOF

chroot /data/ikun-cloud/build/rootfs-mnt systemctl enable regen-ssh-keys.service
rm -f /data/ikun-cloud/build/rootfs-mnt/etc/ssh/ssh_host_*
```

### 3.5 配置静态网络

```bash
cat > /data/ikun-cloud/build/rootfs-mnt/etc/systemd/network/10-ens.network << 'EOF'
[Match]
Name=ens*

[Network]
Address=10.100.0.2/24
Gateway=10.100.0.1
DNS=8.8.8.8
DNS=114.114.114.114
EOF
```

**⚠️ 用 `Name=ens*` 通配匹配**，不同版本 CH 的 virtio-net 接口名可能是 `ens2`、`ens3`、`ens4`。

### 3.6 卸载并保存镜像

```bash
umount /data/ikun-cloud/build/rootfs-mnt/proc
umount /data/ikun-cloud/build/rootfs-mnt/sys
umount /data/ikun-cloud/build/rootfs-mnt/dev
umount /data/ikun-cloud/build/rootfs-mnt

mkdir -p /data/ikun-cloud/templates
cp /data/ikun-cloud/build/rootfs.raw /data/ikun-cloud/templates/debian12-custom.raw
```

### 3.7 验证镜像（必须！）

**⚠️ debootstrap 可能假成功**——被 OOM kill 或网络中断后仍可能输出 "DONE"，但 rootfs 是空的：

```bash
mkdir -p /tmp/check-tpl
mount -o loop /data/ikun-cloud/templates/debian12-custom.raw /tmp/check-tpl

# 检查关键文件
ls /tmp/check-tpl/bin/bash            # 必须存在
ls /tmp/check-tpl/sbin/init           # 必须存在
ls /tmp/check-tpl/usr/sbin/sshd       # 必须存在
ls -d /tmp/check-tpl/lib/modules/*    # 必须存在（见坑 13）

# 检查已安装包数量（应 > 100）
chroot /tmp/check-tpl dpkg -l | grep '^ii' | wc -l

# 检查镜像大小（应 > 500MB）
ls -lh /data/ikun-cloud/templates/debian12-custom.raw

umount /tmp/check-tpl
```

---

## 4. 内核选择

### 4.1 为什么不用 Debian 官方内核

| 内核 | PVH 支持 | 结果 |
|------|---------|------|
| Debian 官方 `linux-image-amd64` | ❌ 没有 `CONFIG_PVH` | triple-fault，无法启动 |
| PVM host 内核 | ❌ 是宿主机内核 | 不兼容 CH 虚拟硬件 |
| **CubeSandbox vmlinux-pvm** | ✅ PVM guest 内核 | ✅ 正常启动 |

### 4.2 内核与 rootfs 的关系

```
vmlinux-pvm (50MB)              rootfs.raw (含内核模块)
  ├── PVH 引导支持                ├── /bin, /sbin, /usr ...
  ├── virtio-blk 驱动 (built-in)  ├── systemd, sshd
  ├── virtio-net 驱动 (built-in)  ├── /lib/modules/6.x.x/
  └── ext4 文件系统驱动            └── root:ikun123456
```

内核通过 `--kernel` 直接加载，不需要 initramfs。但 **rootfs 里必须有 `/lib/modules/`**（见坑 13）。

---

## 5. 启动配置

### 5.1 CH 启动命令

```bash
cloud-hypervisor \
  --api-socket /tmp/ikun-vm-001.sock \
  --kernel /data/ikun-cloud/kernel/vmlinux-pvm \
  --disk path=/data/ikun-cloud/disks/vm-001.qcow2,readonly=off,backing_files=on,image_type=qcow2 \
  --disk path=/data/ikun-cloud/cloud-init/vm-001.iso,readonly=on \
  --cmdline 'console=ttyS0 root=/dev/vda rw' \
  --cpus boot=1 \
  --memory size=512M \
  --net tap=tap-vm-001,mac=02:xx:xx:xx:xx:xx,ip=10.100.0.2,mask=255.255.255.0 \
  --serial tty \
  --console off
```

### 5.2 关键参数说明

| 参数 | 值 | 说明 |
|------|-----|------|
| `--kernel` | `vmlinux-pvm` | PVM guest 内核（ELF 格式） |
| `--cmdline` | `root=/dev/vda rw` | ⚠️ 用 `/dev/vda` 不是 `/dev/vda1`（无分区表） |
| `backing_files=on` | 必须 | ⚠️ CH 默认禁用 qcow2 backing file |
| `image_type=qcow2` | 必须 | ⚠️ 不指定会自动覆盖 `backing_files` 设置 |
| `--serial tty` | 串口输出 | 用于查看启动日志 |
| `--console off` | 关闭 virtio-console | 减少设备开销 |

---

## 6. VM 管理

### 6.1 使用 JSON 配置文件创建

创建 `vm1.json`：

```json
{
  "name": "张三的小鸡",
  "template": "debian12-custom",
  "cpus": 2,
  "memory_mb": 1024,
  "disk_gb": 40,
  "ssh_port": 2201,
  "password": "mypassword123"
}
```

```bash
# 从配置文件创建
ikun-ctl create -f vm1.json

# 命令行参数覆盖 JSON
ikun-ctl create -f vm1.json --memory 2048 --name "改名了"

# 不用 JSON，直接命令行
ikun-ctl create --name my-vm --template debian12-custom --cpus 2 --memory 1024 --disk 40
```

**优先级**：命令行参数 > JSON 配置 > 默认值

### 6.2 常用命令

```bash
ikun-ctl create -f vm1.json           # 创建 VM
ikun-ctl start vm-001                 # 启动
ikun-ctl stop vm-001                  # 停止
ikun-ctl restart vm-001               # 重启
ikun-ctl destroy vm-001               # 删除
ikun-ctl list                         # 列出所有 VM
ikun-ctl status vm-001                # 查看状态（JSON）
ikun-ctl console vm-001               # 查看串口日志
ikun-ctl reset-password vm-001        # 重置密码
ikun-ctl reinstall vm-001             # 重装系统
```

### 6.3 连接 VM

```bash
ssh -p <ssh_port> root@<宿主公网IP>
# 密码：build-rootfs-v2.sh 中 ROOT_PASS 设置的值（默认 ikun123456）
```

---

## 7. 性能测试

VM 创建后可用以下工具测试性能：

### 7.1 磁盘 I/O

```bash
# 安装 fio
apt-get install -y fio

# 顺序读
fio --name=seq-read --rw=read --bs=1M --size=512M --numjobs=1 --runtime=30 --filename=/tmp/fio-test

# 顺序写
fio --name=seq-write --rw=write --bs=1M --size=512M --numjobs=1 --runtime=30 --filename=/tmp/fio-test

# 随机读写（模拟数据库）
fio --name=rand-rw --rw=randrw --bs=4k --size=256M --numjobs=4 --runtime=30 --filename=/tmp/fio-test
```

### 7.2 网络带宽

```bash
# 宿主机安装 iperf3 服务端
apt-get install -y iperf3
iperf3 -s -D

# VM 内安装 iperf3 客户端
apt-get install -y iperf3
iperf3 -c 10.100.0.1 -t 30
```

### 7.3 CPU 性能

```bash
# sysbench CPU
apt-get install -y sysbench
sysbench cpu --cpu-max-prime=20000 --threads=1 run

# 多线程
sysbench cpu --cpu-max-prime=20000 --threads=4 run
```



---

## 8. 网络架构

```
宿主机公网 IP
  │
  ├── iptables DNAT: 2201 → 10.100.0.2:22
  ├── iptables DNAT: 2202 → 10.100.0.3:22
  └── iptables MASQUERADE: 10.100.0.0/24 → 公网
  │
  └── ikun-br0 (bridge, 10.100.0.1/24)
       ├── tap-vm-001 → VM 1 (10.100.0.2)
       └── tap-vm-002 → VM 2 (10.100.0.3)
```

---

## 9. 踩坑记录

### 坑 1: qcow2 `MaxNestingDepthExceeded`

**现象**: `Maximum disk nesting depth exceeded`

**原因**: CH 默认 `backing_files=false`。

**解决**: 磁盘参数必须同时指定两个参数：

```bash
--disk path=vm.qcow2,readonly=off,backing_files=on,image_type=qcow2
```

⚠️ 只加 `backing_files=on` 不够！不指定 `image_type=qcow2` 会自动覆盖设置。

---

### 坑 2: `hypervisor-fw` EFI 引导崩溃

**现象**: `PANIC: panicked at 'assertion failed: status == Status::SUCCESS'`

**解决**: 放弃 EFI 固件引导，用 CubeSandbox 的 PVM guest 内核直接引导。

---

### 坑 3: Debian 内核 triple-fault

**现象**: `Guest likely triple-faulted` 反复出现。

**原因**: Debian 官方内核没有 `CONFIG_PVH=y`。

**解决**: 用 CubeSandbox 的 `vmlinux-pvm`。

---

### 坑 4: `root=/dev/vda1` 找不到根文件系统

**现象**: `VFS: Cannot open root device "/dev/vda1"`

**原因**: rootfs 是裸 ext4（无分区表），CH 暴露为 `/dev/vda` 而非 `/dev/vda1`。

**解决**: cmdline 用 `root=/dev/vda` 不是 `root=/dev/vda1`。

---

### 坑 5: `--api-socket` 已被占用

**现象**: `ApiSocketInUse("/tmp/ikun-vm-001.sock")`

**解决**:

```bash
pkill -9 -f cloud-hypervisor
rm -f /tmp/ikun-vm-*.sock
```

---

### 坑 6: 网络接口名不固定

**现象**: VM 内网络不通。

**原因**: 不同版本 CH 枚举顺序不同，接口名可能是 `ens2`、`ens3`、`ens4`。

**解决**: systemd-networkd 用 `Name=ens*` 通配匹配。

---

### 坑 7: debootstrap 假成功（镜像为空）

**现象**: VM 能启动但 virtio-net 不探测，网络完全不通。

**原因**: debootstrap 被 OOM kill 但脚本继续执行，rootfs 是空的（0 个包、没有 bash/init/sshd）。

**解决**: 先加 swap，构建后必须验证（见 3.7 节）。

---

### 坑 8: 不装内核包导致 virtio-net 不探测

**现象**: VM 能启动到 login，但 `grep virtio_net console.log` 无输出，网络不通。

**原因**: PVM guest 内核需要 `/lib/modules/` 目录才能正常 probe virtio-net 驱动，即使 `CONFIG_VIRTIO_NET=y`（built-in）。

**解决**: debootstrap `--include` 必须包含 `linux-image-amd64`。

---

### 坑 9: 所有 VM SSH 指纹相同

**现象**: 不同 VM 的 SSH 指纹一样。

**原因**: 所有 VM 共用基础镜像，SSH host key 是基础镜像里的。

**解决**: 添加 `regen-ssh-keys.service`（见 3.4 节）。

---

### 坑 10: iptables 规则重复累积

**现象**: `iptables -L` 看到几十条重复的 DNAT 规则。

**解决**: `ikun-ctl destroy` 会自动清理，或 `ikun-ctl init` 时重置。

---

### 坑 11: debootstrap 用国外源极慢

**解决**: 用阿里云镜像 `https://mirrors.aliyun.com/debian` 或清华镜像 `https://mirrors.tuna.tsinghua.edu.cn/debian`。

---

## 10. 服务器环境差异

不同云服务器的 PVM 环境可能有差异，以下是已知问题：

| 服务器 | 现象 | 原因 |
|--------|------|------|
| 某些阿里云实例 | virtio-net 不探测 | 底层 KVM/QEMU 实现差异，与 IOMMU 模式无关 |

**验证方法**：用已知可用的 rootfs 镜像在同一台服务器上测试，确认是服务器问题还是镜像问题。
