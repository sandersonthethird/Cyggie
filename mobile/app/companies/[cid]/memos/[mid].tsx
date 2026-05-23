import { useEffect } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import Markdown from 'react-native-markdown-display'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '../../../../lib/api/client'
import { ErrorBoundary } from '../../../../components/ErrorBoundary'
import { fetchMemo, type MemoDetail } from '../../../../lib/api/memos'
import { useAuthStore } from '../../../../lib/auth/store'
import { colors, radii, spacing, type } from '../../../../theme'

// Memo detail (read-only). Pushed onto the stack from the Memos tab on
// company detail. Renders the latest version's contentMarkdown via the
// same markdown-display library + ErrorBoundary fallback used by the
// meeting Summary tab.
//
// Three render states (CEO Issue 2A):
//   • loading     → spinner
//   • empty       → "This memo is still being drafted on desktop"
//   • markdown    → <Markdown> with the same memoMarkdownStyles theme
//                   meeting Summary uses (copied; T34 tracks the eventual
//                   shared extraction)

export default function MemoDetailScreen() {
  const params = useLocalSearchParams<{ cid: string; mid: string }>()
  const cid = typeof params.cid === 'string' ? params.cid : ''
  const mid = typeof params.mid === 'string' ? params.mid : ''
  const signOut = useAuthStore((s) => s.signOut)

  const query = useQuery({
    queryKey: ['memo', mid],
    queryFn: ({ signal }) => fetchMemo(mid, { signal }),
    enabled: mid.length > 0,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  const memo = query.data

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace(`/companies/${cid}`)
            }
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle} numberOfLines={1}>
            {memo?.title ?? ''}
          </Text>
          <View style={styles.backBtn} />
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.scroll}>
        {renderBody(memo, query.isLoading, query.error)}
      </ScrollView>
    </View>
  )
}

function renderBody(
  memo: MemoDetail | undefined,
  isLoading: boolean,
  error: unknown,
): React.JSX.Element {
  if (isLoading && !memo) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.crimson} />
      </View>
    )
  }
  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Memo not found</Text>
          <Text style={styles.emptySubtitle}>
            This memo may have been deleted on desktop.
          </Text>
        </View>
      )
    }
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Couldn&apos;t load memo</Text>
        <Text style={styles.emptySubtitle}>
          Pull down to try again, or open this memo on desktop.
        </Text>
      </View>
    )
  }
  if (!memo) return <View style={styles.center} />

  const isEmpty =
    !memo.contentMarkdown || memo.contentMarkdown.trim().length === 0
  if (isEmpty) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyTitle}>Empty memo</Text>
        <Text style={styles.emptySubtitle}>
          This memo is still being drafted on desktop. Check back later.
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.section}>
      <View style={styles.headerMeta}>
        <Text style={styles.statusPill}>{memo.status}</Text>
        <Text style={styles.versionMeta}>
          v{memo.latestVersionNumber} · {formatRelative(memo.updatedAt)}
        </Text>
      </View>
      <View style={styles.card}>
        <ErrorBoundary
          fallback={() => (
            <Text style={styles.emptySubtitle}>
              Couldn&apos;t render memo — open on desktop.
            </Text>
          )}
        >
          <Markdown style={memoMarkdownStyles}>{memo.contentMarkdown ?? ''}</Markdown>
        </ErrorBoundary>
      </View>
    </View>
  )
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(iso).toLocaleDateString()
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },

  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topbarTitle: {
    flex: 1,
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },
  pressed: { opacity: 0.6 },

  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  section: { gap: spacing.md },

  center: {
    flex: 1,
    minHeight: 240,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  emptyTitle: { color: colors.text, fontSize: type.h2, fontWeight: '600' },
  emptySubtitle: {
    color: colors.text3,
    fontSize: type.body,
    textAlign: 'center',
    lineHeight: 20,
  },

  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusPill: {
    color: colors.text3,
    fontSize: type.caption,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    backgroundColor: colors.surface3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.sm,
  },
  versionMeta: { color: colors.text3, fontSize: type.bodyTight },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
})

// Mirror of summaryMarkdownStyles in meetings/[id].tsx. T34 tracks the
// eventual shared extraction once a third surface needs the same theme.
const memoMarkdownStyles = StyleSheet.create({
  body: { color: colors.text, fontSize: type.body + 1, lineHeight: 22 },
  heading1: {
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  heading2: {
    color: colors.text,
    fontSize: type.h2 - 2,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  heading3: {
    color: colors.text,
    fontSize: type.body + 2,
    fontWeight: '600',
    marginTop: spacing.sm,
    marginBottom: 4,
  },
  paragraph: { marginTop: 6, marginBottom: 6 },
  bullet_list: { marginTop: 4, marginBottom: 4 },
  ordered_list: { marginTop: 4, marginBottom: 4 },
  list_item: { marginVertical: 2 },
  code_inline: {
    backgroundColor: colors.surface3,
    color: colors.text,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: type.body,
  },
  fence: {
    backgroundColor: colors.surface3,
    color: colors.text,
    padding: spacing.sm,
    borderRadius: radii.sm,
    fontSize: type.bodyTight,
  },
  link: { color: colors.crimson },
  strong: { fontWeight: '700', color: colors.text },
})
