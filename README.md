# P2PBOX

**Decentralized P2P Social Chat** — built on the Nostr protocol.

A clean, fully client-side webapp for social posts and private encrypted messaging. No backend. No central servers own your data. You control your keys.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Public social feed** — Post notes (kind 1), replies, hashtag filtering, follow authors
- **Private encrypted DMs** — 1:1 chats using NIP-04 encryption (only you and the recipient can read)
- **Sovereign identity** — Generate keys or use a NIP-07 browser extension (Alby, nos2x, etc.)
- **Publish your profile** — Set name, bio, avatar (kind 0) visible across the Nostr network
- **Multi-relay support** — Connect to many public relays or add your own for better reach and censorship resistance
- **Real interoperability** — Everything you post is standard Nostr events and appears in other clients (Damus, Primal, Iris, etc.)

> This is a real Nostr client. Posts and messages are broadcast to the open network.

## Run Locally

```bash
# Clone the repository
git clone https://github.com/TheGreatOneInTheMetaVerse/P2PBOX.git
cd P2PBOX

# Install dependencies
npm install

# Start the development server
npm run dev
```

Open **http://localhost:5173** in your browser.

### First time usage

1. Choose how to log in:
   - **Generate new identity** (recommended for testing)
   - Paste an existing `nsec...` private key
   - Connect a browser extension (NIP-07)

2. The app connects automatically to several reliable public Nostr relays.

3. Start posting to the global feed or switch to the **Messages** tab for encrypted chats.

## Build for Production

```bash
npm run build
```

The production files will be in the `dist/` folder. This is a static single-page app — you can deploy it anywhere that hosts static files:

- **GitHub Pages**
- Vercel / Netlify / Cloudflare Pages (free & easy)
- Any web server (Nginx, Apache, etc.)

No backend or database is required.

## Project Structure

```
P2PBOX/
├── src/
│   ├── App.tsx          # Main app (feed, DMs, profile, relays)
│   ├── main.tsx
│   └── index.css        # Dark theme + components
├── public/
├── package.json
└── README.md
```

**Tech stack**
- React 19 + TypeScript + Vite
- Tailwind CSS
- nostr-tools (the standard lightweight Nostr library)
- Pure client-side (all logic runs in the browser)

## Under the Hood

- Uses `SimplePool` for connecting to multiple relays
- All events are validated with `verifyEvent`
- Public posts = kind 1, Profiles = kind 0, Follow lists = kind 3, DMs = kind 4 (NIP-04)
- DMs are end-to-end encrypted before they ever leave your device
- Keys are only stored in your browser's localStorage (export your backup!)

## Privacy & Security Notes

- **Local keys only** — When using the built-in key generator, your `nsec` lives only in `localStorage`. Always export a backup and treat it like a password.
- **Best practice** — Use a NIP-07 extension (Alby, nos2x, Flamingo) so your private key never touches the web page.
- **Relays** — Messages go to the relays you choose. You can run your own relay for maximum sovereignty.
- No analytics, no tracking, no server logs.

## License

MIT License — see the [LICENSE](LICENSE) file.

## Why Nostr?

This project uses Nostr instead of Matrix or a blockchain because:

- Extremely simple & lightweight (JSON over WebSocket)
- Native support for both public social content and private encrypted chats
- True cryptographic identity (pubkey = your identity)
- No registration or homeserver account required
- Works today with a huge ecosystem of clients and relays

Made for the decentralized web. Enjoy P2PBOX!

---

**Repo**: https://github.com/TheGreatOneInTheMetaVerse/P2PBOX

If you want to contribute, open an issue or PR. Feedback welcome!
