import { Animated, StyleProp, StyleSheet, Text as RNText, TextProps, TextStyle } from 'react-native';
import { useFonts } from 'expo-font';

// Switzer ships as one static file per weight; React Native picks a file by family name, not by fontWeight.
const FILES = {
  'Switzer-Regular': require('../assets/fonts/Switzer-Regular.ttf'),
  'Switzer-Medium': require('../assets/fonts/Switzer-Medium.ttf'),
  'Switzer-Semibold': require('../assets/fonts/Switzer-Semibold.ttf'),
};
export const useSwitzer = () => useFonts(FILES)[0];

export const familyFor = (style: StyleProp<TextStyle>) => {
  const w = String(StyleSheet.flatten(style)?.fontWeight ?? '400');
  return w === '500' ? 'Switzer-Medium' : Number(w) >= 600 || w === 'bold' ? 'Switzer-Semibold' : 'Switzer-Regular';
};

export const Text = ({ style, ...rest }: TextProps) => <RNText {...rest} style={[style, { fontFamily: familyFor(style), fontWeight: 'normal' }]} />;
export const AnimatedText = Animated.createAnimatedComponent(Text);
