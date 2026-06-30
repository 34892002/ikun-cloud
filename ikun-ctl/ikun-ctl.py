#!/usr/bin/env python3
"""
ikun-ctl: ikun-cloud VPS 管理工具
基于 Cloud Hypervisor REST API 的轻量 VPS 管理 CLI
"""

import argparse
import hashlib
import json
import os
import random
import shutil
import signal
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

# ============================================================
# 配置常量
# ============================================================

DATA_DIR = Path("/data/ikun-cloud")
VMS_DIR = DATA_DIR / "vms"
DISKS_DIR = DATA_DIR / "disks"
IMAGES_DIR = DATA_DIR / "images"
CH_BINARY = "/usr/local/bin/cloud-hypervisor"
CH_REMOTE_BINARY = "/usr/local/bin/ch-remote"

# 网络配置
BRIDGE_NAME = "ikun-br0"
BRIDGE_SUBNET = "10.100.0"
BRIDGE_IP = f"{BRIDGE_SUBNET}.1"
BRIDGE_MASK = "255.255.255.0"
DNS_SERVERS = "8.8.8.8,114.114.114.114"

# VM 默认配置
DEFAULT_CPUS = 1
DEFAULT_MEMORY_MB = 512
DEFAULT_DISK_GB = 20
DEFAULT_SSH_PORT_BASE = 2200


# ============================================================
# 工具函数
# ============================================================

