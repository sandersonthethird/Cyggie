/** State shape returned by useTakeaways hook — used as props for KeyTakeawaysCard */
export interface TakeawaysState {
  text: string
  editing: boolean
  generating: boolean
  streaming: string
  error: string | null
  hasNewData: boolean
  generatedAt: string | null
  showGenerate: boolean
  showUpdate: boolean
  generate: () => void
  save: () => void
  startEditing: () => void
  cancelEditing: () => void
  setEditText: (text: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}
