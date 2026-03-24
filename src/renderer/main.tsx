import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { migratePerEntityKeyNames } from './utils/layoutPref'

// Run once on startup — renames legacy :company:{id} localStorage keys → :entity:{id}
migratePerEntityKeyNames()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
