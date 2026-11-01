// The shell bootstrap: runs in <head>, before the document paints, as a plain
// same-origin script.
//
// It lives in its own file rather than inline in index.html so the served shell
// needs no 'unsafe-inline' in script-src: the client's CSP is `script-src 'self'`
// and this file is 'self'. Anything moved back inline widens the CSP again.
//
// It must be a CLASSIC script (no type="module", no defer): a module script is
// deferred, and a deferred bootstrap runs after the body is parsed — which is
// exactly the light flash this file exists to prevent.
//
// TWO THINGS, ONE PASS, BEFORE THE FIRST PAINT:
//
//   1. the saved light/dark choice (as it has always done here);
//   2. the saved LOOK — a palette a person made or put on — written as the same
//      CSS variables `~/utils/lookTheme.ts` writes at runtime. The variables are
//      the only thing that crosses this seam: a colour is written only if it is
//      `#rrggbb`, a size only as a whole number in range, and a variable name
//      only if it is on one of the lists below — so nothing a look holds can
//      become CSS, a property name, or a fetch. `lookTheme.test.ts` holds this
//      file's names to lookTheme's, because a second copy of them that drifts is
//      how a flash of the previous palette comes back.
(function () {
  var STORAGE_KEY = 'user-saved-theme';
  var LOOK_KEY = 'fiddy-look';
  // Fiddy is a dark client: an unset preference resolves to dark, not to the OS,
  // so the shell never flashes the fork's light ground.
  var DEFAULT_THEME = 'dark';

  var root = document.documentElement;

  // The look's own palette variables: the css variable each look token writes.
  var VAR_OF_TOKEN = {
    bg: '--fiddy-bg',
    card: '--fiddy-bg-raise',
    ink: '--fiddy-ink',
    muted: '--fiddy-ink-dim',
    accent: '--fiddy-accent',
    onAccent: '--fiddy-on-accent',
    line: '--fiddy-line',
    soft: '--fiddy-soft',
    like: '--fiddy-like',
    recast: '--fiddy-recast',
    border: '--fiddy-look-line',
  };
  // The fork's app aliases, which the same tokens also fill.
  var VAR_OF_ALIAS = {
    '--bg-app': 'bg',
    '--text-default': 'ink',
    '--bg-muted': 'soft',
    '--text-muted': 'muted',
    '--border-default': 'line',
    '--bg-elevated': 'card',
    '--bg-action-primary': 'accent',
    '--bg-action-secondary': 'soft',
  };
  // The two sizes, and the faces this client already has.
  var SIZES = {
    '--fiddy-radius': ['round', 24],
    '--fiddy-look-border': ['borderWidth', 4],
  };
  var FONTS = {
    rounded: "'SF Pro Rounded', ui-rounded, system-ui, sans-serif",
    inter: "'Inter', sans-serif",
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  };
  var DEFAULTS = {
    bg: '#161715',
    card: '#1d1e1c',
    ink: '#eef0e8',
    muted: '#9ba193',
    line: '#2b2c29',
    soft: '#1d1e1c',
    accent: '#d4ff3f',
    onAccent: '#1a1c10',
    like: '#ff6f9c',
    recast: '#7cb518',
    border: '#2b2c29',
    round: 18,
    borderWidth: 1,
    font: 'rounded',
  };
  var HEX = /^#[0-9a-f]{6}$/i;

  try {
    var stored = localStorage.getItem(STORAGE_KEY);
    var userSavedTheme = stored || DEFAULT_THEME;

    var effective = userSavedTheme;
    if (userSavedTheme === 'system') {
      var prefersDark = window.matchMedia(
        '(prefers-color-scheme: dark)',
      ).matches;
      effective = prefersDark ? 'dark' : 'light';
    }

    var look = null;
    try {
      var raw = localStorage.getItem(LOOK_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          look = parsed;
        }
      }
    } catch (e) {
      look = null;
    }

    if (look) {
      var colour = function (token) {
        var own = look[token];
        return typeof own === 'string' && HEX.test(own)
          ? own.toLowerCase()
          : DEFAULTS[token];
      };
      var whole = function (token, max) {
        var own = Number(look[token]);
        return isFinite(own)
          ? Math.min(Math.max(Math.round(own), 0), max)
          : DEFAULTS[token];
      };

      for (var token in VAR_OF_TOKEN) {
        root.style.setProperty(VAR_OF_TOKEN[token], colour(token));
      }
      for (var alias in VAR_OF_ALIAS) {
        root.style.setProperty(alias, colour(VAR_OF_ALIAS[alias]));
      }
      for (var size in SIZES) {
        root.style.setProperty(
          size,
          whole(SIZES[size][0], SIZES[size][1]) + 'px',
        );
      }
      root.style.setProperty(
        '--fiddy-font',
        FONTS[look.font] || FONTS[DEFAULTS.font],
      );

      root.setAttribute('data-look', 'yours');
      var base = look.base === 'light' || look.base === 'dark' ? look.base : '';
      if (base) {
        // The look's own ground wins over the saved light/dark choice, which is
        // what putting a look on writes back to that choice.
        root.setAttribute('data-look-base', base);
        effective = base;
      }
    }

    root.classList.toggle('dark', effective === 'dark');
    root.classList.toggle('light', effective === 'light');
    root.setAttribute('data-theme', userSavedTheme);
  } catch (e) {
    // Fallback if localStorage is unavailable
    var fallbackDark = window.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches;
    root.classList.toggle('dark', fallbackDark);
    root.classList.toggle('light', !fallbackDark);
  }
})();
