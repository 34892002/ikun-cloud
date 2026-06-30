#!/usr/bin/env python3
"""P1 租户系统远程测试脚本"""
import json
import sys
sys.path.insert(0, '.')
from ssh_helper import run

def api(method, path, data=None, token=None):
    """调用远程 API"""
    cmd = f"curl -s -X {method} http://localhost:3000/api{path} -H 'Content-Type: application/json'"
    if token:
        cmd += f" -H 'Authorization: Bearer {token}'"
    if data:
        cmd += f" -d '{json.dumps(data)}'"
    exit_code, out, err = run(cmd)
    try:
        return json.loads(out)
    except:
        return {"raw": out, "err": err}

def test(name, condition, detail=""):
    status = "✅" if condition else "❌"
    print(f"  {status} {name}" + (f" ({detail})" if detail else ""))

print("=" * 50)
print("P1 租户系统测试")
print("=" * 50)

# 1. 公开接口
print("\n[公开接口]")
r = api("GET", "/public/site-info")
test("站点信息", r.get("code") == 0, f"registration={r.get('data',{}).get('registrationOpen')}")

r = api("GET", "/public/announcements")
test("公告列表", r.get("code") == 0)

# 2. 管理员登录
print("\n[管理员登录]")
r = api("POST", "/public/login", {"username": "admin", "password": "admin123"})
admin_token = r.get("data", {}).get("token", "")
admin_role = r.get("data", {}).get("user", {}).get("role", "")
test("admin 登录", r.get("code") == 0 and admin_token, f"role={admin_role}")

# 3. 管理员接口
print("\n[管理员接口]")
r = api("GET", "/user/me", token=admin_token)
test("GET /user/me", r.get("code") == 0 and r.get("data", {}).get("role") == "root")

r = api("GET", "/admin/dashboard", token=admin_token)
test("GET /admin/dashboard", r.get("code") == 0)

r = api("GET", "/admin/users", token=admin_token)
test("GET /admin/users", r.get("code") == 0)

# 4. 创建用户
print("\n[用户管理]")
r = api("POST", "/admin/users", {"username": "testuser", "password": "test123456"}, admin_token)
test("创建用户 testuser", r.get("code") == 0, f"id={r.get('data',{}).get('id')}")

r = api("GET", "/admin/users", token=admin_token)
user_count = len(r.get("data", []))
test("用户列表", user_count >= 2, f"count={user_count}")

# 5. 网站配置
print("\n[网站配置]")
r = api("PUT", "/admin/settings", {"registration_open": "true"}, admin_token)
test("开放注册", r.get("code") == 0)

r = api("GET", "/public/site-info")
test("注册状态已更新", r.get("data", {}).get("registrationOpen") == True)

r = api("POST", "/public/register", {"username": "reguser", "password": "regpass123"})
test("注册新用户", r.get("code") == 0)

r = api("PUT", "/admin/settings", {"registration_open": "false"}, admin_token)
test("关闭注册", r.get("code") == 0)

r = api("POST", "/public/register", {"username": "shouldfail", "password": "regpass123"})
test("注册被拒绝", r.get("code") != 0, f"code={r.get('code')}")

# 6. 公告管理
print("\n[公告管理]")
r = api("POST", "/admin/announcements", {"title": "测试公告", "content": "这是测试公告内容", "isActive": True}, admin_token)
test("创建公告", r.get("code") == 0)

r = api("GET", "/public/announcements")
test("公开获取公告", r.get("code") == 0 and len(r.get("data", [])) > 0)

# 7. 租户登录
print("\n[租户登录]")
r = api("POST", "/public/login", {"username": "testuser", "password": "test123456"})
user_token = r.get("data", {}).get("token", "")
user_role = r.get("data", {}).get("user", {}).get("role", "")
test("testuser 登录", r.get("code") == 0 and user_token, f"role={user_role}")

# 8. 租户权限
print("\n[租户权限]")
r = api("GET", "/user/me", token=user_token)
test("GET /user/me", r.get("code") == 0 and r.get("data", {}).get("role") == "user")

r = api("GET", "/user/vms", token=user_token)
test("查看 VM 列表", r.get("code") == 0 and len(r.get("data", {}).get("items", [])) == 0)

r = api("GET", "/admin/users", token=user_token)
test("访问 admin 接口 → 403", r.get("code") == 403, f"code={r.get('code')}")

r = api("GET", "/user/vms")
test("无 token → 401", r.get("code") == 401, f"code={r.get('code')}")

r = api("GET", "/admin/users")
test("无 token 访问 admin → 401", r.get("code") == 401)

# 9. 修改密码
print("\n[修改密码]")
r = api("PUT", "/user/password", {"oldPassword": "test123456", "newPassword": "newpass123"}, user_token)
test("修改密码", r.get("code") == 0)

r = api("POST", "/public/login", {"username": "testuser", "password": "newpass123"})
test("新密码登录", r.get("code") == 0)

# 10. 管理员修改用户
print("\n[管理员修改用户]")
r = api("PUT", "/admin/users/2", {"username": "testuser-renamed"}, admin_token)
test("修改用户名", r.get("code") == 0)

r = api("PUT", "/admin/users/2", {"username": "testuser"}, admin_token)
test("改回用户名", r.get("code") == 0)

# 11. 管理员重置密码
r = api("POST", "/admin/users/2/reset-password", {"password": "reset123456"}, admin_token)
test("重置用户密码", r.get("code") == 0)

r = api("POST", "/public/login", {"username": "testuser", "password": "reset123456"})
test("重置后登录", r.get("code") == 0)

print("\n" + "=" * 50)
print("测试完成")
print(f"管理面板: http://YOUR_SERVER:3000")
print("=" * 50)
