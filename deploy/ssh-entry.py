#!/usr/bin/python3
"""Install root:root 0755. Invoked by sshd forced command, never a shell."""
import os
import re
import subprocess
import sys

original = os.environ.get("SSH_ORIGINAL_COMMAND", "")
entry_mode = sys.argv[1:]
if entry_mode:
    sys.exit("invalid GreenPMS SSH entry mode")
version = r"v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
deploy = re.fullmatch(rf"(deploy|rollback) ({version}) ([0-9a-f]{{40}}) (greenpms/releases/{version}/[0-9a-f]{{40}}/) ([0-9a-f]{{64}})", original)
if deploy:
    operation, tag, revision, key, checksum = deploy.groups()
    if key != f"greenpms/releases/{tag}/{revision}/":
        sys.exit("invalid GreenPMS identity")
    arguments = [operation, tag, revision, key, checksum]
elif original == "maintenance":
    arguments = [original]
else:
    sys.exit("restricted GreenPMS deployment command required")

# sudoers grants only this root-owned wrapper, which validates again after sudo.
result = subprocess.run(["sudo", "-n", "/usr/local/sbin/greenpms-deploy", *arguments],
                        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}, check=False)
sys.exit(result.returncode)
