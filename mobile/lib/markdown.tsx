import { Linking, StyleSheet } from 'react-native'
import Markdown, { MarkdownIt } from 'react-native-markdown-display'
import { colors, radii, spacing, type } from '../theme'

const md = MarkdownIt({ typographer: true, linkify: true })

export const richMarkdownStyles = StyleSheet.create({
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

export const chatMarkdownStyles = StyleSheet.create({
  ...richMarkdownStyles,
  heading1: { ...richMarkdownStyles.heading1, marginTop: 8, marginBottom: 0 },
  heading2: { ...richMarkdownStyles.heading2, marginTop: 8, marginBottom: 0 },
  heading3: { ...richMarkdownStyles.heading3, marginTop: 6, marginBottom: 0 },
  paragraph: { marginTop: 4, marginBottom: 4 },
  bullet_list: { marginTop: 2, marginBottom: 2 },
  ordered_list: { marginTop: 2, marginBottom: 2 },
})

export function handleLinkPress(url: string): boolean {
  Linking.openURL(url).catch((err: unknown) => {
    console.warn('[RichMarkdown] failed to open link', { url, err: String(err) })
  })
  return false
}

type RichMarkdownProps = {
  children: string | null | undefined
  style?: StyleSheet.NamedStyles<unknown>
}

export function RichMarkdown({ children, style }: RichMarkdownProps) {
  const safe = typeof children === 'string' ? children : ''
  return (
    <Markdown markdownit={md} onLinkPress={handleLinkPress} style={style ?? richMarkdownStyles}>
      {safe}
    </Markdown>
  )
}

export function stripMarkdown(input: string | null | undefined): string {
  if (typeof input !== 'string' || input.length === 0) return ''
  return input
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(^|\W)\*(?!\*)([^*]+)\*/g, '$1$2')
    .replace(/(^|\W)_([^_]+)_/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}
