export const DECISION_TRIGGER_STAGES = new Set(['documentation', 'pass'])
export const DECISION_TRIGGER_ENTITY_TYPES = new Set(['portfolio'])

export function shouldPromptDecisionLog(
  prevStage: string | null,
  newStage: string | null,
  prevEntityType: string,
  newEntityType: string
): boolean {
  if (newStage && DECISION_TRIGGER_STAGES.has(newStage) && newStage !== prevStage) return true
  if (
    DECISION_TRIGGER_ENTITY_TYPES.has(newEntityType) &&
    !DECISION_TRIGGER_ENTITY_TYPES.has(prevEntityType)
  )
    return true
  return false
}

export function defaultDecisionType(
  newStage: string | null,
  newEntityType: string
): string {
  if (newStage === 'pass') return 'Pass'
  if (newStage === 'documentation' || newEntityType === 'portfolio') return 'Investment Approved'
  return 'Other'
}
