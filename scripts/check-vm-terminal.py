"""Read-only, bounded real CLI/SSH PTY check; never sends input/model commands or prints capture."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import termios
import time

root = Path(__file__).resolve().parent.parent
node = shutil.which("node")
if node is None:
    raise SystemExit("Compatible Node must be on PATH")
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 140, 0, 0))
baseline = termios.tcgetattr(slave)
env = dict(os.environ, TERM="xterm-256color", PI_PROGRAM_STATUS="0")
child = subprocess.Popen([node, "--experimental-strip-types", str(root / "packages/client/src/main.ts"),
                          "--ssh-host", "sof-sandbox.exe.xyz", "--remote-port", "7777"],
                         cwd=root, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
capture = bytearray()
connected = False
sent_exit = False
answered_da = False
error = False
try:
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                data = os.read(master, 8192)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                data = b""
            capture.extend(data)
            if len(capture) > 128 * 1024:
                raise RuntimeError("Capture bound exceeded")
            if not answered_da and b"\x1b[c" in capture:
                os.write(master, b"\x1b[?1;2c")
                answered_da = True
        # Cursor-position escape terminators can end in uppercase H immediately before the header.
        # Treat CSI boundaries as separators so DISCONNECTED cannot satisfy CONNECTED.
        text = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"\n", capture)
        connected = re.search(rb"\bCONNECTED\b", text) is not None and b"gpt-5.4-mini" in text
        if connected and not sent_exit:
            os.write(master, b"\x03")  # Ctrl+C exits face without remote abort.
            sent_exit = True
        if child.poll() is not None:
            while select.select([master], [], [], 0)[0]:
                try:
                    data = os.read(master, 8192)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                capture.extend(data)
                if len(capture) > 128 * 1024:
                    raise RuntimeError("Capture bound exceeded")
            break
    if child.poll() is None:
        raise RuntimeError("PTY deadline exceeded")
except BaseException:
    error = True
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)  # Only this driver's owned client/tunnel group.
        child.wait()
    restored = termios.tcgetattr(slave) == baseline
    os.close(master)
    os.close(slave)
passed = not error and child.returncode == 0 and connected and sent_exit and restored and b"\x1b[?1049l" in capture
print(json.dumps({"health": "PASS" if passed else "FAIL", "realCliSsh": True, "exitCode": child.returncode,
                  "freshRemoteModelRendered": connected, "termiosRestored": restored,
                  "alternateScreenRestored": b"\x1b[?1049l" in capture, "captureBytes": len(capture),
                  "modelCallsRequested": 0}))
raise SystemExit(0 if passed else 1)
