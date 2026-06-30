import sys; sys.path.insert(0, '.')
from ssh_helper import run
import json

# Login
_, out, _ = run('curl -s -X POST http://localhost:3000/api/public/login -H "Content-Type: application/json" -d "{\\"username\\":\\"admin\\",\\"password\\":\\"admin123\\"}"')
token = json.loads(out)['data']['token']

# Reset testuser password
cmd = f'curl -s -X POST http://localhost:3000/api/admin/users/2/reset-password -H "Content-Type: application/json" -H "Authorization: Bearer {token}" -d "{{\\"password\\":\\"test123456\\"}}"'
_, out2, _ = run(cmd)
print(out2)
