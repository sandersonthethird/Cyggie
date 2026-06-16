import { cloneElement, isValidElement, useCallback, useState, type ReactNode, type HTMLAttributes } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CompanyDetail } from '../../../shared/types/company'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import { PropertyRow, type PropertyRowType } from '../crm/PropertyRow'
import { MultiCompanyPicker } from '../crm/MultiCompanyPicker'
import { CompanyChip } from '../common/CompanyChip'
import { PolymorphicEntitySearch } from '../crm/PolymorphicEntitySearch'
import type { PolymorphicEntity } from '../crm/PolymorphicEntitySearch'
import { addCustomFieldOption } from '../../utils/customFieldUtils'
import { CollapsibleSection } from '../crm/CollapsibleSection'
import { Icon, type IconKey } from '../common/Icon'
import { COMPANY_HARDCODED_FIELD_MAP } from '../../constants/companyFields'
import { COMPANY_FIELD_META as M } from '../../constants/companyFieldMeta'
import { getVisibleFieldCount, isEmptyValue } from '../../utils/visibleFieldCount'
import { HideableRow } from '../crm/HideableRow'
import { DraggableFieldRow } from '../crm/DraggableFieldRow'
import styles from './CompanyPropertiesPanel.module.css'

// ── Types ──────────────────────────────────────────────────────────────────

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

interface OptionSet {
  targetCustomer: { value: string; label: string }[]
  businessModel: { value: string; label: string }[]
  productStage: { value: string; label: string }[]
  employeeRange: { value: string; label: string }[]
  round: { value: string; label: string }[]
  industry: { value: string; label: string }[]
  targetInvestmentStage: { value: string; label: string }[]
  targetInvestmentSector: { value: string; label: string }[]
}

