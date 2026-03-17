import { useEffect, useRef, useState } from 'react'
import { useCustomFieldSection } from '../../hooks/useCustomFieldSection'
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
import { CustomFieldsPanel } from '../crm/CustomFieldsPanel'
import { ChipSelect } from '../crm/ChipSelect'
import { SummaryConfigPopover } from '../crm/SummaryConfigPopover'
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
}

function HealthBadge({ lastTouchpoint }: { lastTouchpoint: string | null }) {
  const days = daysSince(lastTouchpoint)
  if (days == null) return <span className={`${styles.healthBadge} ${styles.healthNone}`}>No contact</span>
  if (days <= 7) return <span className={`${styles.healthBadge} ${styles.healthGreen}`}>{days}d ago</span>
  if (days <= 30) return <span className={`${styles.healthBadge} ${styles.healthYellow}`}>{days}d ago</span>
  return <span className={`${styles.healthBadge} ${styles.healthRed}`}>{days}d ago</span>
}

function SectionHeader({ title }: { title: string }) {
  return <div className={styles.sectionHeader}>{title}</div>
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

export function CompanyPropertiesPanel({ company, onUpdate }: CompanyPropertiesPanelProps) {
  const navigate = useNavigate()
  const [isEditing, setIsEditing] = useState(false)
  const [showAllFields, setShowAllFields] = useState(false)
  const [nameDraft, setNameDraft] = useState(company.canonicalName)
  const [showConfig, setShowConfig] = useState(false)
  const [customFields, setCustomFields] = useState<CustomFieldWithValue[]>([])
  const [latestDecision, setLatestDecision] = useState<CompanyDecisionLog | null>(null)
  const [showDecisionModal, setShowDecisionModal] = useState(false)
  const [decisionTriggerType, setDecisionTriggerType] = useState<string | undefined>(undefined)
  const [editDecisionId, setEditDecisionId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [createFieldOpen, setCreateFieldOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const headerBadgesRef = useRef<HTMLDivElement>(null)

  const { getJSON, setJSON } = usePreferencesStore()
  const { companyDefs, refresh } = useCustomFieldStore()
  const pinnedKeys = getJSON<string[]>('cyggie:company-summary-fields', [])
  const pinnedFieldKeys = getJSON<string[]>('cyggie:company-pinned-fields', [])

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

  function togglePinnedKey(key: string) {
    const next = pinnedKeys.includes(key)
      ? pinnedKeys.filter((k) => k !== key)
      : [...pinnedKeys, key]
    setJSON('cyggie:company-summary-fields', next)
  }

  function togglePinnedField(key: string) {
    const next = pinnedFieldKeys.includes(key)
      ? pinnedFieldKeys.filter((k) => k !== key)
      : [...pinnedFieldKeys, key]
    setJSON('cyggie:company-pinned-fields', next)
  }

  // One-time migration: copy custom: keys from summary-fields → pinned-fields if pinned-fields is empty
  useEffect(() => {
    if (pinnedFieldKeys.length === 0) {
      const customKeys = pinnedKeys.filter(k => k.startsWith('custom:'))
      if (customKeys.length > 0) {
        setJSON('cyggie:company-pinned-fields', customKeys)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pinnedCustomFields = pinnedFieldKeys
    .filter(k => k.startsWith('custom:'))
    .map(key => customFields.find(f => f.id === key.slice(7)) ?? null)
    .filter((f): f is NonNullable<typeof f> => f !== null)

  function getPinnedFieldValue(field: (typeof pinnedCustomFields)[0]): string | number | boolean | null {
    if (!field.value) return null
    switch (field.fieldType) {
      case 'number': case 'currency': return field.value.valueNumber
      case 'boolean': return field.value.valueBoolean
      case 'date': return field.value.valueDate
      case 'contact_ref': case 'company_ref': return field.value.valueRefId
      default: return field.value.valueText
    }
  }

  async function handlePinnedFieldSave(field: (typeof pinnedCustomFields)[0], newValue: string | number | boolean | null) {
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

  const { draggingFieldId, setDraggingFieldId, dragOverSection, sectionedFields, handleFieldDrop, sectionDragProps } =
    useCustomFieldSection('company', company.id, customFields, setCustomFields)

  // Sync name draft when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setNameDraft(company.canonicalName)
      setTimeout(() => nameInputRef.current?.focus(), 0)
    }
  }, [isEditing, company.canonicalName])

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

  function renderSectionedFields(sectionKey: string) {
    const opts = (field: (typeof customFields)[0]) => {
      try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] }
    }
    return sectionedFields(sectionKey).map((field) => (
      <div
        key={field.id}
        className={styles.sectionedFieldRow}
        draggable={isEditing}
        onDragStart={() => setDraggingFieldId(field.id)}
        onDragEnd={() => setDraggingFieldId(null)}
      >
        {isEditing && <span className={styles.dragHandle}>⠿</span>}
        <PropertyRow
          label={field.label}
          value={getPinnedFieldValue(field)}
          type={field.fieldType as import('../crm/PropertyRow').PropertyRowType}
          options={opts(field)}
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
      </div>
    ))
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

  const hasHiddenFields = !isEditing && !showAllFields && (
    !company.description || !company.sector || !company.targetCustomer ||
    !company.businessModel || !company.productStage || !company.foundingYear ||
    !company.employeeCountRange || !company.hqAddress || !company.revenueModel ||
    !company.dealSource || !company.warmIntroSource || !company.referralContactId ||
    !company.relationshipOwner || !company.nextFollowupDate ||
    !company.raiseSize || !company.postMoneyValuation || !company.arr ||
    !company.burnRate || !company.runwayMonths || !company.lastFundingDate ||
    !company.totalFundingRaised || !company.leadInvestor || !company.coInvestors ||
    !company.websiteUrl || !company.linkedinCompanyUrl || !company.crunchbaseUrl ||
    !company.angellistUrl || !company.twitterHandle
  )

  const faviconUrl = googleFaviconUrl(company.primaryDomain)

  return (
    <div className={styles.panel}>
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
          <div className={styles.headerBadges} ref={headerBadgesRef}>
            {isEditing ? (
              <div className={styles.editChipField}>
                <span className={styles.editChipLabel}>Type</span>
                <ChipSelect
                  value={company.entityType}
                  options={entityTypeOptions}
                  isEditing={isEditing}
                  onSave={(v) => saveWithDecisionPrompt('entityType', v ?? 'unknown')}
                  className={`${styles.badge} ${ENTITY_TYPE_STYLE[company.entityType] ?? ''}`}
                  allowEmpty={false}
                  onAddOption={entityTypeDef ? async (opt) => addCustomFieldOption(entityTypeDef.id, entityTypeDef.optionsJson, opt) : undefined}
                />
              </div>
            ) : (
              <ChipSelect
                value={company.entityType}
                options={entityTypeOptions}
                isEditing={isEditing}
                onSave={(v) => saveWithDecisionPrompt('entityType', v ?? 'unknown')}
                className={`${styles.badge} ${ENTITY_TYPE_STYLE[company.entityType] ?? ''}`}
                allowEmpty={false}
              />
            )}
            {isEditing ? (
              <div className={styles.editChipField}>
                <span className={styles.editChipLabel}>Stage</span>
                <ChipSelect
                  value={company.pipelineStage ?? ''}
                  options={[{ value: '', label: '—' }, ...stageOptions]}
                  isEditing={isEditing}
                  onSave={(v) => saveWithDecisionPrompt('pipelineStage', v || null)}
                  className={`${styles.badge} ${company.pipelineStage ? (STAGE_STYLE[company.pipelineStage] ?? '') : ''}`}
                  onAddOption={stageDef ? async (opt) => addCustomFieldOption(stageDef.id, stageDef.optionsJson, opt) : undefined}
                />
              </div>
            ) : (
              <ChipSelect
                value={company.pipelineStage ?? ''}
                options={[{ value: '', label: '—' }, ...stageOptions]}
                isEditing={isEditing}
                onSave={(v) => saveWithDecisionPrompt('pipelineStage', v || null)}
                className={`${styles.badge} ${company.pipelineStage ? (STAGE_STYLE[company.pipelineStage] ?? '') : ''}`}
              />
            )}
            {isEditing ? (
              <div className={styles.editChipField}>
                <span className={styles.editChipLabel}>Priority</span>
                <ChipSelect
                  value={company.priority ?? ''}
                  options={[{ value: '', label: '—' }, ...priorityOptions]}
                  isEditing={isEditing}
                  onSave={(v) => save('priority', v || null)}
                  className={`${styles.badge} ${company.priority ? (PRIORITY_STYLE[company.priority] ?? '') : ''}`}
                  onAddOption={priorityDef ? async (opt) => addCustomFieldOption(priorityDef.id, priorityDef.optionsJson, opt) : undefined}
                />
              </div>
            ) : (
              <ChipSelect
                value={company.priority ?? ''}
                options={[{ value: '', label: '—' }, ...priorityOptions]}
                isEditing={isEditing}
                onSave={(v) => save('priority', v || null)}
                className={`${styles.badge} ${company.priority ? (PRIORITY_STYLE[company.priority] ?? '') : ''}`}
              />
            )}
            {isEditing ? (
              <div className={styles.editChipField}>
                <span className={styles.editChipLabel}>Round</span>
                <ChipSelect
                  value={company.round ?? ''}
                  options={[{ value: '', label: '—' }, ...roundOptions]}
                  isEditing={isEditing}
                  onSave={(v) => save('round', v || null)}
                  className={`${styles.badge} ${company.round ? (ROUND_STYLE[company.round] ?? '') : ''}`}
                  onAddOption={roundDef ? async (opt) => addCustomFieldOption(roundDef.id, roundDef.optionsJson, opt) : undefined}
                />
              </div>
            ) : (
              <ChipSelect
                value={company.round ?? ''}
                options={[{ value: '', label: '—' }, ...roundOptions]}
                isEditing={isEditing}
                onSave={(v) => save('round', v || null)}
                className={`${styles.badge} ${company.round ? (ROUND_STYLE[company.round] ?? '') : ''}`}
              />
            )}
            {pinnedKeys.map((key) => renderPinnedChip(key))}
            <div className={styles.configureWrap}>
              <button
                className={styles.configureBtn}
                title="Configure summary"
                onClick={() => setShowConfig((s) => !s)}
              >
                ⊕
              </button>
              {showConfig && (
                <SummaryConfigPopover
                  pinnedKeys={pinnedKeys}
                  onToggle={togglePinnedKey}
                  columnDefs={COLUMN_DEFS}
                  customDefs={companyDefs}
                  entityData={company as Record<string, unknown>}
                  customFields={customFields}
                  headerKeys={COMPANY_HEADER_KEYS}
                  onClose={() => setShowConfig(false)}
                />
              )}
            </div>
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
          <p className={styles.descriptionText}>{company.description}</p>
        )
      )}
      <div className={styles.headerDivider} />

      {pinnedCustomFields.length > 0 && (
        <>
          <SectionHeader title="Pinned" />
          {pinnedCustomFields.map((field) => {
            const opts = field.optionsJson ? (() => { try { return JSON.parse(field.optionsJson!) } catch { return [] } })() : []
            return (
              <PropertyRow
                key={field.id}
                label={field.label}
                value={getPinnedFieldValue(field)}
                type={field.fieldType as import('../crm/PropertyRow').PropertyRowType}
                options={opts}
                onSave={(val) => handlePinnedFieldSave(field, val)}
              />
            )
          })}
        </>
      )}

      <div {...sectionDragProps('overview')} className={dragOverSection === 'overview' ? styles.dropTarget : ''}>
        <SectionHeader title="Overview" />
        {show(company.sector) && <PropertyRow label="Sector" value={company.sector} type="text" editMode={isEditing} onSave={(v) => save('sector', v)} />}
        {show(company.targetCustomer) && (
          <PropertyRow
            label="Target Customer"
            value={company.targetCustomer}
            type="select"
            options={targetCustomerOptions}
            editMode={isEditing}
            onSave={(v) => save('targetCustomer', v)}
            onAddOption={targetCustomerDef ? async (opt) => addCustomFieldOption(targetCustomerDef.id, targetCustomerDef.optionsJson, opt) : undefined}
          />
        )}
        {show(company.businessModel) && (
          <PropertyRow
            label="Business Model"
            value={company.businessModel}
            type="select"
            options={businessModelOptions}
            editMode={isEditing}
            onSave={(v) => save('businessModel', v)}
            onAddOption={businessModelDef ? async (opt) => addCustomFieldOption(businessModelDef.id, businessModelDef.optionsJson, opt) : undefined}
          />
        )}
        {show(company.productStage) && (
          <PropertyRow
            label="Product Stage"
            value={company.productStage}
            type="select"
            options={productStageOptions}
            editMode={isEditing}
            onSave={(v) => save('productStage', v)}
            onAddOption={productStageDef ? async (opt) => addCustomFieldOption(productStageDef.id, productStageDef.optionsJson, opt) : undefined}
          />
        )}
        {show(company.foundingYear) && <PropertyRow label="Founded" value={company.foundingYear} type="number" editMode={isEditing} onSave={(v) => save('foundingYear', v)} />}
        {show(company.employeeCountRange) && (
          <PropertyRow
            label="Employees"
            value={company.employeeCountRange}
            type="select"
            options={employeeRangeOptions}
            editMode={isEditing}
            onSave={(v) => save('employeeCountRange', v)}
            onAddOption={employeeCountDef ? async (opt) => addCustomFieldOption(employeeCountDef.id, employeeCountDef.optionsJson, opt) : undefined}
          />
        )}
        {show(company.hqAddress) && <PropertyRow label="HQ" value={company.hqAddress} type="text" editMode={isEditing} onSave={(v) => save('hqAddress', v)} />}
        {show(company.revenueModel) && <PropertyRow label="Revenue Model" value={company.revenueModel} type="text" editMode={isEditing} onSave={(v) => save('revenueModel', v)} />}
        {renderSectionedFields('overview')}
      </div>

      <div {...sectionDragProps('pipeline')} className={dragOverSection === 'pipeline' ? styles.dropTarget : ''}>
        <SectionHeader title="Pipeline" />
        <PropertyRow
          label="Stage"
          value={company.pipelineStage}
          type="select"
          options={[{ value: '', label: '—' }, ...stageOptions]}
          editMode={isEditing}
          onSave={(v) => saveWithDecisionPrompt('pipelineStage', v || null)}
          onAddOption={stageDef ? async (opt) => addCustomFieldOption(stageDef.id, stageDef.optionsJson, opt) : undefined}
        />
        <PropertyRow
          label="Priority"
          value={company.priority}
          type="select"
          options={[{ value: '', label: '—' }, ...priorityOptions]}
          editMode={isEditing}
          onSave={(v) => save('priority', v)}
          onAddOption={priorityDef ? async (opt) => addCustomFieldOption(priorityDef.id, priorityDef.optionsJson, opt) : undefined}
        />
        {show(company.dealSource) && <PropertyRow label="Deal Source" value={company.dealSource} type="text" editMode={isEditing} onSave={(v) => save('dealSource', v)} />}
        {show(company.warmIntroSource) && <PropertyRow label="Warm Intro Source" value={company.warmIntroSource} type="text" editMode={isEditing} onSave={(v) => save('warmIntroSource', v)} />}
        {show(company.referralContactId) && (
          <PropertyRow
            label="Referral Contact"
            value={company.referralContactId}
            type="contact_ref"
            editMode={isEditing}
            onSave={(v) => save('referralContactId', v)}
          />
        )}
        {show(company.relationshipOwner) && <PropertyRow label="Relationship Owner" value={company.relationshipOwner} type="text" editMode={isEditing} onSave={(v) => save('relationshipOwner', v)} />}
        {show(company.nextFollowupDate) && <PropertyRow label="Next Follow-up" value={company.nextFollowupDate} type="date" editMode={isEditing} onSave={(v) => save('nextFollowupDate', v)} />}
        {renderSectionedFields('pipeline')}
      </div>

      <div {...sectionDragProps('financials')} className={dragOverSection === 'financials' ? styles.dropTarget : ''}>
        <SectionHeader title="Financials" />
        {show(company.round) && (
          <PropertyRow
            label="Round"
            value={company.round}
            type="select"
            options={[{ value: '', label: '—' }, ...roundOptions]}
            editMode={isEditing}
            onSave={(v) => save('round', v)}
            onAddOption={roundDef ? async (opt) => addCustomFieldOption(roundDef.id, roundDef.optionsJson, opt) : undefined}
          />
        )}
        {show(company.raiseSize) && <PropertyRow label="Raise Size" value={company.raiseSize} type="currency" editMode={isEditing} onSave={(v) => save('raiseSize', v)} />}
        {show(company.postMoneyValuation) && <PropertyRow label="Post-Money Val." value={company.postMoneyValuation} type="currency" editMode={isEditing} onSave={(v) => save('postMoneyValuation', v)} />}
        {show(company.arr) && <PropertyRow label="ARR" value={company.arr} type="currency" editMode={isEditing} onSave={(v) => save('arr', v)} />}
        {show(company.burnRate) && <PropertyRow label="Burn Rate" value={company.burnRate} type="currency" editMode={isEditing} onSave={(v) => save('burnRate', v)} />}
        {show(company.runwayMonths) && <PropertyRow label="Runway (months)" value={company.runwayMonths} type="number" editMode={isEditing} onSave={(v) => save('runwayMonths', v)} />}
        {show(company.lastFundingDate) && <PropertyRow label="Last Funded" value={company.lastFundingDate} type="date" editMode={isEditing} onSave={(v) => save('lastFundingDate', v)} />}
        {show(company.totalFundingRaised) && <PropertyRow label="Total Raised" value={company.totalFundingRaised} type="currency" editMode={isEditing} onSave={(v) => save('totalFundingRaised', v)} />}
        {show(company.leadInvestor) && <PropertyRow label="Lead Investor" value={company.leadInvestor} type="text" editMode={isEditing} onSave={(v) => save('leadInvestor', v)} />}
        {show(company.coInvestors) && <PropertyRow label="Co-Investors" value={company.coInvestors} type="text" editMode={isEditing} onSave={(v) => save('coInvestors', v)} />}
        {renderSectionedFields('financials')}
      </div>

      {(isEditing || company.entityType === 'portfolio' ||
        company.investmentSize || company.ownershipPct ||
        company.followonInvestmentSize || company.totalInvested ||
        sectionedFields('investment').length > 0) && (
        <div {...sectionDragProps('investment')} className={dragOverSection === 'investment' ? styles.dropTarget : ''}>
          <SectionHeader title="Investment" />
          {show(company.investmentSize) && (
            <PropertyRow label="Investment Size" value={company.investmentSize} type="text" editMode={isEditing} onSave={(v) => save('investmentSize', v)} />
          )}
          {show(company.ownershipPct) && (
            <PropertyRow label="Ownership %" value={company.ownershipPct} type="text" editMode={isEditing} onSave={(v) => save('ownershipPct', v)} />
          )}
          {show(company.followonInvestmentSize) && (
            <PropertyRow label="Follow-on Size" value={company.followonInvestmentSize} type="text" editMode={isEditing} onSave={(v) => save('followonInvestmentSize', v)} />
          )}
          {show(company.totalInvested) && (
            <PropertyRow label="Total Invested" value={company.totalInvested} type="text" editMode={isEditing} onSave={(v) => save('totalInvested', v)} />
          )}
          {renderSectionedFields('investment')}
        </div>
      )}

      <div {...sectionDragProps('links')} className={dragOverSection === 'links' ? styles.dropTarget : ''}>
        <SectionHeader title="Links" />
        {show(company.linkedinCompanyUrl) && <PropertyRow label="LinkedIn" value={company.linkedinCompanyUrl} type="url" editMode={isEditing} onSave={(v) => save('linkedinCompanyUrl', v)} />}
        {show(company.crunchbaseUrl) && <PropertyRow label="Crunchbase" value={company.crunchbaseUrl} type="url" editMode={isEditing} onSave={(v) => save('crunchbaseUrl', v)} />}
        {show(company.angellistUrl) && <PropertyRow label="AngelList" value={company.angellistUrl} type="url" editMode={isEditing} onSave={(v) => save('angellistUrl', v)} />}
        {show(company.twitterHandle) && <PropertyRow label="Twitter/X" value={company.twitterHandle} type="text" editMode={isEditing} onSave={(v) => save('twitterHandle', v)} />}
        {renderSectionedFields('links')}
      </div>

      {hasHiddenFields && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(true)}>
          Show all fields
        </button>
      )}
      {showAllFields && !isEditing && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(false)}>
          Hide empty fields
        </button>
      )}

      <CustomFieldsPanel
        entityType="company"
        entityId={company.id}
        onFieldsLoaded={setCustomFields}
        onCreateField={() => setCreateFieldOpen(true)}
        draggingFieldId={draggingFieldId}
        onDropToUnsectioned={() => handleFieldDrop(null)}
      />

      {createFieldOpen && (
        <CreateCustomFieldModal
          entityType="company"
          onSaved={() => { void refresh().then(() => setCreateFieldOpen(false)) }}
          onClose={() => setCreateFieldOpen(false)}
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
