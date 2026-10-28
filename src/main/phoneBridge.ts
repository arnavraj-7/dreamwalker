// PHONE BRIDGE: drive Dreamwalker from your phone, over the internet, with no ADB and no same network.
// A tiny HTTP server INSIDE the app. The phone reaches it through a Cloudflare tunnel:
//   cloudflared tunnel --url http://localhost:8787
// then opens the printed https URL and pastes the token (shown in the app's Phone page / console).
//
// It touches no other module: it takes callbacks. `onCommand(text)` is wired to link.sayText — so a
// phone command is just another user text turn, and the agent runs it through the SAME gatekeeper,
// ledger and tools as the voice. Progress is the same event stream the UI already gets; `offerFile`
// hands a file the agent just wrote (a .pptx say) to the phone to download over the same tunnel.
//
// Transport: SSE (laptop -> phone push) + POST (phone -> laptop). No WebSocket lib, no build, no APK.
// ponytail: single paired phone, in-memory file cache, token in query. Confirm-on-phone is the next
// safety step before dangerous actions run remotely (see onCommand note in index.ts wiring).

import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'

export interface PhoneBridge {
  /** Push any event to the phone. Feed it the same stream the UI gets (agent state, tool activity). */
  emit(event: { type: string; [k: string]: unknown }): void
  /** Make a file the agent just saved downloadable on the phone (reads it from disk once). */
  offerFile(absPath: string): Promise<void>
  /** Ask the phone to approve a risky action. Resolves true/false; false on timeout (deny when in doubt). */
  askConfirm(summary: string, risk: string, timeoutMs?: number): Promise<boolean>
  /** Stream a chunk of Orbi's voice to the phone (24 kHz Int16 PCM, as the speaker gets it). */
  sendAudio(pcm: Uint8Array): void
  /** Tell the phone to stop playing now (an interruption). */
  stopAudio(): void
  /** True while a phone command is in flight — so the caller routes created files and confirms back to it. */
  commandActive: boolean
  token: string
  stop(): void
}

const MIME: Record<string, string> = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
}

