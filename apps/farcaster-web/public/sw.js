/**
 * The phone's half of alerts: this worker does ONE thing.
 *
 * IT SHOWS WHAT THE HOST SENT, and it opens the app when the person taps.
 * Nothing else — and deliberately nothing else:
 *
 *   * NO `fetch` handler. NO cache. A service worker that answers fetches
 *     would serve yesterday's bundle PAST both gates that keep this app honest:
 *     the release ritual that verifies served assets byte-identical, and
 *     `init/initReloadOnStaleChunks.ts`, which owns what happens when the host
 *     is running a newer build than the tab. A caching worker would break both
 *     silently, so this file never registers interest in a request. If a future
 *     change adds one, the release gate's byte-comparison is the test that
 *     fails loudly.
 *   * NO PLUMBING WORDS in what it shows: a person sees "Maya and 4 others
 *     liked your cast", never a subscription, an endpoint or a VAPID.
 *
 * The message it receives is already unreadable to the push service that
 * carried it (RFC 8291, decrypted by the browser, not by this file): it is a
 * small JSON { title, body, url, tag, kind }. A `tag` lets a newer
 * notification replace an older one on the phone, which is how a burst of
 * likes becomes one moving line instead of a stack.
 */

self.addEventListener('push', (event) => {
  if (!event.data) {
    // An empty push is the push service's own heartbeat; showing anything for
    // it would be inventing a message nobody sent.
    return;
  }
  /** @type {{title?: string, body?: string, url?: string, tag?: string}} */
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Fiddy', {
      body: payload.body,
      tag: payload.tag,
      // The phone replaces an older line with the same tag instead of stacking.
      renotify: payload.tag !== undefined,
      icon: '/fiddy-mark-poster.png',
      badge: '/fiddy-mark-poster.png',
      data: { url: payload.url || '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/notifications';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          // A tab that is already open is brought forward and sent there, rather
          // than stacking a second window for a person who only has one.
          if ('focus' in client) {
            client.focus();
            if ('navigate' in client && url.startsWith('/')) {
              return client.navigate(url).catch(() => undefined);
            }
            return undefined;
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
