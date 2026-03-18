import { useEffect, useRef, useState, type ReactNode, type HTMLAttributes } from 'react'
import { useCustomFieldSection } from '../../hooks/useCustomFieldSection'
import { useHeaderChipOrder } from '../../hooks/useHeaderChipOrder'
import { useHardcodedFieldOrder } from '../../hooks/useHardcodedFieldOrder'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { CreateCustomFieldModal } from '../crm/CreateCustomFieldModal'
import type { CompanyDecisionLog, CompanyDetail } from '../../../shared/types/company'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import ConfirmDialog from '../common/ConfirmDialog'
import { shouldPromptDecisionLog, defaultDecisionType } from '../../utils/decisionLogTrigger'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import { daysSince, formatCurrency, formatDate } from '../../utils/format'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { addCustomFieldOption, mergeBuiltinOptions } from '../../utils/customFieldUtils'
import { PropertyRow } from '../crm/PropertyRow'
import { ChipSelect } from '../crm/ChipSelect'
import { computeChipDelta } from '../../utils/chip-delta'
import { usePinnedMigration } from '../../hooks/usePinnedMigration'
import {
  COLUMN_DEFS,
  COMPANY_HEADER_KEYS,
  ENTITY_TYPES,
  STAGES,
  PRIORITIES,
  ROUNDS,
  EMPLOYEE_RANGES,
  TARGET_CUSTOMERS,
  BUSINESS_MODELS,
  PRODUCT_STAGES,
} from './companyColumns'
import styles from './CompanyPropertiesPanel.module.css'
import { api } from '../../api'

const ENTITY_TYPE_STYLE: Record<string, string> = {
  prospect: styles.chipProspect,
  portfolio: styles.chipPortfolio,
  pass: styles.chipPass,
  vc_fund: styles.chipVcFund,
  customer: styles.chipCustomer,
  partner: styles.chipPartner,
  vendor: styles.chipVendor,
  unknown: styles.chipUnknown,
  other: styles.chipOther,
}

const STAGE_STYLE: Record<string, string> = {
  screening: styles.chipScreening,
  diligence: styles.chipDiligence,
  decision: styles.chipDecision,
  documentation: styles.chipDocumentation,
  pass: styles.chipPass,
}

const PRIORITY_STYLE: Record<string, string> = {
  high: styles.priorityHigh,
  further_work: styles.priorityFurtherWork,
  monitor: styles.priorityMonitor,
}

const ROUND_STYLE: Record<string, string> = {
  pre_seed: styles.chipPreSeed,
  seed: styles.chipSeed,
  seed_extension: styles.chipSeedExtension,
  series_a: styles.chipSeriesA,
  series_b: styles.chipSeriesB,
}

interface CompanyPropertiesPanelProps {
  company: CompanyDetail
  onUpdate: (updates: Record<string, unknown>) => void
  showEnrichBanner?: boolean
  enrichMeetingCount?: number
  fieldSources?: Record<string, { meetingId: string; meetingTitle: string }>
  onEnrichFromMeetings?: () => void
  isLoadingEnrich?: boolean
}

function HealthBadge({ lastTouchpoint }: { lastTouchpoint: string | null }) {
  const days = daysSince(lastTouchpoint)
  if (days == null) return <span className={`${styles.healthBadge} ${styles.healthNone}`}>No contact</span>
  if (days <= 7) return <span className={`${styles.healthBadge} ${styles.healthGreen}`}>{days}d ago</span>
  if (days <= 30) return <span className={`${styles.healthBadge} ${styles.healthYellow}`}>{days}d ago</span>
  return <span className={`${styles.healthBadge} ${styles.healthRed}`}>{days}d ago</span>
}

function SectionHeader({
  title,
  collapsible,
  isCollapsed,
  onToggle,
}: {
  title: string
  collapsible?: boolean
  isCollapsed?: boolean
  onToggle?: () => void
}) {
  return (
    <div className={styles.sectionHeader}>
      {title}
      {collapsible && (
        <button
          className={styles.sectionCollapseBtn}
          onClick={onToggle}
          title={isCollapsed ? 'Expand section' : 'Collapse section'}
        >
          {isCollapsed ? '▶' : '▼'}
        </button>
      )}
    </div>
  )
}

function googleFaviconUrl(domain: string | null): string | null {
  if (!domain) return null
  return `https://www.google.com/s2/favicons?sz=32&domain=${domain}`
}

function formatPinnedValue(value: unknown, type: string, options?: { value: string; label: string }[]): string | null {
  if (value == null || value === '') return null
  if (options) {
    const opt = options.find((o) => o.value === String(value))
    if (opt) return opt.label
  }
  switch (type) {
    case 'currency': return formatCurrency(Number(value))
    case 'date': return formatDate(String(value))
    default: return String(value)
  }
}

