// Adapted from quilcast `src/ui.tsx` `ImgLink` / `Media` (MIT,
// backmeupplz/quilcast): a picture that couldn't be shown becomes a link to
// it — its host and file name — instead of a blank frame with nothing to
// tap. Mobile renders this after CastImageThumbnail's own retry and watchdog
// have given up; it also fits the `fallback` element slot of
// `RemoteImage` for any caller that wants the same card.
//
// Fiddy twist: we link out only over plain https (upstream additionally
// suppresses navigation for look-alike Unicode hosts; we don't ship that
// warning yet — wire the confirmation here once the look-alike host card
// lands).

import { Ionicons } from '@expo/vector-icons';
import React, { FC, memo, useCallback } from 'react';
import { Linking, Pressable, View, ViewStyle } from 'react-native';

import { Text2 } from '~/components/Text';
import { sizes, useTheme } from '~/contexts/ThemeProvider';

const IMAGE_LINK_CARD_LABEL = "Image couldn't load";
const MAX_PATH_SEGMENT_LENGTH = 40;

const truncateMiddle = (value: string): string => {
  if (value.length <= MAX_PATH_SEGMENT_LENGTH) {
    return value;
  }
  const keep = MAX_PATH_SEGMENT_LENGTH - 1;
  const head = value.slice(0, Math.ceil(keep / 2));
  const tail = value.slice(-Math.floor(keep / 2));
  return `${head}…${tail}`;
};

const lastPathSegment = (pathname: string): string => {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments.length > 0 ? segments[segments.length - 1] : '';
  if (!last) {
    return '';
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

type DescribedUrl = {
  hostname: string;
  pathSegment: string;
};

const describeUrl = (url: string): DescribedUrl | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return {
      hostname: parsed.hostname.replace(/^www\./, ''),
      pathSegment: lastPathSegment(parsed.pathname),
    };
  } catch {
    return null;
  }
};

type ImageLinkCardProps = {
  /** Raw (non-proxied) media URL to link out to. */
  url: string;
  height?: number;
  width?: number;
  maxWidth?: number;
  style?: ViewStyle;
};

const ImageLinkCard: FC<ImageLinkCardProps> = memo(
  ({ url, height = 56, width, maxWidth, style }) => {
    const t = useTheme();

    const described = describeUrl(url);

    const handlePress = useCallback(() => {
      // Plain https check for now — the look-alike host confirmation lands
      // with its own card.
      if (described) {
        void Linking.openURL(url);
      }
    }, [described, url]);

    return (
      <Pressable
        accessibilityLabel={`${IMAGE_LINK_CARD_LABEL} — ${described?.hostname ?? ''}`}
        disabled={!described}
        onPress={handlePress}
        style={({ pressed }) => [
          {
            height,
            width,
            maxWidth: maxWidth ?? sizes.s18 * 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: sizes.s2,
            paddingHorizontal: sizes.s3,
          },
          style,
          pressed && t.opacity50,
        ]}
      >
        <Ionicons
          name="image-outline"
          size={20}
          color={t.colors.text.secondary}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text2
            size="xs"
            weight="medium"
            color="secondary"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {described ? described.hostname : IMAGE_LINK_CARD_LABEL}
          </Text2>
          <Text2
            size="2xs"
            color="tertiary"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {described
              ? truncateMiddle(described.pathSegment || url)
              : truncateMiddle(url)}
          </Text2>
        </View>
      </Pressable>
    );
  },
);

ImageLinkCard.displayName = 'ImageLinkCard';

export { IMAGE_LINK_CARD_LABEL, ImageLinkCard };
