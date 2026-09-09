/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'frc-blue': '#0066B3',
        'frc-red': '#ED1C24',
        'frc-yellow': '#FFC72C',
      },
    },
  },
  plugins: [],
}
