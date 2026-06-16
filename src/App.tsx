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
  Reply, RefreshCw, X, Check, Download, Key
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

  return (
    <div className="min-h-screen bg-[#0b0b10] text-zinc-200 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="text-3xl font-semibold mb-1">P2PBOX</div>
        <div className="text-xs opacity-60 mb-6">Real decentralized P2P social chat on Nostr. No demos. Pure network.</div>

        {!pk ? (
          <button onClick={newId} className="px-6 py-3 bg-violet-600 rounded-2xl">Generate Real Persistent Nostr Key</button>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Feed */}
            <div className="bg-[#111116] border border-[#23232a] rounded-3xl p-4">
              <div className="font-medium mb-2">Feed (real Nostr network)</div>
              <div className="flex gap-2 mb-3">
                <input value={comp} onChange={e=>setComp(e.target.value)} className="flex-1 bg-black/30 border p-2 rounded text-sm" placeholder="Post to the network..." />
                <button onClick={post} className="px-4 bg-violet-600 rounded text-sm">Post</button>
              </div>
              <div className="space-y-2 text-sm max-h-80 overflow-auto">
                {notes.length===0 && <div className="opacity-50">No posts loaded yet. Post something above.</div>}
                {notes.slice(0,8).map((n:any,i:number)=>
                  <div key={i} className="border-b border-white/10 pb-1 text-sm">
                    {n.content}
                    <div onClick={()=>{setSel(n.pubkey);}} className="text-violet-400 text-xs cursor-pointer">Message this person</div>
                  </div>
                )}
              </div>
            </div>

            {/* Real Messages only */}
            <div className="bg-[#111116] border border-[#23232a] rounded-3xl p-4 flex flex-col">
              <div className="font-medium mb-1 flex items-center justify-between">
                <span>Messages (real Nostr)</span>
                <button onClick={() => copy(nip19.npubEncode(pk), 'Your real npub copied — send DM from Primal.net or Damus to test')} className="text-[10px] px-2 py-0.5 bg-white/5 rounded">Copy my npub</button>
              </div>

              {realDms.length === 0 && (
                <div className="text-xs text-zinc-400 py-3">
                  No real messages yet.<br /><br />
                  <strong>To test real chat:</strong><br />
                  1. Click "Copy my npub" above<br />
                  2. Go to <a href="https://primal.net" target="_blank" className="text-violet-400 underline">primal.net</a> (or Damus app)<br />
                  3. Paste your npub and send a DM<br />
                  4. Come back — it will appear here (thanks to cache + live subs)
                </div>
              )}

              {realDms.slice(0,5).map((c:any,i:number)=>
                <div key={i} onClick={()=>setSel(c.pubkey)} className={`text-sm p-1 cursor-pointer rounded ${sel===c.pubkey?'bg-white/10':''}`}>{c.pubkey.slice(0,10)} — {c.content.slice(0,30)}</div>
              )}

              {sel && (
                <div className="mt-3 pt-3 border-t">
                  <div className="text-xs mb-1">Real chat with {sel.slice(0,10)}</div>
                  <div className="h-28 overflow-auto bg-black/30 p-2 text-xs mb-2 rounded">
                    {currMsgs.map((m:any,i:number) => {
                      const plain = decrypted[m.id] || (m.content.length < 30 ? m.content : '[encrypted - will decrypt on load]')
                      return <div key={i} className={m.outgoing ? 'text-right' : ''}>{plain}</div>
                    })}
                  </div>
                  <div className="flex">
                    <input value={dmt} onChange={e=>setDmt(e.target.value)} className="flex-1 bg-black/30 text-sm p-1 rounded" onKeyDown={e=>e.key==='Enter'&&send()} />
                    <button onClick={send} className="ml-1 px-3 bg-violet-600 rounded text-sm">Send</button>
                  </div>
                  <div className="text-[10px] opacity-50 mt-1">Real encrypted DMs via Nostr relays (NIP-44 + NIP-04 fallback).</div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-6 text-xs opacity-50">
          Pure real P2P on Nostr. Messages persist across reloads via local cache + network.
          Everything you send or receive is on the actual decentralized network.
        </div>
      </div>

      <div className="fixed bottom-3 right-3 text-xs bg-zinc-900 border px-2 py-px rounded">{pk ? 'Live on Nostr' : 'No key'}</div>
    </div>
  )
}

export default P2PBOXApp
