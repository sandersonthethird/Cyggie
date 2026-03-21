/**
 * SuggestionsPanel — collapsible banner showing companies with recent activity
 * not yet in the current digest.
 *
 * Each suggestion has:
 *   - [+] button → opens AddToSyncModal for that company
 *   - [Dismiss] → calls PARTNER_MEETING_DISMISS_SUGGESTION
 * [Hide all] button dismisses all suggestions at once.
 */

import { useCallback, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { DigestSuggestion, PartnerMeetingItem } from '../../../shared/types/partner-meeting'
import type { CompanySummary } from '../../../shared/types/company'
import { AddToSyncModal } from './AddToSyncModal'
import { api } from '../../api'
import styles from './SuggestionsPanel.module.css'

interface SuggestionsPanelProps {
  digestId: string
  suggestions: DigestSuggestion[]
  onDismiss: (companyId: string) => void
  onAdded: (item: PartnerMeetingItem) => void
}

export function SuggestionsPanel({ digestId, suggestions, onDismiss, onAdded }: SuggestionsPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [addModal, setAddModal] = useState<CompanySummary | null>(null)

  const handleDismiss = useCallback(async (companyId: string) => {
    try {
      await api.invoke(IPC_CHANNELS.PARTNER_MEETING_DISMISS_SUGGESTION, digestId, companyId)
      onDismiss(companyId)
    } catch (err) {
      console.error('[SuggestionsPanel] dismiss failed:', err)
    }
  }, [digestId, onDismiss])

  const handleDismissAll = useCallback(async () => {
    for (const s of suggestions) {
      try {
        await api.invoke(IPC_CHANNELS.PARTNER_MEETING_DISMISS_SUGGESTION, digestId, s.companyId)
        onDismiss(s.companyId)
      } catch {
        // best effort
      }
    }
  }, [digestId, suggestions, onDismiss])

  const handleAdd = useCallback((suggestion: DigestSuggestion) => {
    // Build a minimal CompanySummary shell for the modal
    const companySummary: CompanySummary = {
      id: suggestion.companyId,
      canonicalName: suggestion.companyName,
      normalizedName: suggestion.companyName.toLowerCase(),
      description: null,
      primaryDomain: null,
      websiteUrl: null,
      city: null,
      state: null,
      stage: null,
      status: 'active',
      crmProvider: null,
      crmCompanyId: null,
      entityType: 'prospect',
      includeInCompaniesView: true,
      classificationSource: 'auto',
      classificationConfidence: null,
      meetingCount: 0,
      emailCount: 0,
      noteCount: 0,
      contactCount: 0,
      lastTouchpoint: suggestion.lastTouchpoint,
      priority: null,
      postMoneyValuation: null,
      raiseSize: null,
      round: null,
      pipelineStage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      foundingYear: null,
      employeeCountRange: null,
      hqAddress: null,
      linkedinCompanyUrl: null,
      twitterHandle: null,
      crunchbaseUrl: null,
      angellistUrl: null,
      sector: null,
      targetCustomer: null,
      businessModel: null,
      productStage: null,
      revenueModel: null,
      arr: null,
      burnRate: null,
      runwayMonths: null,
      lastFundingDate: null,
      totalFundingRaised: null,
      leadInvestor: null,
      sourceType: null,
      sourceEntityType: null,
      sourceEntityId: null,
      relationshipOwner: null,
      dealSource: null,
      warmIntroSource: null,
      referralContactId: null,
      nextFollowupDate: null,
      investmentSize: null,
      ownershipPct: null,
      followonInvestmentSize: null,
      totalInvested: null,
      fieldSources: null,
    }
    setAddModal(companySummary)
  }, [])

  if (suggestions.length === 0) return null

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <button className={styles.toggleBtn} onClick={() => setCollapsed(v => !v)}>
            {collapsed ? '▶' : '▾'} Suggested this week
            <span className={styles.count}>{suggestions.length}</span>
          </button>
          <button className={styles.hideAllBtn} onClick={handleDismissAll}>
            Hide all
          </button>
        </div>

        {!collapsed && (
          <div className={styles.list}>
            <div className={styles.description}>
              These companies had activity since Tuesday and aren't in this sync:
            </div>
            {suggestions.map(s => (
              <div key={s.companyId} className={styles.row}>
                <button className={styles.addBtn} onClick={() => handleAdd(s)} title="Add to sync">
                  +
                </button>
                <span className={styles.name}>{s.companyName}</span>
                <span className={styles.activity}>{s.activitySummary}</span>
                <button
                  className={styles.dismissBtn}
                  onClick={() => handleDismiss(s.companyId)}
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {addModal && (
        <AddToSyncModal
          company={addModal}
          onClose={() => setAddModal(null)}
          onAdded={(item) => {
            onAdded(item)
            setAddModal(null)
          }}
        />
      )}
    </>
  )
}
