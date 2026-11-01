import { arePathsRelated, hydratePath } from '~/utils/navUtils';

describe('navUtils', () => {
  describe('hydratePath', () => {
    /**
     * Links to an account whose name the app owns are built in the explicit
     * `/u` namespace. Without this, a mention of @feed (or the profile's own
     * tab links) would point at `/feed` — the app's path — and land on the
     * front door instead of the account.
     */
    it('addresses a reserved handle through /u', () => {
      expect(
        hydratePath({
          path: '/:username',
          params: { username: 'feed' },
          searchParams: undefined,
        }),
      ).toBe('/u/feed');

      expect(
        hydratePath({
          path: '/:username/likes',
          params: { username: 'Feed' },
          searchParams: undefined,
        }),
      ).toBe('/u/Feed/likes');

      expect(
        hydratePath({
          path: '/:username/likes',
          params: { username: 'feed' },
          searchParams: { castHash: '0xabc' },
        }),
      ).toBe('/u/feed/likes?castHash=0xabc');

      expect(
        hydratePath({
          path: '/:username/:castHashPrefix',
          params: { username: 'feed', castHashPrefix: '0xdeadbeef' },
          searchParams: undefined,
        }),
      ).toBe('/u/feed/0xdeadbeef');
    });

    it('leaves a normal handle, and every other route, untouched', () => {
      expect(
        hydratePath({
          path: '/:username',
          params: { username: 'alice' },
          searchParams: undefined,
        }),
      ).toBe('/alice');

      expect(
        hydratePath({
          path: '/:username/pack/:id',
          params: { username: 'alice', id: '9' },
          searchParams: undefined,
        }),
      ).toBe('/alice/pack/9');

      // `username` under the app prefix is not a handle: `/~/r/alice` is a
      // referral link, and it keeps its own shape.
      expect(
        hydratePath({
          path: '/~/r/:username',
          params: { username: 'feed' },
          searchParams: undefined,
        }),
      ).toBe('/~/r/feed');

      expect(
        hydratePath({
          path: '/~settings/storage',
          params: {},
          searchParams: undefined,
        }),
      ).toBe('/~settings/storage');
    });
  });

  describe('arePathsRelated', () => {
    it('should determine if paths are related', () => {
      expect(arePathsRelated('/', '/')).toEqual(true);
      expect(arePathsRelated('/', '/bob')).toEqual(false);
      expect(arePathsRelated('/', '/~/debug')).toEqual(false);
      expect(arePathsRelated('/~/download', '/~/notifications')).toEqual(false);
      expect(arePathsRelated('/~/download', '/~/download')).toEqual(true);
      expect(arePathsRelated('/bob', '/bob')).toEqual(true);
      expect(arePathsRelated('/bob', '/not-bob')).toEqual(false);
      expect(arePathsRelated('/bob', '/bob/casts')).toEqual(true);
      expect(arePathsRelated('/bob/casts', '/bob/casts/1')).toEqual(true);

      expect(
        arePathsRelated('/bob/casts', '/bob/casts/1/some-other-param'),
      ).toEqual(true);

      expect(
        arePathsRelated(
          '/bob/casts',
          '/bob/casts/1/some-other-path-segment?query-param=val',
        ),
      ).toEqual(true);
    });
  });
});
