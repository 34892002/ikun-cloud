#!/usr/bin/env python3
"""Debug: test user route param matching on server"""
import sys
sys.path.insert(0, '.')
from ssh_helper import run, upload

# Upload test script
upload('test/debug-routes.ts', '/tmp/debug-routes.ts')

# Run test
exit_code, out, err = run("cd /opt/ikun-cloud/server && bun run /tmp/debug-routes.ts 2>&1")
print(out)
if err:
    print("STDERR:", err)
