import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          emphasis: '#014fd3',
          emphasisHover: '#0072de',
          emphasisPressed: '#0046be',
          highlight: '#0072de',
          highlightHover: '#025ccc',
          highlightPressed: '#014fd3',
          hover: '#cfe9fe',
          pressed: '#9bcffc',
        },
        secondary: {
          DEFAULT: '#fff6d1',
          emphasis: '#ffe200',
          hover: '#fff200',
          pressed: '#ffce00',
        },
        success: { emphasis: '#03721e' },
        attention: { emphasis: '#983e00' },
        danger: { emphasis: '#b00625' },
        forest: {
          50: '#f0f4ff', 100: '#e7f4ff', 200: '#cfe9fe', 300: '#9bcffc',
          400: '#4ea5f0', 500: '#0072de', 600: '#025ccc', 700: '#014fd3',
          800: '#0046be', 900: '#092d74', 950: '#061b46',
        },
        sand: {
          50: '#fffdf0', 100: '#fff6d1', 200: '#fff200', 300: '#ffe200',
          400: '#ffce00', 500: '#d6aa00', 600: '#aa8400', 700: '#7b6000',
          800: '#554200', 900: '#332800',
        },
        terracotta: { 500: '#b85812', 600: '#983e00', 700: '#7a3100' },
        ink: '#07142b',
        paper: '#f0f2f4',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        urbanist: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        outfit: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      letterSpacing: { tightest: '0' },
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
