import base64
import gzip
import http.cookiejar
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from console.proxy import GrafanaProxy


class FakeGrafana(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _answer(self, body, content_type="text/html"):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Frame-Options", "deny")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("Content-Encoding", "gzip")
        payload = gzip.compress(body)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith("/api/health"):
            self._answer(json.dumps({"database": "ok", "path": self.path}).encode(), "application/json")
        else:
            self._answer(b"<html>real grafana</html>")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self._answer(json.dumps({"received": body.decode(), "path": self.path}).encode(), "application/json")


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeGrafana)
        self.upstream_thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.upstream_thread.start()
        self.proxy = GrafanaProxy("http://127.0.0.1:%d" % self.upstream.server_port, token="test-token", port=0)
        self.proxy_thread = threading.Thread(target=self.proxy.serve_forever, daemon=True)
        self.proxy_thread.start()
        self.base = "http://127.0.0.1:%d" % self.proxy.server_port
        self.cookies = http.cookiejar.CookieJar()
        self.browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies), NoRedirect())

    def tearDown(self):
        self.proxy.shutdown()
        self.proxy.server_close()
        self.proxy_thread.join()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.upstream_thread.join()

    def handshake(self):
        try:
            return self.browser.open(self.base + "/?token=test-token", timeout=3)
        except urllib.error.HTTPError as response:
            if response.code != 302:
                raise
            return response

    def test_unauthenticated_loopback_request_is_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.base + "/api/health", timeout=3)
        self.assertEqual(caught.exception.code, 403)
        self.assertNotIn("test-token", caught.exception.read().decode())

    def test_token_becomes_cookie_and_leaves_the_url(self):
        response = self.handshake()
        self.assertEqual(response.status, 302)
        self.assertEqual(response.headers["Location"], "/")
        self.assertEqual(len(self.cookies), 1)
        self.assertNotIn("test-token", response.headers["Location"])
        dashboard = self.browser.open(self.base + "/d/snapchain", timeout=3)
        self.assertEqual(gzip.decompress(dashboard.read()), b"<html>real grafana</html>")
        self.assertIsNone(dashboard.headers.get("X-Frame-Options"))
        self.assertIsNone(dashboard.headers.get("Content-Security-Policy"))

    def test_handoff_link_works_for_browser_and_embed(self):
        self.handshake()
        fresh = urllib.request.build_opener(NoRedirect())
        with self.assertRaises(urllib.error.HTTPError) as caught:
            fresh.open(self.base + "/?token=test-token", timeout=3)
        self.assertEqual(caught.exception.code, 302)

    def test_wrong_token_is_still_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.base + "/?token=wrong", timeout=3)
        self.assertEqual(caught.exception.code, 403)

    def test_real_api_and_post_bodies_pass_through(self):
        self.handshake()
        health = self.browser.open(self.base + "/api/health?orgId=1", timeout=3)
        self.assertEqual(json.loads(gzip.decompress(health.read()))["database"], "ok")
        request = urllib.request.Request(self.base + "/api/ds/query", data=b'{"real":true}', method="POST")
        response = self.browser.open(request, timeout=3)
        self.assertEqual(json.loads(gzip.decompress(response.read())), {"received": '{"real":true}', "path": "/api/ds/query"})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


if __name__ == "__main__":
    unittest.main()
