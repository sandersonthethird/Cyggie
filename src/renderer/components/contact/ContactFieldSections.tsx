/**
 * ContactFieldSections — the per-section orchestration for the contact
 * properties card (contact_info, professional, relationship, investor_info).
 *
 * Mirrors CompanyFieldSections. The parent (ContactPropertiesPanel) owns
 * the PropertiesCard shell (topBand + footer + AddFieldDropdown) and slots
 * this component in as its body.
 *
 *   ┌─ PropertiesCard ────────────────────────────────────────────────┐
 *   │  topBand: relationship strength                                  │
 *   │  body  : <ContactFieldSections>                                  │
 *   │  footer: PropertiesCardFooter (+ Add property, Show hidden)      │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Houses local renderHardcodedSection + renderSectionedFields helpers and a
 * thin <HideableRow> wrapper that delegates to the shared atom. Imports the
 * parent's CSS module so previousCompanies + fundraising-callout styling
 * keeps working without duplication. Matches the established
 * CompanyHeaderCard / ContactHeaderCard sibling-component pattern.
 */

import { useNavigate } from 'react-router-dom'
import { type Dispatch, type HTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject, type SetStateAction } from 'react'
import type { ContactDetail, LinkedInEducationEntry } from '../../../shared/types/contact'
import type { CompanySummary } from '../../../shared/types/company'
import type { CustomFieldDefinition, CustomFieldWithValue } from '../../../shared/types/custom-fields'
import { PropertyRow, type PropertyRowType } from '../crm/PropertyRow'
import { TagPicker } from '../crm/TagPicker'
import { SocialsEditor } from '../crm/SocialsEditor'
import { CollapsibleSection } from '../crm/CollapsibleSection'
import { HideableRow as SharedHideableRow } from '../crm/HideableRow'
import { DraggableFieldRow } from '../crm/DraggableFieldRow'
import { addCustomFieldOption } from '../../utils/customFieldUtils'
import { CONTACT_FIELD_META as M } from '../../constants/contactFieldMeta'
import { parsePriorCompanies, type PriorCompanyEntry } from './ContactPropertiesPanel'
import styles from './ContactPropertiesPanel.module.css'

// ── Helpers (private to this file) ────────────────────────────────────────

function priorCompanyName(entry: PriorCompanyEntry): string {
  return typeof entry === 'string' ? entry : entry.name
}

function filteredOtherSocials(otherSocials: string | null, linkedinUrl: string | null): string | null {
  if (!linkedinUrl || !otherSocials) return otherSocials
  try {
    const obj = JSON.parse(otherSocials) as Record<string, string>
    const filtered = Object.fromEntries(
      Object.entries(obj).filter(([k]) => k.toLowerCase() !== 'linkedin')
    )
    return Object.keys(filtered).length > 0 ? JSON.stringify(filtered) : null
  } catch {
    return otherSocials
  }
}

// ── Hook-return shapes (bundled so parent passes ergonomic groups) ────────

interface SectionOrderState {
  orderedSections: string[]
  draggingSectionKey: string | null
  setDraggingSectionKey: (key: string | null) => void
  dragOverSectionKey: string | null
  setDragOverSectionKey: (key: string | null) => void
  reorder: (fromKey: string, toKey: string) => void
}

interface HardcodedFieldOrderState {
  applyOrder: (fields: Array<{ key: string; visible: boolean; render: () => ReactNode }>, sectionKey: string) => Array<{ key: string; visible: boolean; render: () => ReactNode }>
  draggingKey: string | null
  setDraggingKey: (key: string | null) => void
  draggingOverKey: string | null
  setDraggingOverKey: (key: string | null) => void
  reorder: (sectionKey: string, fromKey: string, toKey: string, orderedKeys: string[]) => void
}

interface CustomFieldSectionState {
  sectionedFields: (sectionKey: string) => CustomFieldWithValue[]
  nullSectionFields: () => CustomFieldWithValue[]
  draggingFieldId: string | null
  setDraggingFieldId: (id: string | null) => void
  draggingOverFieldId: string | null
  setDraggingOverFieldId: (id: string | null) => void
  handleWithinSectionDrop: (targetFieldId: string) => void
  dragOverSection: string | null
}

