import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { NoteFolder } from '../lib/api/notes'
import { NOTES_INBOX_SENTINEL } from '../lib/api/notes'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// NotesFolderPicker — modal sheet for selecting a folder filter on the
// Notes tab. Mirrors the desktop FolderSidebar's three-tier model:
//   • "All notes"   → selection === null
//   • "Inbox"       → selection === NOTES_INBOX_SENTINEL (notes w/ no folder)
//   • <folder path> → selection === "Investments/AI Infrastructure"
//
// Folders arrive flat from the gateway (sorted by path); we build a tree
// here so nested folders indent correctly. The tree is expand/collapse —
// the user can drill in without losing parent context. Tapping any node
// selects it and closes the sheet.
// =============================================================================

interface FolderNode {
  name: string
  fullPath: string
  count: number // self-count (notes directly in this folder)
  children: FolderNode[]
}

interface Props {
  open: boolean
  folders: NoteFolder[]
  inboxCount: number
  totalCount: number
  selection: string | null
  isLoading: boolean
  onSelect: (selection: string | null) => void
  onDismiss: () => void
}

function buildTree(folders: NoteFolder[]): FolderNode[] {
  // Index by path so we can attach to a parent even if the parent has no
  // notes itself (we synthesize zero-count placeholders for missing
  // intermediate segments — matches how desktop renders "Foo/Bar" when
  // only "Foo/Bar" exists, by inferring the "Foo" container).
  const nodeByPath = new Map<string, FolderNode>()
  const roots: FolderNode[] = []

  const ensure = (fullPath: string): FolderNode => {
    const existing = nodeByPath.get(fullPath)
    if (existing) return existing
    const segments = fullPath.split('/')
    const name = segments[segments.length - 1] ?? fullPath
    const node: FolderNode = { name, fullPath, count: 0, children: [] }
    nodeByPath.set(fullPath, node)
    if (segments.length === 1) {
      roots.push(node)
    } else {
      const parentPath = segments.slice(0, -1).join('/')
      const parent = ensure(parentPath)
      parent.children.push(node)
    }
    return node
  }

  for (const f of folders) {
    const node = ensure(f.path)
    node.count = f.count
  }

  const sortRec = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const n of nodes) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

export function NotesFolderPicker({
  open,
  folders,
  inboxCount,
  totalCount,
  selection,
  isLoading,
  onSelect,
  onDismiss,
}: Props): React.JSX.Element {
  const tree = useMemo(() => buildTree(folders), [folders])

  return (
    <Modal
      visible={open}
      animationType="fade"
      transparent
      onRequestClose={onDismiss}
    >
      <Pressable style={styles.overlay} onPress={onDismiss}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Ionicons name="folder-open-outline" size={20} color={colors.crimson} />
            <Text style={styles.headerTitle}>Folders</Text>
          </View>

          {isLoading && folders.length === 0 ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={colors.crimson} />
            </View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listWrap}>
              <RootRow
                label="All notes"
                icon="albums-outline"
                count={totalCount}
                active={selection === null}
                onPress={() => onSelect(null)}
              />
              <RootRow
                label="Inbox"
                icon="file-tray-outline"
                count={inboxCount}
                active={selection === NOTES_INBOX_SENTINEL}
                onPress={() => onSelect(NOTES_INBOX_SENTINEL)}
              />
              {tree.length === 0 ? (
                <Text style={styles.noFolders}>
                  No folders yet. Create folders on desktop to organize notes.
                </Text>
              ) : (
                tree.map((node) => (
                  <FolderTreeNode
                    key={node.fullPath}
                    node={node}
                    depth={0}
                    selection={selection}
                    onSelect={onSelect}
                  />
                ))
              )}
            </ScrollView>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close folders"
            onPress={onDismiss}
            style={({ pressed }) => [
              styles.cancelBtn,
              pressed && styles.cancelBtnPressed,
            ]}
          >
            <Text style={styles.cancelText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function RootRow({
  label,
  icon,
  count,
  active,
  onPress,
}: {
  label: string
  icon: keyof typeof Ionicons.glyphMap
  count: number
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} note${count === 1 ? '' : 's'}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        active && styles.rowActive,
        pressed && styles.rowPressed,
      ]}
    >
      <Ionicons
        name={icon}
        size={18}
        color={active ? colors.crimson : colors.text3}
      />
      <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.rowCount, active && styles.rowCountActive]}>{count}</Text>
    </Pressable>
  )
}

function FolderTreeNode({
  node,
  depth,
  selection,
  onSelect,
}: {
  node: FolderNode
  depth: number
  selection: string | null
  onSelect: (selection: string | null) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children.length > 0
  const active = selection === node.fullPath

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${node.fullPath}, ${node.count} note${node.count === 1 ? '' : 's'}`}
        onPress={() => onSelect(node.fullPath)}
        style={({ pressed }) => [
          styles.row,
          { paddingLeft: spacing.md + depth * 16 },
          active && styles.rowActive,
          pressed && styles.rowPressed,
        ]}
      >
        {hasChildren ? (
          <Pressable
            onPress={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
            hitSlop={8}
            style={styles.chevronBtn}
          >
            <Ionicons
              name={expanded ? 'chevron-down' : 'chevron-forward'}
              size={14}
              color={colors.text3}
            />
          </Pressable>
        ) : (
          <View style={styles.chevronSpacer} />
        )}
        <Ionicons
          name={active ? 'folder' : 'folder-outline'}
          size={18}
          color={active ? colors.crimson : colors.text3}
        />
        <Text
          style={[styles.rowLabel, active && styles.rowLabelActive]}
          numberOfLines={1}
        >
          {node.name}
        </Text>
        {node.count > 0 && (
          <Text style={[styles.rowCount, active && styles.rowCountActive]}>
            {node.count}
          </Text>
        )}
      </Pressable>
      {hasChildren && expanded && (
        <View>
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: spacing.lg,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: spacing.md,
  },
  headerTitle: {
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '700',
  },
  list: {
    maxHeight: 480,
  },
  listWrap: {
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
  },
  rowPressed: {
    backgroundColor: colors.surface3,
  },
  rowActive: {
    backgroundColor: colors.crimsonMuted,
  },
  rowLabel: {
    flex: 1,
    color: colors.text,
    fontSize: type.body,
    fontWeight: '500',
  },
  rowLabelActive: {
    color: colors.crimson,
    fontWeight: '600',
  },
  rowCount: {
    color: colors.text4,
    fontSize: type.bodyTight,
    fontVariant: ['tabular-nums'],
  },
  rowCountActive: {
    color: colors.crimson,
  },
  chevronBtn: {
    width: 16,
    alignItems: 'center',
  },
  chevronSpacer: {
    width: 16,
  },
  noFolders: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  emptyState: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  cancelBtn: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnPressed: {
    backgroundColor: colors.surface3,
  },
  cancelText: {
    color: colors.text2,
    fontSize: type.body,
    fontWeight: '600',
  },
})
