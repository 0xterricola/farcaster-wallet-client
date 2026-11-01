import { describe, expect, it } from 'vitest';

import { callerAddress } from '../../server/unfurl/callerAddress.mjs';

const request = (
  headers: Record<string, string>,
  remoteAddress = '10.0.0.1',
) => ({
  headers,
  socket: { remoteAddress },
});

describe('the address a rate window belongs to', () => {
  it('trusts only the last forwarded hop', () => {
    expect(
      callerAddress(request({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })),
    ).toBe('5.6.7.8');
  });

  it('ignores a spoofed Cloudflare header from any other network', () => {
    expect(
      callerAddress(
        request({
          'x-forwarded-for': '5.6.7.8',
          'cf-connecting-ip': '9.9.9.9',
        }),
      ),
    ).toBe('5.6.7.8');
  });

  it('accepts the visitor from Cloudflare over IPv4', () => {
    expect(
      callerAddress(
        request({
          'x-forwarded-for': '162.158.1.2',
          'cf-connecting-ip': '9.9.9.9',
        }),
      ),
    ).toBe('9.9.9.9');
  });

  it('accepts the visitor from Cloudflare over IPv6', () => {
    expect(
      callerAddress(
        request({
          'x-forwarded-for': '2606:4700::1',
          'cf-connecting-ip': '2001:db8::5',
        }),
      ),
    ).toBe('2001:db8::5');
  });

  it('falls back to the Cloudflare hop when the visitor header is junk', () => {
    expect(
      callerAddress(
        request({
          'x-forwarded-for': '162.158.1.2',
          'cf-connecting-ip': 'junk',
        }),
      ),
    ).toBe('162.158.1.2');
  });

  it('uses the socket address when there are no forwarding headers', () => {
    expect(callerAddress(request({}))).toBe('10.0.0.1');
  });
});