interface BuiltinDefs {
  targetCustomer?: { id: string; optionsJson: string | null }
  businessModel?: { id: string; optionsJson: string | null }
  productStage?: { id: string; optionsJson: string | null }
  employeeCount?: { id: string; optionsJson: string | null }
  round?: { id: string; optionsJson: string | null }
  industry?: { id: string; optionsJson: string | null }
  targetInvestmentStage?: { id: string; optionsJson: string | null }
  targetInvestmentSector?: { id: string; optionsJson: string | null }
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface CompanyFieldSectionsProps {
  company: CompanyDetail
  isEditing: boolean
  showAllFields: boolean
  onUpdate: (updates: Record<string, unknown>) => void
  save: (field: string, value: unknown) => Promise<void>
  saveWithDecisionPrompt: (field: 'pipelineStage' | 'entityType', value: unknown) => void

  // Grouped hook returns
  sectionOrder: SectionOrderState
  hfOrder: HardcodedFieldOrderState
  customFieldSection: CustomFieldSectionState
  fieldVisibility: FieldVisibilityState

  // Section collapse
  isCollapsed: (key: string) => boolean
  toggleSection: (key: string) => void

  // Field show/hide
  show: (key: string, value: unknown) => boolean
  hiddenFields: string[]
  onHideField: (key: string) => void
  onRestoreField: (key: string) => void

  // Custom fields
  customFields: CustomFieldWithValue[]
  setCustomFields: React.Dispatch<React.SetStateAction<CustomFieldWithValue[]>>

  // Field editing
  editingFieldId: string | null
  editingFieldLabel: string
  setEditingFieldId: (id: string | null) => void
  setEditingFieldLabel: (label: string) => void
  handleFieldLabelSave: (id: string, label: string) => Promise<void>
  getPinnedFieldValue: (field: CustomFieldWithValue) => string | number | boolean | null
  handlePinnedFieldSave: (field: CustomFieldWithValue, value: string | number | boolean | null) => Promise<void>

  // Section drag
  syncedSectionDragProps: (sectionKey: string) => HTMLAttributes<HTMLDivElement>

  // Options
  options: OptionSet
  builtinDefs: BuiltinDefs

  // Misc
  fieldSources?: Record<string, { meetingId: string; meetingTitle: string }>

  // Variant C: per-section "+ Add" handler (opens AddFieldDropdown scoped to section)
  onAddInSection?: (sectionKey: string) => void
  // Variant C: tracks which sections the user has manually toggled (suppresses auto-collapse)
  hasUserToggledSection?: (sectionKey: string) => boolean
}

// ── Component ──────────────────────────────────────────────────────────────

export function CompanyFieldSections({
  company,
  isEditing,
  showAllFields,
  onUpdate,
  save,
  saveWithDecisionPrompt,
  sectionOrder,
  hfOrder,
  customFieldSection,
  fieldVisibility,
  isCollapsed,
  toggleSection,
  show,
  hiddenFields,
  onHideField,
  onRestoreField,
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
  options,
  builtinDefs,
  fieldSources,
  onAddInSection,
  hasUserToggledSection,
}: CompanyFieldSectionsProps) {
  const navigate = useNavigate()

  // ── Variant C: icon injection helper ──
  // Auto-inject Icon prop into hardcoded PropertyRow renders by looking up the
  // field's icon key from COMPANY_HARDCODED_FIELD_MAP. Avoids editing every
  // <PropertyRow> callsite. For wrapped renders (badge containers), the icon
  // is silently skipped — those rows already carry their own visual treatment.
  function withIconForKey(rendered: ReactNode, fieldKey: string): ReactNode {
    const iconKey = COMPANY_HARDCODED_FIELD_MAP.get(fieldKey)?.icon
    if (!iconKey) return rendered
    if (!isValidElement(rendered)) return rendered
    if (rendered.type !== PropertyRow) return rendered
    const props = rendered.props as { icon?: ReactNode }
    if (props.icon) return rendered
    return cloneElement(
      rendered as React.ReactElement<{ icon?: ReactNode }>,
      { icon: <Icon name={iconKey as IconKey} size={11} /> },
    )
  }

  // ── Variant C: count visible non-empty hardcoded fields in a section ──
  function countVisibleHardcoded(fields: Array<{ key: string; visible: boolean }>): number {
    let n = 0
    for (const f of fields) {
      if (!f.visible) continue
      if (hiddenFields.includes(f.key)) continue
      n += 1 // visible counted as "has value" — `visible` is gated on `show()` which checks the value
    }
    return n
  }
  function countCustomNonEmpty(sectionKey: string): number {
    return customFieldSection.sectionedFields(sectionKey).filter(f => {
      if (hiddenFields.includes(`custom:${f.id}`)) return false
      return !isEmptyValue(getPinnedFieldValue(f))
    }).length
  }

  // ── Source Name Field (polymorphic entity) ──
  const SourceNameField = useCallback(() => {
    const [showSearch, setShowSearch] = useState(false)
    const handleSelect = (entity: PolymorphicEntity) => {
      onUpdate({ sourceEntityId: entity.id, sourceEntityType: entity.type })
      setShowSearch(false)
    }
    const handleClear = () => {
      onUpdate({ sourceEntityId: null, sourceEntityType: null })
    }
    if (company.sourceEntityId && !showSearch) {
      return (
        <div className={styles.propertyRow}>
          <span className={styles.propertyLabel}>Source Name</span>
          <span className={styles.chipInline}>
            <button
              className={styles.chipLinkBtn}
              onClick={() => navigate(
                company.sourceEntityType === 'contact'
                  ? `/contact/${company.sourceEntityId}`
                  : `/company/${company.sourceEntityId}`,
                { state: { backLabel: company.canonicalName } }
              )}
              title="Open linked entity"
            >
              {company.sourceEntityName ?? company.sourceEntityId}
            </button>
            {isEditing && (
              <button className={styles.chipRemoveInline} onClick={handleClear} title="Clear">×</button>
            )}
          </span>
        </div>
      )
    }
    if (isEditing) {
      return (
        <div className={styles.propertyRow}>
          <span className={styles.propertyLabel}>Source Name</span>
          {showSearch ? (
            <PolymorphicEntitySearch
              onSelect={handleSelect}
              onClose={() => setShowSearch(false)}
              placeholder="Search company or contact…"
            />
          ) : (
            <button className={styles.addChipBtn} onClick={() => setShowSearch(true)}>
              + Link entity
            </button>
          )}
        </div>
      )
    }
    return null
  }, [company.sourceEntityId, company.sourceEntityType, company.sourceEntityName, isEditing, onUpdate, navigate, company.canonicalName])

  // ── Hide handler: routes "hide an empty added-but-unsaved field" to the
  // addedFields cleanup path instead of a no-op hide. Cross-panel pattern; the
  // shared <HideableRow> atom passes (fieldKey, isEmpty) into this callback.
  function handleHide(fieldKey: string, isEmpty: boolean) {
    if (isEmpty && fieldVisibility.addedFields.includes(fieldKey)) {
      fieldVisibility.removeFromAddedFields(fieldKey)
    } else {
      onHideField(fieldKey)
    }
  }

  // ── Render helpers ──

  function renderSectionedFields(sectionKey: string) {
    const opts = (field: CustomFieldWithValue) => {
      try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] }
    }
    return customFieldSection.sectionedFields(sectionKey).map((field) => {
      const fieldKey = `custom:${field.id}`
      if (hiddenFields.includes(fieldKey) && !isEditing && !showAllFields) return null
      const isDropTarget = customFieldSection.draggingOverFieldId === field.id && customFieldSection.draggingFieldId !== field.id
      const value = getPinnedFieldValue(field)
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
          <HideableRow
            fieldKey={fieldKey}
            isEmpty={isEmptyValue(value)}
            isHidden={hiddenFields.includes(fieldKey)}
            isEditing={isEditing}
            showAllFields={showAllFields}
            onHide={handleHide}
            onRestore={onRestoreField}
          >
            <PropertyRow
              label={field.label}
              value={value}
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
    sectionKey: string
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
          <div style={{ flex: 1, minWidth: 0 }}>{withIconForKey(field.render(), field.key)}</div>
        </DraggableFieldRow>
      )
    })
  }

  // ── Section rendering (Variant C: <CollapsibleSection> shell) ──

  // Hardcoded field arrays extracted so the count helper can read them
  // without re-running the closures.
  const overviewFields = (): Array<{ key: string; visible: boolean; render: () => ReactNode }> => [
    { key: 'industry', visible: show('industry', company.industry), render: () => (
      <PropertyRow
        label="Industry"
        value={company.industry}
        type={M.industry.type}
        options={M.industry.getOptions!(options)}
        editMode={isEditing}
        onSave={(v) => save('industry', v)}
        onAddOption={builtinDefs.industry ? async (opt) => addCustomFieldOption(builtinDefs.industry!.id, builtinDefs.industry!.optionsJson, opt) : undefined}
      />
    )},
    { key: 'targetCustomer', visible: show('targetCustomer', company.targetCustomer), render: () => (
      <PropertyRow label="Target Customer" value={company.targetCustomer} type={M.targetCustomer.type} options={M.targetCustomer.getOptions!(options)} editMode={isEditing} onSave={(v) => save('targetCustomer', v)} onAddOption={builtinDefs.targetCustomer ? async (opt) => addCustomFieldOption(builtinDefs.targetCustomer!.id, builtinDefs.targetCustomer!.optionsJson, opt) : undefined} />
    )},
    { key: 'businessModel', visible: show('businessModel', company.businessModel), render: () => (
      <PropertyRow label="Business Model" value={company.businessModel} type={M.businessModel.type} options={M.businessModel.getOptions!(options)} editMode={isEditing} onSave={(v) => save('businessModel', v)} onAddOption={builtinDefs.businessModel ? async (opt) => addCustomFieldOption(builtinDefs.businessModel!.id, builtinDefs.businessModel!.optionsJson, opt) : undefined} />
    )},
    { key: 'productStage', visible: show('productStage', company.productStage), render: () => (
      <PropertyRow label="Product Stage" value={company.productStage} type={M.productStage.type} options={M.productStage.getOptions!(options)} editMode={isEditing} onSave={(v) => save('productStage', v)} onAddOption={builtinDefs.productStage ? async (opt) => addCustomFieldOption(builtinDefs.productStage!.id, builtinDefs.productStage!.optionsJson, opt) : undefined} />
    )},
    { key: 'targetInvestmentStage', visible: show('targetInvestmentStage', company.targetInvestmentStage), render: () => (
      <PropertyRow label="Target Investment Stage" value={company.targetInvestmentStage} type={M.targetInvestmentStage.type} options={M.targetInvestmentStage.getOptions!(options)} editMode={isEditing} onSave={(v) => save('targetInvestmentStage', v)} onAddOption={builtinDefs.targetInvestmentStage ? async (opt) => addCustomFieldOption(builtinDefs.targetInvestmentStage!.id, builtinDefs.targetInvestmentStage!.optionsJson, opt) : undefined} />
    )},
    { key: 'targetInvestmentSector', visible: show('targetInvestmentSector', company.targetInvestmentSector), render: () => (
      <PropertyRow label="Target Investment Sector" value={company.targetInvestmentSector} type={M.targetInvestmentSector.type} options={M.targetInvestmentSector.getOptions!(options)} editMode={isEditing} onSave={(v) => save('targetInvestmentSector', v)} onAddOption={builtinDefs.targetInvestmentSector ? async (opt) => addCustomFieldOption(builtinDefs.targetInvestmentSector!.id, builtinDefs.targetInvestmentSector!.optionsJson, opt) : undefined} />
    )},
    { key: 'foundingYear', visible: show('foundingYear', company.foundingYear), render: () => <PropertyRow label="Founded" value={company.foundingYear} type={M.foundingYear.type} editMode={isEditing} onSave={(v) => save('foundingYear', v)} /> },
    { key: 'employeeCountRange', visible: show('employeeCountRange', company.employeeCountRange), render: () => (
      <PropertyRow label="Employees" value={company.employeeCountRange} type={M.employeeCountRange.type} options={M.employeeCountRange.getOptions!(options)} editMode={isEditing} onSave={(v) => save('employeeCountRange', v)} onAddOption={builtinDefs.employeeCount ? async (opt) => addCustomFieldOption(builtinDefs.employeeCount!.id, builtinDefs.employeeCount!.optionsJson, opt) : undefined} />
    )},
    { key: 'revenueModel', visible: show('revenueModel', company.revenueModel), render: () => <PropertyRow label="Revenue Model" value={company.revenueModel} type={M.revenueModel.type} editMode={isEditing} onSave={(v) => save('revenueModel', v)} /> },
  ]

  const pipelineFields = (): Array<{ key: string; visible: boolean; render: () => ReactNode }> => [
    { key: 'sourceType', visible: show('sourceType', company.sourceType), render: () => (
      <PropertyRow
        label="Source Type"
        value={company.sourceType}
        type={M.sourceType.type}
        options={M.sourceType.getOptions!(options)}
        editMode={isEditing}
        onSave={(v) => save('sourceType', v || null)}
      />
    )},
    { key: 'sourceEntityId', visible: show('sourceEntityId', company.sourceEntityId), render: () => <SourceNameField /> },
    { key: 'dealSource', visible: show('dealSource', company.dealSource), render: () => <PropertyRow label="Deal Source" value={company.dealSource} type={M.dealSource.type} editMode={isEditing} onSave={(v) => save('dealSource', v)} /> },
    { key: 'warmIntroSource', visible: show('warmIntroSource', company.warmIntroSource), render: () => <PropertyRow label="Warm Intro Source" value={company.warmIntroSource} type={M.warmIntroSource.type} editMode={isEditing} onSave={(v) => save('warmIntroSource', v)} /> },
    { key: 'referralContactId', visible: show('referralContactId', company.referralContactId), render: () => <PropertyRow label="Referral Contact" value={company.referralContactId} type={M.referralContactId.type} editMode={isEditing} onSave={(v) => save('referralContactId', v)} /> },
    { key: 'relationshipOwner', visible: show('relationshipOwner', company.relationshipOwner), render: () => <PropertyRow label="Relationship Owner" value={company.relationshipOwner} type={M.relationshipOwner.type} editMode={isEditing} onSave={(v) => save('relationshipOwner', v)} /> },
    { key: 'nextFollowupDate', visible: show('nextFollowupDate', company.nextFollowupDate), render: () => <PropertyRow label="Next Follow-up" value={company.nextFollowupDate} type={M.nextFollowupDate.type} editMode={isEditing} onSave={(v) => save('nextFollowupDate', v)} /> },
  ]

  function renderSection(sectionKey: string, sectionContainerProps: HTMLAttributes<HTMLDivElement>) {
    // Variant C decision: 'pipeline' is rendered INSIDE the 'investment' section, not as its own section.
    if (sectionKey === 'pipeline') return null

    switch (sectionKey) {
      case 'overview': {
        const fields = overviewFields()
        const count = countVisibleHardcoded(fields) + countCustomNonEmpty('overview')
        return (
        <div key="overview" {...sectionContainerProps}>
          <CollapsibleSection
            title="Overview"
            count={count}
            isCollapsed={isCollapsed('overview')}
            onToggle={() => toggleSection('overview')}
            hasUserToggled={hasUserToggledSection?.('overview')}
            onAdd={onAddInSection ? () => onAddInSection('overview') : undefined}
          >
          {renderHardcodedSection(fields, 'overview')}
          {renderSectionedFields('overview')}

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
      }

      case 'financials': {
        const financialsList: Array<{ key: string; visible: boolean; render: () => ReactNode }> = [
            { key: 'round', visible: show('round', company.round), render: () => (
              <div className={!isEditing && fieldSources?.round ? styles.propertyWithBadge : undefined}>
                <PropertyRow label="Last Round" value={company.round} type={M.round.type} options={M.round.getOptions!(options)} editMode={isEditing} onSave={(v) => save('round', v)} onAddOption={builtinDefs.round ? async (opt) => addCustomFieldOption(builtinDefs.round!.id, builtinDefs.round!.optionsJson, opt) : undefined} />
                {!isEditing && fieldSources?.round && <span className={styles.sourceBadge} title={`From: ${fieldSources.round.meetingTitle}`}>📋</span>}
              </div>
            )},
            { key: 'raiseSize', visible: show('raiseSize', company.raiseSize), render: () => (
              <div className={!isEditing && fieldSources?.raiseSize ? styles.propertyWithBadge : undefined}>
                <PropertyRow label="Raise Size" value={company.raiseSize} type={M.raiseSize.type} editMode={isEditing} onSave={(v) => save('raiseSize', v)} />
                {!isEditing && fieldSources?.raiseSize && <span className={styles.sourceBadge} title={`From: ${fieldSources.raiseSize.meetingTitle}`}>📋</span>}
              </div>
            )},
            { key: 'postMoneyValuation', visible: show('postMoneyValuation', company.postMoneyValuation), render: () => (
              <div className={!isEditing && fieldSources?.postMoneyValuation ? styles.propertyWithBadge : undefined}>
                <PropertyRow label="Initial Valuation" value={company.postMoneyValuation} type={M.postMoneyValuation.type} editMode={isEditing} onSave={(v) => save('postMoneyValuation', v)} />
                {!isEditing && fieldSources?.postMoneyValuation && <span className={styles.sourceBadge} title={`From: ${fieldSources.postMoneyValuation.meetingTitle}`}>📋</span>}
              </div>
            )},
            { key: 'arr', visible: show('arr', company.arr), render: () => <PropertyRow label="ARR" value={company.arr} type={M.arr.type} editMode={isEditing} onSave={(v) => save('arr', v)} /> },
            { key: 'burnRate', visible: show('burnRate', company.burnRate), render: () => <PropertyRow label="Burn Rate" value={company.burnRate} type={M.burnRate.type} editMode={isEditing} onSave={(v) => save('burnRate', v)} /> },
            { key: 'runwayMonths', visible: show('runwayMonths', company.runwayMonths), render: () => <PropertyRow label="Runway (months)" value={company.runwayMonths} type={M.runwayMonths.type} editMode={isEditing} onSave={(v) => save('runwayMonths', v)} /> },
            { key: 'lastFundingDate', visible: show('lastFundingDate', company.lastFundingDate), render: () => <PropertyRow label="Last Funded" value={company.lastFundingDate} type={M.lastFundingDate.type} editMode={isEditing} onSave={(v) => save('lastFundingDate', v)} /> },
            { key: 'totalFundingRaised', visible: show('totalFundingRaised', company.totalFundingRaised), render: () => <PropertyRow label="Total Raised" value={company.totalFundingRaised} type={M.totalFundingRaised.type} editMode={isEditing} onSave={(v) => save('totalFundingRaised', v)} /> },
            { key: 'leadInvestor', visible: show('leadInvestor', company.leadInvestorCompany ?? company.leadInvestor), render: () => (
              <div className={styles.propertyRow}>
                <span className={styles.propertyLabel}>Lead Investor</span>
                <MultiCompanyPicker
                  value={company.leadInvestorCompany ? [company.leadInvestorCompany] : []}
                  onChange={(v) => onUpdate({ leadInvestorCompanyId: v.length > 0 ? v[0].id : null })}
                  readOnly={!isEditing}
                  maxChips={1}
                />
              </div>
            )},
            { key: 'coInvestors', visible: show('coInvestors', company.coInvestorsList), render: () => (
              <div className={styles.propertyRow}>
                <span className={styles.propertyLabel}>Co-Investors</span>
                <MultiCompanyPicker
                  value={company.coInvestorsList}
                  onChange={(v) => onUpdate({ coInvestorsList: v })}
                  readOnly={!isEditing}
                  badgeFor={(id) => {
                    const count = company.coInvestorOverlaps[id] ?? 0
                    if (count <= 0) return null
                    return {
                      content: `↑ ${count} more`,
                      title: `Also a co-investor in ${count} of your other portfolio companies`,
                    }
                  }}
                />
              </div>
            )},
            { key: 'priorInvestors', visible: show('priorInvestors', company.priorInvestorsList), render: () => (
              <div className={styles.propertyRow}>
                <span className={styles.propertyLabel}>Prior Investors</span>
                <MultiCompanyPicker
                  value={company.priorInvestorsList}
                  onChange={(v) => onUpdate({ priorInvestorsList: v })}
                  readOnly={!isEditing}
                />
              </div>
            )},
            { key: 'subsequentInvestors', visible: show('subsequentInvestors', company.subsequentInvestorsList), render: () => (
              <div className={styles.propertyRow}>
                <span className={styles.propertyLabel}>Subsequent Investors</span>
                <MultiCompanyPicker
                  value={company.subsequentInvestorsList}
                  onChange={(v) => onUpdate({ subsequentInvestorsList: v })}
                  readOnly={!isEditing}
                />
              </div>
            )},
        ]
        const fcount = countVisibleHardcoded(financialsList) + countCustomNonEmpty('financials') + (company.coInvestedIn.length > 0 ? 1 : 0)
        return (
          <div key="financials" {...sectionContainerProps}>
            <CollapsibleSection
              title="Financials"
              count={fcount}
              isCollapsed={isCollapsed('financials')}
              onToggle={() => toggleSection('financials')}
              hasUserToggled={hasUserToggledSection?.('financials')}
              onAdd={onAddInSection ? () => onAddInSection('financials') : undefined}
            >
              {renderHardcodedSection(financialsList, 'financials')}
              {company.coInvestedIn.length > 0 && (
                <div className={styles.propertyRow}>
                  <span className={styles.propertyLabel}>Co-invested in</span>
                  <div className={styles.chipList}>
                    {company.coInvestedIn.map((c) => (
                      <CompanyChip
                        key={c.id}
                        id={c.id}
                        name={c.name}
                        domain={c.domain}
                        readOnly
                        onClickName={(id) => navigate(`/company/${id}`, { state: { backLabel: company.canonicalName } })}
                      />
                    ))}
                  </div>
                </div>
              )}
              {renderSectionedFields('financials')}
            </CollapsibleSection>
          </div>
        )
      }

      case 'investment': {
        const showInvestment = isEditing || company.entityType === 'portfolio' ||
          company.investmentSize || company.ownershipPct ||
          company.followonInvestmentSize || company.totalInvested ||
          company.investmentMark || company.investmentRound ||
          company.lastCompanyValuation || company.followonCheck ||
          customFieldSection.sectionedFields('investment').length > 0 ||
          // Variant C: pipeline fields are merged into Investment, so a non-empty
          // pipeline field is enough to surface the section.
          customFieldSection.sectionedFields('pipeline').length > 0 ||
          company.sourceType || company.dealSource || company.relationshipOwner ||
          company.nextFollowupDate || company.warmIntroSource
        if (!showInvestment) return null

        const investmentList: Array<{ key: string; visible: boolean; render: () => ReactNode }> = [
          { key: 'portfolioFund', visible: show('portfolioFund', company.portfolioFund), render: () => <PropertyRow label="Portfolio" value={company.portfolioFund} type={M.portfolioFund.type} options={M.portfolioFund.getOptions!(options)} editMode={isEditing} onSave={(v) => save('portfolioFund', v)} /> },
          { key: 'status', visible: show('status', company.status), render: () => <PropertyRow label="Status" value={company.status} type={M.status.type} options={M.status.getOptions!(options)} editMode={isEditing} onSave={(v) => save('status', v)} /> },
          { key: 'investmentSize', visible: show('investmentSize', company.investmentSize), render: () => <PropertyRow label="Initial Investment" value={company.investmentSize} type={M.investmentSize.type} editMode={isEditing} onSave={(v) => save('investmentSize', v)} /> },
          { key: 'ownershipPct', visible: show('ownershipPct', company.ownershipPct), render: () => <PropertyRow label="Initial Ownership %" value={company.ownershipPct} type={M.ownershipPct.type} editMode={isEditing} onSave={(v) => save('ownershipPct', v)} /> },
          { key: 'investmentMark', visible: show('investmentMark', company.investmentMark), render: () => <PropertyRow label="Investment Mark" value={company.investmentMark} type={M.investmentMark.type} editMode={isEditing} onSave={(v) => save('investmentMark', v)} /> },
          { key: 'investmentRound', visible: show('investmentRound', company.investmentRound), render: () => <PropertyRow label="Investment Round" value={company.investmentRound} type={M.investmentRound.type} options={M.investmentRound.getOptions!(options)} editMode={isEditing} onSave={(v) => save('investmentRound', v)} /> },
          { key: 'initialInvestmentSecurity', visible: show('initialInvestmentSecurity', company.initialInvestmentSecurity), render: () => <PropertyRow label="Initial Security" value={company.initialInvestmentSecurity} type={M.initialInvestmentSecurity.type} options={M.initialInvestmentSecurity.getOptions!(options)} editMode={isEditing} onSave={(v) => save('initialInvestmentSecurity', v)} /> },
          { key: 'dateOfInitialInvestment', visible: show('dateOfInitialInvestment', company.dateOfInitialInvestment), render: () => <PropertyRow label="Date of Initial Investment" value={company.dateOfInitialInvestment} type={M.dateOfInitialInvestment.type} editMode={isEditing} onSave={(v) => save('dateOfInitialInvestment', v)} /> },
          { key: 'initialRoundSize', visible: show('initialRoundSize', company.initialRoundSize), render: () => <PropertyRow label="Initial Round Size" value={company.initialRoundSize} type={M.initialRoundSize.type} editMode={isEditing} onSave={(v) => save('initialRoundSize', v)} /> },
          { key: 'lastCompanyValuation', visible: show('lastCompanyValuation', company.lastCompanyValuation), render: () => <PropertyRow label="Last Company Valuation" value={company.lastCompanyValuation} type={M.lastCompanyValuation.type} editMode={isEditing} onSave={(v) => save('lastCompanyValuation', v)} /> },
          { key: 'followonCheck', visible: show('followonCheck', company.followonCheck), render: () => <PropertyRow label="Follow-on Check" value={company.followonCheck} type={M.followonCheck.type} editMode={isEditing} onSave={(v) => save('followonCheck', v)} /> },
          { key: 'followonDate', visible: show('followonDate', company.followonDate), render: () => <PropertyRow label="Follow-on Date" value={company.followonDate} type={M.followonDate.type} editMode={isEditing} onSave={(v) => save('followonDate', v)} /> },
          { key: 'followonCheck2', visible: show('followonCheck2', company.followonCheck2), render: () => <PropertyRow label="Follow-on Check 2" value={company.followonCheck2} type={M.followonCheck2.type} editMode={isEditing} onSave={(v) => save('followonCheck2', v)} /> },
          { key: 'followonDate2', visible: show('followonDate2', company.followonDate2), render: () => <PropertyRow label="Follow-on Date 2" value={company.followonDate2} type={M.followonDate2.type} editMode={isEditing} onSave={(v) => save('followonDate2', v)} /> },
          { key: 'followonInvestmentSize', visible: show('followonInvestmentSize', company.followonInvestmentSize), render: () => <PropertyRow label="Follow-on Size" value={company.followonInvestmentSize} type={M.followonInvestmentSize.type} editMode={isEditing} onSave={(v) => save('followonInvestmentSize', v)} /> },
          { key: 'totalInvested', visible: show('totalInvested', company.totalInvested), render: () => <PropertyRow label="Total Investment" value={company.totalInvested} type={M.totalInvested.type} editMode={isEditing} onSave={(v) => save('totalInvested', v)} /> },
        ]

        const pipelineList = pipelineFields()
        const icount = countVisibleHardcoded(investmentList) + countVisibleHardcoded(pipelineList)
                      + countCustomNonEmpty('investment') + countCustomNonEmpty('pipeline')

        return (
          <div key="investment" {...sectionContainerProps}>
            <CollapsibleSection
              title="Investment"
              count={icount}
              isCollapsed={isCollapsed('investment')}
              onToggle={() => toggleSection('investment')}
              hasUserToggled={hasUserToggledSection?.('investment')}
              onAdd={onAddInSection ? () => onAddInSection('investment') : undefined}
            >
              {renderHardcodedSection(investmentList, 'investment')}
              {renderSectionedFields('investment')}
              {/* Variant C: pipeline fields rendered inside Investment (not as their own section). */}
              {renderHardcodedSection(pipelineList, 'pipeline')}
              {renderSectionedFields('pipeline')}
            </CollapsibleSection>
          </div>
        )
      }

      case 'links': {
        const linksList: Array<{ key: string; visible: boolean; render: () => ReactNode }> = [
          { key: 'linkedinCompanyUrl', visible: show('linkedinCompanyUrl', company.linkedinCompanyUrl), render: () => <PropertyRow label="LinkedIn" value={company.linkedinCompanyUrl} type={M.linkedinCompanyUrl.type} editMode={isEditing} onSave={(v) => save('linkedinCompanyUrl', v)} /> },
          { key: 'crunchbaseUrl', visible: show('crunchbaseUrl', company.crunchbaseUrl), render: () => <PropertyRow label="Crunchbase" value={company.crunchbaseUrl} type={M.crunchbaseUrl.type} editMode={isEditing} onSave={(v) => save('crunchbaseUrl', v)} /> },
          { key: 'angellistUrl', visible: show('angellistUrl', company.angellistUrl), render: () => <PropertyRow label="AngelList" value={company.angellistUrl} type={M.angellistUrl.type} editMode={isEditing} onSave={(v) => save('angellistUrl', v)} /> },
          { key: 'twitterHandle', visible: show('twitterHandle', company.twitterHandle), render: () => <PropertyRow label="Twitter/X" value={company.twitterHandle} type={M.twitterHandle.type} editMode={isEditing} onSave={(v) => save('twitterHandle', v)} /> },
        ]
        const lcount = countVisibleHardcoded(linksList) + countCustomNonEmpty('links')
        return (
          <div key="links" {...sectionContainerProps}>
            <CollapsibleSection
              title="Links"
              count={lcount}
              isCollapsed={isCollapsed('links')}
              onToggle={() => toggleSection('links')}
              hasUserToggled={hasUserToggledSection?.('links')}
              onAdd={onAddInSection ? () => onAddInSection('links') : undefined}
            >
              {renderHardcodedSection(linksList, 'links')}
              {renderSectionedFields('links')}
            </CollapsibleSection>
          </div>
        )
      }

      default: return null
    }
  }

  // ── Main render ──

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

        return renderSection(sectionKey, sectionContainerProps)
      })}
    </>
  )
}
