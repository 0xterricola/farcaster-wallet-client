/**
 * Tests for nodeEnv configuration.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NODE_URL,
  NODE_PROXY_PATH,
  resolveNodeBaseUrl,
  resolveNodeProxyTarget,
} from '~/snapchain/nodeEnv';

describe('nodeEnv', () => {
  describe('resolveNodeBaseUrl', () => {
    it('uses VITE_SNAPCHAIN_HTTP_URL when it is the page’s own origin', () => {
      const env = { VITE_SNAPCHAIN_HTTP_URL: 'http://192.168.1.100:3381' };
      // Out of a browser (pageOrigin undefined) the URL is used as given.
      expect(resolveNodeBaseUrl(env, undefined)).toBe(
        'http://192.168.1.100:3381',
      );
      expect(resolveNodeBaseUrl(env, 'http://192.168.1.100:3381')).toBe(
        'http://192.168.1.100:3381',
      );
    });

    it('trims whitespace from VITE_SNAPCHAIN_HTTP_URL', () => {
      const env = { VITE_SNAPCHAIN_HTTP_URL: '  http://localhost:3381  ' };
      expect(resolveNodeBaseUrl(env, undefined)).toBe('http://localhost:3381');
    });

    it('uses the same-origin relay when the node URL is another origin', () => {
      // A browser cannot POST to a cross-origin node: the node does not answer
      // the preflight. The dev/preview relay is the working route.
      const env = { VITE_SNAPCHAIN_HTTP_URL: 'http://34.101.47.167:3381' };
      expect(resolveNodeBaseUrl(env, 'https://localhost:5173')).toBe(
        NODE_PROXY_PATH,
      );
    });

    it('lets VITE_SNAPCHAIN_DIRECT=true force a cross-origin URL', () => {
      const env = {
        VITE_SNAPCHAIN_HTTP_URL: 'http://34.101.47.167:3381',
        VITE_SNAPCHAIN_DIRECT: 'true',
      };
      expect(resolveNodeBaseUrl(env, 'https://localhost:5173')).toBe(
        'http://34.101.47.167:3381',
      );
    });

    it('falls back to proxy path when VITE_SNAPCHAIN_HTTP_URL is empty string', () => {
      const env = { VITE_SNAPCHAIN_HTTP_URL: '' };
      expect(resolveNodeBaseUrl(env, 'https://localhost:5173')).toBe(
        NODE_PROXY_PATH,
      );
    });

    it('falls back to proxy path when VITE_SNAPCHAIN_HTTP_URL is unset', () => {
      const env = {};
      expect(resolveNodeBaseUrl(env, 'https://localhost:5173')).toBe(
        NODE_PROXY_PATH,
      );
    });
  });

  describe('resolveNodeProxyTarget', () => {
    it('prefers SNAPCHAIN_HTTP_URL over VITE_ version', () => {
      const env = {
        SNAPCHAIN_HTTP_URL: 'http://server:3381',
        VITE_SNAPCHAIN_HTTP_URL: 'http://client:3381',
      };
      expect(resolveNodeProxyTarget(env)).toBe('http://server:3381');
    });

    it('falls back to VITE_SNAPCHAIN_HTTP_URL when server version unset', () => {
      const env = {
        SNAPCHAIN_HTTP_URL: undefined,
        VITE_SNAPCHAIN_HTTP_URL: 'http://client:3381',
      };
      expect(resolveNodeProxyTarget(env)).toBe('http://client:3381');
    });

    it('falls back to default when both are unset', () => {
      const env = {
        SNAPCHAIN_HTTP_URL: undefined,
        VITE_SNAPCHAIN_HTTP_URL: undefined,
      };
      expect(resolveNodeProxyTarget(env)).toBe(DEFAULT_NODE_URL);
    });

    it('treats empty string as unset', () => {
      const env = {
        SNAPCHAIN_HTTP_URL: '',
        VITE_SNAPCHAIN_HTTP_URL: '',
      };
      expect(resolveNodeProxyTarget(env)).toBe(DEFAULT_NODE_URL);
    });
  });

  describe('constants', () => {
    it('NODE_PROXY_PATH is /snapchain-api', () => {
      expect(NODE_PROXY_PATH).toBe('/snapchain-api');
    });

    it('DEFAULT_NODE_URL is http://127.0.0.1:3381', () => {
      expect(DEFAULT_NODE_URL).toBe('http://127.0.0.1:3381');
    });
  });
});
