module.exports = function (api) {
  // Invalidate cache when EXPO_ROUTER_APP_ROOT changes — otherwise babel may
  // re-use a stale config in Metro's worker pool.
  api.cache.using(() => process.env.EXPO_ROUTER_APP_ROOT)
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // react-native-reanimated requires its babel plugin LAST.
      'react-native-reanimated/plugin',
    ],
  }
}
