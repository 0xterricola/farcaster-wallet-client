"""Apply Fiddy's Ovis customizations to an installed Ovis checkout.

Idempotent: safe to re-run after an Ovis update. Three changes:
1. Brand: the top-left wordmark and window title say Fiddy.
2. /api/fiddy/grafana: serves the console's published Grafana proxy URL.
3. Auto-embed: the Ovis UI polls that route and docks Grafana beside the
   pane with no click, and web links default to the panel.
"""
import sys
from pathlib import Path

ROUTE = '''  if (pathname === "/api/fiddy/grafana") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    try {
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const raw = await readFile(`${homedir()}/.config/herdr/plugins/config/fun.fiddy.console/runtime.json`, "utf8");
      const data = JSON.parse(raw);
      return jsonResponse({ url: data.grafana_url ?? null });
    } catch {
      return jsonResponse({ url: null });
    }
  }
'''

EMBED = '''  // Fiddy: the console's Grafana pane publishes its proxy URL; embed it with no click.
  const fiddyGrafana = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch("/api/fiddy/grafana", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        const uri = data?.url as string | null;
        if (!uri || cancelled || uri === fiddyGrafana.current) return;
        const url = panelUrl(uri, window.location);
        if (url === null) return;
        fiddyGrafana.current = uri;
        if (viewing !== null && fileDocked) closeFile();
        setWebPage(url);
      } catch { /* the Fiddy console is optional */ }
    };
    const timer = setInterval(tick, 4000);
    void tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [viewing, fileDocked, closeFile]);
'''


def edit(path, replacements):
    text = path.read_text()
    changed = False
    for old, new, marker in replacements:
        if marker and marker in text:
            continue  # already applied
        if old not in text:
            raise SystemExit("anchor not found in %s: %s" % (path, old[:80]))
        text = text.replace(old, new, 1)
        changed = True
    if changed:
        path.write_text(text)
    print(("patched " if changed else "already ok ") + str(path))


def main(root):
    root = Path(root).expanduser()
    edit(root / "src/App.tsx", [
        ('const APP_TITLE = "Ovis";', 'const APP_TITLE = "Fiddy";', 'APP_TITLE = "Fiddy"'),
        ('<span className="brand-name">\n        Ovis\n      </span>', '<span className="brand-name">\n        Fiddy\n      </span>', '<span className="brand-name">\n        Fiddy'),
        ('· Ovis', '· Fiddy', '· Fiddy'),
    ])
    edit(root / "server/plugin-routes.ts", [
        ('export async function handlePluginRequest(request: Request, url: URL, pathname: string, options: { pluginActionWaitMs?: number }): Promise<Response | null> {\n',
         'export async function handlePluginRequest(request: Request, url: URL, pathname: string, options: { pluginActionWaitMs?: number }): Promise<Response | null> {\n' + ROUTE,
         '/api/fiddy/grafana'),
    ])
    edit(root / "src/lib/useFilePanels.ts", [
        ('  // the panel is no dialog, so no trap gives the focus back when it closes: what opened the file',
         EMBED + '  // the panel is no dialog, so no trap gives the focus back when it closes: what opened the file',
         'fiddyGrafana'),
    ])
    edit(root / "src/lib/settings.ts", [
        ('  webLinks: "tab",', '  webLinks: "panel",', 'webLinks: "panel",'),
    ])
    edit(root / "server/index.ts", [
        ('pathname === "/api/plugins/actions" || pathname === "/api/plugin/action"',
         'pathname === "/api/fiddy/grafana" || pathname === "/api/plugins/actions" || pathname === "/api/plugin/action"',
         'pathname === "/api/fiddy/grafana" || pathname === "/api/plugins/actions"'),
    ])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: ovis_customize.py <ovis-checkout-dir>")
    main(sys.argv[1])
