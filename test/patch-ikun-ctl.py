with open('/usr/local/bin/ikun-ctl', 'r') as f:
    code = f.read()

old = '''    if config["status"] == "running":
        print(f"VM {vm_id} 已在运行")
        return'''

new = '''    if config["status"] == "running":
        # 检查进程是否真的活着（socket 可连接）
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
        # 进程已死，更新状态继续启动
        print(f"[!] VM {vm_id} 进程已退出，重新启动...")
        config["status"] = "stopped"
        save_vm_config(vm_id, config)'''

if old in code:
    code = code.replace(old, new, 1)
    with open('/usr/local/bin/ikun-ctl', 'w') as f:
        f.write(code)
    print('patched')
else:
    print('pattern not found')
