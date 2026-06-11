import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/globals.css'
import { migratePerEntityKeyNames } from './utils/layoutPref'
import { getJSON as mirrorGet } from './lib/safe-storage'
import { APPEARANCE_PREF_KEY, DEFAULTS, applyAppearance } from './lib/appearance'

// Run once on startup — renames legacy :company:{id} localStorage keys → :entity:{id}
migratePerEntityKeyNames()

// Apply the cached reading-appearance preference BEFORE first paint so notes
// don't flash at default spacing while the synced store loads (useAppearance
// re-applies + refreshes this mirror once the authoritative value arrives).
applyAppearance(mirrorGet(APPEARANCE_PREF_KEY, DEFAULTS))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
