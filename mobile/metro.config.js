// Monorepo-aware Metro config.
// Tells Metro to resolve modules from both mobile/node_modules and the root
// node_modules (where npm workspaces hoists shared deps), and to watch the
// workspace packages we depend on (@cyggie/shared, etc.).

const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// Append, don't replace — expo-doctor flags watchFolders that drop the
// defaults (projectRoot is implicit otherwise; losing it breaks Metro's
// own asset resolution in some edge cases and fails EAS Build's
// `expo doctor` step).
config.watchFolders = [...(config.watchFolders ?? []), workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

module.exports = config
