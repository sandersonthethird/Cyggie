import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { MeetingTemplate } from '../../shared/types/template'
import EmptyState from '../components/common/EmptyState'
import styles from './Templates.module.css'
import { api } from '../api'

const INSTRUCTIONS_WRAPPER = `Meeting: {{meeting_title}}
Date: {{date}} | Duration: {{duration}}
Speakers: {{speakers}}

---

Transcript:
{{transcript}}

---

{{instructions}}`

function buildFullPrompt(template: MeetingTemplate): { systemPrompt: string; userPrompt: string } {
  const DEFAULT_SYSTEM = 'You are an expert meeting analyst. Provide clear, structured meeting summaries in markdown format.'
  const systemPrompt = template.systemPrompt || DEFAULT_SYSTEM
  const userPrompt = template.instructions
    ? INSTRUCTIONS_WRAPPER.replace('{{instructions}}', template.instructions)
    : template.userPromptTemplate
  return { systemPrompt, userPrompt }
}

export default function Templates() {
  const [templates, setTemplates] = useState<MeetingTemplate[]>([])
  const [selected, setSelected] = useState<MeetingTemplate | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', context: '', instructions: '', description: '' })
  const [showPromptModal, setShowPromptModal] = useState(false)

  const fetchTemplates = useCallback(async () => {
    const result = await api.invoke<MeetingTemplate[]>(IPC_CHANNELS.TEMPLATE_LIST)
    setTemplates(result)
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const handleSelect = (template: MeetingTemplate) => {
    setSelected(template)
    setIsEditing(false)
    setShowPromptModal(false)
  }

  const handleEdit = () => {
    if (!selected) return
    setEditForm({
      name: selected.isDefault ? `${selected.name} (custom)` : selected.name,
      context: selected.systemPrompt,
      instructions: selected.instructions ?? '',
      description: selected.description ?? '',
    })
    setIsEditing(true)
  }

  const handleNew = () => {
    setSelected(null)
    setEditForm({ name: '', context: '', instructions: '', description: '' })
    setIsEditing(true)
  }

  const handleSave = async () => {
    const payload = {
      name: editForm.name,
      description: editForm.description,
      category: 'custom' as const,
      systemPrompt: editForm.context.trim(),
      userPromptTemplate: '',
      instructions: editForm.instructions || null,
      outputFormat: 'markdown' as const,
    }
    let saved: MeetingTemplate | null = null
    if (selected && !selected.isDefault) {
      saved = await api.invoke<MeetingTemplate>(IPC_CHANNELS.TEMPLATE_UPDATE, selected.id, {
        name: payload.name,
        systemPrompt: payload.systemPrompt,
        instructions: payload.instructions,
        description: payload.description,
      })
    } else {
      // selected is null (new) OR selected.isDefault (fork) — always CREATE
      saved = await api.invoke<MeetingTemplate>(IPC_CHANNELS.TEMPLATE_CREATE, payload)
    }
    setIsEditing(false)
    await fetchTemplates()
    if (saved) setSelected(saved)
  }

  const handleDelete = async (id: string) => {
    await api.invoke(IPC_CHANNELS.TEMPLATE_DELETE, id)
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
                <button className={styles.viewPromptBtn} onClick={() => setShowPromptModal(true)}>
                  View Full Prompt
                </button>
                <button className={styles.editBtn} onClick={handleEdit}>
                  {selected.isDefault ? 'Edit (creates copy)' : 'Edit'}
                </button>
                {!selected.isDefault && (
                  <button
                    className={styles.deleteBtn}
                    onClick={() => handleDelete(selected.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>

            {selected.isDefault && (
              <div className={styles.readOnlyNotice}>
                This is a built-in template. Editing it will create a new custom template — the original is preserved.
              </div>
            )}

            {selected.description && (
              <div className={styles.field}>
                <label>Description</label>
                <p className={styles.desc}>{selected.description}</p>
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
            <h2>{selected && !selected.isDefault ? 'Edit Template' : 'New Template'}</h2>
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
              <label>Description</label>
              <input
                className={styles.input}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                placeholder="e.g. For first meetings with founders pitching seed-stage deals."
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

      {showPromptModal && selected && createPortal(
        <div className={styles.promptOverlay} onClick={() => setShowPromptModal(false)}>
          <div className={styles.promptDialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.promptDialogHeader}>
              <h2 className={styles.promptDialogTitle}>{selected.name} — Full Prompt</h2>
              <button className={styles.promptCloseBtn} onClick={() => setShowPromptModal(false)}>✕</button>
            </div>
            <div className={styles.promptDialogBody}>
              {(() => {
                const { systemPrompt, userPrompt } = buildFullPrompt(selected)
                return (
                  <>
                    <div className={styles.promptSection}>
                      <div className={styles.promptSectionLabel}>System Prompt</div>
                      <pre className={styles.promptPre}>{systemPrompt}</pre>
                    </div>
                    <div className={styles.promptSection}>
                      <div className={styles.promptSectionLabel}>User Prompt</div>
                      <pre className={styles.promptPre}>{userPrompt}</pre>
                    </div>
                  </>
                )
              })()}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
