// Monorepo-aware Metro config.
// Tells Metro to resolve modules from both mobile/node_modules and the root
// node_modules (where npm workspaces hoists shared deps), and to watch the
// workspace packages we depend on (@cyggie/shared, etc.).

const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// Keep test files out of the Metro bundle. The `app/` tree is globbed by Expo
// Router's `require.context` (see expo-router/_ctx.*.js), whose regex matches
// every *.tsx under app/ except `+api`/`+html`/`+middleware` — it does NOT skip
// `.test.tsx` or `__tests__`/`__ui-tests__` dirs. A co-located test would then be
// evaluated as a route, running `jest.fn()` at module load → runtime crash.
// blockList removes these files from resolution (and thus from require.context).
//
//   require.context(app/)  ──►  blockList filters  ──►  routes only
//        *.test.tsx                /\.(test|spec)\./       (no test modules
//        __ui-tests__/             /__(ui-)?tests__\//      reach the bundle)
//
// Append to (don't replace) Expo's default blockList. blockList is a single
// RegExp (or array) of absolute paths to exclude; combine the existing pattern
// with ours into one RegExp by OR-ing their sources. (We build this by hand
// rather than via metro's exclusionList helper, whose subpath isn't stable
// across metro's package "exports" map.)
const existingBlockList = config.resolver.blockList
const existingPatterns = Array.isArray(existingBlockList)
  ? existingBlockList
  : existingBlockList
    ? [existingBlockList]
    : []
const testFilePatterns = [/\.(test|spec)\.[jt]sx?$/, /[\\/]__(ui-)?tests__[\\/]/]
config.resolver.blockList = new RegExp(
  [...existingPatterns, ...testFilePatterns].map((re) => `(?:${re.source})`).join('|'),
)

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
