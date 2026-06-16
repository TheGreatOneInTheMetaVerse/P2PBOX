// @ts-nocheck
import React, { useState, useEffect, useRef, useReducer, useMemo } from 'react'
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent,
  SimplePool,
  nip19,
  nip04,
  nip44,
} from 'nostr-tools'
import type { Filter } from 'nostr-tools'
import {
  Send, Plus, User, MessageCircle, Users, Globe, Settings, Copy, LogOut,
  Reply, RefreshCw, X, Check, Download, Key, Menu, X as Close
} from 'lucide-react'

// helpers (included for the minimal new-arch file)
const hexToBytes = (hex: string): Uint8Array => { const b = new Uint8Array(hex.length/2); for(let i=0;i<hex.length;i+=2) b[i/2]=parseInt(hex.substr(i,2),16); return b }
const bytesToHex = (b: Uint8Array): string => Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('')

// NEW ARCHITECTURE
type NostrEvent = any
interface EventCache { events: Map<string, NostrEvent>; byAuthor: Map<string, Set<string>>; byKind: Map<number, Set<string>> }
function createEventCache(): EventCache { return { events: new Map(), byAuthor: new Map(), byKind: new Map() } }
function addToCache(cache: EventCache, evt: NostrEvent) { if (cache.events.has(evt.id)) return false; cache.events.set(evt.id, evt); if (!cache.byAuthor.has(evt.pubkey)) cache.byAuthor.set(evt.pubkey, new Set()); cache.byAuthor.get(evt.pubkey)!.add(evt.id); if (!cache.byKind.has(evt.kind)) cache.byKind.set(evt.kind, new Set()); cache.byKind.get(evt.kind)!.add(evt.id); return true }
function loadCacheFromStorage(pubkey: string): EventCache { const c = createEventCache(); try { const r = localStorage.getItem(`p2pbox:cache:${pubkey}`); if (r) JSON.parse(r).forEach((e: any) => addToCache(c, e)) } catch {} return c }
function saveCacheToStorage(pubkey: string, c: EventCache) { try { const evs = Array.from(c.events.values()).sort((a,b)=>b.created_at-a.created_at).slice(0,400); localStorage.setItem(`p2pbox:cache:${pubkey}`, JSON.stringify(evs)) } catch {} }

class NostrService {
  private pool = new SimplePool(); private relays: string[]; private subs: any[] = []
  constructor(r: string[]) { this.relays = r }
  updateRelays(r: string[]) { this.relays = r; this.closeAll() }
  closeAll() { this.subs.forEach(s => { try { s.close() } catch {} }); this.subs = [] }
  async publish(evt: any) { try { const p = this.pool.publish(this.relays, evt); const r = await Promise.allSettled(p.map((x:any)=>Promise.race([x, new Promise((_,rej)=>setTimeout(()=>rej('t'),7000))]))); return r.some(x=>x.status==='fulfilled') } catch { return false } }
  subscribe(f: Filter[], cb: (e:any)=>void) { const s = this.pool.subscribeMany(this.relays, f as any, { onevent: cb }); this.subs.push(s); return s }
  async query(f: Filter[], lim=80) { try { return await this.pool.querySync(this.relays, [...f, {limit:lim}] as any) } catch { return [] } }
  async enc(sk: Uint8Array, r: string, c: string) { return nip44.encrypt(c, nip44.getConversationKey(sk, r)) }
  async dec(sk: Uint8Array, s: string, ct: string) { try { return nip44.decrypt(ct, nip44.getConversationKey(sk, s)) } catch { return nip04.decrypt(sk, s, ct) } }
}

type St = { key: {sk:Uint8Array|null;pk:string|null;nsec:string|null;npub:string|null}; cache: EventCache; relays: string[]; isDemoMode: boolean; connectedCount: number }
type Act = {type:'SET_KEY';payload:any} | {type:'ADD_EVENT';payload:any} | {type:'LOAD_CACHE';payload:EventCache} | {type:'CLEAR'}
function red(state: St, a: Act): St {
  switch(a.type){
    case 'SET_KEY': return {...state, key: a.payload}
    case 'ADD_EVENT': const ad = addToCache(state.cache, a.payload); if(ad && state.key.pk) saveCacheToStorage(state.key.pk, state.cache); return {...state}
    case 'LOAD_CACHE': return {...state, cache: a.payload}
    case 'CLEAR': return {key:{sk:null,pk:null,nsec:null,npub:null}, cache:createEventCache(), relays:state.relays, isDemoMode:false, connectedCount:0}
    default: return state
  }
}

