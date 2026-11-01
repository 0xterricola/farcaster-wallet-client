# fiddy.fun/client — microsite hosting (static, no backend)

Status as of 2026-10-18 (IST). The quickstart + tutorial microsite from `site/index.html`
is live at **https://fiddy.fun/client** — the target README, `docs/SPEC.md` and `bin/fiddy`
all link to. Verified state below; everything in the "How verified" column was actually run.

## Live facts

| Fact | Value | How verified |
| --- | --- | --- |
| URL | https://fiddy.fun/client | `curl -o /dev/null -w '%{http_code}'` → **200** (also `/client/`, `?x=1`) |
| Canonical | `<link rel="canonical" href="https://fiddy.fun/client">`, `og:url` same | served HTML |
| Origin file | `/var/www/fiddy-client/index.html` (outside the release symlink tree) | `ls -l`, `md5sum` |
| Deployed content | `md5 91b6ba72b49addbfd1e0e50cb65d1a01` = `site/index.html` at repo HEAD (`358111f`) | `md5sum` on the VPS vs `md5 -q site/index.html` locally, equal |
| Served bytes | byte-identical to the repo file | `diff <(curl -sS https://fiddy.fun/client) site/index.html` → empty |
| Host | srv1569292 (LC VPS, 100.111.203.78 / public 187.127.148.194), Cloudflare-proxied | `hostname`, `curl -4 ifconfig.me`, `dig fiddy.fun` |
| Redirects | `http → 308 https://fiddy.fun/client`; `www → 308 https://fiddy.fun/client` | `curl -w '%{redirect_url}'` |
| Neighbours unchanged | `/start` 200, `/FSSC/` 200, `/release.json` 200 (`revision 9047c21`), mate.legitclub.com `/api/health` 200 | `curl` |

## How it is served

`/etc/nginx/sites-available/fiddy.fun` (backup: `/root/nginx-backups/fiddy.fun.<ts>.bak`):

```nginx
location = /client {                 # the README/SPEC/bin-fiddy link target: 200, no redirect
    alias /var/www/fiddy-client/index.html;
    default_type text/html;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'" always;
    add_header Cache-Control "public, max-age=300, no-transform" always;
}
location ^~ /client/ {               # directory form kept for any future assets
    alias /var/www/fiddy-client/;
    index index.html;
    try_files $uri $uri/ =404;
    # same headers
}
```

No backend, no proxy, no service unit: the page is one self-contained HTML file (inline CSS +
one inline script for the copy buttons), so `/client` and `/client/` can both answer 200.

## Deploy (or update)

```bash
cd /Users/lc/fiddy
git show <sha>:site/index.html | ssh root@100.111.203.78 \
  'cat > /var/www/fiddy-client/index.html && chmod 0644 /var/www/fiddy-client/index.html && md5sum /var/www/fiddy-client/index.html'
md5 -q site/index.html          # must match
```

Pin the content hash, not the branch: other workers commit to this checkout concurrently.

## Verification performed (2026-10-18)

| Check | Result |
| --- | --- |
| `lintapple https://fiddy.fun/client` run from `site/` (390 / 768 / 1440, dark) | **exit 0, 0 findings** |
| Hero renders live | h1 visible 1440×740 / 390×350 box, wordmark, lede, 3-command quickstart card with 3 lime badges; pixel check confirms lime + ink paint in the hero band at both widths |
| Copy buttons | click → label `copied`, clipboard = `fiddy provision --aws` |
| Mobile 390 / tablet 768 / desktop 1440 | no horizontal overflow, no clipped text, no page errors |
| `#safety` anchor (README's second link) | lands with the seed-phrase note in the viewport at 390 / 768 / 1440 |
| Console (live, Playwright) | no page errors; only Cloudflare's own Web Analytics beacon is CSP-blocked (`script-src` does not allow `static.cloudflareinsights.com`) — zone-level setting, harmless, not page code |

`site/ui-policy.json` is the lint policy for this page, generated from its real type system
(measured computed sizes, dark scheme, three viewports). Run the lint from `site/`:

```bash
cd site && lintapple https://fiddy.fun/client        # exit 0 = no UI findings
```

## Pitfalls (learned live)

- **Cloudflare Scrape Shield rewrites literal email addresses** in served HTML into a
  `__cf_email__` span whose decoder script lives at `fiddy.fun/cdn-cgi/...`. This page's CSP is
  `script-src 'unsafe-inline'`, so the decoder is blocked and the Step 0 command rendered as
  `fiddy provision --ssh [email protected]` for every visitor. The `@` is written as `&#64;`
  in `site/index.html`; do not "tidy" it back to a literal `@`.
- Both `/client` and `/client/` answer 200 (the exact-match location serves the file, the
  prefix location serves the directory). `rel=canonical` pins the slashless form that README uses.
- `site/index.html` is the only deployed artifact — a `site/` change needs the deploy command
  above; pushing to `main` does not deploy it (no CI in this repo).