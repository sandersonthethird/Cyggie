import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyDetail } from '../../../shared/types/company'
import { daysSince } from '../../utils/format'
import { PropertyRow } from '../crm/PropertyRow'
import { CustomFieldsPanel } from '../crm/CustomFieldsPanel'
import styles from './CompanyPropertiesPanel.module.css'

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

export function CompanyPropertiesPanel({ company, onUpdate }: CompanyPropertiesPanelProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [showAllFields, setShowAllFields] = useState(false)
  const [nameDraft, setNameDraft] = useState(company.canonicalName)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Sync name draft when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setNameDraft(company.canonicalName)
      setTimeout(() => nameInputRef.current?.focus(), 0)
    }
  }, [isEditing, company.canonicalName])

  function save(field: string, value: unknown) {
    return window.api
      .invoke(IPC_CHANNELS.COMPANY_UPDATE, company.id, { [field]: value })
      .then(() => { onUpdate({ [field]: value }) })
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
          <div className={styles.headerBadges}>
            <select
              className={styles.badge}
              value={company.entityType}
              onChange={(e) => save('entityType', e.target.value)}
            >
              {['prospect','portfolio','pass','vc_fund','customer','partner','vendor','other','unknown'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            {company.pipelineStage && (
              <span className={`${styles.badge} ${styles.pipelineBadge}`}>{company.pipelineStage}</span>
            )}
            <HealthBadge lastTouchpoint={company.lastTouchpoint} />
          </div>
        </div>
        {isEditing ? (
          <button className={styles.doneBtn} onClick={handleDone}>Done</button>
        ) : (
          <button className={styles.editBtn} onClick={() => setIsEditing(true)}>Edit</button>
        )}
      </div>

      {show(company.description) && (
        <PropertyRow
          label="Description"
          value={company.description}
          type="textarea"
          editMode={isEditing}
          onSave={(v) => save('description', v)}
        />
      )}

      <SectionHeader title="Overview" />
      {show(company.sector) && <PropertyRow label="Sector" value={company.sector} type="text" editMode={isEditing} onSave={(v) => save('sector', v)} />}
      {show(company.targetCustomer) && (
        <PropertyRow
          label="Target Customer"
          value={company.targetCustomer}
          type="select"
          options={['b2b','b2c','b2b2c','government','other']}
          editMode={isEditing}
          onSave={(v) => save('targetCustomer', v)}
        />
      )}
      {show(company.businessModel) && (
        <PropertyRow
          label="Business Model"
          value={company.businessModel}
          type="select"
          options={['saas','marketplace','transactional','hardware','services','other']}
          editMode={isEditing}
          onSave={(v) => save('businessModel', v)}
        />
      )}
      {show(company.productStage) && (
        <PropertyRow
          label="Product Stage"
          value={company.productStage}
          type="select"
          options={['pre_product','mvp','beta','ga','scaling']}
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
          options={['1-10','11-50','51-200','201-500','500+']}
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
        options={['screening','diligence','decision','documentation','pass']}
        editMode={isEditing}
        onSave={(v) => save('pipelineStage', v)}
      />
      <PropertyRow
        label="Priority"
        value={company.priority}
        type="select"
        options={['high','further_work','monitor']}
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
          options={['pre_seed','seed','seed_extension','series_a','series_b']}
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

      <SectionHeader title="Links" />
      {show(company.websiteUrl) && <PropertyRow label="Website" value={company.websiteUrl} type="url" editMode={isEditing} onSave={(v) => save('websiteUrl', v)} />}
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

      <CustomFieldsPanel entityType="company" entityId={company.id} />
    </div>
  )
}
