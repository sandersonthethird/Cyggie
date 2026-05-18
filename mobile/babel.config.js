module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // react-native-reanimated requires its babel plugin LAST.
      'react-native-reanimated/plugin',
    ],
  }
}
