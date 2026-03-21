import { useMemo, useRef, useState } from 'react'
import type { TagSuggestion } from '../../../shared/types/note'
import styles from './FolderSidebar.module.css'

interface FolderNode {
  name: string
  fullPath: string
  children: FolderNode[]
}

/** Sentinel value passed to onSelect when the Inbox item is clicked. */
export const INBOX_SENTINEL = '__inbox__'

interface NodeHandlers {
  onSelect: (path: string | null) => void
  onDismissSuggestion: (folderPath: string) => void
  onAcceptSuggestion: (folderPath: string, suggestion: TagSuggestion) => void
  onRenameFolder: (oldPath: string, newPath: string) => Promise<void>
  onDeleteFolder: (path: string) => Promise<void>
}

interface Props {
  folders: string[]
  selected: string | null
  isInboxActive: boolean
  onSelect: (path: string | null) => void
  tagSuggestions: Map<string, TagSuggestion>
  onDismissSuggestion: (folderPath: string) => void
  onAcceptSuggestion: (folderPath: string, suggestion: TagSuggestion) => void
  importSources: string[]
  selectedImportSource: string | null
  onSelectImportSource: (source: string | null) => void
  onCreateFolder: (path: string) => Promise<void>
  onRenameFolder: (oldPath: string, newPath: string) => Promise<void>
  onDeleteFolder: (path: string) => Promise<void>
}

/** Build a nested tree from a flat sorted array of folder paths. */
export function buildFolderTree(paths: string[]): FolderNode[] {
  const roots: FolderNode[] = []
  const nodeMap = new Map<string, FolderNode>()

  for (const fullPath of paths) {
    const segments = fullPath.split('/')
    let currentPath = ''
    let parentNode: FolderNode | null = null

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      if (!nodeMap.has(currentPath)) {
        const node: FolderNode = { name: segment, fullPath: currentPath, children: [] }
        nodeMap.set(currentPath, node)
        if (parentNode) {
          parentNode.children.push(node)
        } else {
          roots.push(node)
        }
      }
      parentNode = nodeMap.get(currentPath)!
    }
  }

  return roots
}

interface FolderNodeItemProps {
  node: FolderNode
  depth: number
  selected: string | null
  tagSuggestions: Map<string, TagSuggestion>
  handlers: NodeHandlers
}

