# Tally — Track Anything (PWA)

Count anything, see your trends. Installable, works offline, all data stays on-device (IndexedDB).

## Deploy (pick one)

### Option A: Netlify Drop (fastest — 60 seconds, no code tools needed)
1. Go to https://app.netlify.com/drop
2. Drag the `dist/` folder onto the page (use the prebuilt one, or run `npm run build` yourself)
3. Done — you get a live URL. Set a custom subdomain in Site settings.

### Option B: Vercel (best long-term — auto-deploys when you update code)
1. Push this folder to a GitHub repo
2. Go to https://vercel.com → New Project → import the repo
3. Vercel auto-detects Vite. Click Deploy.

## Develop locally
```
npm install
npm run dev      # local dev server
npm run build    # production build → dist/
```

## Installing it on your phone
- **iPhone**: open the URL in Safari → Share → Add to Home Screen
- **Android**: open in Chrome → tap the install prompt (or menu → Install app)

## Notes
- Data is local to each device. Export/Import backup buttons are on the home screen.
- HTTPS is required for PWA install + service worker — Netlify/Vercel give you that automatically.
