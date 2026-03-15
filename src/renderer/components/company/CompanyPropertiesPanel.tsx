import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyDecisionLog, CompanyDetail } from '../../../shared/types/company'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import { shouldPromptDecisionLog, defaultDecisionType } from '../../utils/decisionLogTrigger'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import { daysSince, formatCurrency, formatDate } from '../../utils/format'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
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
  EMPLOYEE_RANGES
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
  const [isEditing, setIsEditing] = useState(false)
  const [showAllFields, setShowAllFields] = useState(false)
  const [nameDraft, setNameDraft] = useState(company.canonicalName)
  const [showConfig, setShowConfig] = useState(false)
  const [customFields, setCustomFields] = useState<CustomFieldWithValue[]>([])
  const [latestDecision, setLatestDecision] = useState<CompanyDecisionLog | null>(null)
  const [showDecisionModal, setShowDecisionModal] = useState(false)
  const [decisionTriggerType, setDecisionTriggerType] = useState<string | undefined>(undefined)
  const [editDecisionId, setEditDecisionId] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const headerBadgesRef = useRef<HTMLDivElement>(null)

  const { getJSON, setJSON } = usePreferencesStore()
  const { companyDefs } = useCustomFieldStore()
  const pinnedKeys = getJSON<string[]>('cyggie:company-summary-fields', [])

  function togglePinnedKey(key: string) {
    const next = pinnedKeys.includes(key)
      ? pinnedKeys.filter((k) => k !== key)
      : [...pinnedKeys, key]
    setJSON('cyggie:company-summary-fields', next)
  }

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

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleDone()
    if (e.key === 'Escape') setIsEditing(false)
  }

  function show(value: unknown): boolean {
    if (isEditing || showAllFields) return true
    return value !== null && value !== undefined && value !== ''
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
            <ChipSelect
              value={company.entityType}
              options={ENTITY_TYPES}
              isEditing={isEditing}
              onSave={(v) => saveWithDecisionPrompt('entityType', v ?? 'unknown')}
              className={`${styles.badge} ${ENTITY_TYPE_STYLE[company.entityType] ?? ''}`}
              allowEmpty={false}
            />
            <ChipSelect
              value={company.pipelineStage ?? ''}
              options={[{ value: '', label: '—' }, ...STAGES]}
              isEditing={isEditing}
              onSave={(v) => saveWithDecisionPrompt('pipelineStage', v || null)}
              className={`${styles.badge} ${company.pipelineStage ? (STAGE_STYLE[company.pipelineStage] ?? '') : ''}`}
            />
            <ChipSelect
              value={company.priority ?? ''}
              options={[{ value: '', label: '—' }, ...PRIORITIES]}
              isEditing={isEditing}
              onSave={(v) => save('priority', v || null)}
              className={`${styles.badge} ${company.priority ? (PRIORITY_STYLE[company.priority] ?? '') : ''}`}
            />
            <ChipSelect
              value={company.round ?? ''}
              options={[{ value: '', label: '—' }, ...ROUNDS]}
              isEditing={isEditing}
              onSave={(v) => save('round', v || null)}
              className={`${styles.badge} ${company.round ? (ROUND_STYLE[company.round] ?? '') : ''}`}
            />
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
          <button className={styles.doneBtn} onClick={handleDone}>Done</button>
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

      <SectionHeader title="Overview" />
      {show(company.sector) && <PropertyRow label="Sector" value={company.sector} type="text" editMode={isEditing} onSave={(v) => save('sector', v)} />}
      {show(company.targetCustomer) && (
        <PropertyRow
          label="Target Customer"
          value={company.targetCustomer}
          type="select"
          options={['b2b', 'b2c', 'b2b2c', 'government', 'other']}
          editMode={isEditing}
          onSave={(v) => save('targetCustomer', v)}
        />
      )}
      {show(company.businessModel) && (
        <PropertyRow
          label="Business Model"
          value={company.businessModel}
          type="select"
          options={['saas', 'marketplace', 'transactional', 'hardware', 'services', 'other']}
          editMode={isEditing}
          onSave={(v) => save('businessModel', v)}
        />
      )}
      {show(company.productStage) && (
        <PropertyRow
          label="Product Stage"
          value={company.productStage}
          type="select"
          options={['pre_product', 'mvp', 'beta', 'ga', 'scaling']}
          editMode={isEditing}
          onSave={(v) => save('productStage', v)}
        />
      )}
      {show(company.foundingYear) && <PropertyRow label="Founded" value={company.foundingYear} type="number" editMode={isEditing} onSave={(v) => save('foundingYear', v)} />}
      {show(company.employeeCountRange) && (
        <PropertyRow
          label="Employees"
          value={company.employeeCountRange}
          type="select"
          options={EMPLOYEE_RANGES}
          editMode={isEditing}
          onSave={(v) => save('employeeCountRange', v)}
        />
      )}
      {show(company.hqAddress) && <PropertyRow label="HQ" value={company.hqAddress} type="text" editMode={isEditing} onSave={(v) => save('hqAddress', v)} />}
      {show(company.revenueModel) && <PropertyRow label="Revenue Model" value={company.revenueModel} type="text" editMode={isEditing} onSave={(v) => save('revenueModel', v)} />}

      <SectionHeader title="Pipeline" />
      <PropertyRow
        label="Stage"
        value={company.pipelineStage}
        type="select"
        options={[{ value: '', label: '—' }, ...STAGES]}
        editMode={isEditing}
        onSave={(v) => saveWithDecisionPrompt('pipelineStage', v || null)}
      />
      <PropertyRow
        label="Priority"
        value={company.priority}
        type="select"
        options={[{ value: '', label: '—' }, ...PRIORITIES]}
        editMode={isEditing}
        onSave={(v) => save('priority', v)}
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

      <SectionHeader title="Financials" />
      {show(company.round) && (
        <PropertyRow
          label="Round"
          value={company.round}
          type="select"
          options={[{ value: '', label: '—' }, ...ROUNDS]}
          editMode={isEditing}
          onSave={(v) => save('round', v)}
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

      {(isEditing || company.entityType === 'portfolio' ||
        company.investmentSize || company.ownershipPct ||
        company.followonInvestmentSize || company.totalInvested) && (
        <>
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
        </>
      )}

      <SectionHeader title="Links" />
      {show(company.linkedinCompanyUrl) && <PropertyRow label="LinkedIn" value={company.linkedinCompanyUrl} type="url" editMode={isEditing} onSave={(v) => save('linkedinCompanyUrl', v)} />}
      {show(company.crunchbaseUrl) && <PropertyRow label="Crunchbase" value={company.crunchbaseUrl} type="url" editMode={isEditing} onSave={(v) => save('crunchbaseUrl', v)} />}
      {show(company.angellistUrl) && <PropertyRow label="AngelList" value={company.angellistUrl} type="url" editMode={isEditing} onSave={(v) => save('angellistUrl', v)} />}
      {show(company.twitterHandle) && <PropertyRow label="Twitter/X" value={company.twitterHandle} type="text" editMode={isEditing} onSave={(v) => save('twitterHandle', v)} />}

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
      />

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
    </div>
  )
}
