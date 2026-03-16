import { useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CustomFieldDefinition, CustomFieldEntityType } from '../../../shared/types/custom-fields'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import styles from './CustomFieldsSettings.module.css'
import { api } from '../../api'

type EntityTab = 'company' | 'contact'

interface DeleteConfirm {
  def: CustomFieldDefinition
  valueCount: number
}

interface DeleteBuiltinConfirm {
  def: CustomFieldDefinition
  option: string
  usageCount: number | null
}

interface RenameState {
  defId: string
  fieldKey: string
  option: string
  draft: string
}

function parseOptions(optionsJson: string | null): string[] {
  if (!optionsJson) return []
  try { return JSON.parse(optionsJson) as string[] } catch { return [] }
}

export function CustomFieldsSettings() {
  const { companyDefs, contactDefs, refresh } = useCustomFieldStore()
  const [entityTab, setEntityTab] = useState<EntityTab>('company')
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Builtin option management
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [deleteBuiltin, setDeleteBuiltin] = useState<DeleteBuiltinConfirm | null>(null)
  const [deletingBuiltin, setDeletingBuiltin] = useState(false)
  const [dragOption, setDragOption] = useState<{ defId: string; option: string } | null>(null)

  const allDefs = entityTab === 'company' ? companyDefs : contactDefs
  const defs = allDefs.filter(d => !d.isBuiltin)
  const builtinDefsWithExtensions = allDefs
    .filter(d => d.isBuiltin && parseOptions(d.optionsJson).length > 0)

  async function handleDeleteConfirm(def: CustomFieldDefinition) {
    const r = await api.invoke<{ success: boolean; count: number }>(
      IPC_CHANNELS.CUSTOM_FIELD_COUNT_VALUES, def.id
    )
    setDeleteConfirm({ def, valueCount: r.success ? r.count : 0 })
  }

  async function handleDelete() {
    if (!deleteConfirm) return
    setDeleting(true)
    await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_DELETE_DEFINITION, deleteConfirm.def.id)
    setDeleteConfirm(null)
    setDeleting(false)
    await refresh()
  }

  async function handleRenameConfirm() {
    if (!renaming) return
    const newValue = renaming.draft.trim()
    if (!newValue || newValue === renaming.option) { setRenaming(null); return }
    await api.invoke(
      IPC_CHANNELS.CUSTOM_FIELD_RENAME_BUILTIN_OPTION,
      renaming.defId,
      renaming.fieldKey,
      renaming.option,
      newValue
    )
    setRenaming(null)
    await refresh()
  }

  async function handleDeleteBuiltinClick(def: CustomFieldDefinition, option: string) {
    const r = await api.invoke<{ success: boolean; count: number }>(
      IPC_CHANNELS.CUSTOM_FIELD_COUNT_BUILTIN_OPTION, def.fieldKey, option
    )
    setDeleteBuiltin({ def, option, usageCount: r.success ? r.count : 0 })
  }

  async function handleDeleteBuiltinConfirm() {
    if (!deleteBuiltin) return
    setDeletingBuiltin(true)
    const current = parseOptions(deleteBuiltin.def.optionsJson)
    const filtered = current.filter(o => o !== deleteBuiltin.option)
    await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, deleteBuiltin.def.id, {
      optionsJson: filtered.length > 0 ? JSON.stringify(filtered) : null
    })
    setDeleteBuiltin(null)
    setDeletingBuiltin(false)
    await refresh()
  }

  async function handleDropOption(def: CustomFieldDefinition, targetOption: string) {
    if (!dragOption || dragOption.defId !== def.id || dragOption.option === targetOption) return
    const current = parseOptions(def.optionsJson)
    const fromIdx = current.indexOf(dragOption.option)
    const toIdx = current.indexOf(targetOption)
    if (fromIdx === -1 || toIdx === -1) return
    const reordered = [...current]
    reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, dragOption.option)
    await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, def.id, {
      optionsJson: JSON.stringify(reordered)
    })
    setDragOption(null)
    await refresh()
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>Custom Fields</h2>

      <p className={styles.redirectNote}>
        Create and manage custom fields from the column picker (⊕) in the Companies or Contacts table view.
      </p>

      {/* Entity tabs */}
      <div className={styles.tabs}>
        {(['company', 'contact'] as EntityTab[]).map((tab) => (
          <button
            key={tab}
            className={`${styles.tab} ${entityTab === tab ? styles.tabActive : ''}`}
            onClick={() => setEntityTab(tab)}
          >
            {tab === 'company' ? 'Companies' : 'Contacts'}
          </button>
        ))}
      </div>

      {/* Read-only field list */}
      {defs.length === 0 ? (
        <p className={styles.emptyNote}>No custom fields yet.</p>
      ) : (
        <div className={styles.fieldList}>
          {defs.map((def) => (
            <div key={def.id} className={styles.fieldItem}>
              <div className={styles.fieldInfo}>
                <span className={styles.fieldLabel}>{def.label}</span>
                <span className={styles.fieldMeta}>{def.fieldKey} · {def.fieldType}</span>
              </div>
              <button
                className={styles.deleteBtn}
                onClick={() => void handleDeleteConfirm(def)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Built-in Field Extensions section */}
      {builtinDefsWithExtensions.length > 0 && (
        <>
          <div className={styles.sectionDivider} />
          <h3 className={styles.subheading}>Built-in Field Extensions</h3>
          <p className={styles.extensionsNote}>
            Options you've added to built-in fields. Double-click to rename; drag ↕ to reorder; × to delete.
          </p>
          {builtinDefsWithExtensions.map((def) => {
            const options = parseOptions(def.optionsJson)
            return (
              <div key={def.id} className={styles.builtinGroup}>
                <div className={styles.builtinGroupLabel}>{def.label}</div>
                <div className={styles.optionList}>
                  {options.map((option) => {
                    const isRenaming = renaming?.defId === def.id && renaming?.option === option
                    return (
                      <div
                        key={option}
                        className={`${styles.optionRow} ${dragOption?.defId === def.id && dragOption?.option === option ? styles.dragging : ''}`}
                        draggable
                        onDragStart={() => setDragOption({ defId: def.id, option })}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => void handleDropOption(def, option)}
                        onDragEnd={() => setDragOption(null)}
                      >
                        <span className={styles.dragHandle}>↕</span>
                        {isRenaming ? (
                          <input
                            className={styles.renameInput}
                            value={renaming.draft}
                            autoFocus
                            onChange={(e) => setRenaming({ ...renaming, draft: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleRenameConfirm()
                              if (e.key === 'Escape') setRenaming(null)
                            }}
                            onBlur={() => void handleRenameConfirm()}
                          />
                        ) : (
                          <span
                            className={styles.optionLabel}
                            onDoubleClick={() => setRenaming({ defId: def.id, fieldKey: def.fieldKey, option, draft: option })}
                          >
                            {option}
                          </span>
                        )}
                        <button
                          className={styles.optionDeleteBtn}
                          onClick={() => void handleDeleteBuiltinClick(def, option)}
                          title="Delete option"
                        >
                          ×
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </>
      )}

      {/* Delete confirmation for custom fields */}
      {deleteConfirm && (
        <div className={styles.confirmOverlay} onClick={() => setDeleteConfirm(null)}>
          <div className={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.confirmText}>
              Delete <strong>{deleteConfirm.def.label}</strong>?
              {deleteConfirm.valueCount > 0 && (
                <> This will also delete {deleteConfirm.valueCount} value{deleteConfirm.valueCount !== 1 ? 's' : ''}.</>
              )}
            </p>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button
                className={styles.confirmDelete}
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation for built-in option */}
      {deleteBuiltin && (
        <div className={styles.confirmOverlay} onClick={() => setDeleteBuiltin(null)}>
          <div className={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.confirmText}>
              Remove <strong>"{deleteBuiltin.option}"</strong> from {deleteBuiltin.def.label}?
              {deleteBuiltin.usageCount != null && deleteBuiltin.usageCount > 0 && (
                <> {deleteBuiltin.usageCount} record{deleteBuiltin.usageCount !== 1 ? 's use' : ' uses'} this option and will be cleared.</>
              )}
            </p>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => setDeleteBuiltin(null)}>
                Cancel
              </button>
              <button
                className={styles.confirmDelete}
                onClick={() => void handleDeleteBuiltinConfirm()}
                disabled={deletingBuiltin}
              >
                {deletingBuiltin ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
