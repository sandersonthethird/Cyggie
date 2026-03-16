import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CustomFieldEntityType } from '../../shared/types/custom-fields'
import type {
  CreateCustomFieldDefinitionInput,
  UpdateCustomFieldDefinitionInput,
  SetCustomFieldValueInput
} from '../../shared/types/custom-fields'
import {
  listFieldDefinitions,
  createFieldDefinition,
  updateFieldDefinition,
  deleteFieldDefinition,
  reorderFieldDefinitions,
  getFieldValuesForEntity,
  setFieldValue,
  deleteFieldValue,
  countFieldValues,
  getBulkFieldValues,
  countBuiltinOptionUsage,
  renameBuiltinOption
} from '../database/repositories/custom-fields.repo'

function err(message: string, detail?: unknown) {
  console.error(`[custom-fields.ipc] ${message}`, detail ?? '')
  return { success: false as const, error: 'CUSTOM_FIELD_ERROR', message }
}

export function registerCustomFieldsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CUSTOM_FIELD_LIST_DEFINITIONS, (_event, entityType: CustomFieldEntityType) => {
    try {
      return { success: true, data: listFieldDefinitions(entityType) }
    } catch (e) {
      return err('Failed to list field definitions', e)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_FIELD_CREATE_DEFINITION, (_event, input: CreateCustomFieldDefinitionInput) => {
    try {
      const def = createFieldDefinition(input)
      return { success: true, data: def }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to create field definition'
      return err(message, e)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, (_event, id: string, updates: UpdateCustomFieldDefinitionInput) => {
    try {
      const def = updateFieldDefinition(id, updates)
      if (!def) return err(`Field definition not found: ${id}`)
      return { success: true, data: def }
    } catch (e) {
      return err('Failed to update field definition', e)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_FIELD_DELETE_DEFINITION, (_event, id: string) => {
    try {
      const deleted = deleteFieldDefinition(id)
      return { success: true, deleted }
    } catch (e) {
      return err('Failed to delete field definition', e)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CUSTOM_FIELD_REORDER_DEFINITIONS, (_event, orderedIds: string[]) => {
    try {
      reorderFieldDefinitions(orderedIds)
      return { success: true }
    } catch (e) {
      return err('Failed to reorder field definitions', e)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_FIELD_GET_VALUES,
    (_event, entityType: CustomFieldEntityType, entityId: string) => {
      try {
        return { success: true, data: getFieldValuesForEntity(entityType, entityId) }
      } catch (e) {
        return err('Failed to get field values', e)
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, (_event, input: SetCustomFieldValueInput) => {
    try {
      setFieldValue(input)
      return { success: true }
    } catch (e) {
      return err('Failed to set field value', e)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_FIELD_DELETE_VALUE,
    (_event, fieldDefinitionId: string, entityId: string) => {
      try {
        const deleted = deleteFieldValue(fieldDefinitionId, entityId)
        return { success: true, deleted }
      } catch (e) {
        return err('Failed to delete field value', e)
      }
    }
  )

  // Count values for a definition (used by Settings deletion safety check)
  ipcMain.handle(IPC_CHANNELS.CUSTOM_FIELD_COUNT_VALUES, (_event, fieldDefinitionId: string) => {
    try {
      return { success: true, count: countFieldValues(fieldDefinitionId) }
    } catch (e) {
      return err('Failed to count field values', e)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_FIELD_GET_BULK_VALUES,
    (_event, entityType: CustomFieldEntityType, fieldDefinitionIds: string[]) => {
      try {
        return { success: true, data: getBulkFieldValues(entityType, fieldDefinitionIds) }
      } catch (e) {
        return err('Failed to get bulk field values', e)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_FIELD_COUNT_BUILTIN_OPTION,
    (_event, fieldKey: string, value: string) => {
      try {
        return { success: true, count: countBuiltinOptionUsage(fieldKey, value) }
      } catch (e) {
        return err('Failed to count builtin option usage', e)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_FIELD_RENAME_BUILTIN_OPTION,
    (_event, defId: string, fieldKey: string, oldValue: string, newValue: string) => {
      try {
        renameBuiltinOption(defId, fieldKey, oldValue, newValue)
        return { success: true }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to rename builtin option'
        return err(message, e)
      }
    }
  )
}