def run(cmd, check=True, capture=False):
    """执行 shell 命令"""
    print(f"  $ {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=capture, text=True)
    if check and result.returncode != 0:
        stderr = result.stderr.strip() if capture else ""
        print(f"  ERROR: {stderr}")
        sys.exit(1)
    return result


def kill_by_socket(sock_path):
    """优雅终止所有使用指定 socket 的 CH 进程（三步走）"""
    if not sock_path:
        return 0

    # 找到所有匹配的 CH 进程
    result = subprocess.run(
        f"pgrep -f '{CH_BINARY}.*{sock_path}'",
        shell=True, capture_output=True, text=True
    )
    pids = [int(p) for p in result.stdout.strip().split() if p]
    if not pids:
        return 0

    # 第一步：SIGTERM（允许 Rust Drop 析构清理 socket）
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    # 第二步：轮询等待进程退出，最多 5 秒
    for _ in range(5):
        alive = [p for p in pids if os.path.exists(f"/proc/{p}")]
        if not alive:
            break
        time.sleep(1)
    else:
        # 超时：SIGKILL 强杀
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(1)

    # 第三步：无条件清理 socket 文件（不管进程是否正常退出）
    if sock_path and os.path.exists(sock_path):
        os.remove(sock_path)

    return len(pids)


def cleanup_vm(vm_id, config, level="process"):
    """
    统一清理 VM 资源
    level:
      process - 杀 CH 进程 + 清 socket（stop / resize 用）
      network - + 删 TAP + 清 iptables 规则（destroy 用）
      all     - + 删磁盘 + 删配置目录（destroy 用）
    """
    sock = config.get("api_socket", api_socket_path(vm_id))
    ip = config.get("ip", "")

    # 1. 杀进程 + 清 socket（三步走：SIGTERM → 等待 → SIGKILL → 删 socket）
    n = kill_by_socket(sock)
    if n:
        print(f"  已终止 {n} 个残留进程")

    if level == "process":
        return

    # 2. 删 TAP
    delete_tap(vm_id)

    # 3. 清 iptables（按 IP 清空所有规则）
    if ip:
        remove_port_forward(config.get("ssh_port", 0), ip)
        # 清除所有到该 IP 的残留规则
        for chain, table in [("PREROUTING", "nat"), ("FORWARD", "filter")]:
            result = subprocess.run(
                f"iptables -t {table} -S {chain}",
                shell=True, capture_output=True, text=True
            )
            for line in result.stdout.split("\n"):
                if ip in line:
                    del_args = line.replace("^-A", "-D").strip().split()
                    subprocess.run(
                        ["iptables", "-t", table] + del_args,
                        capture_output=True
                    )

    if level == "network":
        return

    # 4. 删磁盘
    disk_path = config.get("disk_path", "")
    if disk_path and os.path.exists(disk_path):
        os.remove(disk_path)
        print(f"  磁盘已删除: {disk_path}")

    # 5. 删配置目录
    vm_dir = VMS_DIR / vm_id
    if vm_dir.exists():
        shutil.rmtree(vm_dir)
        print(f"  配置目录已删除")


def api_socket_path(vm_id):
    return f"/tmp/ikun-{vm_id}.sock"


def api_request(vm_id, method, endpoint, data=None):
    """调用 CH REST API"""
    sock_path = api_socket_path(vm_id)
    if not os.path.exists(sock_path):
        return None, "API socket not found"

    url = f"http://localhost/api/v1{endpoint}"
    cmd = ['curl', '-s', '-X', method, '--unix-socket', sock_path, url]
    if data:
        cmd.extend(['-H', 'Content-Type: application/json', '-d', json.dumps(data)])

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    try:
        resp = json.loads(result.stdout) if result.stdout.strip() else None
    except json.JSONDecodeError:
        resp = result.stdout.strip()
    return resp, None


def vmm_ping():
    """检查 VMM 是否运行"""
    sock_path = "/tmp/ikun-vmm.sock"
    if not os.path.exists(sock_path):
        return False
    result = subprocess.run(
        ['curl', '-s', '-X', 'PUT', '--unix-socket', sock_path,
         'http://localhost/api/v1/vmm.ping'],
        capture_output=True, text=True, timeout=5
    )
    return result.returncode == 0


def generate_mac():
    """生成随机 MAC 地址"""
    return "02:%02x:%02x:%02x:%02x:%02x" % tuple(random.randint(0, 255) for _ in range(5))


def generate_password(length=12):
    """生成随机密码"""
    chars = "abcdefghjkmnpqrstuvwxyz23456789"
    return ''.join(random.choice(chars) for _ in range(length))


def next_vm_id():
    """生成下一个 VM ID（vm-xxxxx 格式，5位小写字母数字）"""
    import secrets
    import string
    alphabet = string.ascii_lowercase + string.digits
    while True:
        vm_id = "vm-" + "" .join(secrets.choice(alphabet) for _ in range(5))
        if not (VMS_DIR / vm_id).exists():
            return vm_id


def next_ssh_port():
    """分配下一个 SSH 端口"""
    used_ports = set()
    for vm_dir in VMS_DIR.iterdir():
        cfg_file = vm_dir / "config.json"
        if cfg_file.exists():
            cfg = json.loads(cfg_file.read_text())
            used_ports.add(cfg.get("ssh_port", 0))
    port = DEFAULT_SSH_PORT_BASE + 1
    while port in used_ports:
        port += 1
    return port


def next_ip():
    """分配下一个内网 IP"""
    used_ips = set()
    for vm_dir in VMS_DIR.iterdir():
        cfg_file = vm_dir / "config.json"
        if cfg_file.exists():
            cfg = json.loads(cfg_file.read_text())
            used_ips.add(cfg.get("ip", ""))
    host = 2
    while f"{BRIDGE_SUBNET}.{host}" in used_ips:
        host += 1
    return f"{BRIDGE_SUBNET}.{host}"


def load_vm_config(vm_id):
    """加载 VM 配置"""
    cfg_file = VMS_DIR / vm_id / "config.json"
    if not cfg_file.exists():
        print(f"VM {vm_id} 不存在")
        sys.exit(1)
    return json.loads(cfg_file.read_text())


def save_vm_config(vm_id, config):
    """保存 VM 配置"""
    vm_dir = VMS_DIR / vm_id
    vm_dir.mkdir(parents=True, exist_ok=True)
    (vm_dir / "config.json").write_text(json.dumps(config, indent=2, ensure_ascii=False))


# ============================================================
# 网络管理
# ============================================================

def init_network():
    """初始化网络（bridge + iptables）"""
    print("[*] 初始化网络...")

    # 创建 bridge
    if run(f"ip link show {BRIDGE_NAME}", check=False, capture=True).returncode != 0:
        run(f"ip link add {BRIDGE_NAME} type bridge")
    run(f"ip addr add {BRIDGE_IP}/24 dev {BRIDGE_NAME}", check=False, capture=True)
    run(f"ip link set {BRIDGE_NAME} up")

    # 开启转发
    run("echo 1 > /proc/sys/net/ipv4/ip_forward")

    # NAT 出网（如果不存在则添加）
    run(f"iptables -t nat -C POSTROUTING -s {BRIDGE_SUBNET}.0/24 -j MASQUERADE 2>/dev/null || "
        f"iptables -t nat -A POSTROUTING -s {BRIDGE_SUBNET}.0/24 -j MASQUERADE",
        check=False, capture=True)

    print(f"  Bridge {BRIDGE_NAME} 已就绪: {BRIDGE_IP}/24")


def create_tap(vm_id):
    """创建 TAP 设备并加入 bridge"""
    tap_name = f"tap-{vm_id}"
    # 清理旧 TAP
    run(f"ip link del {tap_name}", check=False, capture=True)
    run(f"ip tuntap add dev {tap_name} mode tap")
    run(f"ip link set {tap_name} master {BRIDGE_NAME}")
    run(f"ip link set {tap_name} up")
    return tap_name


def delete_tap(vm_id):
    """删除 TAP 设备"""
    tap_name = f"tap-{vm_id}"
    run(f"ip link del {tap_name}", check=False, capture=True)


def add_port_forward(ssh_port, vm_ip):
    """添加端口映射（幂等：已存在则跳过）"""
    # 检查是否已存在
    check = subprocess.run(
        f"iptables -t nat -C PREROUTING -p tcp --dport {ssh_port} -j DNAT --to {vm_ip}:22",
        shell=True, capture_output=True
    )
    if check.returncode == 0:
        return  # 已存在
    run(f"iptables -t nat -A PREROUTING -p tcp --dport {ssh_port} -j DNAT --to {vm_ip}:22",
        check=False, capture=True)
    run(f"iptables -A FORWARD -p tcp -d {vm_ip} --dport 22 -j ACCEPT",
        check=False, capture=True)


def remove_port_forward(ssh_port, vm_ip):
    """移除端口映射"""
    run(f"iptables -t nat -D PREROUTING -p tcp --dport {ssh_port} -j DNAT --to {vm_ip}:22",
        check=False, capture=True)
    run(f"iptables -D FORWARD -p tcp -d {vm_ip} --dport 22 -j ACCEPT",
        check=False, capture=True)


# ============================================================
# 磁盘管理
# ============================================================

def import_image(name, source_path):
    """导入基础镜像"""
    print(f"[*] 导入镜像: {name}")
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    dest = IMAGES_DIR / f"{name}.raw"

    if dest.exists():
        print(f"  镜像 {name} 已存在，覆盖")
        dest.unlink()

    # 如果是 qcow2 先转换
    if source_path.endswith(".qcow2") or source_path.endswith(".img"):
        print(f"  转换 qcow2 -> raw ...")
        run(f"qemu-img convert -p -f qcow2 -O raw {source_path} {dest}")
    else:
        shutil.copy2(source_path, dest)

    print(f"  镜像已保存: {dest}")
    print(f"  大小: {dest.stat().st_size / (1024**3):.1f} GB")


def create_vm_disk(vm_id, image_name, disk_gb):
    """基于基础镜像创建 VM 磁盘（qcow2 copy-on-write，厚分配）"""
    DISKS_DIR.mkdir(parents=True, exist_ok=True)
    image_path = IMAGES_DIR / f"{image_name}.raw"
    if not image_path.exists():
        print(f"镜像 {image_name} 不存在")
        sys.exit(1)

    disk_path = DISKS_DIR / f"{vm_id}.qcow2"
    size = f"{disk_gb}G"

    # 创建 qcow2 镜像，基于基础镜像作为 backing file
    run(f"qemu-img create -f qcow2 -b {image_path} -F raw {disk_path} {size}")

    # 注意：不要用 qemu-img -o preallocation=falloc 替代下面的 fallocate！
    # preallocation=falloc 必须配合 extended_l2=on，但当前 CH 版本不支持 extended_l2，
    # 会报错：Unsupported qcow2 feature(s): extended L2 entries
    run(f"fallocate -l {disk_gb}G {disk_path}")

    return str(disk_path)


# ============================================================
# 磁盘配置（direct 方式）
# ============================================================

def provision_disk(disk_path, ip, password):
    """直接挂载磁盘，写入网络配置、密码和扩容服务"""
    import subprocess as sp
    import time as _time

    mount_point = f"/tmp/provision-{os.getpid()}"
    run(f"mkdir -p {mount_point}")
    run(f"qemu-nbd --connect=/dev/nbd0 {disk_path}")
    _time.sleep(1)
    run(f"mount /dev/nbd0 {mount_point}")

    # 设置密码（通过 chroot + chpasswd）
    run(f"chroot {mount_point} /bin/bash -c 'echo root:{password} | chpasswd'")

    # 验证密码确实写入成功
    verify = subprocess.run(
        f"chroot {mount_point} /bin/bash -c 'getent shadow root'",
        shell=True, capture_output=True, text=True
    )
    if verify.returncode != 0:
        print("  ERROR: 密码验证失败，getent shadow 无法读取")
        sys.exit(1)
    shadow_fields = verify.stdout.strip().split(":")
    pwd_hash = shadow_fields[1] if len(shadow_fields) > 1 else ""
    if not pwd_hash or pwd_hash in ("*", "!", "!!"):
        print(f"  ERROR: 密码验证失败，shadow hash 异常: {pwd_hash}")
        sys.exit(1)
    print(f"  密码已设置并验证通过")

    # 写入网络配置
    network_conf = f"""[Match]
Name=ens*

[Network]
Address={ip}/24
Gateway={BRIDGE_IP}
DNS=8.8.8.8
DNS=114.114.114.114
"""
    net_file = Path(mount_point) / "etc/systemd/network/10-ens.network"
    net_file.write_text(network_conf)
    print(f"  网络配置已写入")

    # 确保 SSH 允许 root 登录和密码认证
    sshd_config = Path(mount_point) / "etc/ssh/sshd_config"
    if sshd_config.exists():
        content = sshd_config.read_text()
        # 确保 PermitRootLogin yes 存在
        if "PermitRootLogin yes" not in content:
            content += "\nPermitRootLogin yes\n"
        # 确保 PasswordAuthentication yes 存在
        if "PasswordAuthentication yes" not in content:
            content += "\nPasswordAuthentication yes\n"
        sshd_config.write_text(content)
        print(f"  SSH 配置已更新")

    # 写入首次启动扩容服务
    svc_path = Path(mount_point) / "etc/systemd/system/first-boot-resize.service"
    svc_path.write_text("""[Unit]
Description=Resize filesystem to fill disk on first boot
After=local-fs.target
ConditionPathExists=!/var/lib/first-boot-resize-done

[Service]
Type=oneshot
ExecStart=/sbin/resize2fs /dev/vda
ExecStartPost=/bin/touch /var/lib/first-boot-resize-done
ExecStartPost=/bin/systemctl disable first-boot-resize.service
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
""")
    wants_dir = Path(mount_point) / "etc/systemd/system/multi-user.target.wants"
    wants_dir.mkdir(parents=True, exist_ok=True)
    link_path = wants_dir / "first-boot-resize.service"
    try:
        link_path.symlink_to(svc_path)
    except FileExistsError:
        pass
    print(f"  扩容服务已写入")

    # 安全卸载流程
    run(f"umount -f {mount_point}", check=False)
    sp.run(["sync"])
    _time.sleep(2)
    sp.run(["blockdev", "--flushbufs", "/dev/nbd0"], check=False)
    _time.sleep(1)
    run("qemu-nbd --disconnect /dev/nbd0", check=False)
    _time.sleep(1)
    run(f"rm -rf {mount_point}", check=False)


# ============================================================
# VM 生命周期
# ============================================================

def cmd_init(args):
    """初始化宿主机"""
    print("=" * 50)
    print("  ikun-cloud 宿主机初始化")
    print("=" * 50)

    # 创建目录
    for d in [DATA_DIR, VMS_DIR, DISKS_DIR, IMAGES_DIR]:
        d.mkdir(parents=True, exist_ok=True)
        print(f"  目录就绪: {d}")

    # 初始化网络
    init_network()

    # 安装依赖（工具名 -> 包名）
    deps = {
        "qemu-img": "qemu-utils",
        "genisoimage": "genisoimage",
        "curl": "curl",
        "ip": "iproute2",
        "iptables": "iptables",
    }
    print("[*] 检查依赖...")
    for tool, pkg in deps.items():
        result = run(f"which {tool}", check=False, capture=True)
        if result.returncode != 0:
            print(f"  缺少: {tool}，安装 {pkg}...")
            run(f"apt-get install -y -qq {pkg} 2>/dev/null || yum install -y -q {pkg} 2>/dev/null",
                check=False)

    print("\n[+] 初始化完成!")


def cmd_image(args):
    """镜像管理"""
    if args.image_cmd == "import":
        import_image(args.name, args.source)
    elif args.image_cmd == "list":
        if not IMAGES_DIR.exists():
            print("暂无镜像")
            return
        print(f"{'镜像名':<20} {'大小':<10} {'路径'}")
        print("-" * 60)
        for f in sorted(IMAGES_DIR.iterdir()):
            if f.suffix == ".raw":
                size_gb = f.stat().st_size / (1024**3)
                print(f"{f.stem:<20} {size_gb:<10.1f}G {f}")
    elif args.image_cmd == "remove":
        target = IMAGES_DIR / f"{args.name}.raw"
        if target.exists():
            target.unlink()
            print(f"镜像 {args.name} 已删除")
        else:
            print(f"镜像 {args.name} 不存在")


def load_vm_json(file_path):
    """从 JSON 文件加载 VM 配置"""
    path = Path(file_path)
    if not path.exists():
        print(f"错误: 配置文件不存在: {file_path}")
        sys.exit(1)
    try:
        with open(path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"错误: JSON 格式错误: {e}")
        sys.exit(1)
    # 验证字段类型
    int_fields = {"cpus": int, "memory_mb": int, "disk_gb": int, "ssh_port": int}
    for field, typ in int_fields.items():
        if field in data and not isinstance(data[field], typ):
            print(f"错误: {field} 必须是整数")
            sys.exit(1)
    return data


def cmd_create(args):
    """创建 VM"""
    # 加载 JSON 配置（如果指定）
    json_cfg = {}
    if args.file:
        json_cfg = load_vm_json(args.file)

    # 合并配置：命令行参数 > JSON 配置 > 默认值
    vm_id = next_vm_id()
    name = args.name or json_cfg.get("name", vm_id)
    base_image = args.base_image or json_cfg.get("base_image")
    if not base_image:
        print("错误: 必须指定基础镜像 (--base-image 或 JSON 中的 base_image)")
        sys.exit(1)
    cpus = args.cpus or json_cfg.get("cpus", DEFAULT_CPUS)
    memory = args.memory or json_cfg.get("memory_mb", DEFAULT_MEMORY_MB)
    disk_gb = args.disk or json_cfg.get("disk_gb", DEFAULT_DISK_GB)
    ssh_port = args.ssh_port or json_cfg.get("ssh_port") or next_ssh_port()
    password = args.password or json_cfg.get("password") or generate_password()
    ip = next_ip()
    mac = generate_mac()

    print(f"[*] 创建 VM: {vm_id}")
    print(f"  名称: {name}")
    print(f"  镜像: {base_image}")
    print(f"  配置: {cpus}C / {memory}MB / {disk_gb}GB")
    print(f"  IP: {ip}  SSH端口: {ssh_port}")

    # 1. 创建磁盘
    print("[*] 创建磁盘...")
    disk_path = create_vm_disk(vm_id, base_image, disk_gb)

    # 2. 创建 TAP
    print("[*] 创建网络...")
    tap_name = create_tap(vm_id)

    # 3. 添加端口映射
    add_port_forward(ssh_port, ip)

    # 4. 直接配置磁盘（写入网络配置和密码）
    print("[*] 配置磁盘...")
    provision_disk(disk_path, ip, password)

    # 4.5 清理宿主机 known_hosts 中的旧指纹（VM 重建时 IP 可能重复）
    subprocess.run(
        ['ssh-keygen', '-R', ip],
        capture_output=True, text=True
    )

    # 5. 保存配置
    config = {
        "id": vm_id,
        "name": name,
        "status": "stopped",
        "cpus": cpus,
        "memory_mb": memory,
        "disk_gb": disk_gb,
        "disk_path": disk_path,
        "base_image": base_image,
        "ip": ip,
        "mac": mac,
        "tap": tap_name,
        "ssh_port": ssh_port,
        "password": password,
        "api_socket": api_socket_path(vm_id),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    save_vm_config(vm_id, config)

    print(f"\n[+] VM {vm_id} 创建成功!")
    print(f"  名称: {config['name']}")
    print(f"  SSH: ssh -p {ssh_port} root@<宿主公网IP>")
    print(f"  密码: {password}")
    print(f"  API: {config['api_socket']}")


def cmd_start(args):
    """启动 VM"""
    vm_id = args.vm_id
    config = load_vm_config(vm_id)

    if config["status"] == "running":
        # 检查进程是否真的活着
        sock = config.get("api_socket", api_socket_path(vm_id))
        proc_alive = False
        if sock and os.path.exists(sock):
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(1)
                s.connect(sock)
                s.close()
                proc_alive = True
            except (ConnectionRefusedError, FileNotFoundError, OSError):
                pass
        if proc_alive:
            print(f"VM {vm_id} 已在运行")
            return
        print(f"[!] VM {vm_id} 进程已退出，重新启动...")
        config["status"] = "stopped"
        save_vm_config(vm_id, config)

    print(f"[*] 启动 VM: {vm_id}")

    # 防御性 socket 清理（方案 3：先探测再处理）
    sock = config.get("api_socket", api_socket_path(vm_id))
    if sock and os.path.exists(sock):
        alive = False
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(1)
            s.connect(sock)
            s.close()
            alive = True
        except (ConnectionRefusedError, FileNotFoundError, OSError):
            pass

        if alive:
            # socket 还活着 = 旧进程还在，先清理
            print(f"  检测到残留进程，清理中...")
            kill_by_socket(sock)
        else:
            # socket 是死文件，直接删
            os.remove(sock)
            print(f"  清理残留 socket")

    # 确保 TAP 存在
    tap_name = config["tap"]
    if run(f"ip link show {tap_name}", check=False, capture=True).returncode != 0:
        create_tap(vm_id)

    # 确保端口映射
    add_port_forward(config["ssh_port"], config["ip"])

    # 构造 CH 命令（直接内核引导）
    kernel_dir = "/data/ikun-cloud/kernel"
    cmd_parts = [
        CH_BINARY,
        f"--api-socket {config['api_socket']}",
        f"--kernel {kernel_dir}/vmlinux-pvm",
        f"--disk path={config['disk_path']},readonly=off,backing_files=on,image_type=qcow2",
        "--cmdline 'console=ttyS0 root=/dev/vda rw'",
        f"--cpus boot={config['cpus']}",
        f"--memory size={config['memory_mb']}M",
        f"--net tap={tap_name},mac={config['mac']},ip={config['ip']},mask={config['mask'] if 'mask' in config else BRIDGE_MASK}",
        "--serial tty",
        "--console off",
    ]

    # 过滤空参数
    cmd_str = " ".join(p for p in cmd_parts if p)

    # 后台启动
    log_file = VMS_DIR / vm_id / "console.log"
    print(f"  日志: {log_file}")
    proc = subprocess.Popen(
        cmd_str, shell=True,
        stdout=open(log_file, "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True
    )

    # 等待 API 就绪
    for i in range(10):
        time.sleep(1)
        if os.path.exists(config["api_socket"]):
            break

    # 查找真正的 cloud-hypervisor 进程 PID（过滤掉 bash wrapper）
    ch_pid = ""
    try:
        result = subprocess.run(
            ["pgrep", "-f", f"cloud-hypervisor.*{config['api_socket']}"],
            capture_output=True, text=True
        )
        for pid_str in result.stdout.strip().split("\n"):
            pid_str = pid_str.strip()
            if not pid_str:
                continue
            try:
                with open(f"/proc/{pid_str}/comm") as f:
                    if f.read().strip().startswith("cloud-hyperviso"):
                        ch_pid = pid_str
                        break
            except (FileNotFoundError, IOError):
                continue
    except Exception:
        pass

    config["status"] = "running"
    config["pid"] = ch_pid
    save_vm_config(vm_id, config)

    print(f"[+] VM {vm_id} 已启动 (PID: {config.get('pid', '?')})")


def cmd_stop(args):
    """停止 VM"""
    vm_id = args.vm_id
    config = load_vm_config(vm_id)

    if config["status"] != "running":
        cleanup_vm(vm_id, config, "process")
        print(f"VM {vm_id} 未运行")
        return

    print(f"[*] 停止 VM: {vm_id}")

    # 尝试优雅关闭
    api_request(vm_id, "PUT", "/vm.shutdown")

    # 清理进程 + socket
    cleanup_vm(vm_id, config, "process")

    config["status"] = "stopped"
    config.pop("pid", None)
    save_vm_config(vm_id, config)
    print(f"[+] VM {vm_id} 已停止")


def cmd_restart(args):
    """重启 VM"""
    vm_id = args.vm_id
    config = load_vm_config(vm_id)

    if config["status"] != "running":
        print(f"VM {vm_id} 未运行，尝试启动...")
        cmd_start(args)
        return

    print(f"[*] 重启 VM: {vm_id}")
    resp, err = api_request(vm_id, "PUT", "/vm.reboot")
    if err:
        print(f"  API 错误: {err}")
    else:
        print(f"[+] VM {vm_id} 重启中")


def cmd_destroy(args):
    """删除 VM"""
    vm_id = args.vm_id
    config = load_vm_config(vm_id)

    print(f"[*] 删除 VM: {vm_id}")

    # 尝试优雅关闭
    if config["status"] == "running":
        api_request(vm_id, "PUT", "/vm.shutdown")

    # 全量清理：进程 + socket + TAP + iptables + 磁盘 + 配置
    cleanup_vm(vm_id, config, "all")

    print(f"[+] VM {vm_id} 已删除")


def cmd_list(args):
    """列出所有 VM"""
    if not VMS_DIR.exists():
        print("暂无 VM")
        return

    print(f"{'ID':<10} {'名称':<15} {'状态':<8} {'配置':<12} {'IP':<16} {'SSH端口':<8} {'密码'}")
    print("-" * 90)

    for vm_dir in sorted(VMS_DIR.iterdir()):
        cfg_file = vm_dir / "config.json"
        if not cfg_file.exists():
            continue
        cfg = json.loads(cfg_file.read_text())
        real_status = get_real_status(cfg)
        cfg["status"] = real_status
        save_vm_config(cfg["id"], cfg)
        status = "🟢运行" if real_status == "running" else "🔴停止"
        spec = f"{cfg['cpus']}C/{cfg['memory_mb']}M/{cfg['disk_gb']}G"
        print(f"{cfg['id']:<10} {cfg['name']:<15} {status:<8} {spec:<12} {cfg['ip']:<16} {cfg['ssh_port']:<8} {cfg['password']}")


def get_real_status(cfg):
    """检查 VM 真实状态：config 状态 + 进程存活"""
    if cfg.get("status") != "running":
        return cfg.get("status", "stopped")

    # 检查 socket 是否可连接
    sock = cfg.get("api_socket", "")
    if sock and os.path.exists(sock):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(1)
            s.connect(sock)
            s.close()
            return "running"
        except (ConnectionRefusedError, FileNotFoundError, OSError):
            pass

    return "stopped"


def cmd_status(args):
    """查看 VM 状态"""
    config = load_vm_config(args.vm_id)
    print(json.dumps(config, indent=2, ensure_ascii=False))


def cmd_console(args):
    """连接 VM 控制台"""
    config = load_vm_config(args.vm_id)
    if config["status"] != "running":
        print(f"VM {args.vm_id} 未运行")
        return

    log_file = VMS_DIR / args.vm_id / "console.log"
    print(f"[*] 连接控制台 (Ctrl+C 退出)...日志: {log_file}")
    os.system(f"tail -f {log_file}")


def cmd_reset_password(args):
    """重置 VM 密码"""
    vm_id = args.vm_id
    config = load_vm_config(vm_id)
    new_password = args.password or generate_password()

    # 直接修改磁盘中的密码
    provision_disk(config["disk_path"], config["ip"], new_password)

    config["password"] = new_password
    save_vm_config(vm_id, config)

    print(f"[+] VM {vm_id} 密码已重置: {new_password}")
    print(f"  需要重启 VM 生效: ikun-ctl restart {vm_id}")


def cmd_reinstall(args):
    """重装 VM 系统"""
    vm_id = args.vm_id
    config = load_vm_config(vm_id)
    base_image = args.base_image or config["base_image"]
    new_password = args.password or generate_password()

    was_running = config["status"] == "running"
    if was_running:
        cmd_stop(args)

    # 重新加载 config（cmd_stop 会更新状态）
    config = load_vm_config(vm_id)

    # 删除旧磁盘
    if os.path.exists(config["disk_path"]):
        os.remove(config["disk_path"])

    # 创建新磁盘
    disk_path = create_vm_disk(vm_id, base_image, config["disk_gb"])
    provision_disk(disk_path, config["ip"], new_password)

    # 清理宿主机 known_hosts 中的旧指纹（重装会重新生成 SSH host key）
    subprocess.run(['ssh-keygen', '-R', config['ip']], capture_output=True, text=True)

    config["disk_path"] = disk_path
    config["base_image"] = base_image
    config["password"] = new_password
    save_vm_config(vm_id, config)

    print(f"[+] VM {vm_id} 已重装 (镜像: {base_image})")
    print(f"  新密码: {new_password}")

    if was_running:
        cmd_start(args)


def cmd_resize(args):
    """修改 VM 配置（CPU/内存/磁盘）— 运行中会自动重启"""
    vm_id = args.vm_id
    config = load_vm_config(vm_id)

    new_cpus = args.cpus
    new_memory = args.memory
    new_disk = args.disk

    if not new_cpus and not new_memory and not new_disk:
        print("错误: 至少指定一个参数 (--cpus / --memory / --disk)")
        sys.exit(1)

    # 磁盘只能升不能降
    if new_disk is not None:
        if new_disk < config["disk_gb"]:
            print(f"错误: 磁盘只能扩大不能缩小 (当前 {config['disk_gb']}GB，请求 {new_disk}GB)")
            sys.exit(1)
        if new_disk == config["disk_gb"]:
            new_disk = None

    # 检查是否有实际变化
    cpus_changed = new_cpus is not None and new_cpus != config["cpus"]
    mem_changed = new_memory is not None and new_memory != config["memory_mb"]
    disk_changed = new_disk is not None

    if not cpus_changed and not mem_changed and not disk_changed:
        print("没有需要修改的配置")
        return

    was_running = config["status"] == "running"

    print(f"[*] 修改 VM {vm_id} 配置")

    # 运行中的 VM 需要先停机
    if was_running:
        print("  [!] 停机修改配置...")
        cmd_stop(args)
        # cmd_stop 有自己的 config 副本，重新加载最新状态
        config = load_vm_config(vm_id)

    # 磁盘扩容
    if disk_changed:
        print(f"  磁盘: {config['disk_gb']}GB -> {new_disk}GB")
        run(f"qemu-img resize {config['disk_path']} {new_disk}G")
        config["disk_gb"] = new_disk

    # CPU
    if cpus_changed:
        print(f"  CPU: {config['cpus']} -> {new_cpus}")
        config["cpus"] = new_cpus

    # 内存
    if mem_changed:
        print(f"  内存: {config['memory_mb']}MB -> {new_memory}MB")
        config["memory_mb"] = new_memory

    # 保存配置
    save_vm_config(vm_id, config)
    print(f"  当前: {config['cpus']}C / {config['memory_mb']}MB / {config['disk_gb']}GB")

    # 重启
    if was_running:
        print("  重启 VM...")
        cmd_start(args)

    print(f"[+] VM {vm_id} 配置更新完成")



# ============================================================
# VMM 管理（CH 实例级别）
# ============================================================

def cmd_vmm_start(args):
    """启动 VMM（CH 实例）"""
    sock = "/tmp/ikun-vmm.sock"
    if os.path.exists(sock):
        os.remove(sock)

    print("[*] 启动 Cloud Hypervisor VMM...")
    subprocess.Popen(
        f"{CH_BINARY} --api-socket {sock}",
        shell=True,
        stdout=open("/var/log/ikun-vmm.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True
    )

    for i in range(10):
        time.sleep(1)
        if os.path.exists(sock):
            break

    print(f"[+] VMM 已启动, socket: {sock}")


def cmd_vmm_stop(args):
    """停止 VMM"""
    sock = "/tmp/ikun-vmm.sock"
    if not os.path.exists(sock):
        print("VMM 未运行")
        return

    # 停止所有 VM
    if VMS_DIR.exists():
        for vm_dir in VMS_DIR.iterdir():
            cfg_file = vm_dir / "config.json"
            if cfg_file.exists():
                cfg = json.loads(cfg_file.read_text())
                if cfg["status"] == "running":
                    print(f"  停止 VM: {cfg['id']}")
                    try:
                        api_request(cfg["id"], "PUT", "/vm.shutdown")
                    except Exception:
                        pass

    time.sleep(2)
    run(f"pkill -f '{CH_BINARY}.*{sock}'", check=False)
    os.remove(sock) if os.path.exists(sock) else None
    print("[+] VMM 已停止")


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        prog="ikun-ctl",
        description="ikun-cloud VPS 管理工具"
    )
    sub = parser.add_subparsers(dest="command")

    # init
    sub.add_parser("init", help="初始化宿主机")

    # image
    img = sub.add_parser("image", help="镜像管理")
    img_sub = img.add_subparsers(dest="image_cmd")
    img_import = img_sub.add_parser("import", help="导入镜像")
    img_import.add_argument("name", help="镜像名称")
    img_import.add_argument("source", help="源镜像路径")
    img_sub.add_parser("list", help="列出镜像")
    img_remove = img_sub.add_parser("remove", help="删除镜像")
    img_remove.add_argument("name", help="镜像名称")

    # create
    crt = sub.add_parser("create", help="创建 VM")
    crt.add_argument("--name", help="VM 名称")
    crt.add_argument("--base-image", help="基础镜像名称 (可从 JSON 文件读取)")
    crt.add_argument("--cpus", type=int, help=f"CPU 数量 (默认 {DEFAULT_CPUS})")
    crt.add_argument("--memory", type=int, help=f"内存 MB (默认 {DEFAULT_MEMORY_MB})")
    crt.add_argument("--disk", type=int, help=f"磁盘 GB (默认 {DEFAULT_DISK_GB})")
    crt.add_argument("--ssh-port", type=int, help="SSH 端口 (自动分配)")
    crt.add_argument("--password", help="root 密码 (自动生成)")
    crt.add_argument("-f", "--file", help="从 JSON 配置文件创建")

    # start/stop/restart/destroy/status/console/reset-password/reinstall
    for cmd_name in ["start", "stop", "restart", "destroy", "status", "console"]:
        p = sub.add_parser(cmd_name, help=f"{cmd_name} VM")
        p.add_argument("vm_id", help="VM ID (如 vm-001)")

    rpw = sub.add_parser("reset-password", help="重置 VM 密码")
    rpw.add_argument("vm_id")
    rpw.add_argument("--password", help="新密码 (自动生成)")

    ri = sub.add_parser("reinstall", help="重装 VM 系统")
    ri.add_argument("vm_id")
    ri.add_argument("--base-image", help="新镜像 (默认用原镜像)")
    ri.add_argument("--password", help="新密码 (留空随机生成)")

    # resize
    rz = sub.add_parser("resize", help="修改 VM 配置")
    rz.add_argument("vm_id")
    rz.add_argument("--cpus", type=int, help="CPU 数量")
    rz.add_argument("--memory", type=int, help="内存 MB")
    rz.add_argument("--disk", type=int, help="磁盘 GB (只能扩大)")

    # list
    sub.add_parser("list", help="列出所有 VM")

    # vmm
    vmm = sub.add_parser("vmm", help="VMM 管理")
    vmm_sub = vmm.add_subparsers(dest="vmm_cmd")
    vmm_sub.add_parser("start", help="启动 VMM")
    vmm_sub.add_parser("stop", help="停止 VMM")

    args = parser.parse_args()

    if args.command == "init":
        cmd_init(args)
    elif args.command == "image":
        if args.image_cmd == "import":
            cmd_image(args)
        elif args.image_cmd == "list":
            cmd_image(args)
        elif args.image_cmd == "remove":
            cmd_image(args)
        else:
            parser.print_help()
    elif args.command == "create":
        cmd_create(args)
    elif args.command == "start":
        cmd_start(args)
    elif args.command == "stop":
        cmd_stop(args)
    elif args.command == "restart":
        cmd_restart(args)
    elif args.command == "destroy":
        cmd_destroy(args)
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "console":
        cmd_console(args)
    elif args.command == "reset-password":
        cmd_reset_password(args)
    elif args.command == "reinstall":
        cmd_reinstall(args)
    elif args.command == "resize":
        cmd_resize(args)
    elif args.command == "vmm":
        if args.vmm_cmd == "start":
            cmd_vmm_start(args)
        elif args.vmm_cmd == "stop":
            cmd_vmm_stop(args)
        else:
            parser.print_help()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
