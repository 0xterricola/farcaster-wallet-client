"""Loopback-only, token-gated Grafana reverse proxy.

Grafana stays on its node's loopback interface. SSH tunnelling is owned by
console.node.TunnelManager; this module only makes the stock dashboard frameable
inside Ovis on the same machine.
"""

import http.client
import hmac
import http.cookies
import secrets
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
}
FRAME_HEADERS = {"x-frame-options", "content-security-policy", "content-security-policy-report-only"}


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # Browsers routinely cancel assets and close keep-alive sockets. Those
        # disconnects are not node failures and must not flood the Herdr pane.
        return


class GrafanaProxy:
    def __init__(self, upstream, token=None, host="127.0.0.1", port=43117):
        parsed = urllib.parse.urlparse(upstream)
        if parsed.scheme != "http" or not parsed.hostname or parsed.path not in ("", "/"):
            raise ValueError("Grafana must be a plain http:// loopback base URL.")
        if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("Grafana must stay on loopback; use an SSH tunnel for a remote node.")
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("The console proxy may only listen on loopback.")
        self.upstream = upstream.rstrip("/")
        self.token = token or secrets.token_urlsafe(32)
        self.session_token = secrets.token_urlsafe(32)
        self.handoff_lock = threading.Lock()
        self.host = host
        connection_class = http.client.HTTPConnection
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format, *args):
                # URLs can carry the one-time hand-off token. Never log them.
                return

            def _authorised(self):
                parsed_request = urllib.parse.urlparse(self.path)
                supplied = urllib.parse.parse_qs(parsed_request.query).get("token", [""])[-1]
                with proxy.handoff_lock:
                    # The link stays valid for this pane's lifetime: the browser
                    # auto-open, a manual click and an Ovis embed all need it.
                    # It is still a 32-byte secret on loopback, never logged.
                    accepted = bool(proxy.token) and hmac.compare_digest(supplied, proxy.token)
                if accepted:
                    query = [(key, value) for key, values in urllib.parse.parse_qsl(parsed_request.query, keep_blank_values=True) if key != "token" for value in [values]]
                    destination = parsed_request.path or "/"
                    if query:
                        destination += "?" + urllib.parse.urlencode(query)
                    self.send_response(302)
                    self.send_header("Location", destination)
                    self.send_header("Set-Cookie", "fiddy_console=%s; HttpOnly; SameSite=Strict; Path=/" % proxy.session_token)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return False
                cookie = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
                morsel = cookie.get("fiddy_console")
                if morsel is not None and hmac.compare_digest(morsel.value, proxy.session_token):
                    return True
                body = b"Fiddy console: this address only works through the Grafana button's link. Open the Fiddy console and choose Grafana; it opens the dashboard for you.\n"
                self.send_response(403)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return False

            def _proxy(self):
                if not self._authorised():
                    return
                length = int(self.headers.get("Content-Length", "0") or 0)
                if length > 4 * 1024 * 1024:
                    self.send_error(413, "Request too large")
                    return
                body = self.rfile.read(length) if length else None
                parsed_upstream = urllib.parse.urlparse(proxy.upstream)
                connection = connection_class(parsed_upstream.hostname, parsed_upstream.port or 80, timeout=30)
                headers = {key: value for key, value in self.headers.items() if key.lower() not in HOP_HEADERS}
                headers["Host"] = parsed_upstream.netloc
                headers["X-Forwarded-Host"] = self.headers.get("Host", "127.0.0.1")
                headers["X-Forwarded-Proto"] = "http"
                try:
                    connection.request(self.command, self.path, body=body, headers=headers)
                    response = connection.getresponse()
                    payload = response.read()
                    self.send_response(response.status)
                    for key, value in response.getheaders():
                        if key.lower() not in HOP_HEADERS and key.lower() not in FRAME_HEADERS:
                            self.send_header(key, value)
                    self.send_header("Content-Length", str(len(payload)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    if self.command != "HEAD":
                        self.wfile.write(payload)
                except (OSError, http.client.HTTPException):
                    if not self.wfile.closed:
                        try:
                            self.send_error(502, "Grafana is not answering. Check that the node and its dashboard are running.")
                        except (BrokenPipeError, ConnectionResetError):
                            pass
                finally:
                    connection.close()

            do_GET = _proxy
            do_HEAD = _proxy
            do_POST = _proxy
            do_PUT = _proxy
            do_PATCH = _proxy
            do_DELETE = _proxy
            do_OPTIONS = _proxy

        self.server = QuietThreadingHTTPServer((host, port), Handler)
        self.server.daemon_threads = True
        self.server_port = self.server.server_port

    @property
    def url(self):
        return "http://127.0.0.1:%d/?token=%s" % (self.server_port, urllib.parse.quote(self.token))

    def serve_forever(self):
        self.server.serve_forever()

    def shutdown(self):
        self.server.shutdown()

    def server_close(self):
        self.server.server_close()
