/**
 * The picture cache: bounded by bytes, by entries and by a single picture's
 * size, and honest about how often it answered.
 *
 * The numbers are the ones a self-hosted box can afford, and they are env
 * overridable (`FIDDY_IMG_CACHE_*`): 64 MB / 20000 entries / nothing over 2 MB
 * / a picture kept a day / a miss held ten minutes. A miss is held at all so a
 * broken avatar URL costs one fetch per ten minutes, not one per render.
 *
 * `hits`, `misses` and `bytesServed` are the measurement the box's bandwidth
 * becomes: `/unfurl/health` reports them, and the service log writes one line
 * every `LOG_EVERY` requests. A hit rate read off the box is a number; "the
 * proxy should help" is a guess.
 */

export const CACHE_DEFAULTS = {
  bytes: 64_000_000,
  count: 20_000,
  big: 2_000_000,
  ttl: 24 * 60 * 60 * 1000,
  miss: 10 * 60 * 1000,
};

export const createImageCache = ({
  bytes = CACHE_DEFAULTS.bytes,
  count = CACHE_DEFAULTS.count,
  big = CACHE_DEFAULTS.big,
  ttl = CACHE_DEFAULTS.ttl,
  miss = CACHE_DEFAULTS.miss,
  now = Date.now,
} = {}) => {
  /** key → { value, size, until } in least-recently-used-last order. */
  const kept = new Map();
  /** key → the load already under way, so two readers of one avatar cost one fetch. */
  const loading = new Map();
  const counters = { hits: 0, misses: 0, fetches: 0, notFound: 0, bytesServed: 0 };
  let total = 0;

  const drop = (key) => {
    const entry = kept.get(key);
    if (!entry) {
      return;
    }
    total -= entry.size;
    kept.delete(key);
  };

  const trim = () => {
    for (const key of kept.keys()) {
      if (total <= bytes && kept.size <= count) {
        return;
      }
      drop(key);
    }
  };

  return {
    /**
     * The value for `key`, loading it with `load()` when it is not held.
     *
     * A load that throws is not kept (a timeout is not "nothing there"), and a
     * load that resolves `null` is kept for `miss` (something answered, and the
     * answer was "not a picture"). A picture bigger than `big` is served but
     * not kept.
     */
    async get(key, load) {
      const entry = kept.get(key);
      if (entry && entry.until > now()) {
        counters.hits += 1;
        counters.bytesServed += entry.size;
        // Refresh its place in the order.
        kept.delete(key);
        kept.set(key, entry);
        return entry.value;
      }
      if (entry) {
        drop(key);
      }
      let running = loading.get(key);
      if (!running) {
        counters.misses += 1;
        counters.fetches += 1;
        running = Promise.resolve()
          .then(load)
          .then((value) => {
            const size = value?.body?.length ?? 0;
            if (size > 0 && size <= big) {
              drop(key);
              kept.set(key, { value, size, until: now() + ttl });
              total += size;
              trim();
            } else if (!value) {
              kept.set(key, { value: null, size: 0, until: now() + miss });
              trim();
            }
            return value;
          })
          .finally(() => {
            loading.delete(key);
          });
        loading.set(key, running);
      }
      const value = await running;
      if (value) {
        counters.bytesServed += value.body?.length ?? 0;
      } else {
        counters.notFound += 1;
      }
      return value;
    },

    /** A picture the route says is no longer wanted (410 from a push is not this, but a takedown might be). */
    forget(key) {
      drop(key);
    },

    stats() {
      const answered = counters.hits + counters.misses;
      return {
        entries: kept.size,
        bytes: total,
        hitRate: answered === 0 ? null : Math.round((counters.hits / answered) * 1000) / 1000,
        ...counters,
      };
    },
  };
};