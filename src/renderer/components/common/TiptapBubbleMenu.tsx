import { BubbleMenu } from '@tiptap/react/menus'
import type { Editor } from '@tiptap/react'
import styles from './TiptapBubbleMenu.module.css'

interface TiptapBubbleMenuProps {
  editor: Editor | null
}

export function TiptapBubbleMenu({ editor }: TiptapBubbleMenuProps) {
  if (!editor) return null
  return (
    <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }}>
      <div className={styles.bubbleMenu}>
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={editor.isActive('bold') ? styles.isActive : ''}
        >B</button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={editor.isActive('italic') ? styles.isActive : ''}
        >I</button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={editor.isActive('heading', { level: 1 }) ? styles.isActive : ''}
        >H1</button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={editor.isActive('heading', { level: 2 }) ? styles.isActive : ''}
        >H2</button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          className={editor.isActive('heading', { level: 3 }) ? styles.isActive : ''}
        >H3</button>
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={editor.isActive('bulletList') ? styles.isActive : ''}
        >• List</button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={editor.isActive('orderedList') ? styles.isActive : ''}
        >1. List</button>
      </div>
    </BubbleMenu>
  )
}
