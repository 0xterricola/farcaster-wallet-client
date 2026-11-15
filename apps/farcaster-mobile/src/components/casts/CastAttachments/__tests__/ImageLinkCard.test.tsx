import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import { ImageLinkCard } from '../ImageLinkCard';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('~/components/Text', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    Text2: ({ children }: { children?: React.ReactNode }) => (
      <Text>{children}</Text>
    ),
  };
});

jest.mock('~/contexts/ThemeProvider', () => ({
  useTheme: () => ({
    colors: { text: { secondary: '#888888' } },
    opacity50: { opacity: 0.5 },
    texts: {},
  }),
  sizes: { s2: 8, s3: 12, s18: 72 },
}));

const openURLSpy = jest.spyOn(Linking, 'openURL').mockImplementation(jest.fn());

describe('ImageLinkCard', () => {
  it('shows the host and file name of the failed picture', () => {
    const { getByText, getByLabelText } = render(
      <ImageLinkCard url="https://media.example/photos/pic-of-a-cat.jpg" />,
    );

    expect(getByText('media.example')).toBeTruthy();
    expect(getByText('pic-of-a-cat.jpg')).toBeTruthy();
    expect(getByLabelText("Image couldn't load — media.example")).toBeTruthy();
  });

  it('opens the source URL when tapped', () => {
    const { getByLabelText } = render(
      <ImageLinkCard url="https://media.example/photos/pic-of-a-cat.jpg" />,
    );

    fireEvent.press(getByLabelText("Image couldn't load — media.example"));

    expect(openURLSpy).toHaveBeenCalledWith(
      'https://media.example/photos/pic-of-a-cat.jpg',
    );
  });

  it('strips www. and never opens a non-https URL', () => {
    const { getByText, rerender } = render(
      <ImageLinkCard url="https://www.example.com/a.png" />,
    );
    expect(getByText('example.com')).toBeTruthy();

    rerender(<ImageLinkCard url="http://media.example/a.png" />);
    expect(getByText("Image couldn't load")).toBeTruthy();

    // Non-https URLs render a card but must not navigate.
    fireEvent.press(getByText("Image couldn't load"));
    expect(openURLSpy).not.toHaveBeenCalled();
  });
});