const DEFAULT_RELAYS = ['wss://relay.damus.io','wss://nos.lol','wss://relay.nostr.band','wss://relay.primal.net','wss://nostr.wine']

const P2PBOXApp: React.FC = () => {
  const [st, dis] = useReducer(red, { key:{sk:null,pk:null,nsec:null,npub:null}, cache:createEventCache(), relays:DEFAULT_RELAYS, isDemoMode:false, connectedCount:DEFAULT_RELAYS.length })
  const svcRef = useRef<NostrService | null>(null)
  const getSvc = () => { if(!svcRef.current) svcRef.current = new NostrService(st.relays); return svcRef.current }

  const {key, cache} = st
  const sk = key.sk, pk = key.pk

  const evs = useMemo(()=>Array.from(cache.events.values()),[cache])
  const notes = useMemo(()=>evs.filter((e:any)=>e.kind===1).sort((a:any,b:any)=>b.created_at-a.created_at).slice(0,180),[evs])
  const realDms = useMemo(()=>{ if(!pk) return []; return evs.filter((e:any)=>e.kind===4).map((e:any)=>{ const out=e.pubkey===pk; const p=e.tags?.find((t:any)=>t[0]==='p')?.[1]||''; return {id:e.id,pubkey:out?p:e.pubkey,created_at:e.created_at,content:e.content,outgoing:out,raw:e} }).sort((a:any,b:any)=>a.created_at-b.created_at) },[evs,pk])

  const [sel, setSel] = useState<string|null>(null)
  const [comp, setComp] = useState('')
  const [dmt, setDmt] = useState('')
  const [tsts, setTsts] = useState<any[]>([])

  const toast = (m:string) => { const id=Date.now(); setTsts(p=>[...p,{id,m}]); setTimeout(()=>setTsts(p=>p.filter(x=>x.id!==id)),2800) }

  const setKey = (skb:Uint8Array, p:string) => {
    dis({type:'SET_KEY', payload:{sk:skb, pk:p, nsec:nip19.nsecEncode(skb), npub:nip19.npubEncode(p)}})
    dis({type:'LOAD_CACHE', payload: loadCacheFromStorage(p) })
    const svc = getSvc(); svc.updateRelays(st.relays)
    svc.subscribe([ {kinds:[1],limit:120,since:Math.floor(Date.now()/1000)-60*60*48}, {kinds:[4],'#p':[p],since:Math.floor(Date.now()/1000)-60*60*24*7}, {kinds:[4],authors:[p],since:Math.floor(Date.now()/1000)-60*60*24*7} ], (e:any)=>{ if(verifyEvent(e)) dis({type:'ADD_EVENT',payload:e}) })
    svc.query([{kinds:[4],'#p':[p]},{kinds:[4],authors:[p]}],100).then(es=>es.forEach(e=>{if(verifyEvent(e)) dis({type:'ADD_EVENT',payload:e})}))
  }

  const pubNote = async (c:string) => { if(!sk||!key.pk) return; const e=finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),tags:[],content:c},sk); const ok=await getSvc().publish(e); if(ok) dis({type:'ADD_EVENT',payload:e}); return ok }
  const sendNetDM = async (to:string, txt:string) => { if(!sk||!key.pk) return false; const ct = await getSvc().enc(sk,to,txt); const e=finalizeEvent({kind:4,created_at:Math.floor(Date.now()/1000),tags:[['p',to]],content:ct},sk); const ok=await getSvc().publish(e); if(ok) dis({type:'ADD_EVENT',payload:e}); return ok }

  useEffect(() => {
    const s = localStorage.getItem('p2pbox:sk')
    if (s && !pk) { try { const b = hexToBytes(s); setKey(b, getPublicKey(b)) } catch {} }
  }, [pk])

  const newId = () => { const s=generateSecretKey(); setKey(s,getPublicKey(s)); setSel(null) }
  const logOut = () => { getSvc().closeAll(); localStorage.removeItem('p2pbox:sk'); dis({type:'CLEAR'} as any); setSel(null) }

  const send = async () => {
    const t = dmt.trim(); if(!t || !sel || !key.pk) return
    const ok = await sendNetDM(sel, t)
    if(ok){ setDmt(''); toast('Sent on real Nostr') }
  }

  const post = () => { if(comp.trim()) pubNote(comp.trim()).then(()=>setComp('')) }

  const currMsgs = realDms.filter((d:any)=>d.pubkey===sel)

  // Simple decryption for display in real chat (runs on render for small lists)
  const [decrypted, setDecrypted] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!pk || !sk || !sel) return
    const toDecrypt = currMsgs.filter((m:any) => !decrypted[m.id] && m.content && m.content.length > 20)
    if (toDecrypt.length === 0) return

    ;(async () => {
      const updates: any = {}
      for (const m of toDecrypt) {
        try {
          const other = m.outgoing ? sel : m.pubkey
          const plain = await getSvc().dec(sk, other, m.content)
          updates[m.id] = plain
        } catch {
          updates[m.id] = '[encrypted]'
        }
      }
      if (Object.keys(updates).length) setDecrypted(prev => ({...prev, ...updates}))
    })()
  }, [currMsgs, sel, pk, sk, decrypted])

  // Professional modern UI/UX (inspired by UI-UX Pro Max principles)
  // - Clean minimal + Dark OLED for social/chat
  // - Strong hierarchy, generous whitespace, micro-interactions
  // - Proper chat experience (bubbles, composer, scroll)
  // - Responsive (sidebar collapses on mobile)
  // - Real network only — no fakes

  const [mobileOpen, setMobileOpen] = useState(false)

  const copyMyNpub = () => {
    if (!pk) return
    const np = nip19.npubEncode(pk)
    navigator.clipboard.writeText(np).then(() => toast('npub copied — use Primal.net or Damus to send a real test DM'))
  }

  const doPost = () => {
    const txt = comp.trim()
    if (!txt) return
    pubNote(txt).then(ok => {
      if (ok) { setComp(''); toast('Posted to the live Nostr network') }
    })
  }

  const doSend = async () => {
    const txt = dmt.trim()
    if (!txt || !sel) return
    const ok = await sendNetDM(sel, txt)
    if (ok) { setDmt(''); toast('Sent on real Nostr (encrypted)') }
  }

  // Message bubble renderer
  const renderBubble = (m: any, idx: number) => {
    const isMe = m.outgoing
    const text = decrypted[m.id] || m.content
    const time = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    return (
      <div key={idx} className={`flex ${isMe ? 'justify-end' : 'justify-start'} mb-1.5`}>
        <div className={`max-w-[82%] px-4 py-[9px] text-[14.5px] leading-tight rounded-3xl ${isMe 
            ? 'bg-violet-600 text-white rounded-br-xl' 
            : 'bg-zinc-800 border border-zinc-700 rounded-bl-xl'}`}>
          <div className="whitespace-pre-wrap break-words">{text}</div>
          <div className={`text-right text-[10px] mt-1 tracking-tight ${isMe ? 'text-violet-200/70' : 'text-zinc-500'}`}>{time}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-200">
      {/* Refined top bar */}
      <div className="sticky top-0 z-50 bg-[#0a0a0f]/95 backdrop-blur border-b border-white/10">
        <div className="max-w-screen-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                <Globe className="w-4.5 h-4.5 text-white" />
              </div>
              <div className="font-semibold text-xl tracking-[-0.3px]">P2PBOX</div>
            </div>
            <div className="text-[10px] px-2 py-px bg-emerald-500/10 text-emerald-400 border border-emerald-900/30 rounded">LIVE ON NOSTR</div>
          </div>

          {pk && (
            <div className="flex items-center gap-2 text-sm">
              <button onClick={copyMyNpub} className="flex items-center gap-2 px-3.5 py-1.5 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs transition active:scale-[0.985]">
                <Copy className="w-3.5 h-3.5" /> <span className="font-mono hidden sm:inline">{npub?.slice(5,13)}…</span><span className="sm:hidden">Copy npub</span>
              </button>
              <button onClick={logOut} className="px-3 py-1.5 rounded-2xl border border-white/10 hover:bg-white/5 flex items-center gap-1.5 text-sm">
                <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Log out</span>
              </button>
              <button onClick={() => setMobileOpen(!mobileOpen)} className="md:hidden p-2 rounded-xl bg-white/5"><Menu className="w-5 h-5" /></button>
            </div>
          )}
        </div>
      </div>

      {!pk ? (
        /* Clean professional onboarding */
        <div className="flex-1 flex items-center justify-center px-6 pt-10">
          <div className="max-w-md text-center">
            <div className="mx-auto mb-8 w-20 h-20 rounded-3xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-xl shadow-violet-500/20">
              <Globe className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-6xl font-semibold tracking-[-1.8px] mb-3">P2PBOX</h1>
            <p className="text-2xl text-zinc-400 leading-none mb-9 tracking-tight">Own your voice.<br />Chat freely on the open network.</p>
            <button onClick={newId} className="mx-auto flex items-center justify-center gap-3 bg-white active:bg-zinc-100 text-black font-semibold text-lg px-9 py-4 rounded-3xl w-full max-w-[280px] shadow-2xl">Generate Real Identity</button>
            <p className="text-xs text-zinc-500 mt-4">Your key never leaves this device. Export it right away.</p>
          </div>
        </div>
      ) : (
        <div className="max-w-screen-2xl mx-auto flex">
          {/* Sidebar */}
          <div className={`${mobileOpen ? 'flex' : 'hidden'} md:flex w-60 flex-col border-r border-white/10 bg-[#0a0a0f] p-2 shrink-0 h-[calc(100vh-56px)] overflow-auto`}>
            <div className="px-3 py-2 text-xs tracking-widest text-zinc-500">MENU</div>
            {[
              { label: 'Global Feed', view: 'feed', icon: Globe },
              { label: 'Messages', view: 'messages', icon: MessageCircle },
              { label: 'Relays', view: 'relays', icon: Settings },
              { label: 'Profile', view: 'profile', icon: User },
            ].map(item => (
              <button key={item.view} onClick={() => { setView(item.view as any); setMobileOpen(false) }} 
                className={`flex items-center gap-3 px-3 py-2 rounded-2xl mb-px text-sm ${view === item.view ? 'bg-white/10 font-medium' : 'hover:bg-white/5'}`}>
                <item.icon className="w-4 h-4" /> {item.label}
              </button>
            ))}

            <div className="mt-auto px-3 pt-8 text-xs text-zinc-500 border-t border-white/10">Real. Decentralized. Yours.</div>
          </div>

          {/* Main area */}
          <div className="flex-1 min-w-0">
            {/* Feed */}
            {view === 'feed' && (
              <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-5">
                <div className="bg-[#111116] border border-white/10 rounded-3xl p-5">
                  <textarea value={comp} onChange={e=>setComp(e.target.value)} placeholder="What’s on your mind?" className="w-full bg-transparent text-[15px] placeholder:text-zinc-500 min-h-[78px] resize-y focus:outline-none" onKeyDown={e => (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) && handlePost()} />
                  <div className="flex justify-end border-t border-white/10 pt-3">
                    <button onClick={handlePost} disabled={!comp.trim()} className="px-6 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 rounded-2xl text-sm font-medium flex items-center gap-2 active:scale-[0.985]">Post to Nostr <Send className="w-4 h-4" /></button>
                  </div>
                </div>

                <div className="space-y-3">
                  {notes.length === 0 && <div className="text-center py-10 text-zinc-400 text-sm">No posts yet from the network.<br />Post something real above.</div>}
                  {notes.map((n:any,i:number) => (
                    <div key={i} className="bg-[#111116] border border-white/10 rounded-3xl p-5 hover:border-white/20">
                      <div className="flex gap-3 mb-3 items-center text-sm">
                        <img src={getAvatarUrl(n.pubkey)} className="w-7 h-7 rounded-full" />
                        <div className="font-medium">{getDisplayName(n.pubkey)}</div>
                        <div className="font-mono text-xs text-zinc-500">{shortNpub(n.pubkey)}</div>
                        <div className="flex-1 text-right text-xs text-zinc-500">{formatDistanceToNowStrict(new Date(n.created_at*1000), {addSuffix:true})}</div>
                      </div>
                      <div className="text-[15px] leading-relaxed whitespace-pre-wrap mb-4">{n.content}</div>
                      <button onClick={() => { setSel(n.pubkey); setView('messages') }} className="text-violet-400 text-sm hover:underline">Message this person</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Messages - excellent chat UX */}
            {view === 'messages' && (
              <div className="max-w-3xl mx-auto h-[calc(100vh-8rem)] md:h-[calc(100vh-7rem)] flex flex-col bg-[#111116] border border-white/10 rounded-3xl overflow-hidden m-3 md:m-6">
                {!sel ? (
                  <div className="flex-1 flex items-center justify-center p-8 text-center">
                    <div>
                      <div className="text-xl font-semibold mb-2">Start a real conversation</div>
                      <div className="text-sm text-zinc-400 max-w-[260px] mx-auto mb-5">All messages are end-to-end encrypted on the actual Nostr network.</div>
                      <button onClick={copyNpub} className="px-6 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-2xl font-medium text-sm inline-flex items-center gap-2 active:bg-violet-700">
                        <Copy className="w-4 h-4" /> Copy my npub
                      </button>
                      <div className="text-xs text-zinc-500 mt-3">Paste it into Primal.net or Damus and send yourself a message.</div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="px-5 py-3 border-b border-white/10 flex items-center gap-3 bg-black/20">
                      <img src={getAvatarUrl(sel)} className="w-9 h-9 rounded-full ring-1 ring-white/10" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{getDisplayName(sel)}</div>
                        <div className="text-xs font-mono text-zinc-500 truncate">{nip19.npubEncode(sel)}</div>
                      </div>
                      <button onClick={() => setSel(null)} className="text-xs px-3 py-1 border border-white/10 hover:bg-white/5 rounded-2xl">Close</button>
                    </div>

                    <div className="flex-1 p-4 overflow-y-auto space-y-px bg-[#0c0c11]" style={{scrollbarWidth: 'thin'}}>
                      {currMsgs.length === 0 && <div className="text-sm text-zinc-500 text-center py-12">No messages yet. Send the first real encrypted message.</div>}
                      {currMsgs.map((m:any, i:number) => renderBubble(m, i))}
                    </div>

                    <div className="p-3 border-t border-white/10 bg-[#111116]">
                      <div className="flex gap-2">
                        <input 
                          value={dmt} onChange={e=>setDmt(e.target.value)} 
                          className="flex-1 bg-zinc-900 border border-white/10 focus:border-white/30 px-4 py-3 rounded-3xl text-sm placeholder:text-zinc-500" 
                          placeholder="Encrypted message..." 
                          onKeyDown={e => e.key==='Enter' && !e.shiftKey && doSend()} 
                        />
                        <button onClick={doSend} disabled={!dmt.trim()} className="px-6 rounded-3xl bg-violet-600 flex items-center disabled:bg-zinc-800"><Send className="w-4 h-4" /></button>
                      </div>
                      <div className="text-[10px] text-center text-zinc-500 mt-1.5">End-to-end encrypted on the Nostr network</div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Relays & Profile */}
            {(view === 'relays' || view === 'profile') && (
              <div className="max-w-xl mx-auto mt-6 p-6 bg-[#111116] border border-white/10 rounded-3xl">
                {view === 'relays' && (
                  <>
                    <div className="font-medium mb-3">Your relays</div>
                    {relays.map((r,i) => <div key={i} className="text-xs font-mono bg-black/40 p-2.5 rounded-2xl mb-1">{r}</div>)}
                  </>
                )}
                {view === 'profile' && (
                  <>
                    <div className="font-medium mb-3">Your sovereign identity</div>
                    <div className="font-mono text-sm break-all bg-black/30 p-4 rounded-2xl mb-4 select-all">{npub}</div>
                    <button onClick={copyNpub} className="px-4 py-2 text-sm border border-white/10 rounded-2xl hover:bg-white/5">Copy full npub</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 space-y-2 z-[70]">
        {tsts.map((t:any) => <div key={t.id} className="px-4 py-2 bg-zinc-900 border border-white/10 rounded-2xl text-sm shadow">{t.m}</div>)}
      </div>
    </div>
  )
}

export default P2PBOXApp
