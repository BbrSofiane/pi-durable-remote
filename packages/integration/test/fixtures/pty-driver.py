"""Bounded stdlib PTY smoke: runs the REAL client CLI, not a terminal/socket double."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, entry, url, mode = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 140, 0, 0))
baseline = termios.tcgetattr(slave)
env = dict(os.environ, TERM="xterm-256color", PI_PROGRAM_STATUS="0")
child = subprocess.Popen([node, "--experimental-strip-types", entry, "--url", url],
                         stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
print(json.dumps({"type": "pty-start", "pid": child.pid}), flush=True)
capture = bytearray()
sent_input = False
sent_exit = False
sent_recover = False
sent_expand = False
answered_da = False
error = None
try:
    deadline = time.monotonic() + (25 if mode == "recover-restart" else 15)
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                data = os.read(master, 8192)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                data = b""
            capture.extend(data)
            if len(capture) > 128 * 1024:
                raise RuntimeError("PTY capture limit exceeded")
            if not answered_da and b"\x1b[c" in capture:
                os.write(master, b"\x1b[?1;2c")
                answered_da = True
        if mode in ("submit-exit", "recover-restart") and not sent_input and b"CONNECTED" in capture:
            # Bracketed paste then Enter exercises the actual released Editor/input path.
            os.write(master, b"\x1b[200~PTY input keeps remote work alive\x1b[201~\r")
            sent_input = True
        if mode == "recover-restart" and not sent_recover and b"Unconfirmed: 1" in capture and b"Ready" in capture:
            os.write(master, b"/recover\r")
            sent_recover = True
        target = (b"Recovered input durably admitted" if mode == "recover-restart" else
                  b"Input durably admitted" if mode == "submit-exit" else b"integration-final: server bytes verified")
        if mode == "observe-final" and not sent_expand and target in capture:
            os.write(master, b"\x0f")  # real Ctrl+O expands tools locally before the full-output proof
            sent_expand = True
            continue
        expanded = mode != "observe-final" or sent_expand and b"Arguments" in capture
        if not sent_exit and target in capture and expanded:
            os.write(master, b"\x03")  # real Ctrl+C key; raw-mode UI exit, never remote abort
            sent_exit = True
        if child.poll() is not None:
            # Drain terminal restoration sequences after process exit.
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
            break
    if child.poll() is None:
        raise RuntimeError("PTY smoke deadline exceeded")
except BaseException as exc:
    error = str(exc)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)  # only this driver's owned client session
        child.wait()
    restored = termios.tcgetattr(slave) == baseline
    os.close(master)
    os.close(slave)
print(json.dumps({"type": "pty-result", "code": child.returncode, "sentInput": sent_input,
                  "sentExit": sent_exit, "sentRecover": sent_recover, "sentExpand": sent_expand, "restored": restored,
                  "capture": capture.decode("utf-8", errors="replace"), "error": error}), flush=True)
sys.exit(0 if error is None and child.returncode == 0 and sent_exit and restored else 1)
