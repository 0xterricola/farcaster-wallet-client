/**
 * Which addresses this service may reach. The deny list, in one place.
 *
 * `/api/img` is a fetcher that takes a URL from a stranger, so the ONLY
 * question that matters is whether the address it is about to connect to is on
 * the public internet. A check that runs before the request (resolve the host,
 * compare the answer, then connect by name) has a window a hostile DNS server
 * can walk through — the second lookup answers differently. So the check lives
 * inside the socket's own `lookup` (`fetch.mjs` passes this as the `lookup`
 * option), which is the resolution the socket connects with: there is no
 * second answer to swap.
 *
 * Everything here is a pure function of a string, which is what makes the
 * rules testable without a network (see `src/__tests__/imageProxy.test.ts`).
 */

/** The IPv4 ranges that are not "somewhere on the public internet". */
const BLOCKED_V4 = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT (and Tailscale)'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const ipv4Bytes = (host) => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return undefined;
  }
  const bytes = match.slice(1).map((each) => Number(each));
  return bytes.every((each) => each <= 255) ? bytes : undefined;
};

const inV4Range = ([a, b, c, d], [base, bits]) => {
  const [w, x, y, z] = base.split('.').map(Number);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const left = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const right = ((w << 24) | (x << 16) | (y << 8) | z) >>> 0;
  return ((left & mask) >>> 0) === ((right & mask) >>> 0);
};

/**
 * The 16 bytes of an IPv6 address, or undefined when the text is not one.
 * Handles `::` compression, an embedded dotted quad (`::ffff:127.0.0.1`) and a
 * zone id (`fe80::1%eth0` — a link-local address the caller names a NIC for).
 */
export const ipv6Bytes = (text) => {
  const bare = text.split('%')[0].toLowerCase();
  if (!bare.includes(':')) {
    return undefined;
  }
  const halves = bare.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const groupsOf = (part) => {
    if (part === '') {
      return [];
    }
    const parts = part.split(':');
    const out = [];
    for (const [index, each] of parts.entries()) {
      const last = index === parts.length - 1;
      const quad = last ? ipv4Bytes(each) : undefined;
      if (quad) {
        out.push(((quad[0] << 8) | quad[1]).toString(16), ((quad[2] << 8) | quad[3]).toString(16));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(each)) {
        return undefined;
      }
      out.push(each);
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!head || !tail) {
    return undefined;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) {
    return undefined;
  }
  const groups = [...head, ...new Array(Math.max(0, missing)).fill('0'), ...tail];
  if (groups.length !== 8) {
    return undefined;
  }
  const bytes = [];
  for (const group of groups) {
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
};

const v4FromBytes = (bytes, offset) => [
  bytes[offset],
  bytes[offset + 1],
  bytes[offset + 2],
  bytes[offset + 3],
];

/**
 * Why this address may not be fetched, or undefined when it may.
 *
 * A public address answers undefined; anything else answers a short reason the
 * service can log and the caller can read without learning anything about the
 * network behind it.
 */
export const blockedReason = (address) => {
  const text = String(address ?? '').trim().toLowerCase();
  if (text === '') {
    return 'no address';
  }
  const quad = ipv4Bytes(text);
  if (quad) {
    const hit = BLOCKED_V4.find((range) => inV4Range(quad, range));
    return hit ? hit[2] : undefined;
  }
  const six = ipv6Bytes(text);
  if (!six) {
    return 'not an address';
  }
  const allZero = six.every((each) => each === 0);
  if (allZero) {
    return 'this network';
  }
  const loopback = six.slice(0, 15).every((each) => each === 0) && six[15] === 1;
  if (loopback) {
    return 'loopback';
  }
  const firstTenZero = six.slice(0, 10).every((each) => each === 0);
  const firstTwelveZero = six.slice(0, 12).every((each) => each === 0);
  // ::ffff:a.b.c.d — an IPv4 address written as IPv6, which the OS would
  // connect to as IPv4. Judge the address it really is.
  if (firstTenZero && six[10] === 0xff && six[11] === 0xff) {
    return blockedReason(v4FromBytes(six, 12).join('.'));
  }
  // ::a.b.c.d — the deprecated IPv4-compatible form, same idea.
  if (firstTwelveZero && six.slice(12).some((each) => each !== 0)) {
    return blockedReason(v4FromBytes(six, 12).join('.'));
  }
  // 64:ff9b::/96 — NAT64, which reaches an IPv4 address through a translator.
  if (six[0] === 0x00 && six[1] === 0x64 && six[2] === 0xff && six[3] === 0x9b) {
    return blockedReason(v4FromBytes(six, 12).join('.'));
  }
  if ((six[0] & 0xfe) === 0xfc) {
    return 'unique-local';
  }
  if (six[0] === 0xfe && (six[1] & 0xc0) === 0x80) {
    return 'link-local';
  }
  if (six[0] === 0xff) {
    return 'multicast';
  }
  // 2001:db8::/32 documentation, 2002::/16 6to4 (it wraps an IPv4 address).
  if (six[0] === 0x20 && six[1] === 0x01 && six[2] === 0x0d && six[3] === 0xb8) {
    return 'documentation';
  }
  if (six[0] === 0x20 && six[1] === 0x02) {
    return '6to4';
  }
  return undefined;
};

/**
 * A `lookup` for the socket, with every answer checked.
 *
 * `node:dns`' `lookup(hostname, options, callback)` answers ONE address (or an
 * array with `all: true`). This answers the same shape, after refusing a host
 * that resolves to an address we may not reach. A host that resolves to both a
 * public and a private address is refused: the resolver does not promise which
 * one the socket would take, so allowing it would be a guess.
 */
export const guardedLookup = (lookup) => (hostname, options, callback) => {
  const askAll = typeof options === 'object' && options !== null && options.all === true;
  try {
    lookup(hostname, { ...(typeof options === 'object' ? options : {}), all: true }, (error, address, family) => {
      if (error) {
        callback(error);
        return;
      }
      const all = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
      // ANY private answer refuses the host. A resolver that answers both a
      // public and a private address does not promise which one the socket
      // takes, so allowing it would be a guess.
      const bad = all
        .map((each) => ({ each, reason: blockedReason(each.address) }))
        .find(({ reason }) => reason !== undefined);
      if (bad) {
        callback(new RefusedAddressError(hostname, bad.each.address, bad.reason));
        return;
      }
      if (askAll) {
        callback(null, all);
        return;
      }
      const first = all[0];
      if (!first) {
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
        return;
      }
      callback(null, first.address, first.family ?? 4);
    });
  } catch (error) {
    callback(error);
  }
};

/** The one error a blocked host raises, carrying the reason and never the bytes. */
export class RefusedAddressError extends Error {
  constructor(hostname, address, reason) {
    super(`${hostname} resolves to ${reason}`);
    this.name = 'RefusedAddressError';
    this.code = 'IMG_ADDRESS_REFUSED';
    this.hostname = hostname;
    this.address = address;
    this.reason = reason;
  }
}