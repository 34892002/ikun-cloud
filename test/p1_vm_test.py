#!/usr/bin/env python3
"""P1 VM + WebSocket 功能测试"""
import json
import sys
import time
sys.path.insert(0, '.')
from ssh_helper import run

HOST = "YOUR_SERVER"
BASE = f"http://{HOST}:3000"

def api(method, path, data=None, token=None):
    cmd = f"curl -s -X {method} {BASE}/api{path} -H 'Content-Type: application/json'"
    if token:
        cmd += f" -H 'Authorization: Bearer {token}'"
    if data:
        cmd += f" -d '{json.dumps(data)}'"
    exit_code, out, err = run(cmd, timeout=30)
    try:
        return json.loads(out)
    except:
        return {"_raw": out[:200], "_err": err[:200]}

def test(name, condition, detail=""):
    status = "✅" if condition else "❌"
    print(f"  {status} {name}" + (f" ({detail})" if detail else ""))

print("=" * 50)
print("VM + WebSocket 功能测试")
print("=" * 50)

# ========== 登录 ==========
print("\n[1. 登录]")
r = api("POST", "/public/login", {"username": "admin", "password": "admin123"})
admin_token = r["data"]["token"]
test("admin 登录", bool(admin_token))

# ========== VM 列表 ==========
print("\n[2. VM 列表]")
r = api("GET", "/user/vms", token=admin_token)
vms = r.get("data", {}).get("items", [])
test("user/vms 返回列表", len(vms) > 0, f"count={len(vms)}")
for vm in vms:
    print(f"    {vm['id']} | {vm.get('name','')} | {vm.get('status','')} | owner={vm.get('ownerId')}")

r = api("GET", "/admin/vms", token=admin_token)
admin_vms = r.get("data", {}).get("items", [])
test("admin/vms 返回列表", len(admin_vms) > 0, f"count={len(admin_vms)}")

# ========== VM 详情 ==========
print("\n[3. VM 详情]")
if vms:
    vm_id = vms[0]["id"]
    r = api("GET", f"/user/vms/{vm_id}", token=admin_token)
    test(f"GET /user/vms/{vm_id}", r.get("code") == 0, f"status={r.get('data',{}).get('status')}")
else:
    test("无 VM 可测试", False, "列表为空")

# ========== VM 操作（停止/启动）==========
print("\n[4. VM 操作]")
if vms:
    vm_id = vms[0]["id"]
    vm_status = vms[0].get("status", "")

    if vm_status == "running":
        # 停止
        r = api("POST", f"/user/vms/{vm_id}/stop", token=admin_token)
        test(f"POST /user/vms/{vm_id}/stop", r.get("code") == 0, r.get("message"))

        # 等一下
        time.sleep(2)

        # 启动
        r = api("POST", f"/user/vms/{vm_id}/start", token=admin_token)
        test(f"POST /user/vms/{vm_id}/start", r.get("code") == 0, r.get("message"))

        time.sleep(2)
    else:
        # 启动
        r = api("POST", f"/user/vms/{vm_id}/start", token=admin_token)
        test(f"POST /user/vms/{vm_id}/start", r.get("code") == 0, r.get("message"))

        time.sleep(2)

        # 停止
        r = api("POST", f"/user/vms/{vm_id}/stop", token=admin_token)
        test(f"POST /user/vms/{vm_id}/stop", r.get("code") == 0, r.get("message"))

    # 重启
    r = api("POST", f"/user/vms/{vm_id}/start", token=admin_token)
    time.sleep(2)
    r = api("POST", f"/user/vms/{vm_id}/restart", token=admin_token)
    test(f"POST /user/vms/{vm_id}/restart", r.get("code") == 0, r.get("message"))