function FolderNodeItem({ node, depth, selected, tagSuggestions, handlers }: FolderNodeItemProps) {
  const [expanded, setExpanded] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const hasChildren = node.children.length > 0
  const isActive = selected === node.fullPath
  const suggestion = tagSuggestions.get(node.fullPath)

  const startRename = () => {
    setIsRenaming(true)
    setRenameValue(node.name)
    setMenuOpen(false)
    // focus is handled by autoFocus on the input
  }

  const commitRename = async (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || trimmed === node.name) {
      setIsRenaming(false)
      return
    }
    const lastSlash = node.fullPath.lastIndexOf('/')
    const parentPath = lastSlash > -1 ? node.fullPath.substring(0, lastSlash) : ''
    const newFullPath = parentPath ? `${parentPath}/${trimmed}` : trimmed
    setIsRenaming(false)
    await handlers.onRenameFolder(node.fullPath, newFullPath)
  }

  const handleDelete = async () => {
    setMenuOpen(false)
    if (!window.confirm(`Delete folder "${node.fullPath}"? Notes inside will be moved to Inbox.`)) return
    await handlers.onDeleteFolder(node.fullPath)
  }

  return (
    <div>
      <div
        className={`${styles.folderItem} ${isActive ? styles.folderItemActive : ''}`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        onClick={() => {
          if (!isRenaming) handlers.onSelect(isActive ? null : node.fullPath)
        }}
      >
        {hasChildren && (
          <button
            className={`${styles.folderChevron} ${expanded ? styles.folderChevronExpanded : ''}`}
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v) }}
          >
            ›
          </button>
        )}
        {!hasChildren && <span className={styles.folderLeafSpacer} />}

        {isRenaming ? (
          <input
            autoFocus
            ref={renameInputRef}
            className={styles.folderRenameInput}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') void commitRename(renameValue)
              if (e.key === 'Escape') setIsRenaming(false)
            }}
            onBlur={() => void commitRename(renameValue)}
          />
        ) : (
          <span className={styles.folderName}>{node.name}</span>
        )}

        {!isRenaming && (
          <div className={styles.folderMenuWrapper} ref={menuRef}>
            <button
              className={styles.folderMenuBtn}
              onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
            >
              ···
            </button>
            {menuOpen && (
              <div className={styles.folderMenu}>
                <button className={styles.folderMenuItem} onClick={e => { e.stopPropagation(); startRename() }}>
                  Rename
                </button>
                <button className={`${styles.folderMenuItem} ${styles.folderMenuItemDanger}`} onClick={e => { e.stopPropagation(); void handleDelete() }}>
                  Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {suggestion && (
        <div className={styles.folderTagBanner} style={{ paddingLeft: `${12 + depth * 14 + 18}px` }}>
          <span className={styles.folderTagText}>
            Tag to {suggestion.companyName || suggestion.contactName}?
          </span>
          <button
            className={styles.folderTagAccept}
            onClick={() => handlers.onAcceptSuggestion(node.fullPath, suggestion)}
          >
            Tag
          </button>
          <button
            className={styles.folderTagDismiss}
            onClick={() => handlers.onDismissSuggestion(node.fullPath)}
          >
            ✕
          </button>
        </div>
      )}

      {hasChildren && expanded && (
        <div>
          {node.children.map(child => (
            <FolderNodeItem
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              selected={selected}
              tagSuggestions={tagSuggestions}
              handlers={handlers}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const IMPORT_SOURCE_LABELS: Record<string, string> = {
  'apple-notes': 'Apple Notes',
  'notion': 'Notion',
  'generic': 'Imported',
}

export function FolderSidebar({
  folders, selected, isInboxActive, onSelect,
  tagSuggestions, onDismissSuggestion, onAcceptSuggestion,
  importSources, selectedImportSource, onSelectImportSource,
  onCreateFolder, onRenameFolder, onDeleteFolder,
}: Props) {
  const tree = useMemo(() => buildFolderTree(folders), [folders])
  const [creatingFolder, setCreatingFolder] = useState(false)

  const isAllActive = selected === null && !selectedImportSource && !isInboxActive

  const handlers: NodeHandlers = {
    onSelect,
    onDismissSuggestion,
    onAcceptSuggestion,
    onRenameFolder,
    onDeleteFolder,
  }

  return (
    <div className={styles.sidebar}>
      <div
        className={`${styles.folderItem} ${isAllActive ? styles.folderItemActive : ''}`}
        style={{ paddingLeft: '12px' }}
        onClick={() => { onSelect(null); onSelectImportSource(null) }}
      >
        <span className={styles.folderLeafSpacer} />
        <span className={styles.folderName}>All Notes</span>
      </div>

      <div
        className={`${styles.folderItem} ${isInboxActive ? styles.folderItemActive : ''}`}
        style={{ paddingLeft: '12px' }}
        onClick={() => onSelect(INBOX_SENTINEL)}
      >
        <span className={styles.folderLeafSpacer} />
        <span className={styles.folderName}>Inbox</span>
      </div>

      {tree.map(node => (
        <FolderNodeItem
          key={node.fullPath}
          node={node}
          depth={0}
          selected={selected}
          tagSuggestions={tagSuggestions}
          handlers={handlers}
        />
      ))}

      <div className={styles.newFolderArea}>
        {!creatingFolder ? (
          <button className={styles.newFolderBtn} onClick={() => setCreatingFolder(true)}>
            + New folder
          </button>
        ) : (
          <input
            autoFocus
            className={styles.newFolderInput}
            placeholder="Folder name…"
            onKeyDown={e => {
              if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                void onCreateFolder(e.currentTarget.value.trim())
                setCreatingFolder(false)
              }
              if (e.key === 'Escape') setCreatingFolder(false)
            }}
            onBlur={() => setCreatingFolder(false)}
          />
        )}
      </div>

      {importSources.length > 0 && (
        <div className={styles.importSourceSection}>
          <div className={styles.importSourceLabel}>Import sources</div>
          {importSources.map(src => (
            <button
              key={src}
              className={`${styles.importSourceChip} ${selectedImportSource === src ? styles.importSourceChipActive : ''}`}
              onClick={() => { onSelect(null); onSelectImportSource(selectedImportSource === src ? null : src) }}
            >
              {IMPORT_SOURCE_LABELS[src] ?? src}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
