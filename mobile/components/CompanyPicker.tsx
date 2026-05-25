import { useCallback } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import {
  type CompanyListItem,
  createCompany,
  fetchCompanies,
} from '../lib/api/companies'
import { EntityPicker } from './EntityPicker'
import { CompanyLogo } from './CompanyLogo'
import { colors, type } from '../theme'

// Company-typed wrapper around EntityPicker. Used by meeting detail's
// "Link Company" affordance.
//
// "Create '{query}'" is enabled — calls POST /companies with just
// `{canonicalName: query}` (no enrichment; desktop's company enrichment
// pipeline runs later when the user opens the company there).

export interface CompanyPickerProps {
  open: boolean
  onClose: () => void
  /** Called with the picked (or freshly-created) company. The screen
   *  then POSTs to /meetings/:id/companies to link it. */
  onPick: (company: CompanyListItem) => void
}

export function CompanyPicker({
  open,
  onClose,
  onPick,
}: CompanyPickerProps): React.JSX.Element {
  const onSearch = useCallback(
    async (query: string, signal: AbortSignal): Promise<CompanyListItem[]> => {
      const opts: { limit: number; signal: AbortSignal; q?: string } = {
        limit: 30,
        signal,
      }
      if (query) opts.q = query
      const res = await fetchCompanies(opts)
      return res.companies
    },
    [],
  )

  const onCreate = useCallback(
    async (query: string) => {
      try {
        const { company } = await createCompany({ canonicalName: query })
        onPick(company)
      } catch {
        // Reported via picker error state on next interaction.
      }
    },
    [onPick],
  )

  return (
    <EntityPicker<CompanyListItem>
      open={open}
      onClose={onClose}
      title="Link company"
      placeholder="Search companies…"
      onSearch={onSearch}
      keyFor={(c) => c.id}
      renderItem={(c) => <CompanyRow company={c} />}
      onPick={onPick}
      onCreate={onCreate}
    />
  )
}

function CompanyRow({ company }: { company: CompanyListItem }): React.JSX.Element {
  const subtitle = [company.industry, company.stage, company.city]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <CompanyLogo
        domain={company.primaryDomain}
        name={company.name}
        size={32}
        shape="rounded"
      />
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {company.name}
        </Text>
        {subtitle && (
          <Text style={styles.meta} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  text: { flex: 1 },
  name: { color: colors.text, fontSize: type.body + 1, fontWeight: '500' },
  meta: { color: colors.text3, fontSize: type.meta, marginTop: 2 },
})
