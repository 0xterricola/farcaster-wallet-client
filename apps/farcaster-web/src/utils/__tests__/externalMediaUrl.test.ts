import { describe, expect, it } from 'vitest';

import {
  proxiedExternalMediaUrl,
  secureExternalMediaUrl,
} from '~/utils/externalMediaUrl';

const securePage = { protocol: 'https:', hostname: 'fiddy.fun' } as const;

describe('external media on a secure page', () => {
  it('asks an external HTTP image host over HTTPS without changing the rest', () => {
    expect(
      secureExternalMediaUrl(
        'http://media.example/photo?id=1&size=large#preview',
        securePage,
      ),
    ).toBe('https://media.example/photo?id=1&size=large#preview');
  });

  it('leaves HTTPS URLs byte-identical', () => {
    const url = 'https://media.example/Photo%20One?id=1&size=large';
    expect(secureExternalMediaUrl(url, securePage)).toBe(url);
  });

  it('leaves ordinary HTTP pages alone', () => {
    const url = 'http://media.example/photo.png';
    expect(
      secureExternalMediaUrl(url, {
        protocol: 'http:',
        hostname: 'fiddy.fun',
      }),
    ).toBe(url);
  });

  it('preserves self-hosted, relative, and non-HTTP media URLs', () => {
    for (const url of [
      'http://fiddy.fun/photo.png',
      '/photo.png',
      '../photo.png',
      'data:image/png;base64,AAAA',
      'blob:https://fiddy.fun/photo',
    ]) {
      expect(secureExternalMediaUrl(url, securePage)).toBe(url);
    }
  });

  it('does not rewrite loopback, LAN, or local development hosts', () => {
    for (const hostname of [
      'localhost',
      'media.localhost',
      'printer.local',
      '127.0.0.1',
      '0.0.0.0',
      '10.0.0.4',
      '192.168.1.4',
      '172.16.0.2',
      '172.31.255.254',
      '169.254.1.1',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
    ]) {
      const url = `http://${hostname}/photo.png`;
      expect(secureExternalMediaUrl(url, securePage)).toBe(url);
    }
  });
});

describe('the same-origin picture proxy', () => {
  it("asks the host for another site's picture, address encoded whole", () => {
    expect(
      proxiedExternalMediaUrl(
        'https://media.example/photo?id=1&size=large',
        securePage,
        true,
      ),
    ).toBe(
      '/api/img?u=' +
        encodeURIComponent('https://media.example/photo?id=1&size=large'),
    );
  });

  it('upgrades an HTTP picture and then asks for it, once', () => {
    expect(
      proxiedExternalMediaUrl(
        'http://media.example/photo.png',
        securePage,
        true,
      ),
    ).toBe(
      '/api/img?u=' + encodeURIComponent('https://media.example/photo.png'),
    );
  });

  it("never asks for the host's own pictures, or its uploads", () => {
    for (const url of [
      'https://fiddy.fun/photo.png',
      'https://fiddy.fun/api/fiddy/media/xyz.png',
      '/api/fiddy/media/xyz.png',
      '/photo.png',
    ]) {
      expect(proxiedExternalMediaUrl(url, securePage, true)).toBe(url);
    }
  });

  it("never asks for data:, blob:, or a local host's pictures", () => {
    for (const url of [
      'data:image/png;base64,AAAA',
      'blob:https://fiddy.fun/photo',
      'http://localhost/photo.png',
      'http://127.0.0.1/photo.png',
    ]) {
      expect(proxiedExternalMediaUrl(url, securePage, true)).toBe(
        secureExternalMediaUrl(url, securePage),
      );
    }
  });

  it('does nothing when the build never asked for the proxy, or the page is not secure', () => {
    expect(
      proxiedExternalMediaUrl(
        'https://media.example/photo.png',
        securePage,
        false,
      ),
    ).toBe('https://media.example/photo.png');
    expect(
      proxiedExternalMediaUrl(
        'https://media.example/photo.png',
        { protocol: 'http:', hostname: 'fiddy.fun' },
        true,
      ),
    ).toBe('https://media.example/photo.png');
  });

  it('does not ask twice for a picture already behind the route', () => {
    const behind =
      '/api/img?u=' + encodeURIComponent('https://media.example/photo.png');
    expect(proxiedExternalMediaUrl(behind, securePage, true)).toBe(behind);
  });
});
