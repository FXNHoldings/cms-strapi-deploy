import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        forest: {
          50: '#f1f7f4', 100: '#d8ebe0', 200: '#b2d7c3', 300: '#81b99c',
          400: '#5a9b7b', 500: '#3f7e5e', 600: '#2d6249', 700: '#244e3b',
          800: '#1b4332', 900: '#152f24', 950: '#0a1a14',
        },
        sand: {
          50: '#fdfaf2', 100: '#faedcd', 200: '#f5daa5', 300: '#edbf74',
          400: '#e0a148', 500: '#cd8529', 600: '#ae6821', 700: '#8c4f1e',
          800: '#6f401e', 900: '#5a361d',
        },
        terracotta: { 500: '#c26a4f', 600: '#a9543c', 700: '#8b4331' },
        ink: '#1a1a19',
        paper: '#fbf8f2',
      },
      fontFamily: {
        // Body default — Outfit (light 300)
        sans: ['var(--font-outfit)', 'system-ui', 'sans-serif'],
        // Headings — Urbanist (bold 700)
        display: ['var(--font-urbanist)', 'system-ui', 'sans-serif'],
        urbanist: ['var(--font-urbanist)', 'system-ui', 'sans-serif'],
        outfit: ['var(--font-outfit)', 'system-ui', 'sans-serif'],
      },
      letterSpacing: { tightest: '-0.04em' },
      maxWidth: { prose: '68ch' },
      fontSize: {
        '6xl': ['2.5rem', { lineHeight: '1' }],
        '7xl': ['3rem', { lineHeight: '1' }],
      },
      borderRadius: {
        '3xl': '0.3rem',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
} satisfies Config;