# ========== 端口映射 ==========
print("\n[5. 端口映射]")
if vms:
    vm_id = vms[0]["id"]
    vm_ip = vms[0].get("ip", "")

    # 查看端口列表
    r = api("GET", f"/user/network/vms/{vm_id}/ports", token=admin_token)
    test(f"GET /user/network/vms/{vm_id}/ports", r.get("code") == 0, f"count={len(r.get('data', []))}")

    # 添加端口映射
    r = api("POST", f"/user/network/vms/{vm_id}/ports", {"hostPort": 18080, "guestPort": 80, "protocol": "tcp"}, admin_token)
    test(f"POST 端口映射 (18080->80)", r.get("code") == 0, r.get("message"))

    # 再次查看
    r = api("GET", f"/user/network/vms/{vm_id}/ports", token=admin_token)
    ports = r.get("data", [])
    test(f"端口映射列表更新", len(ports) > 0, f"count={len(ports)}")

    # 删除端口映射
    if ports:
        port_id = ports[-1]["id"]
        r = api("DELETE", f"/user/network/vms/{vm_id}/ports/{port_id}", token=admin_token)
        test(f"DELETE 端口映射", r.get("code") == 0, r.get("message"))

# ========== 租户隔离 ==========
print("\n[6. 租户隔离]")
# 创建测试用户
r = api("POST", "/admin/users", {"username": "vmtester", "password": "vmtest123"}, admin_token)
if r.get("code") == 0 or "已存在" in r.get("message", ""):
    test("创建测试用户", True)
else:
    test("创建测试用户", False, r.get("message"))

r = api("POST", "/public/login", {"username": "vmtester", "password": "vmtest123"})
user_token = r.get("data", {}).get("token", "")
test("vmtester 登录", bool(user_token))

# 分配 VM 给用户
if vms and user_token:
    vm_id = vms[0]["id"]
    r = api("POST", f"/admin/vms/{vm_id}/assign", {"userId": r.get("data",{}).get("user",{}).get("id")}, admin_token)
    test(f"分配 VM 给 vmtester", r.get("code") == 0, r.get("message"))

    # 用户查看自己的 VM
    r = api("GET", "/user/vms", token=user_token)
    my_vms = r.get("data", {}).get("items", [])
    test("vmtester 看到自己的 VM", len(my_vms) > 0, f"count={len(my_vms)}")

    # 用户操作自己的 VM
    r = api("GET", f"/user/vms/{vm_id}", token=user_token)
    test("vmtester 查看自己的 VM 详情", r.get("code") == 0)

    # 用户访问 admin 接口
    r = api("GET", "/admin/users", token=user_token)
    test("vmtester 不能访问 admin", r.get("code") == 403)

    # 取消分配
    r = api("POST", f"/admin/vms/{vm_id}/unassign", token=admin_token)
    test("取消分配", r.get("code") == 0)

    # 取消后用户看不到
    r = api("GET", "/user/vms", token=user_token)
    my_vms2 = r.get("data", {}).get("items", [])
    test("取消后 vmtester 看不到 VM", len(my_vms2) == 0)

# ========== WebSocket ==========
print("\n[7. WebSocket]")
try:
    import websocket as ws_lib
    ws_url = f"ws://{HOST}:3000/api/ws?token={admin_token}"
    ws_messages = []

    ws = ws_lib.create_connection(ws_url, timeout=5)
    # 订阅仪表盘
    ws.send(json.dumps({"action": "subscribe_dashboard"}))
    # 等待接收数据
    ws.settimeout(2)
    for _ in range(5):
        try:
            msg = ws.recv()
            if msg:
                ws_messages.append(msg)
        except:
            break
    ws.close()

    test("WebSocket 连接成功", len(ws_messages) > 0, f"收到 {len(ws_messages)} 条消息")
    if ws_messages:
        for msg in ws_messages[:3]:
            try:
                d = json.loads(msg)
                print(f"    消息类型: {d.get('type', 'unknown')}")
            except:
                print(f"    消息: {msg[:80]}")
except ImportError:
    test("websocket-client 未安装", False, "pip install websocket-client")
except Exception as e:
    test("WebSocket 连接", False, str(e)[:100])

print("\n" + "=" * 50)
print("测试完成")
print(f"管理面板: http://{HOST}:3000")
print("=" * 50)