interface FieldVisibilityState {
  addedFields: string[]
  removeFromAddedFields: (key: string) => void
}

interface PriorCompanyAutocompleteState {
  drafts: PriorCompanyEntry[]
  setDrafts: Dispatch<SetStateAction<PriorCompanyEntry[]>>
  autocomplete: { index: number; results: CompanySummary[] } | null
  setAutocomplete: (v: { index: number; results: CompanySummary[] } | null) => void
  activeIdx: number
  setActiveIdx: (n: number) => void
  onKeyDown: (e: KeyboardEvent) => boolean
  listRef: RefObject<HTMLElement | null>
  onInput: (index: number, value: string) => void
  selectFromAutocomplete: (entry: { name: string; companyId: string }) => void
  save: (drafts: PriorCompanyEntry[]) => void
}

// ── Props ─────────────────────────────────────────────────────────────────

export interface ContactFieldSectionsProps {
  contact: ContactDetail
  isEditing: boolean
  showAllFields: boolean

  // Save / IPC
  save: (field: string, value: unknown) => Promise<unknown>

  // Grouped hook returns
  sectionOrder: SectionOrderState
  hfOrder: HardcodedFieldOrderState
  customFieldSection: CustomFieldSectionState
  fieldVisibility: FieldVisibilityState

  // Section collapse
  isCollapsed: (key: string) => boolean
  toggleSection: (key: string) => void
  hasUserToggledSection: (key: string) => boolean

  // Field show/hide
  showField: (key: string, value: unknown) => boolean
  hiddenFields: string[]
  hideField: (key: string) => void
  restoreField: (key: string) => void

  // Custom fields
  customFields: CustomFieldWithValue[]
  setCustomFields: Dispatch<SetStateAction<CustomFieldWithValue[]>>

  // Field editing
  editingFieldId: string | null
  editingFieldLabel: string
  setEditingFieldId: (id: string | null) => void
  setEditingFieldLabel: (label: string) => void
  handleFieldLabelSave: (id: string, label: string) => Promise<void>
  getPinnedFieldValue: (field: CustomFieldWithValue) => string | number | boolean | null
  handlePinnedFieldSave: (field: CustomFieldWithValue, value: string | number | boolean | null) => Promise<unknown>

  // Section drag
  syncedSectionDragProps: (sectionKey: string) => HTMLAttributes<HTMLDivElement>

  // Variant C
  openAddFieldDropdown: (section: string | null) => void

  // Contact-specific: previous companies inline editor + autocomplete
  priorCompany: PriorCompanyAutocompleteState

  // Contact-specific: LinkedIn parsed data (decides university visibility)
  liEduEntries: LinkedInEducationEntry[]

  // Contact-specific: investor section option sets
  talentPipelineDef?: CustomFieldDefinition
  talentPipelineOptions: { value: string; label: string }[]
  stageFocusDef?: CustomFieldDefinition
  stageFocusOptions: { value: string; label: string }[]
  sectorFocusDef?: CustomFieldDefinition
  sectorFocusOptions: { value: string; label: string }[]

  // Contact-specific: fundraising callout
  onRequestCreateCompany?: () => void
}

// ── Component ─────────────────────────────────────────────────────────────

