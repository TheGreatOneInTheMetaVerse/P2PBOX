import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent,
  SimplePool,
  nip19,
  nip04,
} from 'nostr-tools'
import type { Filter } from 'nostr-tools'
import { formatDistanceToNowStrict } from 'date-fns'
import {
  Send, Plus, User, MessageCircle, Users, Globe, Settings, Copy, LogOut,
  Reply, RefreshCw, X, Check, Download, Key
} from 'lucide-react'

// Pure byte/hex helpers (avoid deep noble import issues)
const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')

// Types
interface Profile {
  name?: string
  about?: string
  picture?: string
  nip05?: string
}

interface Note {
  id: string
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
}

interface DM {
  id: string
  pubkey: string // the other party
  created_at: number
  content: string // decrypted plain
  outgoing: boolean
  raw: any
}

interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
}

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>
      signEvent: (event: any) => Promise<any>
      nip04?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>
      }
    }
  }
}

// Default public relays (reliable, open)
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://relay.snort.social',
]

// Some well-known npubs for suggestions (fiatjaf, etc)
const SUGGESTED_FOLLOWS = [
  { npub: 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', name: 'fiatjaf' },
  { npub: 'npub1l2vyh47mk2p0qlsku7hg0vn29faehy9hy34ygaclpn66ukqp3afqutajft', name: 'jb55' },
  { npub: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6', name: 'matt' },
]

// (removed unused SHORT_RELAYS)

function getAvatarUrl(pubkey: string, picture?: string): string {
  if (picture && picture.startsWith('http')) return picture
  // Deterministic fun identicon (free, reliable)
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${pubkey}&radius=50&backgroundColor=1e2937,0f172a`
}

function shortNpub(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey)
    return npub.slice(0, 10) + '...' + npub.slice(-6)
  } catch {
    return pubkey.slice(0, 8) + '...' + pubkey.slice(-4)
  }
}

function fullNpub(pubkey: string): string {
  try { return nip19.npubEncode(pubkey) } catch { return pubkey }
}

function parseNpubOrHex(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(trimmed)
      if (decoded.type === 'npub') return decoded.data as string
    } catch {}
    return null
  }
  // assume hex
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase()
  return null
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#([a-zA-Z0-9_]+)/g) || []
  return matches.map(t => t.slice(1).toLowerCase())
}

function renderContent(text: string, onHashtag?: (tag: string) => void): React.ReactNode {
  // Very lightweight link + hashtag + mention parser
  const parts: React.ReactNode[] = []
  const regex = /(https?:\/\/[^\s]+)|(#\w+)|(npub1[0-9a-z]+)/gi
  let last = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(<span key={key++}>{text.slice(last, match.index)}</span>)
    }
    const token = match[0]
    if (token.startsWith('http')) {
      parts.push(
        <a key={key++} href={token} target="_blank" rel="noreferrer" className="break-all">
          {token.length > 55 ? token.slice(0, 52) + '...' : token}
        </a>
      )
    } else if (token.startsWith('#')) {
      const tag = token.slice(1)
      parts.push(
        <span key={key++} className="tag" onClick={() => onHashtag?.(tag)}>
          {token}
        </span>
      )
    } else if (token.startsWith('npub1')) {
      parts.push(
        <span key={key++} className="text-violet-400 hover:underline cursor-pointer" title={token}>
          {token.slice(0, 12)}…
        </span>
      )
    } else {
      parts.push(<span key={key++}>{token}</span>)
    }
    last = match.index + token.length
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>)

  return <span className="content-text whitespace-pre-wrap break-words">{parts}</span>
}

function formatTime(ts: number): string {
  try {
    return formatDistanceToNowStrict(new Date(ts * 1000), { addSuffix: true })
  } catch {
    return 'just now'
  }
}

const P2PBOXApp: React.FC = () => {
  // Identity
  const [sk, setSk] = useState<Uint8Array | null>(null)
  const [pk, setPk] = useState<string | null>(null)
  const [nsec, setNsec] = useState<string | null>(null)
  const [npub, setNpub] = useState<string | null>(null)
  const [useExtension, setUseExtension] = useState(false)

  // Data
  const [notes, setNotes] = useState<Note[]>([])
  const [profiles, setProfiles] = useState<Record<string, Profile>>({})
  const [follows, setFollows] = useState<string[]>([])
  const [dms, setDms] = useState<DM[]>([])
  const [relays, setRelays] = useState<string[]>(DEFAULT_RELAYS)

  // UI State
  const [view, setView] = useState<'feed' | 'following' | 'messages' | 'relays' | 'profile'>('feed')
  const [selectedChat, setSelectedChat] = useState<string | null>(null)
  const [composeText, setComposeText] = useState('')
  const [dmText, setDmText] = useState('')
  const [newRelay, setNewRelay] = useState('')
  const [newNpubInput, setNewNpubInput] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(true)
  const [isPublishing, setIsPublishing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [testChatPub, setTestChatPub] = useState<string | null>(null) // for local demo chat

  // Nostr
  const poolRef = useRef<SimplePool | null>(null)
  const seenIds = useRef<Set<string>>(new Set())
  const repliesMap = useRef<Record<string, Note[]>>({})
  const subRef = useRef<any>(null)

  // Persist helpers
  const persist = (key: string, val: any) => {
    try { localStorage.setItem(`p2pbox:${key}`, JSON.stringify(val)) } catch {}
  }
  const load = <T,>(key: string, fallback: T): T => {
    try {
      const v = localStorage.getItem(`p2pbox:${key}`)
      return v ? JSON.parse(v) : fallback
    } catch { return fallback }
  }

  // Toast helper
  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Date.now()
    setToasts((t) => [...t, { id, message, type }])
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, 4200)
  }, [])

  // Get current public key (hex)
  const myPub = pk

  // Computed lists
  const displayNotes = useMemo(() => {
    let filtered = notes

    if (view === 'following' && myPub) {
      filtered = filtered.filter((n) => follows.includes(n.pubkey) || n.pubkey === myPub)
    }
    if (tagFilter) {
      filtered = filtered.filter((n) => extractHashtags(n.content).includes(tagFilter.toLowerCase()))
    }
    return filtered
  }, [notes, view, follows, myPub, tagFilter])

  const conversations = useMemo(() => {
    const map = new Map<string, { last: number; preview: string; count: number }>()
    for (const dm of dms) {
      const other = dm.pubkey
      const prev = map.get(other)
      if (!prev || dm.created_at > prev.last) {
        map.set(other, {
          last: dm.created_at,
          preview: dm.content.slice(0, 64),
          count: (prev?.count || 0) + 1,
        })
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].last - a[1].last)
      .map(([pubkey, meta]) => ({ pubkey, ...meta }))
  }, [dms])

  const currentChatMessages = useMemo(() => {
    if (!selectedChat) return []
    return dms
      .filter((d) => d.pubkey === selectedChat)
      .sort((a, b) => a.created_at - b.created_at)
  }, [dms, selectedChat])

  const selectedProfile = selectedChat ? profiles[selectedChat] : null

  // Avatar + display helpers
  const getDisplayName = (pubkey: string) => {
    const p = profiles[pubkey]
    if (p?.name) return p.name
    if (pubkey === myPub) return 'You'
    return shortNpub(pubkey)
  }

  const getProfilePicture = (pubkey: string) => {
    return profiles[pubkey]?.picture || undefined
  }

  // Initialize or restore identity + data
  useEffect(() => {
    const savedSkHex = load<string | null>('sk', null)
    const savedRelays = load<string[]>('relays', DEFAULT_RELAYS)
    const savedFollows = load<string[]>('follows', [])

    setRelays(savedRelays)
    setFollows(savedFollows)

    if (savedSkHex) {
      try {
        const skBytes = hexToBytes(savedSkHex)
        const pub = getPublicKey(skBytes)
        setSk(skBytes)
        setPk(pub)
        setNsec(nip19.nsecEncode(skBytes))
        setNpub(nip19.npubEncode(pub))
        setShowOnboarding(false)
        setUseExtension(false)
      } catch (e) {
        console.warn('Failed to restore key', e)
        localStorage.removeItem('p2pbox:sk')
      }
    } else {
      // Check for extension on load
      if (window.nostr) {
        // don't auto-login, let user choose in onboarding
      }
    }
  }, [])

  // Persist relays + follows
  useEffect(() => { persist('relays', relays) }, [relays])
  useEffect(() => { persist('follows', follows) }, [follows])

  // Save secret when it changes (only for local key mode)
  useEffect(() => {
    if (sk && !useExtension) {
      persist('sk', bytesToHex(sk))
    }
  }, [sk, useExtension])

  // Create / get pool
  const getPool = () => {
    if (!poolRef.current) {
      poolRef.current = new SimplePool()
    }
    return poolRef.current
  }

  // Subscribe to everything important
  const subscribeAll = useCallback(async (pubkey: string, currentRelays: string[]) => {
    const pool = getPool()
    if (subRef.current) {
      try { subRef.current.close() } catch {}
    }

    const noteSince = Math.floor(Date.now() / 1000) - 60 * 60 * 48 // last 48h for notes
    const dmSince = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7 // last 7 days for DMs (catch test messages)

    // Public notes + replies
    const noteFilters: Filter[] = [
      { kinds: [1], limit: 150, since: noteSince },
      { kinds: [0], authors: [pubkey], limit: 1 },
    ]
    const noteSub = pool.subscribeMany(currentRelays, noteFilters as any, {
      onevent(evt) { handleEvent(evt) },
      oneose() {},
    })

    // Extra broader initial load so new users see real content immediately (no time filter for first batch)
    pool.querySync(currentRelays, [{ kinds: [1], limit: 80 }] as any).then((events) => {
      events.forEach(handleEvent)
    })

    // DMs (both directions)
    const dmFilters: Filter[] = [
      { kinds: [4], '#p': [pubkey], since: dmSince },
      { kinds: [4], authors: [pubkey], since: dmSince },
    ]
    const dmSub = pool.subscribeMany(currentRelays, dmFilters as any, {
      onevent(evt) { handleDMEvent(evt, pubkey) },
    })

    // Fetch profiles of people we follow + recent note authors (throttled)
    setTimeout(() => {
      const authors = [...new Set([...follows, ...notes.slice(0, 30).map((n) => n.pubkey)])]
      if (authors.length > 0) {
        const profFilters: Filter[] = [{ kinds: [0], authors: authors.slice(0, 40), limit: 40 }]
        pool.subscribeMany(currentRelays, profFilters as any, { onevent: handleEvent })
      }
    }, 800)

    subRef.current = { close: () => { noteSub.close(); dmSub.close() } }
  }, [follows, notes.length]) // eslint will complain but fine

  // Process any event (kind 0 profile + kind 1 notes)
  const handleEvent = (evt: any) => {
    if (!verifyEvent(evt)) return
    if (seenIds.current.has(evt.id)) return
    seenIds.current.add(evt.id)

    if (evt.kind === 0) {
      try {
        const meta = JSON.parse(evt.content)
        setProfiles((prev) => ({
          ...prev,
          [evt.pubkey]: {
            name: meta.name,
            about: meta.about,
            picture: meta.picture,
            nip05: meta.nip05,
          },
        }))
      } catch {}
      return
    }

    if (evt.kind === 1) {
      const note: Note = {
        id: evt.id,
        pubkey: evt.pubkey,
        created_at: evt.created_at,
        content: evt.content || '',
        tags: evt.tags || [],
      }
      setNotes((prev) => {
        const next = [note, ...prev].sort((a, b) => b.created_at - a.created_at)
        // Keep a reasonable cap
        return next.slice(0, 400)
      })

      // Track simple replies
      const rootOrReply = evt.tags.find((t: string[]) => t[0] === 'e')
      if (rootOrReply && rootOrReply[1]) {
        const parent = rootOrReply[1]
        if (!repliesMap.current[parent]) repliesMap.current[parent] = []
        if (!repliesMap.current[parent].some((n) => n.id === note.id)) {
          repliesMap.current[parent].push(note)
          repliesMap.current[parent].sort((a, b) => a.created_at - b.created_at)
        }
      }
    }
  }

  // Handle incoming DM events (kind 4)
  const handleDMEvent = async (evt: any, myPubkey: string) => {
    if (!verifyEvent(evt)) return
    if (seenIds.current.has(evt.id)) return
    seenIds.current.add(evt.id)

    const isOutgoing = evt.pubkey === myPubkey
    let otherPub = ''
    if (isOutgoing) {
      const pTag = evt.tags.find((t: string[]) => t[0] === 'p')
      if (!pTag) return
      otherPub = pTag[1]
    } else {
      otherPub = evt.pubkey
    }

    let plain = '[encrypted]'
    try {
      if (useExtension && window.nostr?.nip04) {
        plain = await window.nostr.nip04.decrypt(otherPub, evt.content)
      } else if (sk) {
        plain = await nip04.decrypt(sk, otherPub, evt.content)
      }
    } catch (e) {
      // Can't decrypt (maybe not for us or bad data)
      plain = '[cannot decrypt]'
    }

    const dm: DM = {
      id: evt.id,
      pubkey: otherPub,
      created_at: evt.created_at,
      content: plain,
      outgoing: isOutgoing,
      raw: evt,
    }
    setDms((prev) => {
      const exists = prev.some((d) => d.id === dm.id)
      if (exists) return prev
      return [...prev, dm].sort((a, b) => a.created_at - b.created_at)
    })
  }

  // Connect / start subscriptions when we have identity + relays
  useEffect(() => {
    if (!pk || relays.length === 0) return
    subscribeAll(pk, relays)
    // Also fetch own profile immediately
    fetchProfiles([pk], relays)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pk, relays])

  const fetchProfiles = async (pubkeys: string[], currentRelays: string[]) => {
    if (pubkeys.length === 0) return
    const pool = getPool()
    const filters: Filter[] = [{ kinds: [0], authors: pubkeys }]
    const events = await pool.querySync(currentRelays, filters as any)
    events.forEach(handleEvent)
  }

  // Publish helper (works with local key or extension)
  const publishEvent = async (unsigned: any): Promise<boolean> => {
    if (!pk) return false
    const pool = getPool()
    let signed: any

    if (useExtension && window.nostr) {
      try {
        signed = await window.nostr.signEvent(unsigned)
      } catch (e: any) {
        showToast('Extension signing failed: ' + (e?.message || e), 'error')
        return false
      }
    } else if (sk) {
      signed = finalizeEvent(unsigned, sk)
    } else {
      showToast('No signing key available', 'error')
      return false
    }

    if (!verifyEvent(signed)) {
      showToast('Event failed to verify', 'error')
      return false
    }

    setIsPublishing(true)
    try {
      const pubs = pool.publish(relays, signed)
      // Wait for at least one success or timeout fast
      const results = await Promise.allSettled(
        pubs.map((p: any) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej('timeout'), 6500))]))
      )
      const ok = results.some((r) => r.status === 'fulfilled')
      if (!ok) {
        showToast('Published to 0 relays (check connection)', 'error')
      } else {
        showToast('Published to the network', 'success')
      }
      // Optimistic insert for notes
      if (signed.kind === 1 && !seenIds.current.has(signed.id)) {
        handleEvent(signed)
      }
      return ok
    } catch (e: any) {
      showToast('Publish error: ' + (e?.message || 'network'), 'error')
      return false
    } finally {
      setIsPublishing(false)
    }
  }

  // Post a public note (kind 1)
  const postNote = async () => {
    const text = composeText.trim()
    if (!text || !pk) return

    const tags: string[][] = []
    if (tagFilter) tags.push(['t', tagFilter])

    // If replying
    // (we keep simple reply handling via a small state if needed; basic for now)

    const unsigned = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: text,
    }

    const ok = await publishEvent(unsigned)
    if (ok) {
      setComposeText('')
      setTagFilter(null)
    }
  }

  // Send DM (kind 4 + nip04)
  const sendDM = async () => {
    const text = dmText.trim()
    if (!text || !selectedChat || !pk) return

    // Local test chat simulation (demo only)
    if (testChatPub && selectedChat === testChatPub) {
      // Add the "sent" message
      const outgoing: DM = {
        id: 'local-out-' + Date.now(),
        pubkey: testChatPub,
        created_at: Math.floor(Date.now() / 1000),
        content: text,
        outgoing: true,
        raw: null,
      }
      setDms((prev) => [...prev, outgoing])
      setDmText('')

      // Simulate a quick reply from the test user after a short delay
      setTimeout(() => {
        const replies = [
          "Got it!",
          "Interesting point.",
          "Thanks for testing!",
          "This is working locally.",
          "Cool, the UI looks good.",
        ]
        const reply: DM = {
          id: 'local-in-' + Date.now(),
          pubkey: testChatPub,
          created_at: Math.floor(Date.now() / 1000),
          content: replies[Math.floor(Math.random() * replies.length)],
          outgoing: false,
          raw: null,
        }
        setDms((prev) => [...prev, reply])
      }, 600)
      return
    }

    const recipient = selectedChat
    let encrypted: string

    try {
      if (useExtension && window.nostr?.nip04) {
        encrypted = await window.nostr.nip04.encrypt(recipient, text)
      } else if (sk) {
        encrypted = await nip04.encrypt(sk, recipient, text)
      } else {
        throw new Error('No key')
      }
    } catch (e: any) {
      showToast('Failed to encrypt DM: ' + (e?.message || e), 'error')
      return
    }

    const unsigned = {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipient]],
      content: encrypted,
    }

    const ok = await publishEvent(unsigned)
    if (ok) {
      // Optimistically add the outgoing DM (we already know plaintext)
      const fakeId = 'local-' + Date.now()
      const dm: DM = {
        id: fakeId,
        pubkey: recipient,
        created_at: unsigned.created_at,
        content: text,
        outgoing: true,
        raw: unsigned,
      }
      setDms((prev) => [...prev, dm])
      setDmText('')
    }
  }

  // Follow / unfollow (local + optional publish kind 3)
  const toggleFollow = async (targetPub: string, publish = false) => {
    if (!pk || targetPub === pk) return
    const isFollowing = follows.includes(targetPub)
    const nextFollows = isFollowing
      ? follows.filter((f) => f !== targetPub)
      : [...follows, targetPub]

    setFollows(nextFollows)

    if (publish) {
      const tags = nextFollows.map((f) => ['p', f])
      const unsigned = {
        kind: 3,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
      }
      await publishEvent(unsigned)
      showToast(isFollowing ? 'Unfollowed & published' : 'Now following (published to relays)', 'success')
    } else {
      showToast(isFollowing ? 'Unfollowed (local)' : 'Following (local to this device)', 'info')
    }

    // fetch their profile
    fetchProfiles([targetPub], relays)
  }

  // Publish profile metadata (kind 0)
  const publishProfile = async (name: string, about: string, picture: string) => {
    if (!pk) return
    const meta = { name: name.trim(), about: about.trim(), picture: picture.trim() }
    const unsigned = {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(meta),
    }
    const ok = await publishEvent(unsigned)
    if (ok) {
      setProfiles((prev) => ({ ...prev, [pk]: meta }))
      showToast('Profile published', 'success')
    }
  }

  // Generate fresh local identity
  const generateIdentity = () => {
    const newSk = generateSecretKey()
    const newPk = getPublicKey(newSk)
    const newNsecStr = nip19.nsecEncode(newSk)
    const newNpubStr = nip19.npubEncode(newPk)

    setSk(newSk)
    setPk(newPk)
    setNsec(newNsecStr)
    setNpub(newNpubStr)
    setUseExtension(false)
    setShowOnboarding(false)
    // reset data
    setNotes([])
    setDms([])
    setFollows([])
    seenIds.current.clear()
    repliesMap.current = {}

    showToast('New identity created. Save your nsec backup!', 'success')
  }

  // Login with nsec (or hex)
  const loginWithNsec = (input: string) => {
    try {
      let skBytes: Uint8Array
      if (input.startsWith('nsec1')) {
        const decoded = nip19.decode(input)
        if (decoded.type !== 'nsec') throw new Error('Bad nsec')
        skBytes = decoded.data as Uint8Array
      } else {
        skBytes = hexToBytes(input.trim())
      }
      const pub = getPublicKey(skBytes)
      setSk(skBytes)
      setPk(pub)
      setNsec(nip19.nsecEncode(skBytes))
      setNpub(nip19.npubEncode(pub))
      setUseExtension(false)
      setShowOnboarding(false)
      showToast('Logged in with private key', 'success')
    } catch (e: any) {
      showToast('Invalid key: ' + (e?.message || 'format error'), 'error')
    }
  }

  // Login via NIP-07 extension
  const loginWithExtension = async () => {
    if (!window.nostr) {
      showToast('No NIP-07 extension found (try Alby, nos2x, or Flamingo)', 'error')
      return
    }
    try {
      const pub = await window.nostr.getPublicKey()
      setPk(pub)
      setNpub(nip19.npubEncode(pub))
      setSk(null)
      setNsec(null)
      setUseExtension(true)
      setShowOnboarding(false)
      showToast('Connected via browser extension', 'success')
    } catch (e: any) {
      showToast('Extension login failed: ' + (e?.message || e), 'error')
    }
  }

  const logout = () => {
    if (subRef.current) {
      try { subRef.current.close() } catch {}
    }
    localStorage.removeItem('p2pbox:sk')
    setSk(null)
    setPk(null)
    setNsec(null)
    setNpub(null)
    setUseExtension(false)
    setNotes([])
    setDms([])
    setSelectedChat(null)
    setFollows([])
    setProfiles({})
    setTestChatPub(null)
    seenIds.current.clear()
    repliesMap.current = {}
    setShowOnboarding(true)
    setView('feed')
    showToast('Logged out', 'info')
  }

  // Add / remove relay
  const addRelay = () => {
    let r = newRelay.trim()
    if (!r) return
    if (!r.startsWith('wss://')) r = 'wss://' + r
    if (!relays.includes(r)) {
      const next = [...relays, r]
      setRelays(next)
      setNewRelay('')
      showToast('Relay added', 'success')
    }
  }

  const removeRelay = (r: string) => {
    if (relays.length <= 1) {
      showToast('Keep at least one relay', 'error')
      return
    }
    setRelays(relays.filter((x) => x !== r))
  }

  const resetRelays = () => {
    setRelays(DEFAULT_RELAYS)
    showToast('Relays reset to defaults', 'info')
  }

  // Start a DM from anywhere
  const startDM = (targetPub: string) => {
    if (targetPub === pk) {
      showToast("That's you", 'info')
      return
    }
    setSelectedChat(targetPub)
    setView('messages')
    fetchProfiles([targetPub], relays)
  }

  // Local demo chat - lets new users experience the chat UI immediately without external apps or real keys
  const startLocalTestChat = () => {
    if (!pk) return
    const testSk = generateSecretKey()
    const testPk = getPublicKey(testSk)
    setTestChatPub(testPk)
    setSelectedChat(testPk)
    setView('messages')

    // Add a simulated incoming message from the "test user"
    const welcome: DM = {
      id: 'local-test-' + Date.now(),
      pubkey: testPk,
      created_at: Math.floor(Date.now() / 1000),
      content: "Hello! This is a local demo chat (not sent to the real Nostr network). Try sending me a message!",
      outgoing: false,
      raw: null,
    }
    setDms((prev) => [...prev, welcome])
    showToast('Started local test chat — messages here stay in this browser tab only', 'info')
  }

  // Open profile edit quick
  const [profileForm, setProfileForm] = useState({ name: '', about: '', picture: '' })
  const openMyProfile = () => {
    if (!pk) return
    const p = profiles[pk] || {}
    setProfileForm({
      name: p.name || '',
      about: p.about || '',
      picture: p.picture || '',
    })
    setView('profile')
  }

  // Load more older notes
  const loadOlder = async () => {
    if (!pk || loadingMore) return
    setLoadingMore(true)
    const pool = getPool()
    const oldest = notes.length > 0 ? Math.min(...notes.map((n) => n.created_at)) : Math.floor(Date.now() / 1000) - 86400 * 30
    try {
      const q: Filter[] = [{ kinds: [1], until: oldest, limit: 60 }]
      const more = await pool.querySync(relays, q as any)
      more.forEach(handleEvent)
      showToast(`Loaded ${more.length} older posts`, 'info')
    } catch (e) {
      showToast('Failed to load older posts', 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  // Export backup
  const exportBackup = () => {
    if (!nsec) {
      showToast('No local secret to export (using extension)', 'info')
      return
    }
    const blob = new Blob([`P2PBOX Nostr Backup\n\nnsec: ${nsec}\npub: ${npub}\n\nKeep this secret safe and never share it.`], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `p2pbox-backup-${(npub || 'key').slice(0, 12)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Copy helpers
  const copy = async (text: string, label = 'Copied') => {
    await navigator.clipboard.writeText(text)
    showToast(label, 'success')
  }

  // Keyboard send
  const onComposeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      postNote()
    }
  }

  // Hashtag filter from rendered content
  const applyTagFilter = (tag: string) => {
    setTagFilter(tag)
    setView('feed')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Clear filter
  const clearTagFilter = () => setTagFilter(null)

  // === RENDER ===

  if (showOnboarding) {
    return (
      <div className="min-h-screen p2pbox-bg text-zinc-200 flex items-center justify-center p-6">
        <div className="max-w-md w-full">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-11 h-11 rounded-2xl bg-violet-600 flex items-center justify-center">
              <Key className="w-6 h-6" />
            </div>
            <div>
              <div className="text-3xl font-semibold tracking-tighter">P2PBOX</div>
              <div className="text-xs text-zinc-500 -mt-1">DECENTRALIZED SOCIAL</div>
            </div>
          </div>

          <h1 className="text-5xl font-semibold tracking-tighter mb-3">Own your voice.</h1>
          <p className="text-xl text-zinc-400 mb-10">P2P social chat powered by Nostr — no servers own your data, only keys do.</p>

          <div className="space-y-3">
            <button
              onClick={generateIdentity}
              className="w-full py-3.5 rounded-2xl bg-white text-black font-semibold flex items-center justify-center gap-2 hover:bg-zinc-200 active:bg-white transition"
            >
              <Key className="w-4 h-4" /> Generate new identity
            </button>

            <div className="p2pbox-surface border p2pbox-border rounded-2xl p-4">
              <div className="text-xs uppercase tracking-widest text-zinc-500 mb-2">I already have keys</div>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm mono focus:outline-none focus:border-violet-500"
                  placeholder="nsec1... or hex private key"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = (e.target as HTMLInputElement).value
                      if (val) loginWithNsec(val)
                    }
                  }}
                  id="nsec-input"
                />
                <button
                  onClick={() => {
                    const inp = document.getElementById('nsec-input') as HTMLInputElement
                    if (inp?.value) loginWithNsec(inp.value)
                  }}
                  className="px-5 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:bg-black border border-white/10"
                >
                  Login
                </button>
              </div>
              <div className="mt-3 text-[11px] text-zinc-500">Your key never leaves your device.</div>
            </div>

            <button
              onClick={loginWithExtension}
              className="w-full py-3 rounded-2xl border border-white/15 hover:bg-white/5 flex items-center justify-center gap-2 text-sm"
            >
              <User className="w-4 h-4" /> Use browser extension (NIP-07)
            </button>
          </div>

          <div className="mt-10 text-center text-xs text-zinc-500">
            Relays: public &amp; permissionless &nbsp;•&nbsp; Messages are signed &amp; distributed
          </div>
        </div>
      </div>
    )
  }

  // Main App Shell
  return (
    <div className="min-h-screen p2pbox-bg text-zinc-200">
      {/* Top bar */}
      <div className="sticky top-0 z-40 border-b border-white/10 bg-[#0b0b10]/95 backdrop-blur">
        <div className="max-w-[1200px] mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div onClick={() => setView('feed')} className="flex items-center gap-2.5 cursor-pointer">
              <div className="w-8 h-8 rounded-2xl bg-violet-600 flex items-center justify-center">
                <Globe className="w-4.5 h-4.5" />
              </div>
              <div className="font-semibold tracking-tight text-xl">P2PBOX</div>
            </div>
            <div className="hidden md:block text-xs px-2 py-px rounded bg-white/5 text-zinc-400">nostr</div>
          </div>

          <div className="flex items-center gap-3 text-sm">
            {/* Relay status */}
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-white/5 border border-white/10">
              <div className="relay-dot connected" />
              <span className="text-xs text-zinc-400">Live on {relays.length} relays</span>
              <button
                onClick={() => {
                  if (pk) {
                    subscribeAll(pk, relays)
                    showToast('Reconnecting to relays...', 'info')
                  }
                }}
                className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20"
                title="Reconnect"
              >
                ⟳
              </button>
            </div>

            {/* Identity pill */}
            <div onClick={openMyProfile} className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-3xl bg-white/5 hover:bg-white/10 border border-white/10 cursor-pointer">
              <div className="avatar w-7 h-7">
                {pk && <img src={getAvatarUrl(pk, getProfilePicture(pk))} alt="" />}
              </div>
              <div className="text-xs mono max-w-[124px] truncate">{npub ? npub.slice(5, 16) + '…' : '…'}</div>
            </div>

            <button onClick={logout} className="p-2 rounded-xl hover:bg-white/5 border border-white/10" title="Logout">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto px-3 md:px-4 pb-20">
        <div className="flex flex-col md:flex-row gap-4 pt-4">
          {/* Sidebar Nav */}
          <div className="md:w-56 shrink-0">
            <div className="p2pbox-surface border p2pbox-border rounded-3xl p-2 sticky top-20">
              <div className="px-3 py-2 text-[10px] font-medium tracking-[1px] text-zinc-500">MENU</div>

              <button onClick={() => { setView('feed'); setTagFilter(null) }} className={`nav-item w-full ${view === 'feed' ? 'active' : ''}`}>
                <Globe className="w-4 h-4" /> Global Feed
              </button>
              <button onClick={() => setView('following')} className={`nav-item w-full ${view === 'following' ? 'active' : ''}`}>
                <Users className="w-4 h-4" /> Following
              </button>
              <button onClick={() => setView('messages')} className={`nav-item w-full ${view === 'messages' ? 'active' : ''}`}>
                <MessageCircle className="w-4 h-4" /> Messages <span className="ml-auto text-[10px] opacity-60">{conversations.length}</span>
              </button>
              <button onClick={() => setView('profile')} className={`nav-item w-full ${view === 'profile' ? 'active' : ''}`}>
                <User className="w-4 h-4" /> Profile
              </button>
              <button onClick={() => setView('relays')} className={`nav-item w-full ${view === 'relays' ? 'active' : ''}`}>
                <Settings className="w-4 h-4" /> Relays
              </button>

              <div className="h-px bg-white/10 my-3 mx-2" />

              <div className="px-3 pb-1 text-[10px] tracking-widest text-zinc-500">YOUR KEY</div>
              <div className="px-3 py-1">
                <div className="npub text-[10px] leading-snug break-all mb-1.5 select-all">{npub}</div>
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={() => npub && copy(npub, 'npub copied')} className="text-xs px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 flex items-center gap-1">
                    <Copy className="w-3 h-3" /> npub
                  </button>
                  {nsec && (
                    <button onClick={() => copy(nsec, 'nsec copied — keep safe')} className="text-xs px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 flex items-center gap-1">
                      <Copy className="w-3 h-3" /> nsec
                    </button>
                  )}
                  <button onClick={exportBackup} className="text-xs px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 flex items-center gap-1">
                    <Download className="w-3 h-3" /> backup
                  </button>
                </div>
              </div>
            </div>

            {/* Quick who to follow */}
            <div className="mt-4 px-1 hidden lg:block">
              <div className="text-xs text-zinc-500 px-2 mb-1.5">SUGGESTED TO FOLLOW</div>
              {SUGGESTED_FOLLOWS.map((s, i) => {
                const pub = parseNpubOrHex(s.npub)!
                const isFollowed = follows.includes(pub)
                return (
                  <div key={i} className="flex items-center justify-between text-sm px-2 py-1.5 rounded-xl hover:bg-white/5">
                    <div onClick={() => startDM(pub)} className="cursor-pointer truncate">{s.name}</div>
                    <button
                      onClick={() => toggleFollow(pub)}
                      className={`text-xs px-2.5 py-0.5 rounded-full border ${isFollowed ? 'border-emerald-700 text-emerald-400' : 'border-white/20 hover:bg-white/5'}`}
                    >
                      {isFollowed ? 'Following' : 'Follow'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 min-w-0 max-w-3xl">
            {/* FEED + FOLLOWING VIEW */}
            {(view === 'feed' || view === 'following') && (
              <div>
                {/* Composer */}
                <div className="p2pbox-surface border p2pbox-border rounded-3xl p-4 mb-4">
                  <div className="flex gap-3">
                    <div className="avatar mt-0.5">
                      {pk && <img src={getAvatarUrl(pk, getProfilePicture(pk))} alt="" />}
                    </div>
                    <div className="flex-1 compose-box">
                      <textarea
                        value={composeText}
                        onChange={(e) => setComposeText(e.target.value)}
                        onKeyDown={onComposeKeyDown}
                        placeholder={view === 'following' ? "Write to people you follow..." : "What's happening on the mesh?"}
                        className="w-full bg-transparent resize-y outline-none text-[15px] placeholder:text-zinc-500"
                      />
                      <div className="flex justify-between items-center mt-2 pt-3 border-t border-white/10">
                        <div className="flex items-center gap-2 text-xs">
                          {tagFilter && (
                            <span onClick={clearTagFilter} className="cursor-pointer px-2 py-px bg-violet-500/20 text-violet-300 rounded">#{tagFilter} ×</span>
                          )}
                          <span className="text-zinc-500">ctrl+enter to post</span>
                        </div>
                        <button
                          onClick={postNote}
                          disabled={!composeText.trim() || isPublishing}
                          className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 active:bg-violet-700 disabled:bg-zinc-700 disabled:text-zinc-400 transition px-5 h-9 rounded-2xl text-sm font-medium"
                        >
                          <Send className="w-3.5 h-3.5" /> {isPublishing ? 'Publishing…' : 'Post'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Feed header */}
                <div className="flex items-center justify-between mb-2 px-1">
                  <div className="font-medium flex items-center gap-2">
                    {view === 'following' ? 'Following' : 'Global'} {tagFilter && <span className="text-violet-400">#{tagFilter}</span>}
                  </div>
                  <button onClick={loadOlder} disabled={loadingMore} className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-full bg-white/5 hover:bg-white/10 border border-white/10">
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingMore ? 'animate-spin' : ''}`} /> Older
                  </button>
                </div>

                {/* Notes list */}
                <div className="space-y-3">
                  {displayNotes.length === 0 && (
                    <div className="p2pbox-surface border p2pbox-border rounded-3xl p-8 text-center text-sm text-zinc-400">
                      No recent posts loaded (last 48h filter).<br />
                      Try clicking <strong>"Older"</strong> below, or post something in the composer above.<br />
                      <span className="text-xs mt-2 block">Tip: Follow accounts from the right sidebar to see content in the "Following" tab.</span>
                    </div>
                  )}

                  {displayNotes.map((note) => {
                    const isMine = note.pubkey === pk
                    const profile = profiles[note.pubkey]
                    const replies = repliesMap.current[note.id] || []
                    return (
                      <div key={note.id} className="note-card">
                        <div className="flex gap-3">
                          <div onClick={() => startDM(note.pubkey)} className="avatar cursor-pointer">
                            <img src={getAvatarUrl(note.pubkey, profile?.picture)} alt="" />
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-sm">
                              <span onClick={() => startDM(note.pubkey)} className="font-medium cursor-pointer hover:underline">
                                {getDisplayName(note.pubkey)}
                              </span>
                              <span className="npub cursor-pointer" onClick={() => copy(fullNpub(note.pubkey))}>{shortNpub(note.pubkey)}</span>
                              <span className="text-zinc-500 text-xs ml-auto">{formatTime(note.created_at)}</span>
                            </div>

                            <div className="mt-1 text-[15px] leading-snug">
                              {renderContent(note.content, applyTagFilter)}
                            </div>

                            <div className="flex gap-4 mt-3 text-xs">
                              <button
                                onClick={() => startDM(note.pubkey)}
                                className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200"
                              >
                                <MessageCircle className="w-3.5 h-3.5" /> DM
                              </button>
                              {!isMine && (
                                <button
                                  onClick={() => toggleFollow(note.pubkey)}
                                  className={`flex items-center gap-1.5 ${follows.includes(note.pubkey) ? 'text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'}`}
                                >
                                  <Users className="w-3.5 h-3.5" /> {follows.includes(note.pubkey) ? 'Following' : 'Follow'}
                                </button>
                              )}
                              <button
                                onClick={() => {
                                  // Quick reply: append @ + focus compose with context text
                                  const prefix = `@${shortNpub(note.pubkey)} `
                                  setComposeText((c) => (c ? c : prefix))
                                  setView('feed')
                                  window.scrollTo({ top: 120, behavior: 'smooth' })
                                }}
                                className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200"
                              >
                                <Reply className="w-3.5 h-3.5" /> Reply {replies.length > 0 && `(${replies.length})`}
                              </button>
                            </div>

                            {/* Inline replies (very lightweight) */}
                            {replies.length > 0 && (
                              <div className="mt-3 pl-4 border-l border-white/10 space-y-3">
                                {replies.slice(0, 3).map((r) => (
                                  <div key={r.id} className="text-sm flex gap-2">
                                    <div className="avatar w-6 h-6 mt-0.5">
                                      <img src={getAvatarUrl(r.pubkey, profiles[r.pubkey]?.picture)} alt="" />
                                    </div>
                                    <div className="flex-1">
                                      <span className="font-medium text-xs">{getDisplayName(r.pubkey)}</span>
                                      <span className="text-zinc-500 text-xs ml-2">{formatTime(r.created_at)}</span>
                                      <div className="text-zinc-300 mt-0.5">{renderContent(r.content, applyTagFilter)}</div>
                                    </div>
                                  </div>
                                ))}
                                {replies.length > 3 && <div className="text-[10px] text-zinc-500 pl-8">+{replies.length - 3} more replies</div>}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {displayNotes.length > 0 && (
                  <button onClick={loadOlder} className="mt-4 mx-auto block text-sm text-violet-400 hover:text-violet-300">
                    Load older posts
                  </button>
                )}
              </div>
            )}

            {/* MESSAGES / DMs */}
            {view === 'messages' && (
              <div className="flex gap-4">
                {/* Conversations list */}
                <div className="w-72 shrink-0 p2pbox-surface border p2pbox-border rounded-3xl p-2 h-fit sticky top-20">
                  <div className="px-3 py-2 flex items-center justify-between">
                    <div className="font-medium text-sm">Direct Messages</div>
                    <button onClick={() => setSelectedChat(null)} className="text-xs px-2 py-0.5 rounded bg-white/5">New</button>
                  </div>
                  {pk && (
                    <div className="px-3 pb-2 -mt-1 space-y-1">
                      <button
                        onClick={() => copy(fullNpub(pk), 'Your npub copied — send a DM to it from another client to test!')}
                        className="text-[10px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 w-full text-left"
                      >
                        Copy your npub to test DMs from other apps →
                      </button>
                      <button
                        onClick={startLocalTestChat}
                        className="text-[10px] px-2 py-0.5 rounded bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/30 w-full text-left text-violet-300"
                      >
                        Start local test chat (demo — no network)
                      </button>
                    </div>
                  )}

                  {conversations.length === 0 && (
                    <div className="text-xs text-zinc-400 px-3 py-4 leading-relaxed">
                      No messages yet.<br /><br />
                      <strong>To test real chat right now:</strong><br />
                      1. Copy your npub (click the pill at top or go to Profile tab)<br />
                      2. Go to <a href="https://primal.net" target="_blank" className="text-violet-400 underline">primal.net</a> or Damus mobile app<br />
                      3. Paste your npub and send yourself a DM<br />
                      4. Come back — it will appear here if the relays deliver it.
                    </div>
                  )}

                  {conversations.map((c) => {
                    const prof = profiles[c.pubkey]
                    const active = selectedChat === c.pubkey
                    return (
                      <div
                        key={c.pubkey}
                        onClick={() => setSelectedChat(c.pubkey)}
                        className={`px-3 py-2.5 rounded-2xl flex gap-3 cursor-pointer ${active ? 'bg-white/10' : 'hover:bg-white/5'}`}
                      >
                        <div className="avatar w-8 h-8 mt-0.5"><img src={getAvatarUrl(c.pubkey, prof?.picture)} alt="" /></div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium flex items-center gap-2">{getDisplayName(c.pubkey)}</div>
                          <div className="text-xs text-zinc-500 truncate">{c.preview || '…'}</div>
                        </div>
                      </div>
                    )
                  })}

                  {/* Start new chat */}
                  <div className="mt-3 px-2 pt-2 border-t border-white/10">
                    <div className="text-[10px] uppercase text-zinc-500 mb-1 px-1">Start chat with npub</div>
                    <div className="flex gap-2">
                      <input
                        value={newNpubInput}
                        onChange={(e) => setNewNpubInput(e.target.value)}
                        placeholder="npub1..."
                        className="flex-1 text-sm bg-black/40 border border-white/10 rounded-xl px-3 py-2 outline-none focus:border-violet-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const pub = parseNpubOrHex(newNpubInput)
                            if (pub) {
                              startDM(pub)
                              setNewNpubInput('')
                            } else showToast('Invalid npub or hex', 'error')
                          }
                        }}
                      />
                      <button onClick={() => {
                        const pub = parseNpubOrHex(newNpubInput)
                        if (pub) { startDM(pub); setNewNpubInput('') }
                        else showToast('Invalid npub', 'error')
                      }} className="px-3 rounded-xl bg-white/5 border border-white/10"><Plus className="w-4 h-4" /></button>
                    </div>
                  </div>
                </div>

                {/* Chat pane */}
                <div className="flex-1 min-w-0">
                  {!selectedChat ? (
                    <div className="p2pbox-surface border p2pbox-border rounded-3xl p-8 text-sm text-zinc-400">
                      Select a conversation from the left or paste an npub to start a private end-to-end encrypted chat.<br /><br />
                      <strong>Tip:</strong> Click any "DM" button on posts in the Feed tab to start chatting with that person.
                    </div>
                  ) : (
                    <div className="p2pbox-surface border p2pbox-border rounded-3xl flex flex-col h-[620px]">
                      {/* Chat header */}
                      <div className="px-4 py-3 border-b border-white/10 flex items-center gap-3">
                        <div className="avatar w-9 h-9 cursor-pointer" onClick={() => copy(fullNpub(selectedChat))}>
                          <img src={getAvatarUrl(selectedChat, selectedProfile?.picture)} alt="" />
                        </div>
                        <div className="flex-1">
                          <div className="font-medium">{getDisplayName(selectedChat)}</div>
                          <div className="npub text-[10px] cursor-pointer" onClick={() => copy(fullNpub(selectedChat))}>{fullNpub(selectedChat)}</div>
                        </div>
                        <button onClick={() => toggleFollow(selectedChat)} className="text-xs px-3 py-1 rounded-full border border-white/20 hover:bg-white/5">
                          {follows.includes(selectedChat) ? 'Unfollow' : 'Follow'}
                        </button>
                        <button onClick={() => setSelectedChat(null)}><X className="w-4 h-4" /></button>
                      </div>

                      {/* Messages */}
                      <div className="flex-1 overflow-auto p-4 space-y-3 text-sm" id="chat-scroll">
                        {currentChatMessages.length === 0 && (
                          <div className="text-xs text-center py-8 text-zinc-500">Encrypted chat between you two. Messages are only visible to participants.</div>
                        )}
                        {currentChatMessages.map((msg, idx) => (
                          <div key={idx} className={`flex ${msg.outgoing ? 'justify-end' : ''}`}>
                            <div className={`message-bubble ${msg.outgoing ? 'outgoing' : 'incoming'}`}>
                              {msg.content}
                              <div className="text-[10px] opacity-60 mt-1 text-right">{formatTime(msg.created_at)}</div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Input */}
                      <div className="p-3 border-t border-white/10 flex gap-2">
                        <input
                          value={dmText}
                          onChange={(e) => setDmText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDM() } }}
                          placeholder="Encrypted message…"
                          className="flex-1 bg-black/30 border border-white/10 rounded-2xl px-4 py-2.5 text-sm outline-none"
                        />
                        <button onClick={sendDM} disabled={!dmText.trim()} className="px-5 rounded-2xl bg-violet-600 disabled:bg-zinc-700 flex items-center"><Send className="w-4 h-4" /></button>
                      </div>
                      <div className="px-4 pb-3 text-[10px] text-zinc-500">End-to-end encrypted • NIP-04 • only you + recipient can read</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* RELAYS */}
            {view === 'relays' && (
              <div className="p2pbox-surface border p2pbox-border rounded-3xl p-6">
                <div className="font-semibold mb-1">Connected Relays</div>
                <div className="text-xs text-zinc-400 mb-4">Your posts and messages are broadcast to these relays. Add your own or friends' relays for stronger reach.</div>

                <div className="space-y-2 mb-5">
                  {relays.map((r, idx) => (
                    <div key={idx} className="flex items-center gap-3 bg-black/40 px-3 py-2 rounded-2xl border border-white/10">
                      <div className="relay-dot connected" />
                      <div className="mono flex-1 text-sm text-zinc-300">{r}</div>
                      <button onClick={() => removeRelay(r)} className="text-xs px-2 py-1 text-red-400 hover:bg-red-950 rounded">Remove</button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2">
                  <input
                    value={newRelay}
                    onChange={(e) => setNewRelay(e.target.value)}
                    placeholder="wss://my-relay.example.com"
                    className="flex-1 bg-black/30 border border-white/10 px-3 rounded-2xl text-sm py-2.5 outline-none"
                    onKeyDown={(e) => e.key === 'Enter' && addRelay()}
                  />
                  <button onClick={addRelay} className="px-5 rounded-2xl bg-white text-black font-medium">Add</button>
                </div>

                <button onClick={resetRelays} className="mt-4 text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
                  <RefreshCw className="w-3.5 h-3.5" /> Reset to defaults
                </button>
              </div>
            )}

            {/* PROFILE EDITOR */}
            {view === 'profile' && pk && (
              <div className="p2pbox-surface border p2pbox-border rounded-3xl p-6 max-w-xl">
                <div className="flex items-center gap-4 mb-6">
                  <div className="avatar w-14 h-14">
                    <img src={getAvatarUrl(pk, profileForm.picture || getProfilePicture(pk))} alt="" />
                  </div>
                  <div>
                    <div className="font-semibold text-lg">{profileForm.name || getDisplayName(pk)}</div>
                    <div className="npub">{npub}</div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <div className="text-xs mb-1 text-zinc-400">Display name</div>
                    <input value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2" />
                  </div>
                  <div>
                    <div className="text-xs mb-1 text-zinc-400">About</div>
                    <textarea value={profileForm.about} onChange={(e) => setProfileForm({ ...profileForm, about: e.target.value })} className="w-full h-20 bg-black/30 border border-white/10 rounded-xl px-3 py-2" />
                  </div>
                  <div>
                    <div className="text-xs mb-1 text-zinc-400">Avatar URL (https…)</div>
                    <input value={profileForm.picture} onChange={(e) => setProfileForm({ ...profileForm, picture: e.target.value })} className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2" placeholder="https://..." />
                  </div>
                </div>

                <button
                  onClick={() => publishProfile(profileForm.name, profileForm.about, profileForm.picture)}
                  className="mt-6 w-full py-3 rounded-2xl bg-violet-600 font-medium"
                >
                  Publish Profile to Relays
                </button>
                <div className="text-center text-xs mt-2 text-zinc-500">This creates a kind 0 event visible to everyone.</div>
              </div>
            )}
          </div>

          {/* Right context column */}
          <div className="w-72 shrink-0 hidden xl:block">
            <div className="p2pbox-surface border p2pbox-border rounded-3xl p-4 sticky top-20 text-sm">
              <div className="uppercase text-xs tracking-widest text-zinc-500 mb-2 px-1">NETWORK</div>
              <div className="text-xs text-zinc-400 leading-relaxed">
                P2PBOX is a pure client. All data lives on open Nostr relays. Your keys = your identity and your DMs stay private.
              </div>

              <div className="my-4 h-px bg-white/10" />

              <div className="text-xs mb-1 text-zinc-400">Current view</div>
              <div className="font-medium mb-3 capitalize">{view}</div>

              <button onClick={openMyProfile} className="w-full mb-2 flex justify-center items-center gap-2 text-sm py-2 border border-white/15 hover:bg-white/5 rounded-2xl">
                <User className="w-4 h-4" /> Edit my profile
              </button>
              <button onClick={() => { setView('relays') }} className="w-full text-sm py-2 border border-white/15 hover:bg-white/5 rounded-2xl">
                Manage relays
              </button>

              {tagFilter && (
                <button onClick={clearTagFilter} className="mt-3 w-full text-xs py-1.5 text-violet-400">Clear #{tagFilter} filter</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 space-y-2 z-[70]">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type === 'error' ? 'border-red-500/40' : t.type === 'success' ? 'border-emerald-500/40' : ''}`}>
            {t.type === 'success' && <Check className="w-4 h-4 text-emerald-400" />}
            {t.type === 'error' && <X className="w-4 h-4 text-red-400" />}
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export default P2PBOXApp
