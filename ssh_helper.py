#!/usr/bin/env python3
"""SSH helper for remote server operations.

Usage:
  python ssh_helper.py <host> <user> <pass> '<command>'
  python ssh_helper.py YOUR_SERVER root mypass 'ikun-ctl list'
"""
import sys
import paramiko


def run(host, user, password, cmd, timeout=1800):
    """Run a command on the remote server and return output."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=15)

    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    exit_code = stdout.channel.recv_exit_status()

    client.close()
    return exit_code, out, err


def upload(host, user, password, local_path, remote_path):
    """Upload a file to the remote server."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=15)

    sftp = client.open_sftp()
    sftp.put(local_path, remote_path)
    sftp.close()
    client.close()


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python ssh_helper.py <host> <user> <pass> '<command>'")
        sys.exit(1)
    host, user, password = sys.argv[1], sys.argv[2], sys.argv[3]
    cmd = " ".join(sys.argv[4:])
    exit_code, out, err = run(host, user, password, cmd)
    if out:
        print(out, end="")
    if err:
        print(err, end="", file=sys.stderr)
    sys.exit(exit_code)
