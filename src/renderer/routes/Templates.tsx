import { useState, useEffect, useCallback } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { MeetingTemplate, TemplateCategory, OutputFormat } from '../../shared/types/template'
import EmptyState from '../components/common/EmptyState'
import styles from './Templates.module.css'

export default function Templates() {
  const [templates, setTemplates] = useState<MeetingTemplate[]>([])
  const [selected, setSelected] = useState<MeetingTemplate | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({
    name: '',
    description: '',
    category: 'custom' as TemplateCategory,
    systemPrompt: '',
    userPromptTemplate: '',
    outputFormat: 'markdown' as OutputFormat
  })

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
    if (!selected) return
    setEditForm({
      name: selected.name,
      description: selected.description,
      category: selected.category,
      systemPrompt: selected.systemPrompt,
      userPromptTemplate: selected.userPromptTemplate,
      outputFormat: selected.outputFormat
    })
    setIsEditing(true)
  }

  const handleNew = () => {
    setSelected(null)
    setEditForm({
      name: '',
      description: '',
      category: 'custom',
      systemPrompt: '',
      userPromptTemplate: '{{transcript}}',
      outputFormat: 'markdown'
    })
    setIsEditing(true)
  }

  const handleSave = async () => {
    let saved: MeetingTemplate | null = null
    if (selected) {
      saved = await window.api.invoke<MeetingTemplate>(IPC_CHANNELS.TEMPLATE_UPDATE, selected.id, editForm)
    } else {
      saved = await window.api.invoke<MeetingTemplate>(IPC_CHANNELS.TEMPLATE_CREATE, editForm)
    }
    setIsEditing(false)
    await fetchTemplates()
    if (saved) {
      setSelected(saved)
    }
  }

  const handleDelete = async (id: string) => {
    await window.api.invoke(IPC_CHANNELS.TEMPLATE_DELETE, id)
    if (selected?.id === id) {
      setSelected(null)
    }
    await fetchTemplates()
  }

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
            <span className={styles.itemCategory}>{t.category}</span>
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
                <button className={styles.editBtn} onClick={handleEdit}>
                  Edit
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
            <p className={styles.desc}>{selected.description}</p>
            <div className={styles.field}>
              <label>System Prompt</label>
              <pre className={styles.pre}>{selected.systemPrompt}</pre>
            </div>
            <div className={styles.field}>
              <label>User Prompt Template</label>
              <pre className={styles.pre}>{selected.userPromptTemplate}</pre>
            </div>
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
              />
            </div>
            <div className={styles.field}>
              <label>Description</label>
              <input
                className={styles.input}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label>System Prompt</label>
              <textarea
                className={styles.textarea}
                rows={5}
                value={editForm.systemPrompt}
                onChange={(e) => setEditForm({ ...editForm, systemPrompt: e.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label>
                User Prompt Template{' '}
                <span className={styles.hint}>
                  Use {'{{transcript}}'}, {'{{meeting_title}}'}, {'{{date}}'}, {'{{duration}}'},
                  {'{{speakers}}'}
                </span>
              </label>
              <textarea
                className={styles.textarea}
                rows={10}
                value={editForm.userPromptTemplate}
                onChange={(e) =>
                  setEditForm({ ...editForm, userPromptTemplate: e.target.value })
                }
              />
            </div>
            <div className={styles.formActions}>
              <button className={styles.saveBtn} onClick={handleSave}>
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
