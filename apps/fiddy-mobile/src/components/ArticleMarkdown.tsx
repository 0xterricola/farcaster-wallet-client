import {
  parseArticleMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
  type NodeEmbed,
} from 'farcaster-node-client';
import { useMemo } from 'react';
import { Image, Linking, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '~/theme';

/** Image addresses a reader can show inline; everything else is a link. */
const IMAGE = /\.(png|jpe?g|gif|webp|avif|heic|heif)(\?|#|$)/i;

const isImage = (url: string): boolean => IMAGE.test(url);

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const open = (url: string) => {
  void Linking.openURL(url);
};

/** One inline run: a link is tappable and labelled by its own text. */
const Inline = ({ inline }: { inline: MarkdownInline }) => {
  const style = [
    inline.bold ? styles.bold : null,
    inline.italic ? styles.italic : null,
    inline.strike ? styles.strike : null,
    inline.code ? styles.codeSpan : null,
  ];
  if (inline.kind === 'link') {
    return (
      <Text
        style={[style, styles.link]}
        onPress={() => open(inline.url)}
        accessibilityRole="link"
        accessibilityLabel={inline.text}
      >
        {inline.text}
      </Text>
    );
  }
  return <Text style={style}>{inline.text}</Text>;
};

const Inlines = ({ inlines }: { inlines: MarkdownInline[] }) => (
  <>
    {inlines.map((inline, index) => (
      <Inline key={`${index}-${inline.text.slice(0, 8)}`} inline={inline} />
    ))}
  </>
);

const Embed = ({ embed }: { embed: NodeEmbed }) => {
  if ('castId' in embed) {
    // v1 renders no embedded casts: it says so instead of pretending.
    return (
      <Text style={styles.embedNote}>
        embedded cast · {embed.castId.hash.slice(0, 10)}…
      </Text>
    );
  }
  if (isImage(embed.url)) {
    return (
      <Image
        source={{ uri: embed.url }}
        style={styles.image}
        resizeMode="cover"
        accessible
        accessibilityLabel="Image in the article"
      />
    );
  }
  return (
    <Text
      style={styles.preview}
      onPress={() => open(embed.url)}
      accessibilityRole="link"
      accessibilityLabel={embed.url}
    >
      {hostOf(embed.url)}
    </Text>
  );
};

/**
 * A part's article Markdown, drawn with React Native primitives.
 *
 * Headings are exposed as headings (`accessibilityRole="header"`) so VoiceOver
 * can jump between them; links are in document order and labelled by their own
 * text; a code fence is shown literally. The parse lives in
 * `farcaster-node-client` (`parseArticleMarkdown`), so this file is layout only
 * and the fiddly cases are unit-tested in Node.
 */
export const ArticleMarkdown = ({
  text,
  embeds = [],
}: {
  text: string;
  embeds?: readonly NodeEmbed[];
}) => {
  const blocks = useMemo(
    () => parseArticleMarkdown(text, embeds),
    [text, embeds],
  );

  const render = (block: MarkdownBlock, index: number) => {
    switch (block.kind) {
      case 'heading':
        return (
          <Text
            key={index}
            accessibilityRole="header"
            style={[
              styles.heading,
              block.level === 1 ? styles.h1 : null,
              block.level >= 3 ? styles.h3 : null,
            ]}
          >
            <Inlines inlines={block.inlines} />
          </Text>
        );
      case 'paragraph':
        return (
          <Text key={index} style={styles.paragraph}>
            <Inlines inlines={block.inlines} />
          </Text>
        );
      case 'list':
        return (
          <View key={index} style={styles.list}>
            {block.items.map((item, itemIndex) => (
              <View key={itemIndex} style={styles.listItem}>
                <Text style={styles.marker}>
                  {block.ordered ? `${block.start + itemIndex}.` : '•'}
                </Text>
                <Text style={styles.listText}>
                  <Inlines inlines={item} />
                </Text>
              </View>
            ))}
          </View>
        );
      case 'quote':
        return (
          <View key={index} style={styles.quote}>
            <Text style={styles.quoteText}>
              <Inlines inlines={block.inlines} />
            </Text>
          </View>
        );
      case 'code':
        // Literal on purpose: nothing inside a fence is Markdown to a reader.
        return (
          <Text key={index} style={styles.code}>
            {block.text}
          </Text>
        );
      case 'rule':
        return <View key={index} style={styles.rule} />;
      case 'link':
        return (
          <Text
            key={index}
            style={styles.preview}
            onPress={() => open(block.url)}
            accessibilityRole="link"
            accessibilityLabel={block.url}
          >
            {hostOf(block.url)}
          </Text>
        );
      case 'embed':
        return (
          <View key={index} style={styles.embed}>
            <Embed embed={block.embed} />
          </View>
        );
    }
  };

  return <View style={styles.body}>{blocks.map(render)}</View>;
};

const styles = StyleSheet.create({
  body: {
    gap: spacing.md,
  },
  heading: {
    color: colors.ink,
    fontSize: 21,
    fontWeight: '700',
    lineHeight: 28,
    marginTop: spacing.sm,
  },
  h1: {
    fontSize: 25,
    lineHeight: 32,
  },
  h3: {
    fontSize: 17,
    fontWeight: '700',
  },
  paragraph: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 24,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  strike: {
    textDecorationLine: 'line-through',
  },
  codeSpan: {
    fontFamily: fonts.mono,
    backgroundColor: colors.glassStrong,
  },
  link: {
    color: colors.accent,
    textDecorationLine: 'underline',
  },
  list: {
    gap: spacing.xs,
  },
  listItem: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  marker: {
    color: colors.inkDim,
    fontSize: 16,
    lineHeight: 24,
    minWidth: 18,
  },
  listText: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 24,
    flex: 1,
  },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.hairlineAccent,
    paddingLeft: spacing.md,
  },
  quoteText: {
    color: colors.inkDim,
    fontSize: 16,
    lineHeight: 24,
    fontStyle: 'italic',
  },
  code: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.mono,
    backgroundColor: colors.glassStrong,
    borderRadius: 10,
    padding: spacing.md,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hairline,
    marginVertical: spacing.sm,
  },
  preview: {
    color: colors.accent,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  embed: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  embedNote: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: colors.glass,
    padding: spacing.md,
  },
  image: {
    width: '100%',
    height: 200,
    borderRadius: 14,
    backgroundColor: colors.glass,
  },
});
