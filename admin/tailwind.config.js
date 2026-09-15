/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Mirrors the storefront's design tokens so the admin panel reads as the
      // same house, not a bolted-on tool.
      colors: {
        ivory: '#faf7f2',
        'ivory-deep': '#f3eee5',
        cream: '#f4eee4',
        sand: '#e7dcc9',
        beige: '#d9c9b2',
        taupe: '#a2917a',
        'taupe-light': '#c4b6a1',
        mocha: '#7d6b56',
        brown: '#4a3b2e',
        charcoal: '#1f1d1a',
        'charcoal-soft': '#33302b',
        ink: '#12110f',
        gold: '#b08d4f',
        'gold-soft': '#c9a961',
        'gold-pale': '#e4d5b7',
        burgundy: '#5c2233',
        line: '#e4ddd1',
        'line-strong': '#d4c9b8',
        success: '#2e5244',
      },
      fontFamily: {
        serif: ['Cormorant Garamond', 'Georgia', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      transitionTimingFunction: {
        luxe: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
}
