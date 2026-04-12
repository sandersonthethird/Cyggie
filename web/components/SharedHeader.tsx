'use client'

import { useState } from 'react'

interface SharedHeaderProps {
  label: string
  logoUrl?: string
}

const BTN_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  fontSize: 13,
  fontWeight: 500,
  color: '#6b7280',
  background: 'none',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
}

export default function SharedHeader({ label, logoUrl }: SharedHeaderProps) {
  const [copied, setCopied] = useState(false)
  const [showFallback, setShowFallback] = useState(false)

  const handleShare = async () => {
    const url = window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setShowFallback(true)
    }
  }

  return (
    <header
      data-share-header=""
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: '#fff',
        borderBottom: '1px solid #e5e7eb',
        height: 64,
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        gap: 12,
        flexShrink: 0,
      }}
    >
      {/* Left: logo + divider + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl || '/logo.png'}
          alt="Logo"
          style={{ height: 32, objectFit: 'contain', flexShrink: 0 }}
        />
        <div style={{ width: 1, height: 24, background: '#e5e7eb', flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 500, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
      </div>

      {/* Right: action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {showFallback ? (
          <input
            type="text"
            readOnly
            defaultValue={typeof window !== 'undefined' ? window.location.href : ''}
            autoFocus
            onFocus={(e) => e.target.select()}
            style={{
              fontSize: 12,
              border: '1px solid #d1d5db',
              borderRadius: 6,
              padding: '4px 8px',
              width: 220,
              color: '#374151',
              outline: 'none',
            }}
          />
        ) : (
          <button
            style={BTN_STYLE}
            onClick={handleShare}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f3f4f6')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            {copied ? 'Copied!' : 'Share'}
          </button>
        )}

        <button
          style={BTN_STYLE}
          onClick={() => window.print()}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#f3f4f6')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
          Print
        </button>

        <button
          style={BTN_STYLE}
          onClick={() => window.location.reload()}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#f3f4f6')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Refresh
        </button>
      </div>
    </header>
  )
}
