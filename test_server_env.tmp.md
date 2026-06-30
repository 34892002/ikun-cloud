# 测试环境文档

> 用于在 AI 会话中调试测试服务器的模板文件

## 服务器信息

| 项目 | 值 |
|------|-----|
| 名称 | 测试服务器1 |
| IP | 127.0.0.1 |
| 用户 | root |
| SSH 密码 | `123456` |
| SSH 私钥 | `C:\Users\admin\Desktop\test.key` |
| 默认管理员 | 查看 server\.env |


## 远程操作方式

### 方式一：SSH 密钥（推荐）

服务器当前仅允许密钥登录，直接用 `ssh` 执行命令：

```bash
ssh -i C:\Users\admin\Desktop\test.key root@127.0.0.1 "ikun-ctl list"
```

### 方式二：ssh_helper.py（仅密码环境）

`ssh_helper.py` 是为不支持密钥、只有密码的环境准备的。当前服务器已禁用密码登录，**不要用它**。

## 后端重启

```bash
ssh -i C:\Users\admin\Desktop\test.key root@127.0.0.1 "bash /tmp/restart-server.sh"
```

## 本地构建并上传前端

```bash
# 1. 本地构建
cd web && bun run build

# 2. 压缩
cd dist && tar czf ../dist.tar.gz . && cd ..

# 3. 上传压缩包
scp -i C:\Users\admin\Desktop\test.key web/dist.tar.gz root@127.0.0.1:/tmp/dist.tar.gz

# 4. 服务器解压
ssh -i C:\Users\admin\Desktop\test.key root@127.0.0.1 "rm -rf /opt/ikun-cloud/web/dist && mkdir -p /opt/ikun-cloud/web/dist && tar xzf /tmp/dist.tar.gz -C /opt/ikun-cloud/web/dist && rm /tmp/dist.tar.gz"
```

## 上传后端文件

```bash
scp -i C:\Users\admin\Desktop\test.key server/src/routes/vms.ts root@127.0.0.1:/opt/ikun-cloud/server/src/routes/vms.ts
```

## 注意事项

### 改配置

- `ikun-ctl resize` 会自动停机 → 改配置 → 重启
- 磁盘只能扩大不能缩小
- 当前 PVM 内核不支持 CPU/内存热插拔，必须重启生效

### create_vm_disk 不要改

用的是 `fallocate` 外部预分配，不能换成 `qemu-img -o preallocation=falloc`（CH 不支持 `extended_l2`）。

### 数据库 vs 服务器配置

- 数据库 = 面板管理的配置（name、cpus、memory、disk）
- 服务器 config.json = 实际运行状态（status、ip、password）
- 显示时合并：配置来自数据库，状态来自服务器