export function startPhoneBridge(opts: {
  onCommand: (text: string) => void
  onContacts?: (list: { name: string; number: string }[]) => void
  port?: number
  token?: string
}): PhoneBridge {
  const port = opts.port ?? Number(process.env.DW_PORT || 8787)
  const token = opts.token || process.env.DW_TOKEN || randomBytes(16).toString('hex')

  const clients = new Set<import('node:http').ServerResponse>()
  const files = new Map<string, { name: string; mime: string; buf: Buffer }>()
  const confirms = new Map<string, (approved: boolean) => void>() // open phone confirmations, by id

  const push = (obj: unknown): void => {
    const line = `data: ${JSON.stringify(obj)}\n\n`
    for (const res of clients) res.write(line)
  }

  const tokenOk = (given: unknown): boolean => {
    if (typeof given !== 'string' || given.length !== token.length) return false
    try {
      return timingSafeEqual(Buffer.from(given), Buffer.from(token))
    } catch {
      return false
    }
  }

  const bridge: PhoneBridge = {
    token,
    commandActive: false,
    emit: (event) => push(event),
    async offerFile(absPath) {
      const buf = await fs.readFile(absPath)
      const name = basename(absPath)
      const id = randomBytes(8).toString('hex')
      files.set(id, { name, mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream', buf })
      setTimeout(() => files.delete(id), 10 * 60_000).unref()
      push({ type: 'file-ready', name, url: `/dl/${id}?token=${token}` })
    },
    askConfirm(summary, risk, timeoutMs = 60_000) {
      const id = randomBytes(6).toString('hex')
      return new Promise<boolean>((resolve) => {
        const settle = (approved: boolean): void => {
          if (!confirms.delete(id)) return // already answered (reply raced the timeout)
          clearTimeout(timer)
          push({ type: 'confirm-close', id })
          resolve(approved)
        }
        const timer = setTimeout(() => settle(false), timeoutMs)
        timer.unref()
        confirms.set(id, settle)
        push({ type: 'confirm', id, summary, risk })
      })
    },
    sendAudio: (pcm) => push({ type: 'audio', b64: Buffer.from(pcm).toString('base64') }),
    stopAudio: () => push({ type: 'audio-stop' }),
    stop: () => server.close()
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const given = url.searchParams.get('token') ?? req.headers['x-token']

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(CLIENT_HTML)
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('ok')
    }
    // PWA bits — must load before the token gate so the phone can install the app.
    if (url.pathname === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' })
      return res.end(MANIFEST)
    }
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end(SERVICE_WORKER)
    }
    if (url.pathname === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' })
      return res.end(ICON_SVG)
    }
    if (!tokenOk(given)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      return res.end('bad token')
    }

    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('retry: 2000\n\n')
      res.write(`data: ${JSON.stringify({ type: 'event', msg: 'connected to laptop ✓' })}\n\n`)
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let text = ''
        try {
          text = String((JSON.parse(body) as { text?: unknown }).text ?? '')
        } catch {
          /* ignore malformed body */
        }
        if (text.trim()) {
          bridge.commandActive = true
          opts.onCommand(text.trim())
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }

    if (url.pathname === '/confirm-reply' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const { id, approve } = JSON.parse(body) as { id?: unknown; approve?: unknown }
          confirms.get(String(id))?.(approve === true)
        } catch {
          /* ignore malformed body */
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }

    if (url.pathname === '/contacts' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let count = 0
        try {
          const raw = (JSON.parse(body) as { contacts?: unknown }).contacts
          if (Array.isArray(raw)) {
            // The Contact Picker gives {name:[...], tel:[...]} (arrays); accept that or {name, number}.
            const list = raw
              .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
              .flatMap((c) => {
                const nameRaw = Array.isArray(c.name) ? c.name[0] : c.name
                const name = typeof nameRaw === 'string' ? nameRaw.slice(0, 80) : ''
                const tels = Array.isArray(c.tel) ? c.tel : [c.tel ?? c.number]
                return tels
                  .filter((t): t is string => typeof t === 'string')
                  .map((t) => ({ name, number: t.slice(0, 40) }))
              })
              .filter((c) => c.name && c.number)
              .slice(0, 2000)
            count = list.length
            opts.onContacts?.(list)
          }
        } catch {
          /* ignore malformed body */
        }
        push({ type: 'event', msg: `shared ${count} contact${count === 1 ? '' : 's'} with the laptop (kept on your devices)` })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, count }))
      })
      return
    }

    if (url.pathname.startsWith('/dl/')) {
      const f = files.get(url.pathname.slice(4))
      if (!f) {
        res.writeHead(404)
        return res.end('gone')
      }
      res.writeHead(200, { 'content-type': f.mime, 'content-disposition': `attachment; filename="${f.name}"` })
      return res.end(f.buf)
    }

    res.writeHead(404)
    res.end('not found')
  })

  server.listen(port, () => {
    console.log(`[phone] bridge on http://localhost:${port}  token: ${token}`)
    console.log(`[phone] expose it:  cloudflared tunnel --url http://localhost:${port}`)
  })

  return bridge
}

