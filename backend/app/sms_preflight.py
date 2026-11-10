"""Opt-in private-log diagnostics; never call a messaging API or use credentials."""

from importlib import metadata
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time


_LOGGER = logging.getLogger(__name__)
_LOCK = threading.Lock()
_DONE = False
_PACKAGES = ("alibabacloud-dypnsapi20170525", "alibabacloud-tea-openapi",
             "alibabacloud-tea-util", "darabonba-core", "alibabacloud-tea",
             "alibabacloud-credentials", "requests", "urllib3")


def _shape(value: str) -> dict[str, bool]:
    return {"present": bool(value), "ascii": value.isascii(),
            "outer_whitespace": value != value.strip(),
            "contains_whitespace": any(c.isspace() for c in value),
            "placeholder": any(token in value.lower() for token in
                               ("your-password", "your_access", "your-access", "synthetic", "<access"))}


def configuration_facts() -> dict:
    versions = {}
    for package in _PACKAGES:
        try:
            version = metadata.version(package)
            versions[package] = version if re.fullmatch(r"[0-9A-Za-z.+_-]{1,48}", version) else "unavailable"
        except metadata.PackageNotFoundError:
            versions[package] = "missing"
    key_id = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID", "")
    return {"versions": versions, "key_id": {**_shape(key_id), "ltai_prefix": key_id.startswith("LTAI")},
            "key_secret": _shape(os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "")),
            "proxy_configured": any(bool(os.getenv(key)) for key in
                                    ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"))}


def _tls_probe(ca_file=None) -> dict:
    """One fixed host, one address, validated TLS, no HTTP bytes or credentials."""
    import socket
    import ssl
    if ca_file is None:
        import certifi
        ca_file = certifi.where()

    started, stage = time.monotonic(), "dns"
    facts = {"dns": False, "tcp": False, "tls": False, "http_sent": False}
    try:
        address = socket.getaddrinfo("dypnsapi.aliyuncs.com", 443, type=socket.SOCK_STREAM)[0]
        facts["dns"] = True
        facts["dns_ms"] = int((time.monotonic() - started) * 1000)
        stage = "tcp"
        with socket.socket(address[0], address[1], address[2]) as connection:
            connection.settimeout(0.4)
            connection.connect(address[4])
            facts["tcp"] = True
            facts["tcp_done_ms"] = int((time.monotonic() - started) * 1000)
            stage = "tls"
            connection.settimeout(1.3)
            context = ssl.create_default_context(cafile=ca_file)
            with context.wrap_socket(connection, server_hostname="dypnsapi.aliyuncs.com"):
                facts["tls"] = True
        facts["category"] = "none"
    except Exception as error:
        facts["category"] = ("timeout" if isinstance(error, TimeoutError) else
                             "tls_error" if isinstance(error, ssl.SSLError) else
                             "dns_error" if isinstance(error, socket.gaierror) else "connection_error")
    facts["stage"] = stage
    facts["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    return facts


def _bounded_tls_probe() -> dict:
    # DNS itself has no portable socket timeout. A child process bounds the
    # whole probe, inherits no credentials, and is killed on the deadline.
    try:
        # Serverless vendors may add dependencies only to the parent sys.path.
        # Pass the public CA bundle path; the empty-env child needs only stdlib.
        import certifi
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--tls-probe", certifi.where()],
            env={}, capture_output=True, text=True, timeout=3.0, check=False,
        )
        if completed.returncode != 0:
            return {"category": "probe_unavailable", "http_sent": False,
                    "failure_stage": "child_exit"}
        if len(completed.stdout) > 2048:
            return {"category": "probe_unavailable", "http_sent": False,
                    "failure_stage": "invalid_output"}
        result = json.loads(completed.stdout)
        # Export only bounded fixed fields even if a child fails unexpectedly.
        safe = {key: result[key] for key in ("dns", "tcp", "tls", "http_sent")
                if type(result.get(key)) is bool}
        for key in ("dns_ms", "tcp_done_ms", "elapsed_ms"):
            if type(result.get(key)) is int and 0 <= result[key] <= 5000:
                safe[key] = result[key]
        for key, allowed in (("stage", {"dns", "tcp", "tls"}),
                             ("category", {"none", "timeout", "tls_error", "dns_error", "connection_error"})):
            safe[key] = result.get(key) if result.get(key) in allowed else "unknown"
        return safe
    except subprocess.TimeoutExpired:
        return {"category": "probe_deadline", "http_sent": False}
    except Exception:
        return {"category": "probe_unavailable", "http_sent": False}


def maybe_run_sms_preflight() -> None:
    """Called only by /health; once per process, disabled unless explicitly set."""
    global _DONE
    if os.getenv("SMS_HOOK_PREFLIGHT") != "1":
        return
    with _LOCK:
        if _DONE:
            return
        _DONE = True
    try:
        facts = configuration_facts()
        facts["event"] = "sms_preflight"
        facts["network"] = _bounded_tls_probe()
        _LOGGER.warning("sms_preflight %s", json.dumps(facts, separators=(",", ":")))
    except Exception:
        # Diagnostics must not change health or authentication behavior.
        pass


if __name__ == "__main__" and len(sys.argv) in (2,3) and sys.argv[1] == "--tls-probe":
    print(json.dumps(_tls_probe(sys.argv[2] if len(sys.argv)==3 else None), separators=(",", ":")))
