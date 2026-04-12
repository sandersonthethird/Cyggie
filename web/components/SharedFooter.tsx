export default function SharedFooter() {
  return (
    <footer
      data-share-footer=""
      style={{
        borderTop: '1px solid #e5e7eb',
        background: '#f9fafb',
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Cyggie</span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>© 2025 Cyggie. All rights reserved.</span>
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        {['Privacy Policy', 'Terms of Service', 'Support'].map((link) => (
          <a
            key={link}
            href="#"
            style={{ fontSize: 12, color: '#9ca3af', textDecoration: 'none' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#3b82f6')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#9ca3af')}
          >
            {link}
          </a>
        ))}
      </div>
    </footer>
  )
}