export function CompanyPropertiesPanel({
  company,
  onUpdate,
  showEnrichBanner,
  enrichMeetingCount,
  fieldSources,
  onEnrichFromMeetings,
  isLoadingEnrich,
}: CompanyPropertiesPanelProps) {
  const navigate = useNavigate()
  const [isEditing, setIsEditing] = useState(false)
  const [showAllFields, setShowAllFields] = useState(false)
  const [nameDraft, setNameDraft] = useState(company.canonicalName)
  const [customFields, setCustomFields] = useState<CustomFieldWithValue[]>([])
  const [latestDecision, setLatestDecision] = useState<CompanyDecisionLog | null>(null)
  const [showDecisionModal, setShowDecisionModal] = useState(false)
  const [decisionTriggerType, setDecisionTriggerType] = useState<string | undefined>(undefined)
  const [editDecisionId, setEditDecisionId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [createFieldOpen, setCreateFieldOpen] = useState(false)
  const [createFieldSection, setCreateFieldSection] = useState<string | undefined>(undefined)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [editingFieldLabel, setEditingFieldLabel] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const headerBadgesRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const { getJSON, setJSON } = usePreferencesStore()
  const { companyDefs, refresh, loaded: defsLoaded, load: loadDefs, version: defsVersion } = useCustomFieldStore()
  const pinnedKeys = getJSON<string[]>('cyggie:company-summary-fields', [])
  const hiddenFields = getJSON<string[]>('cyggie:company-hidden-fields', [])
  const hiddenHeaderChips = getJSON<string[]>('cyggie:company-hidden-header-chips', [])

  const entityTypeDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'entityType')
  const stageDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'pipelineStage')
  const priorityDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'priority')
  const roundDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'round')
  const targetCustomerDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'targetCustomer')
  const businessModelDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'businessModel')
  const productStageDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'productStage')
  const employeeCountDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'employeeCountRange')

  const entityTypeOptions = mergeBuiltinOptions(ENTITY_TYPES, entityTypeDef?.optionsJson ?? null)
  const stageOptions = mergeBuiltinOptions(STAGES, stageDef?.optionsJson ?? null)
  const priorityOptions = mergeBuiltinOptions(PRIORITIES, priorityDef?.optionsJson ?? null)
  const roundOptions = mergeBuiltinOptions(ROUNDS, roundDef?.optionsJson ?? null)
  const targetCustomerOptions = mergeBuiltinOptions(TARGET_CUSTOMERS, targetCustomerDef?.optionsJson ?? null)
  const businessModelOptions = mergeBuiltinOptions(BUSINESS_MODELS, businessModelDef?.optionsJson ?? null)
  const productStageOptions = mergeBuiltinOptions(PRODUCT_STAGES, productStageDef?.optionsJson ?? null)
  const employeeRangeOptions = mergeBuiltinOptions(
    EMPLOYEE_RANGES.map(v => ({ value: v, label: v })),
    employeeCountDef?.optionsJson ?? null
  )

  // Per-entity collapsed sections (Change 10)
  const collapsedSectionsKey = `cyggie:company-collapsed:${company.id}`
  const collapsedSections = getJSON<string[]>(collapsedSectionsKey, [])
  function isCollapsed(key: string) { return collapsedSections.includes(key) }
  function toggleSection(key: string) {
    const next = collapsedSections.includes(key)
      ? collapsedSections.filter((k) => k !== key)
      : [...collapsedSections, key]
    setJSON(collapsedSectionsKey, next)
  }

  function togglePinnedKey(key: string, force?: boolean) {
    const next = force === true
      ? (pinnedKeys.includes(key) ? pinnedKeys : [...pinnedKeys, key])
      : force === false
        ? pinnedKeys.filter((k) => k !== key)
        : (pinnedKeys.includes(key) ? pinnedKeys.filter((k) => k !== key) : [...pinnedKeys, key])
    setJSON('cyggie:company-summary-fields', next)
  }

  function hideHeaderChip(key: string) {
    if (!hiddenHeaderChips.includes(key)) {
      setJSON('cyggie:company-hidden-header-chips', [...hiddenHeaderChips, key])
    }
  }

  function restoreHeaderChip(key: string) {
    setJSON('cyggie:company-hidden-header-chips', hiddenHeaderChips.filter(k => k !== key))
  }

  // Migrate old 'Pinned' section fields to 'Header' section (Change 4)
  usePinnedMigration('company')

  function getPinnedFieldValue(field: CustomFieldWithValue): string | number | boolean | null {
    if (!field.value) return null
    switch (field.fieldType) {
      case 'number': case 'currency': return field.value.valueNumber
      case 'boolean': return field.value.valueBoolean
      case 'date': return field.value.valueDate
      case 'contact_ref': case 'company_ref': return field.value.valueRefId
      default: return field.value.valueText
    }
  }

  async function handlePinnedFieldSave(field: CustomFieldWithValue, newValue: string | number | boolean | null) {
    if (newValue == null || newValue === '') {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_DELETE_VALUE, field.id, company.id)
      setCustomFields(prev => prev.map(f => f.id === field.id ? { ...f, value: null } : f))
      return
    }
    const input: import('../../../shared/types/custom-fields').SetCustomFieldValueInput = {
      fieldDefinitionId: field.id,
      entityId: company.id,
      entityType: 'company',
    }
    switch (field.fieldType) {
      case 'number': case 'currency': input.valueNumber = Number(newValue); break
      case 'boolean': input.valueBoolean = Boolean(newValue); break
      case 'date': input.valueDate = String(newValue); break
      case 'contact_ref': case 'company_ref': input.valueRefId = String(newValue); break
      default: input.valueText = String(newValue)
    }
    await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input)
  }

  const { draggingFieldId, setDraggingFieldId, dragOverSection, draggingOverFieldId, setDraggingOverFieldId, sectionedFields, nullSectionFields, handleWithinSectionDrop, sectionDragProps } =
    useCustomFieldSection('company', company.id, customFields, setCustomFields)

  const hfOrder = useHardcodedFieldOrder('company')

  const customSummaryIds = customFields.filter(f => f.section === 'summary').map(f => `custom:${f.id}`)
  const allChipIds = [...new Set(['entityType', 'pipelineStage', 'priority', 'round', ...pinnedKeys, ...customSummaryIds])]
  const { effectiveOrder, chipDragProps, chipDropZoneProps, chipDragOverIndex } =
    useHeaderChipOrder('company', allChipIds)

  // Inline field label rename (Change 11)
  async function handleFieldLabelSave(fieldId: string, newLabel: string) {
    const trimmed = newLabel.trim()
    if (!trimmed) { setEditingFieldId(null); return }
    const prev = customFields
    setCustomFields(fs => fs.map(f => f.id === fieldId ? { ...f, label: trimmed } : f))
    setEditingFieldId(null)
    try {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, fieldId, { label: trimmed })
    } catch {
      setCustomFields(prev) // rollback on failure
    }
  }

  // Wrap sectionDragProps to also sync pinnedKeys when a field crosses the 'summary' boundary (Change 1)
  function syncedSectionDragProps(sectionKey: string): HTMLAttributes<HTMLDivElement> {
    const base = sectionDragProps(sectionKey)
    return {
      ...base,
      onDrop: (e) => {
        if (draggingFieldId) {
          const draggingField = customFields.find(f => f.id === draggingFieldId)
          const fromSection = draggingField?.section ?? null
          const chipId = `custom:${draggingFieldId}`
          const newPinnedKeys = computeChipDelta(fromSection, sectionKey, chipId, pinnedKeys)
          if (newPinnedKeys !== pinnedKeys) {
            setJSON('cyggie:company-summary-fields', newPinnedKeys)
          }
        }
        base.onDrop?.(e)
      },
    }
  }

  // Sync name draft when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setNameDraft(company.canonicalName)
      setTimeout(() => nameInputRef.current?.focus(), 0)
    }
  }, [isEditing, company.canonicalName])

  useEffect(() => {
    if (!defsLoaded) loadDefs()
  }, [defsLoaded, loadDefs])

  useEffect(() => {
    if (!defsLoaded) return
    window.api
      .invoke<{ success: boolean; data?: CustomFieldWithValue[] }>(
        IPC_CHANNELS.CUSTOM_FIELD_GET_VALUES,
        'company',
        company.id
      )
      .then((res) => { if (res.success && res.data) setCustomFields(res.data) })
      .catch(console.error)
  }, [company.id, defsLoaded, defsVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.api
      .invoke<CompanyDecisionLog | null>(IPC_CHANNELS.COMPANY_DECISION_LOG_GET_LATEST, company.id)
      .then((d) => setLatestDecision(d ?? null))
      .catch(() => {})
  }, [company.id])

  function save(field: string, value: unknown) {
    return window.api
      .invoke(IPC_CHANNELS.COMPANY_UPDATE, company.id, { [field]: value })
      .then(() => { onUpdate({ [field]: value }) })
  }

  function saveWithDecisionPrompt(field: 'pipelineStage' | 'entityType', value: unknown) {
    const prevStage = company.pipelineStage
    const prevEntityType = company.entityType
    const newStage = field === 'pipelineStage' ? (value as string | null) : prevStage
    const newEntityType = field === 'entityType' ? (value as string) : prevEntityType
    save(field, value).then(() => {
      if (shouldPromptDecisionLog(prevStage, newStage, prevEntityType, newEntityType ?? 'unknown')) {
        setDecisionTriggerType(defaultDecisionType(newStage, newEntityType ?? 'unknown'))
        setShowDecisionModal(true)
      }
    }).catch(console.error)
  }

  function handleDone() {
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== company.canonicalName) {
      save('canonicalName', trimmed).catch(console.error)
    }
    setIsEditing(false)
  }

  async function handleDeleteCompany() {
    if (deleting) return
    setDeleting(true)
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_DELETE, company.id)
      navigate('/companies')
    } catch (err) {
      console.error('[CompanyPropertiesPanel] delete failed:', err)
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleDone()
    if (e.key === 'Escape') setIsEditing(false)
  }

  function show(value: unknown): boolean {
    if (isEditing || showAllFields) return true
    return value !== null && value !== undefined && value !== ''
  }

  function hideField(key: string) {
    setJSON('cyggie:company-hidden-fields', [...hiddenFields, key])
  }

  function restoreField(key: string) {
    setJSON('cyggie:company-hidden-fields', hiddenFields.filter(k => k !== key))
  }

  function HideableRow({ fieldKey, children }: { fieldKey: string; children: ReactNode }) {
    const isHidden = hiddenFields.includes(fieldKey)
    return (
      <div className={`${styles.hideable} ${isHidden ? styles.fieldHidden : ''}`}>
        <div className={styles.hideableContent}>{children}</div>
        {(showAllFields || isEditing) && (
          isHidden
            ? <button className={styles.restoreBtn} title="Restore field" onClick={() => restoreField(fieldKey)}>↺</button>
            : <button className={styles.hideBtn} title="Hide field" onClick={() => hideField(fieldKey)}>×</button>
        )}
      </div>
    )
  }

  function renderSectionedFields(sectionKey: string) {
    const opts = (field: (typeof customFields)[0]) => {
      try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] }
    }
    return sectionedFields(sectionKey).map((field) => {
      const fieldKey = `custom:${field.id}`
      if (hiddenFields.includes(fieldKey) && !isEditing && !showAllFields) return null
      const isDropTarget = draggingOverFieldId === field.id && draggingFieldId !== field.id
      return (
        <div
          key={field.id}
          className={`${styles.sectionedFieldRow} ${isDropTarget ? styles.dragOverFieldIndicator : ''}`}
          draggable={isEditing}
          onDragStart={() => setDraggingFieldId(field.id)}
          onDragEnd={() => { setDraggingFieldId(null); setDraggingOverFieldId(null) }}
          onDragOver={(e) => {
            e.preventDefault()
            if (isEditing && draggingOverFieldId !== field.id) setDraggingOverFieldId(field.id)
          }}
          onDrop={(e) => {
            e.stopPropagation()
            if (isEditing) handleWithinSectionDrop(field.id)
          }}
        >
          {isEditing && <span className={styles.dragHandle}>⠿</span>}
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
              type={field.fieldType as import('../crm/PropertyRow').PropertyRowType}
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
        </div>
      )
    })
  }

  function renderHardcodedSection(
    fields: Array<{ key: string; visible: boolean; render: () => ReactNode }>,
    sectionKey: string
  ) {
    const ordered = hfOrder.applyOrder(fields, sectionKey)
    return ordered.map((field) => {
      if (!field.visible) return null
      const isDropTarget = hfOrder.draggingOverKey === field.key && hfOrder.draggingKey !== field.key
      return (
        <div
          key={field.key}
          className={`${styles.sectionedFieldRow} ${isDropTarget ? styles.dragOverFieldIndicator : ''}`}
          draggable={isEditing}
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
          {isEditing && <span className={styles.dragHandle}>⠿</span>}
          <div style={{ flex: 1, minWidth: 0 }}>{field.render()}</div>
        </div>
      )
    })
  }

  function renderPinnedChip(key: string) {
    if (key.startsWith('custom:')) {
      const id = key.slice(7)
      const def = companyDefs.find((d) => d.id === id)
      if (!def) return null
      const fieldWithValue = customFields.find((f) => f.id === id)
      if (!fieldWithValue?.value) return null
      // Determine display value
      let display = ''
      const v = fieldWithValue.value
      switch (def.fieldType) {
        case 'currency': display = formatCurrency(v.valueNumber ?? 0); break
        case 'date': display = v.valueDate ? formatDate(v.valueDate) : ''; break
        case 'boolean': display = v.valueBoolean != null ? (v.valueBoolean ? 'Yes' : 'No') : ''; break
        case 'contact_ref':
        case 'company_ref': display = v.resolvedLabel ?? v.valueRefId ?? ''; break
        default: display = v.valueText ?? ''
      }
      if (!display) return null
      return (
        <span key={key} className={`${styles.badge} ${styles.pinnedBadge}`} title={def.label}>
          {def.label}: {display}
        </span>
      )
    }

    // Built-in field
    const col = COLUMN_DEFS.find((c) => c.key === key)
    if (!col || !col.field) return null
    const value = (company as Record<string, unknown>)[col.field]
    const display = formatPinnedValue(value, col.type, col.options as { value: string; label: string }[] | undefined)
    if (!display) return null
    return (
      <span key={key} className={`${styles.badge} ${styles.pinnedBadge}`} title={col.label}>
        {col.label}: {display}
      </span>
    )
  }

  const CHIP_LABELS: Record<string, string> = {
    entityType: 'Type',
    pipelineStage: 'Stage',
    priority: 'Priority',
    round: 'Round',
  }

  function renderChipById(id: string) {
    switch (id) {
      case 'entityType':
        return (
          <ChipSelect
            value={company.entityType}
            options={entityTypeOptions}
            isEditing={isEditing}
            onSave={(v) => saveWithDecisionPrompt('entityType', v ?? 'unknown')}
            className={`${styles.badge} ${ENTITY_TYPE_STYLE[company.entityType] ?? ''}`}
            allowEmpty={false}
            onAddOption={entityTypeDef ? async (opt) => addCustomFieldOption(entityTypeDef.id, entityTypeDef.optionsJson, opt) : undefined}
          />
        )
      case 'pipelineStage':
        return (
          <ChipSelect
            value={company.pipelineStage ?? ''}
            options={[{ value: '', label: '—' }, ...stageOptions]}
            isEditing={isEditing}
            onSave={(v) => saveWithDecisionPrompt('pipelineStage', v || null)}
            className={`${styles.badge} ${company.pipelineStage ? (STAGE_STYLE[company.pipelineStage] ?? '') : ''}`}
            onAddOption={stageDef ? async (opt) => addCustomFieldOption(stageDef.id, stageDef.optionsJson, opt) : undefined}
          />
        )
      case 'priority':
        return (
          <ChipSelect
            value={company.priority ?? ''}
            options={[{ value: '', label: '—' }, ...priorityOptions]}
            isEditing={isEditing}
            onSave={(v) => save('priority', v || null)}
            className={`${styles.badge} ${company.priority ? (PRIORITY_STYLE[company.priority] ?? '') : ''}`}
            onAddOption={priorityDef ? async (opt) => addCustomFieldOption(priorityDef.id, priorityDef.optionsJson, opt) : undefined}
          />
        )
      case 'round':
        return (
          <ChipSelect
            value={company.round ?? ''}
            options={[{ value: '', label: '—' }, ...roundOptions]}
            isEditing={isEditing}
            onSave={(v) => save('round', v || null)}
            className={`${styles.badge} ${company.round ? (ROUND_STYLE[company.round] ?? '') : ''}`}
            onAddOption={roundDef ? async (opt) => addCustomFieldOption(roundDef.id, roundDef.optionsJson, opt) : undefined}
          />
        )
      default:
        return renderPinnedChip(id)
    }
  }

  // Count of explicitly-hidden fields + empty hardcoded fields (Change 6)
  const hiddenFieldCount = !isEditing && !showAllFields ? (
    hiddenFields.length +
    ([company.description, company.sector, company.targetCustomer,
      company.businessModel, company.productStage, company.foundingYear,
      company.employeeCountRange, company.hqAddress, company.revenueModel,
      company.dealSource, company.warmIntroSource, company.referralContactId,
      company.relationshipOwner, company.nextFollowupDate,
      company.raiseSize, company.postMoneyValuation, company.arr,
      company.burnRate, company.runwayMonths, company.lastFundingDate,
      company.totalFundingRaised, company.leadInvestor, company.coInvestors,
      company.websiteUrl, company.linkedinCompanyUrl, company.crunchbaseUrl,
      company.angellistUrl, company.twitterHandle]
      .filter(v => !v).length) +
    customFields.filter(f => !f.value && f.section !== 'summary').length
  ) : 0

  const faviconUrl = googleFaviconUrl(company.primaryDomain)

  return (
    <div ref={panelRef} className={styles.panel}>
      {showEnrichBanner && (
        <div className={styles.enrichBanner}>
          <span>✨ Meeting data available</span>
          <button
            className={styles.enrichBannerBtn}
            onClick={onEnrichFromMeetings}
            disabled={isLoadingEnrich}
          >
            {isLoadingEnrich
              ? 'Loading…'
              : `Enrich profile (${enrichMeetingCount} meeting${enrichMeetingCount !== 1 ? 's' : ''})`
            }
          </button>
        </div>
      )}
      {/* Header */}
      <div className={styles.header}>
        {faviconUrl && (
          <img
            src={faviconUrl}
            className={styles.logo}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            alt=""
          />
        )}
        <div className={styles.headerMeta}>
          {isEditing ? (
            <input
              ref={nameInputRef}
              className={styles.nameInput}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={handleNameKeyDown}
            />
          ) : (
            <div className={styles.companyName}>{company.canonicalName}</div>
          )}
          <div
            className={`${styles.headerBadges} ${isEditing && dragOverSection === 'summary' ? styles.dropTarget : ''}`}
            ref={headerBadgesRef}
            {...(isEditing ? syncedSectionDragProps('summary') : {})}
          >
            {effectiveOrder.map((id, i) => {
              const isHidden = hiddenHeaderChips.includes(id)
              if (!isEditing && isHidden) return null
              return (
                <div
                  key={id}
                  className={`${styles.headerChipDraggable} ${chipDragOverIndex === i ? styles.chipDropIndicator : ''} ${isEditing && isHidden ? styles.hiddenHeaderChip : ''}`}
                  {...chipDragProps(id)}
                  {...chipDropZoneProps(i)}
                >
                  {isEditing && isHidden ? (
                    <span className={styles.hiddenChipPlaceholder}>
                      {CHIP_LABELS[id] ?? id}
                      <button className={styles.restoreChipBtn} title="Restore chip" onClick={() => restoreHeaderChip(id)}>↺</button>
                    </span>
                  ) : (
                    <>
                      {isEditing && CHIP_LABELS[id] ? (
                        <div className={styles.editChipField}>
                          <span className={styles.editChipLabel}>{CHIP_LABELS[id]}</span>
                          {renderChipById(id)}
                        </div>
                      ) : (
                        renderChipById(id)
                      )}
                      {isEditing && (
                        <button className={styles.hideChipBtn} title="Hide chip" onClick={() => hideHeaderChip(id)}>×</button>
                      )}
                    </>
                  )}
                </div>
              )
            })}
            <HealthBadge lastTouchpoint={company.lastTouchpoint} />
          </div>
        </div>
        {isEditing ? (
          <button className={styles.doneBtn} onClick={handleDone} disabled={deleting}>
            Done
          </button>
        ) : (
          <button className={styles.editBtn} onClick={() => setIsEditing(true)}>Edit</button>
        )}
      </div>

      {/* Current Decision widget */}
      {latestDecision && (
        <div
          className={`${styles.decisionWidget} ${
            ['Investment Approved', 'Increase Allocation', 'Follow-on'].includes(latestDecision.decisionType)
              ? styles.decisionWidgetGreen
              : latestDecision.decisionType === 'Pass'
              ? styles.decisionWidgetRed
              : styles.decisionWidgetGrey
          }`}
          onClick={() => { setEditDecisionId(latestDecision.id); setShowDecisionModal(false) }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') { setEditDecisionId(latestDecision.id); setShowDecisionModal(false) } }}
        >
          <div className={styles.decisionWidgetTop}>
            <span className={styles.decisionWidgetType}>{latestDecision.decisionType}</span>
            <span className={styles.decisionWidgetDate}>{latestDecision.decisionDate}</span>
          </div>
          <div className={styles.decisionWidgetMeta}>
            {latestDecision.decisionOwner && <span>{latestDecision.decisionOwner}</span>}
            {latestDecision.amountApproved && <span>{latestDecision.amountApproved}</span>}
            {latestDecision.targetOwnership && <span>{latestDecision.targetOwnership}</span>}
          </div>
        </div>
      )}

      {show(company.websiteUrl) && (
        isEditing ? (
          <PropertyRow label="Website" value={company.websiteUrl} type="url" editMode={true} onSave={(v) => save('websiteUrl', v)} />
        ) : (
          <a
            className={styles.websiteLink}
            href="#"
            onClick={(e) => {
              e.preventDefault()
              if (company.websiteUrl) {
                api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, company.websiteUrl).catch(console.error)
              }
            }}
          >
            {company.websiteUrl}
          </a>
        )
      )}
      {show(company.description) && (
        isEditing ? (
          <PropertyRow label="Description" value={company.description} type="textarea" editMode={true} onSave={(v) => save('description', v)} />
        ) : (
          <div className={styles.propertyWithBadge}>
            <p className={styles.descriptionText}>{company.description}</p>
            {fieldSources?.description && (
              <span className={styles.sourceBadge} title={`From: ${fieldSources.description.meetingTitle}`}>📋</span>
            )}
          </div>
        )
      )}
      <div className={styles.headerDivider} />

      <div {...syncedSectionDragProps('overview')} className={isEditing && dragOverSection === 'overview' ? styles.dropTarget : ''}>
        <SectionHeader title="Overview" collapsible isCollapsed={isCollapsed('overview')} onToggle={() => toggleSection('overview')} />
        {!isCollapsed('overview') && (<>
        {renderHardcodedSection([
          { key: 'sector', visible: show(company.sector), render: () => <PropertyRow label="Sector" value={company.sector} type="text" editMode={isEditing} onSave={(v) => save('sector', v)} /> },
          { key: 'targetCustomer', visible: show(company.targetCustomer), render: () => (
            <PropertyRow label="Target Customer" value={company.targetCustomer} type="select" options={targetCustomerOptions} editMode={isEditing} onSave={(v) => save('targetCustomer', v)} onAddOption={targetCustomerDef ? async (opt) => addCustomFieldOption(targetCustomerDef.id, targetCustomerDef.optionsJson, opt) : undefined} />
          )},
          { key: 'businessModel', visible: show(company.businessModel), render: () => (
            <PropertyRow label="Business Model" value={company.businessModel} type="select" options={businessModelOptions} editMode={isEditing} onSave={(v) => save('businessModel', v)} onAddOption={businessModelDef ? async (opt) => addCustomFieldOption(businessModelDef.id, businessModelDef.optionsJson, opt) : undefined} />
          )},
          { key: 'productStage', visible: show(company.productStage), render: () => (
            <PropertyRow label="Product Stage" value={company.productStage} type="select" options={productStageOptions} editMode={isEditing} onSave={(v) => save('productStage', v)} onAddOption={productStageDef ? async (opt) => addCustomFieldOption(productStageDef.id, productStageDef.optionsJson, opt) : undefined} />
          )},
          { key: 'foundingYear', visible: show(company.foundingYear), render: () => <PropertyRow label="Founded" value={company.foundingYear} type="number" editMode={isEditing} onSave={(v) => save('foundingYear', v)} /> },
          { key: 'employeeCountRange', visible: show(company.employeeCountRange), render: () => (
            <PropertyRow label="Employees" value={company.employeeCountRange} type="select" options={employeeRangeOptions} editMode={isEditing} onSave={(v) => save('employeeCountRange', v)} onAddOption={employeeCountDef ? async (opt) => addCustomFieldOption(employeeCountDef.id, employeeCountDef.optionsJson, opt) : undefined} />
          )},
          { key: 'hqAddress', visible: show(company.hqAddress), render: () => <PropertyRow label="HQ" value={company.hqAddress} type="text" editMode={isEditing} onSave={(v) => save('hqAddress', v)} /> },
          { key: 'revenueModel', visible: show(company.revenueModel), render: () => <PropertyRow label="Revenue Model" value={company.revenueModel} type="text" editMode={isEditing} onSave={(v) => save('revenueModel', v)} /> },
        ], 'overview')}
        {renderSectionedFields('overview')}
        {isEditing && (
          <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('overview'); setCreateFieldOpen(true) }}>+ Add field</button>
        )}
        {nullSectionFields().map((field) => {
          const opts = (() => { try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] } })()
          return (
            <div
              key={field.id}
              className={styles.sectionedFieldRow}
              title="No section assigned — drag to reassign"
              draggable={isEditing}
              onDragStart={() => setDraggingFieldId(field.id)}
              onDragEnd={() => setDraggingFieldId(null)}
            >
              {isEditing && <span className={styles.dragHandle}>⠿</span>}
              <PropertyRow
                label={field.label}
                value={getPinnedFieldValue(field)}
                type={field.fieldType as import('../crm/PropertyRow').PropertyRowType}
                options={opts}
                editMode={isEditing}
                onSave={(val) => handlePinnedFieldSave(field, val)}
              />
            </div>
          )
        })}
        </>)}
      </div>

      <div {...syncedSectionDragProps('pipeline')} className={isEditing && dragOverSection === 'pipeline' ? styles.dropTarget : ''}>
        <SectionHeader title="Pipeline" collapsible isCollapsed={isCollapsed('pipeline')} onToggle={() => toggleSection('pipeline')} />
        {!isCollapsed('pipeline') && (<>
        {renderHardcodedSection([
          { key: 'pipelineStage', visible: true, render: () => (
            <div className={!isEditing && fieldSources?.pipelineStage ? styles.propertyWithBadge : undefined}>
              <PropertyRow label="Stage" value={company.pipelineStage} type="select" options={[{ value: '', label: '—' }, ...stageOptions]} editMode={isEditing} onSave={(v) => saveWithDecisionPrompt('pipelineStage', v || null)} onAddOption={stageDef ? async (opt) => addCustomFieldOption(stageDef.id, stageDef.optionsJson, opt) : undefined} />
              {!isEditing && fieldSources?.pipelineStage && <span className={styles.sourceBadge} title={`From: ${fieldSources.pipelineStage.meetingTitle}`}>📋</span>}
            </div>
          )},
          { key: 'priority', visible: true, render: () => (
            <PropertyRow label="Priority" value={company.priority} type="select" options={[{ value: '', label: '—' }, ...priorityOptions]} editMode={isEditing} onSave={(v) => save('priority', v)} onAddOption={priorityDef ? async (opt) => addCustomFieldOption(priorityDef.id, priorityDef.optionsJson, opt) : undefined} />
          )},
          { key: 'dealSource', visible: show(company.dealSource), render: () => <PropertyRow label="Deal Source" value={company.dealSource} type="text" editMode={isEditing} onSave={(v) => save('dealSource', v)} /> },
          { key: 'warmIntroSource', visible: show(company.warmIntroSource), render: () => <PropertyRow label="Warm Intro Source" value={company.warmIntroSource} type="text" editMode={isEditing} onSave={(v) => save('warmIntroSource', v)} /> },
          { key: 'referralContactId', visible: show(company.referralContactId), render: () => <PropertyRow label="Referral Contact" value={company.referralContactId} type="contact_ref" editMode={isEditing} onSave={(v) => save('referralContactId', v)} /> },
          { key: 'relationshipOwner', visible: show(company.relationshipOwner), render: () => <PropertyRow label="Relationship Owner" value={company.relationshipOwner} type="text" editMode={isEditing} onSave={(v) => save('relationshipOwner', v)} /> },
          { key: 'nextFollowupDate', visible: show(company.nextFollowupDate), render: () => <PropertyRow label="Next Follow-up" value={company.nextFollowupDate} type="date" editMode={isEditing} onSave={(v) => save('nextFollowupDate', v)} /> },
        ], 'pipeline')}
        {renderSectionedFields('pipeline')}
        {isEditing && (
          <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('pipeline'); setCreateFieldOpen(true) }}>+ Add field</button>
        )}
        </>)}
      </div>

      <div {...syncedSectionDragProps('financials')} className={isEditing && dragOverSection === 'financials' ? styles.dropTarget : ''}>
        <SectionHeader title="Financials" collapsible isCollapsed={isCollapsed('financials')} onToggle={() => toggleSection('financials')} />
        {!isCollapsed('financials') && (<>
        {renderHardcodedSection([
          { key: 'round', visible: show(company.round), render: () => (
            <div className={!isEditing && fieldSources?.round ? styles.propertyWithBadge : undefined}>
              <PropertyRow label="Round" value={company.round} type="select" options={[{ value: '', label: '—' }, ...roundOptions]} editMode={isEditing} onSave={(v) => save('round', v)} onAddOption={roundDef ? async (opt) => addCustomFieldOption(roundDef.id, roundDef.optionsJson, opt) : undefined} />
              {!isEditing && fieldSources?.round && <span className={styles.sourceBadge} title={`From: ${fieldSources.round.meetingTitle}`}>📋</span>}
            </div>
          )},
          { key: 'raiseSize', visible: show(company.raiseSize), render: () => (
            <div className={!isEditing && fieldSources?.raiseSize ? styles.propertyWithBadge : undefined}>
              <PropertyRow label="Raise Size" value={company.raiseSize} type="currency" editMode={isEditing} onSave={(v) => save('raiseSize', v)} />
              {!isEditing && fieldSources?.raiseSize && <span className={styles.sourceBadge} title={`From: ${fieldSources.raiseSize.meetingTitle}`}>📋</span>}
            </div>
          )},
          { key: 'postMoneyValuation', visible: show(company.postMoneyValuation), render: () => (
            <div className={!isEditing && fieldSources?.postMoneyValuation ? styles.propertyWithBadge : undefined}>
              <PropertyRow label="Post-Money Val." value={company.postMoneyValuation} type="currency" editMode={isEditing} onSave={(v) => save('postMoneyValuation', v)} />
              {!isEditing && fieldSources?.postMoneyValuation && <span className={styles.sourceBadge} title={`From: ${fieldSources.postMoneyValuation.meetingTitle}`}>📋</span>}
            </div>
          )},
          { key: 'arr', visible: show(company.arr), render: () => <PropertyRow label="ARR" value={company.arr} type="currency" editMode={isEditing} onSave={(v) => save('arr', v)} /> },
          { key: 'burnRate', visible: show(company.burnRate), render: () => <PropertyRow label="Burn Rate" value={company.burnRate} type="currency" editMode={isEditing} onSave={(v) => save('burnRate', v)} /> },
          { key: 'runwayMonths', visible: show(company.runwayMonths), render: () => <PropertyRow label="Runway (months)" value={company.runwayMonths} type="number" editMode={isEditing} onSave={(v) => save('runwayMonths', v)} /> },
          { key: 'lastFundingDate', visible: show(company.lastFundingDate), render: () => <PropertyRow label="Last Funded" value={company.lastFundingDate} type="date" editMode={isEditing} onSave={(v) => save('lastFundingDate', v)} /> },
          { key: 'totalFundingRaised', visible: show(company.totalFundingRaised), render: () => <PropertyRow label="Total Raised" value={company.totalFundingRaised} type="currency" editMode={isEditing} onSave={(v) => save('totalFundingRaised', v)} /> },
          { key: 'leadInvestor', visible: show(company.leadInvestor), render: () => <PropertyRow label="Lead Investor" value={company.leadInvestor} type="text" editMode={isEditing} onSave={(v) => save('leadInvestor', v)} /> },
          { key: 'coInvestors', visible: show(company.coInvestors), render: () => <PropertyRow label="Co-Investors" value={company.coInvestors} type="text" editMode={isEditing} onSave={(v) => save('coInvestors', v)} /> },
        ], 'financials')}
        {renderSectionedFields('financials')}
        {isEditing && (
          <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('financials'); setCreateFieldOpen(true) }}>+ Add field</button>
        )}
        </>)}
      </div>

      {(isEditing || company.entityType === 'portfolio' ||
        company.investmentSize || company.ownershipPct ||
        company.followonInvestmentSize || company.totalInvested ||
        sectionedFields('investment').length > 0) && (
        <div {...syncedSectionDragProps('investment')} className={isEditing && dragOverSection === 'investment' ? styles.dropTarget : ''}>
          <SectionHeader title="Investment" collapsible isCollapsed={isCollapsed('investment')} onToggle={() => toggleSection('investment')} />
          {!isCollapsed('investment') && (<>
          {renderHardcodedSection([
            { key: 'investmentSize', visible: show(company.investmentSize), render: () => <PropertyRow label="Investment Size" value={company.investmentSize} type="text" editMode={isEditing} onSave={(v) => save('investmentSize', v)} /> },
            { key: 'ownershipPct', visible: show(company.ownershipPct), render: () => <PropertyRow label="Ownership %" value={company.ownershipPct} type="text" editMode={isEditing} onSave={(v) => save('ownershipPct', v)} /> },
            { key: 'followonInvestmentSize', visible: show(company.followonInvestmentSize), render: () => <PropertyRow label="Follow-on Size" value={company.followonInvestmentSize} type="text" editMode={isEditing} onSave={(v) => save('followonInvestmentSize', v)} /> },
            { key: 'totalInvested', visible: show(company.totalInvested), render: () => <PropertyRow label="Total Invested" value={company.totalInvested} type="text" editMode={isEditing} onSave={(v) => save('totalInvested', v)} /> },
          ], 'investment')}
          {renderSectionedFields('investment')}
          {isEditing && (
            <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('investment'); setCreateFieldOpen(true) }}>+ Add field</button>
          )}
          </>)}
        </div>
      )}

      <div {...syncedSectionDragProps('links')} className={isEditing && dragOverSection === 'links' ? styles.dropTarget : ''}>
        <SectionHeader title="Links" collapsible isCollapsed={isCollapsed('links')} onToggle={() => toggleSection('links')} />
        {!isCollapsed('links') && (<>
        {renderHardcodedSection([
          { key: 'linkedinCompanyUrl', visible: show(company.linkedinCompanyUrl), render: () => <PropertyRow label="LinkedIn" value={company.linkedinCompanyUrl} type="url" editMode={isEditing} onSave={(v) => save('linkedinCompanyUrl', v)} /> },
          { key: 'crunchbaseUrl', visible: show(company.crunchbaseUrl), render: () => <PropertyRow label="Crunchbase" value={company.crunchbaseUrl} type="url" editMode={isEditing} onSave={(v) => save('crunchbaseUrl', v)} /> },
          { key: 'angellistUrl', visible: show(company.angellistUrl), render: () => <PropertyRow label="AngelList" value={company.angellistUrl} type="url" editMode={isEditing} onSave={(v) => save('angellistUrl', v)} /> },
          { key: 'twitterHandle', visible: show(company.twitterHandle), render: () => <PropertyRow label="Twitter/X" value={company.twitterHandle} type="text" editMode={isEditing} onSave={(v) => save('twitterHandle', v)} /> },
        ], 'links')}
        {renderSectionedFields('links')}
        {isEditing && (
          <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('links'); setCreateFieldOpen(true) }}>+ Add field</button>
        )}
        </>)}
      </div>

      {hiddenFieldCount > 0 && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(true)}>
          {hiddenFieldCount} field{hiddenFieldCount !== 1 ? 's' : ''} hidden · Show
        </button>
      )}
      {showAllFields && !isEditing && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(false)}>
          Hide empty fields
        </button>
      )}

      {createFieldOpen && (
        <CreateCustomFieldModal
          entityType="company"
          defaultSection={createFieldSection}
          onSaved={(def) => {
            void refresh().then(() => {
              setCreateFieldOpen(false)
              setCreateFieldSection(undefined)
              // Auto-add to pinnedKeys if created in Header section
              if (def.section === 'summary') {
                togglePinnedKey(`custom:${def.id}`, true)
              }
            })
          }}
          onClose={() => { setCreateFieldOpen(false); setCreateFieldSection(undefined) }}
        />
      )}

      {isEditing && (
        <div className={styles.deleteSection}>
          <button
            className={styles.deleteBtn}
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
          >
            Delete Company
          </button>
        </div>
      )}

      {/* Stage-change decision prompt */}
      {showDecisionModal && (
        <DecisionLogModal
          companyId={company.id}
          initialDecisionType={decisionTriggerType}
          onClose={() => setShowDecisionModal(false)}
          onSaved={(log) => {
            setLatestDecision(log)
            setShowDecisionModal(false)
          }}
        />
      )}

      {/* Edit existing decision from widget */}
      {editDecisionId && (
        <DecisionLogModal
          companyId={company.id}
          logId={editDecisionId}
          onClose={() => setEditDecisionId(null)}
          onSaved={(log) => {
            setLatestDecision(log)
            setEditDecisionId(null)
          }}
          onDeleted={() => {
            setLatestDecision(null)
            setEditDecisionId(null)
          }}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete company?"
        message={`Delete "${company.canonicalName}" and all associated data? This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
        onConfirm={handleDeleteCompany}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
