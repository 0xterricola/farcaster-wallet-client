// Technique adapted from backmeupplz/quilcast commit 5f56d44998fd (MIT):
// https://github.com/backmeupplz/quilcast/commit/5f56d44998fd
import { BlockList, isIP } from 'node:net';

// Cloudflare's published ranges: https://www.cloudflare.com/ips-v4 and ips-v6.
// Only a hop in one of these ranges may name the visitor in CF-Connecting-IP.
const CLOUDFLARE = new BlockList();
for (const range of [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]) {
  const [address, prefix] = range.split('/');
  CLOUDFLARE.addSubnet(address, Number(prefix), 'ipv4');
}
for (const range of [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]) {
  const [address, prefix] = range.split('/');
  CLOUDFLARE.addSubnet(address, Number(prefix), 'ipv6');
}

/** A rate-limit key only: never identity, analytics, or a log field. */
export const callerAddress = (request) => {
  const hop =
    String(request.headers['x-forwarded-for'] ?? '')
      .split(',')
      .pop()
      .trim() ||
    request.socket?.remoteAddress ||
    'unknown';
  const version = isIP(hop);
  if (!version) {
    return hop;
  }
  const family = version === 4 ? 'ipv4' : 'ipv6';
  if (!CLOUDFLARE.check(hop, family)) {
    return hop;
  }
  const visitor = String(request.headers['cf-connecting-ip'] ?? '').trim();
  return isIP(visitor) ? visitor : hop;
};
