import LottieView from 'lottie-react-native';

// The logo animation, looped while something loads.
export const Loader = ({ size = 112 }: { size?: number }) => (
  <LottieView source={require('../assets/logo-loader.json')} autoPlay loop style={{ width: size, height: size }} />
);
