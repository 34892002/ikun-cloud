# ikun-cloud

> 基于 Cloud Hypervisor v52.0 + PVM 内核的轻量 VPS 管理面板，在普通云服务器上“切小鸡”给朋友使用。无需嵌套虚拟化支持，通过 PVM 内核为普通云主机提供 KVM 能力。

## 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 运行时 | **Bun.js** | 替代 Node.js，启动快、内置打包器、原生 TS 支持 |
| 后端框架 | **Hono** | 轻量 Web 框架，Bun 原生支持 |
| 前端框架 | **Vue 3** | Composition API + `<script setup>` |
| UI 组件库 | **Naive UI** | Vue 3 原生，TypeScript 友好 |
| 构建工具 | **Vite** | Vue 官方推荐 |
| 类型 | **TypeScript** | 全栈类型安全 |
| 数据库 | **SQLite** | 通过 `bun:sqlite` 原生驱动 + Drizzle ORM |
| 虚拟化 | **PVM 内核** | 腾讯云 CubeSandbox PVM，为普通云主机提供 KVM 能力 |
| VMM 引擎 | **Cloud Hypervisor v52.0** | 轻量级虚拟机监控器 |
| CLI 工具 | **Python** | ikun-ctl，调用 Cloud Hypervisor API |
| 人机验证 | **Cap** | 自托管 CAPTCHA，基于 PoW + 浏览器检测 |
| 部署 | **单机 Linux** | Bun 单二进制 + 静态前端文件 |

## 快速开始

### 1. 安装依赖

```bash
# 后端
cd server && bun install

# 前端
cd web && bun install
```

### 2. 启动开发服务

```bash
# 后端 (http://localhost:3000)
cd server && bun run dev

# 前端 (http://localhost:5173，代理 API 到后端)
cd web && bun run dev
```

### 3. 构建部署

```bash
# Windows
.\win-build.bat

# Linux / macOS
bash build.sh
```

产物输出到 `dist/` 目录，上传到服务器后执行:

```bash
# 上传 dist/ 到服务器
scp -r dist/ root@SERVER:/tmp/dist

# 服务器部署
bash /tmp/dist/script/install-ikun.sh
```

部署后启动服务:

```bash
cd /opt/ikun-cloud/server
nohup bun run start > /tmp/ikun-server.log 2>&1 &
```

默认管理员: `admin` / `admin123`

---

## ikun-ctl CLI

```bash
# 初始化宿主机 (创建 bridge、目录、NAT)
ikun-ctl init

# 镜像管理
ikun-ctl image import debian12-custom /path/to/rootfs.raw
ikun-ctl image list
ikun-ctl image remove debian12-custom

# VM 管理
ikun-ctl create --name "小鸡-张三" --base-image debian12-custom --cpus 1 --memory 512 --disk 2
ikun-ctl create -f vm.json                # 从 JSON 配置创建
ikun-ctl start vm-xd8j4
ikun-ctl stop vm-xd8j4
ikun-ctl restart vm-xd8j4
ikun-ctl destroy vm-xd8j4
ikun-ctl list
ikun-ctl status vm-xd8j4
ikun-ctl reset-password vm-xd8j4
ikun-ctl reinstall vm-xd8j4 --base-image debian12-custom
```

## 部署到服务器

详见 `script/install-core.sh` (环境安装) 和 `script/install-ikun.sh` (项目部署)。

```bash
# 1. 构建
.\win-build.bat          # Windows
bash build.sh            # Linux / macOS

# 2. 上传 dist/ 到服务器
scp -r dist/ root@server:/tmp/dist

# 3. 安装环境（PVM 内核、Cloud Hypervisor、Swap）
bash /tmp/dist/script/install-core.sh

# 4. 部署项目
bash /tmp/dist/script/install-ikun.sh

# 5. 启动服务
cd /opt/ikun-cloud/server && nohup bun run start > /tmp/ikun-server.log 2>&1 &
```

---

## 文档

| 文档 | 说明 |
|------|------|
| [设计文档](docs/设计文档.md) | 架构、API、数据库设计 |
| [基础镜像制作指南](docs/base-image-guide.md) | 从零构建 rootfs 镜像 |
| [PVM 内核安装](docs/pvm-kernel-install.md) | Debian 上安装 PVM 宿主机内核 |
| [性能测试报告](docs/性能测试报告.md) | VM 性能基准测试 |
| [安全加固](docs/逃逸.md) | 宿主机安全加固清单 |
