# P2PBOX — Decentralized P2P Social Chat

A beautiful, fully-functional decentralized social + chat webapp built on the **Nostr protocol**.

- **True decentralization**: No central servers own your social graph or messages. Data is published to open relays.
- **Cryptographic identity**: You control your keys (nsec/npub). Works great with or without a NIP-07 browser extension (Alby, nos2x, etc.).
- **Public feed**: Real-time global notes (kind 1). Post, reply, follow, hashtag filter.
- **Private messages**: End-to-end encrypted DMs (NIP-04) — only you and the recipient can read.
- **Profiles & follows**: Publish your profile (kind 0) and optionally your contact list (kind 3).
- **Multi-relay**: Broadcasts to many public relays. Add your own.

> This is a real client that talks directly to the live Nostr network. Posts you make here will be visible on any other Nostr client (Damus, Primal, Iris, etc.) if the relays overlap.

## Run it

```bash
cd p2pbox
npm install
npm run dev
```

Open http://localhost:5173

## How to use

1. On first load choose:
   - **Generate new identity** — creates fresh keys locally (recommended for demo)
   - **Login with nsec** — paste your existing private key
   - **Browser extension** — connect via NIP-07 (best security)

2. The app immediately connects to several reliable public relays and subscribes to recent activity.

3. **Feed**: Post public notes. Click hashtags to filter. Follow authors directly from their posts. Replies are collected inline.

4. **Messages**: Click "DM" on any post or use the sidebar to start an encrypted chat by npub. Messages are signed + encrypted before leaving your browser.

5. **Profile**: Edit display name / bio / avatar and publish it to the network.

6. **Relays**: Add or remove relays in Settings. More relays = better reach and censorship resistance.

## Under the hood

- React + Vite + TypeScript + Tailwind
- `nostr-tools` — the standard tiny JS library for Nostr
- `SimplePool` for relay connections and pub/sub
- Events are validated with `verifyEvent`
- DMs use NIP-04 encryption (widely compatible). Future versions can easily upgrade to NIP-44 + gift-wrapped events.
- All follows/profiles are published as real Nostr events when you choose "publish".

## Notes & Privacy

- When using a generated/local key, the nsec lives only in your browser's localStorage. **Export a backup** and treat it like cash.
- Using a NIP-07 extension is strongly recommended for day-to-day use (keys never touch the webapp).
- There is no persistence server on our side — everything is P2P via relays.

## Matrix alternative?

This project chose the Nostr route because:
- Extremely lightweight protocol (JSON over WebSocket)
- Excellent JavaScript ecosystem
- Native support for both social posts and private chats
- True key-based sovereign identity (very "blockchain" in spirit)
- No homeserver account registration needed

If you wanted a Matrix version instead, the same UI could be powered by `matrix-js-sdk` against a public homeserver (e.g. matrix.org) or a self-hosted Synapse. Nostr was picked here for a zero-config amazing P2P experience.

Made with ❤️ for the decentralized web.