export function ContactFieldSections({
  contact,
  isEditing,
  showAllFields,
  save,
  sectionOrder,
  hfOrder,
  customFieldSection,
  fieldVisibility,
  isCollapsed,
  toggleSection,
  hasUserToggledSection,
  showField,
  hiddenFields,
  hideField,
  restoreField,
  customFields,
  setCustomFields,
  editingFieldId,
  editingFieldLabel,
  setEditingFieldId,
  setEditingFieldLabel,
  handleFieldLabelSave,
  getPinnedFieldValue,
  handlePinnedFieldSave,
  syncedSectionDragProps,
  openAddFieldDropdown,
  priorCompany,
  liEduEntries,
  talentPipelineDef,
  talentPipelineOptions,
  stageFocusDef,
  stageFocusOptions,
  sectorFocusDef,
  sectorFocusOptions,
  onRequestCreateCompany,
}: ContactFieldSectionsProps) {
  const navigate = useNavigate()

  // Thin parent-scoped wrapper around the shared <SharedHideableRow> atom — preserves
  // legacy callsites (passing just fieldKey + isEmpty) while routing hide/restore
  // through contact-panel state setters and the addedFields cleanup path.
  function HideableRow({ fieldKey, isEmpty, children }: { fieldKey: string; isEmpty?: boolean; children: ReactNode }) {
    return (
      <SharedHideableRow
        fieldKey={fieldKey}
        isEmpty={isEmpty}
        isHidden={hiddenFields.includes(fieldKey)}
        isEditing={isEditing}
        showAllFields={showAllFields}
        onHide={(key, empty) => {
          if (empty && fieldVisibility.addedFields.includes(key)) {
            fieldVisibility.removeFromAddedFields(key)
          } else {
            hideField(key)
          }
        }}
        onRestore={restoreField}
      >
        {children}
      </SharedHideableRow>
    )
  }

  function renderSectionedFields(sectionKey: string) {
    const opts = (field: CustomFieldWithValue) => {
      try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] }
    }
    return customFieldSection.sectionedFields(sectionKey).map((field) => {
      const fieldKey = `custom:${field.id}`
      if (hiddenFields.includes(fieldKey) && !isEditing && !showAllFields) return null
      const isDropTarget = customFieldSection.draggingOverFieldId === field.id && customFieldSection.draggingFieldId !== field.id
      return (
        <DraggableFieldRow
          key={field.id}
          isEditing={isEditing}
          isDragTarget={isDropTarget}
          onDragStart={() => customFieldSection.setDraggingFieldId(field.id)}
          onDragEnd={() => { customFieldSection.setDraggingFieldId(null); customFieldSection.setDraggingOverFieldId(null) }}
          onDragOver={(e) => {
            e.preventDefault()
            if (isEditing && customFieldSection.draggingOverFieldId !== field.id) customFieldSection.setDraggingOverFieldId(field.id)
          }}
          onDrop={(e) => {
            e.stopPropagation()
            if (isEditing) customFieldSection.handleWithinSectionDrop(field.id)
          }}
        >
          {isEditing && editingFieldId === field.id ? (
            <input
              className={styles.inlineRenameInput}
              autoFocus
              value={editingFieldLabel}
              onChange={(e) => setEditingFieldLabel(e.target.value)}
              onBlur={() => handleFieldLabelSave(field.id, editingFieldLabel)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleFieldLabelSave(field.id, editingFieldLabel)
                if (e.key === 'Escape') setEditingFieldId(null)
              }}
            />
          ) : (
          <HideableRow fieldKey={fieldKey}>
            <PropertyRow
              label={field.label}
              value={getPinnedFieldValue(field)}
              type={field.fieldType as PropertyRowType}
              options={opts(field)}
              editMode={isEditing}
              onSave={(val) => handlePinnedFieldSave(field, val)}
              onAddOption={
                (field.fieldType === 'select' || field.fieldType === 'multiselect')
                  ? async (newOption) => {
                      const opt = newOption.trim().slice(0, 200)
                      await addCustomFieldOption(field.id, field.optionsJson, opt)
                      setCustomFields(prev => prev.map(f => {
                        if (f.id !== field.id) return f
                        const cur: string[] = (() => { try { return JSON.parse(f.optionsJson ?? '[]') } catch { return [] } })()
                        return { ...f, optionsJson: JSON.stringify([...cur, opt]) }
                      }))
                    }
                  : undefined
              }
            />
            {isEditing && (
              <button
                className={styles.renameFieldBtn}
                title="Rename field"
                onClick={() => { setEditingFieldId(field.id); setEditingFieldLabel(field.label) }}
              >✎</button>
            )}
          </HideableRow>
          )}
        </DraggableFieldRow>
      )
    })
  }

  function renderHardcodedSection(
    fields: Array<{ key: string; visible: boolean; render: () => ReactNode }>,
    sectionKey: string,
  ) {
    const ordered = hfOrder.applyOrder(fields, sectionKey)
    return ordered.map((field) => {
      if (!field.visible) return null
      const isDropTarget = hfOrder.draggingOverKey === field.key && hfOrder.draggingKey !== field.key
      return (
        <DraggableFieldRow
          key={field.key}
          isEditing={isEditing}
          isDragTarget={isDropTarget}
          onDragStart={() => hfOrder.setDraggingKey(field.key)}
          onDragEnd={() => { hfOrder.setDraggingKey(null); hfOrder.setDraggingOverKey(null) }}
          onDragOver={(e) => {
            e.preventDefault()
            if (isEditing && hfOrder.draggingOverKey !== field.key) hfOrder.setDraggingOverKey(field.key)
          }}
          onDrop={(e) => {
            e.stopPropagation()
            if (isEditing && hfOrder.draggingKey) {
              hfOrder.reorder(sectionKey, hfOrder.draggingKey, field.key, ordered.map((f) => f.key))
            }
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>{field.render()}</div>
        </DraggableFieldRow>
      )
    })
  }

  return (
    <>
      {sectionOrder.orderedSections.map(sectionKey => {
        const baseDragProps = syncedSectionDragProps(sectionKey)
        const isDraggingThisSection = sectionOrder.draggingSectionKey === sectionKey
        const isDropTargetForSection = sectionOrder.dragOverSectionKey === sectionKey && !isDraggingThisSection
        const sectionContainerProps: HTMLAttributes<HTMLDivElement> = {
          ...baseDragProps,
          className: [
            isDraggingThisSection ? styles.sectionDragging : '',
            isDropTargetForSection || (isEditing && customFieldSection.dragOverSection === sectionKey) ? styles.dropTarget : '',
          ].filter(Boolean).join(' '),
          ...(isEditing ? {
            draggable: true,
            onDragStart: (e) => { e.stopPropagation(); sectionOrder.setDraggingSectionKey(sectionKey) },
            onDragEnd: () => { sectionOrder.setDraggingSectionKey(null); sectionOrder.setDragOverSectionKey(null) },
            onDragOver: (e) => {
              e.preventDefault()
              sectionOrder.setDragOverSectionKey(sectionKey)
              baseDragProps.onDragOver?.(e)
            },
          } : {}),
        }

        switch (sectionKey) {
          case 'contact_info': return (
            <div key="contact_info" {...sectionContainerProps}>
              <CollapsibleSection
                title="Contact Info"
                count={1 /* placeholder; see TODO for non-empty count */}
                isCollapsed={isCollapsed('contact_info')}
                onToggle={() => toggleSection('contact_info')}
                hasUserToggled={hasUserToggledSection('contact_info')}
                onAdd={() => openAddFieldDropdown('contact_info')}
              >
              {renderHardcodedSection([
                { key: 'twitterHandle', visible: showField('twitterHandle', contact.twitterHandle), render: () => (
                  <HideableRow fieldKey="twitterHandle" isEmpty={!contact.twitterHandle}>
                    <PropertyRow label="Twitter/X" value={contact.twitterHandle} type={M.twitterHandle.type} editMode={isEditing} onSave={(v) => save('twitterHandle', v)} />
                  </HideableRow>
                )},
                { key: 'timezone', visible: showField('timezone', contact.timezone), render: () => (
                  <HideableRow fieldKey="timezone" isEmpty={!contact.timezone}>
                    <PropertyRow label="Timezone" value={contact.timezone} type={M.timezone.type} editMode={isEditing} onSave={(v) => save('timezone', v)} />
                  </HideableRow>
                )},
              ], 'contact_info')}
              {renderSectionedFields('contact_info')}

              {customFieldSection.nullSectionFields().map((field) => {
                const opts = (() => { try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] } })()
                return (
                  <div
                    key={field.id}
                    className={styles.sectionedFieldRow}
                    title="No section assigned — drag to reassign"
                    draggable={isEditing}
                    onDragStart={() => customFieldSection.setDraggingFieldId(field.id)}
                    onDragEnd={() => customFieldSection.setDraggingFieldId(null)}
                  >
                    {isEditing && <span className={styles.dragHandle}>⠿</span>}
                    <PropertyRow
                      label={field.label}
                      value={getPinnedFieldValue(field)}
                      type={field.fieldType as PropertyRowType}
                      options={opts}
                      editMode={isEditing}
                      onSave={(val) => handlePinnedFieldSave(field, val)}
                    />
                  </div>
                )
              })}
              </CollapsibleSection>
            </div>
          )

          case 'professional': return (
            <div key="professional" {...sectionContainerProps}>
              <CollapsibleSection
                title="Professional"
                count={1 /* placeholder */}
                isCollapsed={isCollapsed('professional')}
                onToggle={() => toggleSection('professional')}
                hasUserToggled={hasUserToggledSection('professional')}
                onAdd={() => openAddFieldDropdown('professional')}
              >
              {renderHardcodedSection([
                { key: 'previousCompanies', visible: showField('previousCompanies', contact.previousCompanies), render: () => (
                  <HideableRow fieldKey="previousCompanies" isEmpty={parsePriorCompanies(contact.previousCompanies).length === 0}>
                    <div className={styles.priorCompanyField}>
                      <div className={styles.priorCompanyLabel}>Prior Company</div>
                      {isEditing ? (
                        <div className={styles.priorCompanyList}>
                          {priorCompany.drafts.map((entry, i) => (
                            <div key={i} className={styles.priorCompanyEntry}>
                              <input
                                className={styles.priorCompanyInput}
                                value={priorCompanyName(entry)}
                                placeholder="Company name"
                                onChange={(e) => priorCompany.onInput(i, e.target.value)}
                                onKeyDown={priorCompany.autocomplete?.index === i ? priorCompany.onKeyDown : undefined}
                                onBlur={() => {
                                  setTimeout(() => priorCompany.setAutocomplete(null), 150)
                                  priorCompany.save(priorCompany.drafts)
                                }}
                              />
                              <button
                                className={styles.priorCompanyRemoveBtn}
                                onClick={() => {
                                  const next = priorCompany.drafts.filter((_, j) => j !== i)
                                  priorCompany.setDrafts(next)
                                  priorCompany.save(next)
                                }}
                              >×</button>
                              {priorCompany.autocomplete?.index === i && priorCompany.autocomplete.results.length > 0 && (
                                <div
                                  className={styles.priorCompanyAutocomplete}
                                  ref={priorCompany.listRef as RefObject<HTMLDivElement>}
                                >
                                  {priorCompany.autocomplete.results.map((c, idx) => (
                                    <div
                                      key={c.id}
                                      className={`${styles.priorCompanyAutocompleteItem} ${idx === priorCompany.activeIdx ? styles.priorCompanyAutocompleteItemActive : ''}`}
                                      onMouseEnter={() => priorCompany.setActiveIdx(idx)}
                                      onMouseDown={(e) => { e.preventDefault(); priorCompany.selectFromAutocomplete({ name: c.canonicalName, companyId: c.id }) }}
                                    >{c.canonicalName}</div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                          <button
                            className={styles.priorCompanyAddBtn}
                            onClick={() => priorCompany.setDrafts(prev => [...prev, ''])}
                          >+ Add Prior Company</button>
                        </div>
                      ) : (
                        <div className={styles.priorCompanyViewList}>
                          {parsePriorCompanies(contact.previousCompanies).map((entry, i) => {
                            const name = priorCompanyName(entry)
                            const companyId = typeof entry === 'object' ? entry.companyId : null
                            return (
                              <span key={i} className={styles.priorCompanyViewEntry}>
                                {companyId ? (
                                  <button className={styles.companyLink} onClick={() => navigate(`/company/${companyId}`, { state: { backLabel: contact.fullName } })}>{name}</button>
                                ) : name}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </HideableRow>
                )},
                { key: 'university', visible: showField('university', contact.university) && liEduEntries.length === 0, render: () => (
                  <HideableRow fieldKey="university" isEmpty={!contact.university}>
                    <PropertyRow label="University" value={contact.university} type={M.university.type} editMode={isEditing} onSave={(v) => save('university', v)} />
                  </HideableRow>
                )},
                { key: 'tags', visible: showField('tags', contact.tags), render: () => (
                  <HideableRow fieldKey="tags" isEmpty={!contact.tags}>
                    <PropertyRow label="Tags" value={contact.tags} type={M.tags.type} editMode={isEditing} onSave={(v) => save('tags', v)} />
                  </HideableRow>
                )},
                { key: 'pronouns', visible: showField('pronouns', contact.pronouns), render: () => (
                  <HideableRow fieldKey="pronouns" isEmpty={!contact.pronouns}>
                    <PropertyRow label="Pronouns" value={contact.pronouns} type={M.pronouns.type} editMode={isEditing} onSave={(v) => save('pronouns', v)} />
                  </HideableRow>
                )},
              ], 'professional')}
              {renderSectionedFields('professional')}

              {(isEditing || contact.otherSocials) && (
                <>
                  <div className={styles.socialsLabel}>Other Socials</div>
                  <SocialsEditor
                    value={filteredOtherSocials(contact.otherSocials, contact.linkedinUrl)}
                    onSave={(json) => save('otherSocials', json)}
                  />
                </>
              )}
              </CollapsibleSection>
            </div>
          )

          case 'relationship': return (
            <div key="relationship" {...sectionContainerProps}>
              <CollapsibleSection
                title="Relationship"
                count={1 /* placeholder */}
                isCollapsed={isCollapsed('relationship')}
                onToggle={() => toggleSection('relationship')}
                hasUserToggled={hasUserToggledSection('relationship')}
                onAdd={() => openAddFieldDropdown('relationship')}
              >
              {/* Variant C: relationship-strength control lifted to PropertiesCard topBand. */}
              {renderHardcodedSection([
                { key: 'talentPipeline', visible: showField('talentPipeline', contact.talentPipeline), render: () => (
                  <HideableRow fieldKey="talentPipeline" isEmpty={!contact.talentPipeline}>
                    <PropertyRow
                      label="Talent Pipeline"
                      value={contact.talentPipeline}
                      type={M.talentPipeline.type}
                      editMode={isEditing}
                      options={M.talentPipeline.getOptions!({ talentPipeline: talentPipelineOptions })}
                      onSave={(v) => save('talentPipeline', v || null)}
                      onAddOption={talentPipelineDef ? async (opt) => addCustomFieldOption(talentPipelineDef.id, talentPipelineDef.optionsJson, opt) : undefined}
                    />
                  </HideableRow>
                )},
                { key: 'lastMetEvent', visible: showField('lastMetEvent', contact.lastMetEvent), render: () => (
                  <HideableRow fieldKey="lastMetEvent" isEmpty={!contact.lastMetEvent}>
                    <PropertyRow label="Last Met At" value={contact.lastMetEvent} type={M.lastMetEvent.type} editMode={isEditing} onSave={(v) => save('lastMetEvent', v)} />
                  </HideableRow>
                )},
                { key: 'warmIntroPath', visible: showField('warmIntroPath', contact.warmIntroPath), render: () => (
                  <HideableRow fieldKey="warmIntroPath" isEmpty={!contact.warmIntroPath}>
                    <PropertyRow label="Warm Intro Path" value={contact.warmIntroPath} type={M.warmIntroPath.type} editMode={isEditing} onSave={(v) => save('warmIntroPath', v)} />
                  </HideableRow>
                )},
                { key: 'notes', visible: showField('notes', contact.notes), render: () => (
                  <HideableRow fieldKey="notes" isEmpty={!contact.notes}>
                    <PropertyRow label="Notes" value={contact.notes} type={M.notes.type} editMode={isEditing} onSave={(v) => save('notes', v)} />
                  </HideableRow>
                )},
              ], 'relationship')}
              {contact.talentPipeline === 'fundraising' && onRequestCreateCompany && (
                <div className={styles.fundraisingCallout}>
                  <span>Ready to move to pipeline?</span>
                  <button className={styles.fundraisingCalloutBtn} onClick={onRequestCreateCompany}>
                    Create company record &rarr;
                  </button>
                </div>
              )}
              {renderSectionedFields('relationship')}

              </CollapsibleSection>
            </div>
          )

          case 'investor_info':
            if (contact.contactType !== 'investor' && customFieldSection.sectionedFields('investor_info').length === 0) return null
            return (
              <div key="investor_info" {...sectionContainerProps}>
                <CollapsibleSection
                  title="Investor Info"
                  count={1 /* placeholder */}
                  isCollapsed={isCollapsed('investor_info')}
                  onToggle={() => toggleSection('investor_info')}
                  hasUserToggled={hasUserToggledSection('investor_info')}
                  onAdd={() => openAddFieldDropdown('investor_info')}
                >
                {contact.contactType === 'investor' && renderHardcodedSection([
                  { key: 'fundSize', visible: showField('fundSize', contact.fundSize), render: () => (
                    <HideableRow fieldKey="fundSize" isEmpty={!contact.fundSize}>
                      <PropertyRow label="Fund Size" value={contact.fundSize} type={M.fundSize.type} editMode={isEditing} onSave={(v) => save('fundSize', v)} />
                    </HideableRow>
                  )},
                  { key: 'typicalCheckSizeMin', visible: showField('typicalCheckSizeMin', contact.typicalCheckSizeMin), render: () => (
                    <HideableRow fieldKey="typicalCheckSizeMin" isEmpty={!contact.typicalCheckSizeMin}>
                      <PropertyRow label="Check Size Min" value={contact.typicalCheckSizeMin} type={M.typicalCheckSizeMin.type} editMode={isEditing} onSave={(v) => save('typicalCheckSizeMin', v)} />
                    </HideableRow>
                  )},
                  { key: 'typicalCheckSizeMax', visible: showField('typicalCheckSizeMax', contact.typicalCheckSizeMax), render: () => (
                    <HideableRow fieldKey="typicalCheckSizeMax" isEmpty={!contact.typicalCheckSizeMax}>
                      <PropertyRow label="Check Size Max" value={contact.typicalCheckSizeMax} type={M.typicalCheckSizeMax.type} editMode={isEditing} onSave={(v) => save('typicalCheckSizeMax', v)} />
                    </HideableRow>
                  )},
                  { key: 'investmentStageFocus', visible: showField('investmentStageFocus', contact.investmentStageFocus), render: () => (
                    <HideableRow fieldKey="investmentStageFocus" isEmpty={!contact.investmentStageFocus}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ minWidth: 120, color: 'var(--text-muted)' }}>Target Investment Stage</span>
                        <TagPicker
                          value={contact.investmentStageFocus}
                          options={stageFocusOptions}
                          isEditing={isEditing}
                          onSave={(v) => save('investmentStageFocus', v)}
                          onAddOption={stageFocusDef ? async (opt) => addCustomFieldOption(stageFocusDef.id, stageFocusDef.optionsJson, opt) : undefined}
                        />
                      </div>
                    </HideableRow>
                  )},
                  { key: 'investmentSectorFocus', visible: showField('investmentSectorFocus', contact.investmentSectorFocus), render: () => (
                    <HideableRow fieldKey="investmentSectorFocus" isEmpty={!contact.investmentSectorFocus}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ minWidth: 120, color: 'var(--text-muted)' }}>Target Investment Sector</span>
                        <TagPicker
                          value={contact.investmentSectorFocus}
                          options={sectorFocusOptions}
                          isEditing={isEditing}
                          onSave={(v) => save('investmentSectorFocus', v)}
                          onAddOption={sectorFocusDef ? async (opt) => addCustomFieldOption(sectorFocusDef.id, sectorFocusDef.optionsJson, opt) : undefined}
                        />
                      </div>
                    </HideableRow>
                  )},
                  { key: 'investmentSectorFocusNotes', visible: showField('investmentSectorFocusNotes', contact.investmentSectorFocusNotes), render: () => (
                    <HideableRow fieldKey="investmentSectorFocusNotes" isEmpty={!contact.investmentSectorFocusNotes}>
                      <PropertyRow label="Target Investment Sector Notes" value={contact.investmentSectorFocusNotes} type={M.investmentSectorFocusNotes.type} editMode={isEditing} onSave={(v) => save('investmentSectorFocusNotes', v)} />
                    </HideableRow>
                  )},
                  { key: 'proudPortfolioCompanies', visible: showField('proudPortfolioCompanies', contact.proudPortfolioCompanies), render: () => (
                    <HideableRow fieldKey="proudPortfolioCompanies" isEmpty={!contact.proudPortfolioCompanies}>
                      <PropertyRow label="Portfolio Cos" value={contact.proudPortfolioCompanies} type={M.proudPortfolioCompanies.type} editMode={isEditing} onSave={(v) => save('proudPortfolioCompanies', v)} />
                    </HideableRow>
                  )},
                ], 'investor_info')}
                {renderSectionedFields('investor_info')}

                </CollapsibleSection>
              </div>
            )

          default: return null
        }
      })}
    </>
  )
}
