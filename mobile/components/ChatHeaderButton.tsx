import React from 'react'
import { router } from 'expo-router'
import { HeaderIconButton } from './ScreenHeader'

// Persistent "Ask Cyggie" entry point. Lives in the top-right of every main
// screen's ScreenHeader — it replaced the old Chat tab when Record took the
// center tab slot. Opens global chat as a pushed root screen (app/chat/index),
// which carries its own back chevron.
export function ChatHeaderButton(): React.JSX.Element {
  return (
    <HeaderIconButton
      icon="chatbubble-outline"
      onPress={() => router.push('/chat')}
      accessibilityLabel="Ask Cyggie"
    />
  )
}
