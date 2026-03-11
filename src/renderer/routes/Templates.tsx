import { useState, useEffect, useCallback } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { MeetingTemplate } from '../../shared/types/template'
import EmptyState from '../components/common/EmptyState'
import styles from './Templates.module.css'

export default function Templates() {
  const [templates, setTemplates] = useState<MeetingTemplate[]>([])
  const [selected, setSelected] = useState<MeetingTemplate | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', context: '', instructions: '' })

  const fetchTemplates = useCallback(async () => {
    const result = await window.api.invoke<MeetingTemplate[]>(IPC_CHANNELS.TEMPLATE_LIST)
    setTemplates(result)
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const handleSelect = (template: MeetingTemplate) => {
    setSelected(template)
    setIsEditing(false)
  }

  const handleEdit = () => {
    if (!selected || selected.isDefault) return
    setEditForm({
      name: selected.name,
      context: selected.systemPrompt,
      instructions: selected.instructions ?? ''
    })
    setIsEditing(true)
  }

  const handleNew = () => {
    setSelected(null)
    setEditForm({ name: '', context: '', instructions: '' })
    setIsEditing(true)
  }

  const handleDuplicate = () => {
    if (!selected) return
    setSelected(null)
    setEditForm({
      name: `${selected.name} (copy)`,
      context: selected.systemPrompt,
      instructions: selected.instructions ?? selected.description ?? ''
    })
    setIsEditing(true)
  }

  const handleSave = async () => {
    const systemPrompt = editForm.context.trim()
    const payload = {
      name: editForm.name,
      description: '',
      category: 'custom' as const,
      systemPrompt,
      userPromptTemplate: '',
      instructions: editForm.instructions || null,
      outputFormat: 'markdown' as const
    }
    let saved: MeetingTemplate | null = null
    if (selected) {
      saved = await window.api.invoke<MeetingTemplate>(IPC_CHANNELS.TEMPLATE_UPDATE, selected.id, {
        name: payload.name,
        systemPrompt: payload.systemPrompt,
        instructions: payload.instructions
      })
    } else {
      saved = await window.api.invoke<MeetingTemplate>(IPC_CHANNELS.TEMPLATE_CREATE, payload)
    }
    setIsEditing(false)
    await fetchTemplates()
    if (saved) setSelected(saved)
  }

  const handleDelete = async (id: string) => {
    await window.api.invoke(IPC_CHANNELS.TEMPLATE_DELETE, id)
    if (selected?.id === id) setSelected(null)
    await fetchTemplates()
  }

  // Determine if this is a legacy custom template (no instructions, not default)
  const isLegacy = selected && !selected.isDefault && selected.instructions === null

  return (
    <div className={styles.container}>
      <div className={styles.list}>
        <div className={styles.listHeader}>
          <h3>Templates</h3>
          <button className={styles.newBtn} onClick={handleNew}>
            + New
          </button>
        </div>
        {templates.map((t) => (
          <div
            key={t.id}
            className={`${styles.item} ${selected?.id === t.id ? styles.itemActive : ''}`}
            onClick={() => handleSelect(t)}
          >
            <span className={styles.itemName}>{t.name}</span>
            {t.isDefault && <span className={styles.itemBadge}>Built-in</span>}
          </div>
        ))}
      </div>

      <div className={styles.detail}>
        {!isEditing && !selected && (
          <EmptyState
            title="Select a template"
            description="Choose a template from the list to view or edit its details."
          />
        )}

        {!isEditing && selected && (
          <div className={styles.preview}>
            <div className={styles.previewHeader}>
              <h2>{selected.name}</h2>
              <div className={styles.previewActions}>
                {selected.isDefault ? (
                  <button className={styles.editBtn} onClick={handleDuplicate}>
                    Duplicate
                  </button>
                ) : (
                  <>
                    <button className={styles.editBtn} onClick={handleEdit}>
                      Edit
                    </button>
                    <button
                      className={styles.deleteBtn}
                      onClick={() => handleDelete(selected.id)}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>

            {selected.isDefault && (
              <div className={styles.readOnlyNotice}>
                This is a built-in template. Duplicate it to create a customized version.
              </div>
            )}

            {selected.systemPrompt && (
              <div className={styles.field}>
                <label>Context</label>
                <pre className={styles.pre}>{selected.systemPrompt}</pre>
              </div>
            )}

            {selected.instructions ? (
              <div className={styles.field}>
                <label>Instructions</label>
                <pre className={styles.pre}>{selected.instructions}</pre>
              </div>
            ) : isLegacy ? (
              <div className={styles.field}>
                <label>User Prompt Template</label>
                <pre className={styles.pre}>{selected.userPromptTemplate}</pre>
              </div>
            ) : null}
          </div>
        )}

        {isEditing && (
          <div className={styles.editor}>
            <h2>{selected ? 'Edit Template' : 'New Template'}</h2>
            <div className={styles.field}>
              <label>Name</label>
              <input
                className={styles.input}
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                placeholder="e.g. VC Pitch Summary"
              />
            </div>
            <div className={styles.field}>
              <label>Context</label>
              <textarea
                className={styles.textarea}
                rows={4}
                value={editForm.context}
                onChange={(e) => setEditForm({ ...editForm, context: e.target.value })}
                placeholder="Describe the role or perspective for the AI. For example: You are an experienced venture capital analyst focused on early-stage investments."
              />
            </div>
            <div className={styles.field}>
              <label>Instructions</label>
              <textarea
                className={styles.textarea}
                rows={10}
                value={editForm.instructions}
                onChange={(e) => setEditForm({ ...editForm, instructions: e.target.value })}
                placeholder="Describe what you want in the summary. For example: Focus on investment highlights, key risks, and next steps. Use clear bullet points and keep it concise."
              />
              <p className={styles.instructionsHint}>
                Write in plain English. The app automatically includes the transcript, meeting title, date, duration, and speakers.
              </p>
            </div>
            <div className={styles.formActions}>
              <button className={styles.saveBtn} onClick={handleSave} disabled={!editForm.name.trim()}>
                Save
              </button>
              <button className={styles.cancelBtn} onClick={() => setIsEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