// The phone web client (served from "/"). Add to Home Screen = behaves like a native app.
const CLIENT_HTML = /* html */ `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0d12">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/icon.svg">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Dreamwalker Remote</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#0b0d12;color:#e7ecf3;display:flex;flex-direction:column;height:100dvh}
header{padding:14px 16px;border-bottom:1px solid #1d2230;display:flex;align-items:center;gap:10px}
#dot{width:9px;height:9px;border-radius:50%;background:#64748b}
#dot.on{background:#34d399;box-shadow:0 0 8px #34d399}
#log{flex:1;overflow:auto;padding:12px 16px;font-size:14px}
.row{padding:6px 0;border-bottom:1px solid #141925;white-space:pre-wrap;word-break:break-word}
.row a{color:#7dd3fc;font-weight:600}
form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #1d2230}
input{flex:1;background:#121724;border:1px solid #273043;color:#e7ecf3;border-radius:10px;padding:12px}
button{background:#3b82f6;border:0;color:#fff;border-radius:10px;padding:12px 16px;font-weight:600}
#mic{background:#273043;font-size:18px;padding:12px 14px}#mic.on{background:#ef4444}
.gate{padding:24px 16px;display:flex;flex-direction:column;gap:12px}small{color:#8893a7}
#orbiwrap{display:flex;flex-direction:column;align-items:center;gap:6px;padding:18px 0 6px;border-bottom:1px solid #1d2230}
#label{color:#8893a7;font-size:13px;min-height:16px}
</style></head><body>
<header><span id="dot"></span><b>Dreamwalker Remote</b></header>
<div id="orbiwrap" hidden><canvas id="orbi" width="180" height="180" style="width:150px;height:150px"></canvas><div id="label"></div><button type="button" id="addc" style="margin-top:6px;font-size:12px;padding:6px 12px;background:#273043">Share contacts</button></div>
<div id="gate" class="gate">
  <div>Paste the token shown on your laptop:</div>
  <input id="tok" placeholder="token" autocomplete="off">
  <button id="pair">Connect</button>
  <small>The laptop must be running Dreamwalker, exposed via Cloudflare tunnel.</small>
</div>
<div id="log" hidden></div>
<form id="f" hidden><input id="cmd" placeholder="tell the laptop…" autocomplete="off"><button type="button" id="mic" title="speak">\u{1F3A4}</button><button>Send</button></form>
<script>
const $=(id)=>document.getElementById(id),log=$("log"),dot=$("dot")
const add=(h)=>{const d=document.createElement("div");d.className="row";d.innerHTML=h;log.appendChild(d);log.scrollTop=log.scrollHeight}
const esc=(s)=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
let token=localStorage.getItem("dw.token")||""
function connect(){const es=new EventSource("/events?token="+encodeURIComponent(token))
  es.onopen=()=>dot.classList.add("on");es.onerror=()=>dot.classList.remove("on")
  es.onmessage=(e)=>{const m=JSON.parse(e.data)
    if(m.type==="presence"){applyPresence(m.presence);return}
    if(m.type==="audio"){ensureAudio();playChunk(m.b64);return}
    if(m.type==="audio-stop"){stopAudio();return}
    if(m.type==="file-ready"){add('\u{1F4CE} <a href="'+m.url+'" download>'+esc(m.name)+'</a>');return}
    if(m.type==="confirm"){askConfirm(m);return}
    if(m.type==="confirm-close"){const el=document.getElementById("c_"+m.id);if(el&&!el.dataset.answered)el.textContent="⌛ expired";return}
    add(esc(m.msg||JSON.stringify(m)))}}
function askConfirm(m){
  const d=document.createElement("div");d.className="row";d.id="c_"+m.id
  const q=document.createElement("div");q.innerHTML="⚠️ <b>Approve?</b> "+esc(m.summary)+" <small>("+esc(m.risk||"")+")</small>"
  const yes=document.createElement("button");yes.textContent="Approve"
  const no=document.createElement("button");no.textContent="Deny";no.style.background="#64748b";no.style.marginLeft="8px"
  const reply=(a)=>{d.dataset.answered="1";fetch("/confirm-reply?token="+encodeURIComponent(token),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:m.id,approve:a})}).catch(()=>{});d.textContent=(a?"✓ approved: ":"✕ denied: ")+m.summary}
  yes.onclick=()=>reply(true);no.onclick=()=>reply(false)
  d.appendChild(q);d.appendChild(yes);d.appendChild(no);log.appendChild(d);log.scrollTop=log.scrollHeight}
function start(){$("gate").hidden=true;$("orbiwrap").hidden=false;log.hidden=false;$("f").hidden=false;ensureAudio();connect();startOrbi()}

// Portable Orbi: the companion's face, same palette as the desktop (drawFace.ts PALETTES), driven by
// the live presence the laptop forwards. A compact orb, not the full 480-line renderer, but the same
// colours and the same state language.
const PAL={graphite:{acc:"#7FD3E6",att:"#F2B54A",err:"#F0705A",ink:"#E6E8EB",bg:"#0E1013",body:"#121519",dim:"#3a4049"},
          ember:{acc:"#74D9B2",att:"#F4B860",err:"#F0715A",ink:"#EFEAE2",bg:"#15130F",body:"#1B1814",dim:"#3a352c"}}
let orbi={face:"idle",caution:false,theme:"graphite"}
function applyPresence(p){orbi.face=p.face;orbi.caution=p.caution;orbi.theme=PAL[p.theme]?p.theme:"graphite"
  $("label").textContent=p.label||"";document.body.style.background=PAL[orbi.theme].bg}
const rgba=(hex,a)=>{const n=parseInt(hex.slice(1),16);return"rgba("+((n>>16)&255)+","+((n>>8)&255)+","+(n&255)+","+a+")"}
function startOrbi(){const cv=$("orbi"),x=cv.getContext("2d"),w=cv.width,h=cv.height
  const dim=s=>s==="offline"||s==="reconnecting"||s==="paused"
  function frame(t){const P=PAL[orbi.theme],s=orbi.face
    const col=s==="confirm"?P.att:s==="danger"?P.err:dim(s)?P.dim:P.acc
    const active=s==="listening"||s==="thinking"||s==="speaking"||s==="acting"
    x.clearRect(0,0,w,h);const cx=w/2,cy=h/2,br=1+0.03*Math.sin(t/700),r=52*br*(active?1.05:1)
    let g=x.createRadialGradient(cx,cy,r*0.2,cx,cy,r*2.3);g.addColorStop(0,rgba(col,0.38));g.addColorStop(1,rgba(col,0))
    x.fillStyle=g;x.beginPath();x.arc(cx,cy,r*2.3,0,7);x.fill()
    x.fillStyle=P.body;x.strokeStyle=rgba(col,0.95);x.lineWidth=2.5;x.beginPath();x.arc(cx,cy,r,0,7);x.fill();x.stroke()
    if(s==="thinking"||s==="acting"){const a=(t/380)%(Math.PI*2);x.strokeStyle=rgba(col,0.85);x.lineWidth=3;x.beginPath();x.arc(cx,cy,r+9,a,a+1.6);x.stroke()}
    const blink=Math.sin(t/1500)>0.98?0.12:1,ex=16,ey=cy-6,eh=13*blink
    x.fillStyle=P.ink
    x.beginPath();x.ellipse(cx-ex,ey,7,eh,0,0,7);x.fill();x.beginPath();x.ellipse(cx+ex,ey,7,eh,0,0,7);x.fill()
    if(s==="speaking"){const m=0.5+0.5*Math.abs(Math.sin(t/110));x.strokeStyle=P.ink;x.lineWidth=3;x.beginPath();x.moveTo(cx-13,cy+18);x.quadraticCurveTo(cx,cy+18+12*m,cx+13,cy+18);x.stroke()}
    if(orbi.caution){x.strokeStyle=P.att;x.setLineDash([6,5]);x.lineWidth=2;x.beginPath();x.arc(cx,cy,r+16,0,7);x.stroke();x.setLineDash([])}
    requestAnimationFrame(frame)}
  requestAnimationFrame(frame)}
$("pair").onclick=()=>{token=$("tok").value.trim();if(!token)return;localStorage.setItem("dw.token",token);start()}
// Orbi's voice on the phone: 24 kHz Int16 PCM chunks streamed from the laptop, scheduled back to
// back on the Web Audio clock (ported from renderer/audio/mouth.ts) so there are no gaps or clicks.
let actx=null,phead=0;const liveSrc=new Set()
function ensureAudio(){try{if(!actx)actx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000})
  if(actx.state==="suspended")actx.resume()}catch(e){actx=null}}
function playChunk(b64){if(!actx)return
  const bin=atob(b64),n=bin.length,bytes=new Uint8Array(n);for(let i=0;i<n;i++)bytes[i]=bin.charCodeAt(i)
  const even=n-(n%2);if(even<2)return;const samples=new Int16Array(bytes.buffer.slice(0,even));if(!samples.length)return
  const buf=actx.createBuffer(1,samples.length,24000),ch=buf.getChannelData(0)
  for(let i=0;i<samples.length;i++)ch[i]=samples[i]/32768
  const src=actx.createBufferSource();src.buffer=buf;src.connect(actx.destination)
  const now=actx.currentTime;if(phead<now)phead=now+0.08;src.start(phead);phead+=buf.duration
  liveSrc.add(src);src.onended=()=>liveSrc.delete(src)}
function stopAudio(){for(const s of liveSrc){try{s.onended=null;s.stop()}catch(e){}}liveSrc.clear();phead=0}
function sendCmd(t){t=t.trim();if(!t)return;ensureAudio();add("› "+esc(t))
  fetch("/command?token="+encodeURIComponent(token),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:t})}).catch(()=>add("(send failed — laptop offline?)"))}
$("f").onsubmit=(e)=>{e.preventDefault();sendCmd($("cmd").value);$("cmd").value=""}
// Voice input via the browser's Web Speech API (Chrome/Android, iOS 16.4+). HTTPS tunnel = required, mic prompt on first use.
const SR=window.SpeechRecognition||window.webkitSpeechRecognition
if(SR){const mic=$("mic");let rec,listening=false
  mic.onclick=()=>{ensureAudio();if(listening){rec&&rec.stop();return}
    rec=new SR();rec.lang="en-US";rec.interimResults=true
    rec.onstart=()=>{listening=true;mic.classList.add("on")}
    rec.onend=()=>{listening=false;mic.classList.remove("on")}
    rec.onerror=()=>{listening=false;mic.classList.remove("on")}
    rec.onresult=(e)=>{let s="";for(const r of e.results)s+=r[0].transcript;$("cmd").value=s
      if(e.results[e.results.length-1].isFinal){rec.stop();sendCmd(s);$("cmd").value=""}}
    rec.start()}
}else{$("mic").hidden=true}
// Share contacts via the Contact Picker API (Chrome/Android). You pick who Orbi may call; only the
// picked ones are sent, to YOUR laptop over the tunnel. Numbers never reach the AI.
const picker=navigator.contacts
if(picker&&picker.select){$("addc").onclick=async()=>{
  try{const cs=await picker.select(["name","tel"],{multiple:true});if(!cs.length)return
    await fetch("/contacts?token="+encodeURIComponent(token),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({contacts:cs})})
  }catch(e){add("(couldn't read contacts)")}}
}else{$("addc").hidden=true}
if(token)start()
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{})
</script></body></html>`

const MANIFEST = JSON.stringify({
  name: 'Dreamwalker Remote',
  short_name: 'Dreamwalker',
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0d12',
  theme_color: '#0b0d12',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
})

// Minimal SW: makes the app installable and serves the shell when offline. Never touches /events,
// /command or /dl — those must hit the laptop live.
const SERVICE_WORKER = /* js */ `const C='dw-v1'
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.add('/')));self.skipWaiting()})
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()))
self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>caches.match('/')))})`

const ICON_SVG = /* svg */ `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#0b0d12"/>
<circle cx="256" cy="256" r="150" fill="#3b82f6"/>
<circle cx="256" cy="256" r="196" fill="none" stroke="#7dd3fc" stroke-width="10" opacity="0.5"/>
<circle cx="256" cy="256" r="150" fill="none" stroke="#7dd3fc" stroke-width="8" opacity="0.8"/>
</svg>`
