import { useState } from 'react'
import { BubbleMenu } from '@tiptap/react/menus'
import type { Editor } from '@tiptap/react'
import { useAppearancePref } from '../../hooks/useAppearance'
import { AppearanceControls } from './AppearanceControls'
import styles from './TiptapBubbleMenu.module.css'

interface TiptapBubbleMenuProps {
  editor: Editor | null
}

export function TiptapBubbleMenu({ editor }: TiptapBubbleMenuProps) {
  // Hooks must run unconditionally — call before the null guard.
  const [mode, setMode] = useState<'buttons' | 'link'>('buttons')
  const [linkUrl, setLinkUrl] = useState('')
  const [showDisplay, setShowDisplay] = useState(false)
  const [appearance, setAppearance] = useAppearancePref()

  if (!editor) return null

  const cls = (active: boolean) => (active ? styles.isActive : '')

  const openLinkEditor = () => {
    setLinkUrl((editor.getAttributes('link').href as string) ?? '')
    setMode('link')
    setShowDisplay(false)
  }

  const applyLink = () => {
    const url = linkUrl.trim()
    if (!url) {
      // Empty input clears any existing link rather than creating a broken one.
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    }
    setMode('buttons')
  }

  return (
    <BubbleMenu editor={editor}>
      <div className={styles.bubbleMenu}>
        {mode === 'link' ? (
          <div className={styles.linkRow}>
            <input
              className={styles.linkInput}
              type="url"
              placeholder="https://…"
              value={linkUrl}
              autoFocus
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyLink() }
                if (e.key === 'Escape') { e.preventDefault(); setMode('buttons') }
              }}
            />
            <button onClick={applyLink} title="Apply link">Apply</button>
            <button onClick={() => setMode('buttons')} title="Cancel">✕</button>
          </div>
        ) : (
          <>
            <button onClick={() => editor.chain().focus().toggleBold().run()} className={cls(editor.isActive('bold'))} title="Bold"><b>B</b></button>
            <button onClick={() => editor.chain().focus().toggleItalic().run()} className={cls(editor.isActive('italic'))} title="Italic"><i>I</i></button>
            <button onClick={() => editor.chain().focus().toggleStrike().run()} className={cls(editor.isActive('strike'))} title="Strikethrough"><s>S</s></button>
            <button onClick={() => editor.chain().focus().toggleCode().run()} className={cls(editor.isActive('code'))} title="Inline code">&lt;/&gt;</button>
            <span className={styles.sep} />
            <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={cls(editor.isActive('heading', { level: 1 }))} title="Heading 1">H1</button>
            <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={cls(editor.isActive('heading', { level: 2 }))} title="Heading 2">H2</button>
            <button onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} className={cls(editor.isActive('heading', { level: 3 }))} title="Heading 3">H3</button>
            <span className={styles.sep} />
            <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={cls(editor.isActive('bulletList'))} title="Bullet list">• List</button>
            <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={cls(editor.isActive('orderedList'))} title="Numbered list">1. List</button>
            <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={cls(editor.isActive('blockquote'))} title="Quote">&ldquo;</button>
            <button onClick={openLinkEditor} className={cls(editor.isActive('link'))} title="Link">Link</button>
            <span className={styles.sep} />
            <button onClick={() => setShowDisplay((s) => !s)} className={cls(showDisplay)} title="Display & spacing">Aa</button>
          </>
        )}

        {showDisplay && mode === 'buttons' && (
          <div className={styles.displayPanel} onMouseDown={(e) => e.preventDefault()}>
            <AppearanceControls value={appearance} onChange={setAppearance} tone="dark" />
          </div>
        )}
      </div>
    </BubbleMenu>
  )
}
