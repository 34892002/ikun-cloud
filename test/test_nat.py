import sys, json; sys.path.insert(0, '.')
from ssh_helper import run

def api(cmd):
    _, out, _ = run(cmd)
    return json.loads(out)

# login
token = api('curl -s -X POST http://localhost:3000/api/public/login -H "Content-Type: application/json" -d \'{"username":"admin","password":"admin123"}\'')['data']['token']
tk = f'-H "Authorization: Bearer {token}"'

# 创建用户
api(f'curl -s -X POST http://localhost:3000/api/admin/users -H "Content-Type: application/json" {tk} -d \'{{"username":"nat_multi","password":"test123456"}}\'')
r = api('curl -s -X POST http://localhost:3000/api/public/login -H "Content-Type: application/json" -d \'{"username":"nat_multi","password":"test123456"}\'')
user_tk = f'-H "Authorization: Bearer {r["data"]["token"]}"'
uid = r['data']['user']['id']

# 分配 VM 给用户
api(f'curl -s -X POST http://localhost:3000/api/admin/vms/vm-hqs5i/assign -H "Content-Type: application/json" {tk} -d \'{{"userId":{uid}}}\'')

# 设置 NAT 限制 2
api(f'curl -s -X PUT http://localhost:3000/api/admin/settings -H "Content-Type: application/json" {tk} -d \'{{"nat_limit":"2"}}\'')
print('NAT 限制设为 2, 用户有 1 台 VM')

# 用户添加端口
for port in [30001, 30002, 30003]:
    r = api(f'curl -s -X POST http://localhost:3000/api/user/network/vms/vm-hqs5i/ports -H "Content-Type: application/json" {user_tk} -d \'{{"hostPort":{port},"guestPort":80}}\'')
    status = '✅' if r['code'] == 0 else '❌'
    print(f'  {status} 添加 :{port} -> {r.get("message","ok")}')

# 配额
r = api(f'curl -s http://localhost:3000/api/user/network/vms/vm-hqs5i/ports {user_tk}')
print(f'  配额: {r["data"]["usedCount"]}/{r["data"]["limit"]}')

# 端口冲突测试
r = api(f'curl -s -X POST http://localhost:3000/api/user/network/vms/vm-hqs5i/ports -H "Content-Type: application/json" {user_tk} -d \'{{"hostPort":30001,"guestPort":8080}}\'')
print(f'  端口冲突 :30001: code={r["code"]} {r.get("message","")}')

# 黑名单测试
r = api(f'curl -s -X POST http://localhost:3000/api/user/network/vms/vm-hqs5i/ports -H "Content-Type: application/json" {user_tk} -d \'{{"hostPort":22,"guestPort":22}}\'')
print(f'  黑名单 :22: code={r["code"]} {r.get("message","")}')

# 查看所有已分配端口
r = api(f'curl -s http://localhost:3000/api/admin/network/ports {tk}')
print(f'\n所有已分配端口 ({len(r["data"])} 条):')
for p in r['data']:
    print(f'  :{p["hostPort"]} -> {p["vmName"]}:{p["guestPort"]} owner={p["owner"]}')

# 清理
api(f'curl -s -X PUT http://localhost:3000/api/admin/settings -H "Content-Type: application/json" {tk} -d \'{{"nat_limit":"40"}}\'')
r = api(f'curl -s http://localhost:3000/api/user/network/vms/vm-hqs5i/ports {tk}')
for p in r['data']['items']:
    api(f'curl -s -X DELETE http://localhost:3000/api/user/network/vms/vm-hqs5i/ports/{p["id"]} {tk}')
api(f'curl -s -X POST http://localhost:3000/api/admin/vms/vm-hqs5i/unassign -H "Content-Type: application/json" {tk}')
api(f'curl -s -X DELETE http://localhost:3000/api/admin/users/{uid} {tk}')
print('\n清理完成')
