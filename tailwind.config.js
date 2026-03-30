export default {
  content: ['./src/renderer/**/*.{tsx,ts,html}'],
  theme: {
    extend: {
      colors: {
        crimson: {
          DEFAULT: '#B91C1C',
          hover:   '#991B1B',
          faint:   '#FEF2F2',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
}
