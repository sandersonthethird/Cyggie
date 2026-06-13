/**
 * Window CustomEvent name used to sync agent-settings state across the two
 * sibling Settings sections. AgentModelTierSection dispatches it when the model
 * changes; AgentLimitsSection listens and re-reads the model so its live cost
 * estimate stays in sync without a page reload.
 */
export const AGENT_SETTINGS_CHANGED_EVENT = 'agent-settings-changed'
