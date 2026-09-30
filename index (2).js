/* ============================================================
   KPI TEAM Freedom University — server AUTONOMO (v1)
   ============================================================
   Progetto SEPARATO dal Funnel: repository suo, servizio Render suo.
   Fa tre cose:
   1. Serve la dashboard del team (team.html) con password, alla radice
   2. /api/team-sync: KPI di setter e closer, giorno per giorno,
      incrociando GHL (utenti, pipeline, APPUNTAMENTI IN CALENDARIO)
      con i due fogli Google compilati dal team
   3. /api/team-debug: diagnosi permessi (utenti, calendari, opportunità)

   Variabili d'ambiente su Render (solo queste tre):
     SYNC_API_KEY    = password del sito (stessa del Funnel, se vuoi)
     GHL_TOKEN       = token Integrazione privata GHL (copialo dal
                       servizio del Funnel: Render → Environment)
     GHL_LOCATION_ID = id del sub-account GHL (idem)
   Niente chiavi Meta: questo server non tocca le campagne.
   ============================================================ */
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const { SYNC_API_KEY, GHL_TOKEN, GHL_LOCATION_ID, PORT = 3000 } = process.env;

const GHL = "https://services.leadconnectorhq.com";
const ghlHeaders = { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json" };

app.get("/health", (_req, res) => res.json({ ok: true }));
function checkKey(req, res, next) {
  if (SYNC_API_KEY && req.query.key !== SYNC_API_KEY)
    return res.status(401).json({ ok: false, error: "Password errata." });
  next();
}
app.get("/api/ping", checkKey, (_req, res) => res.json({ ok: true }));

/* ---------- helper condivisi (identici al server del Funnel) ---------- */
const norm = s => String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
const money = v => { const n=parseFloat(String(v??"").replace(/[€$\s]/g,"").replace(/\.(?=\d{3}\b)/g,"").replace(",",".")); return isFinite(n)?n:0; };
const dayOf = v => { if(!v) return null; const s=String(v); const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m?`${m[1]}-${m[2]}-${m[3]}`:null; };
async function ghlGET(path){
  const r = await fetch(GHL+path, {headers: ghlHeaders});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`GHL ${path}: ${j.message||j.error||r.status}`);
  return j;
}

/* ID dei campi UTM di questa location (dalla diagnosi): funzionano anche senza
   il permesso "campi personalizzati" sul token. Gli altri campi (Cash, Contrattualizzato,
   Data Vendita) si risolvono per nome appena il token ha lo scope giusto. */
const FIELD_FALLBACK = {
  "eIWChn1tSHr9SV3k8nPg": "utm source",
  "ngCaDZhKshp4XYiq1Vme": "utm campaign",
  "bFlpzo17stRQocW1WAEh": "utm medium",
  "4v33gsK21jenFc8xEyw4": "utm content"
};

function parseCSVText(text){
  const rows=[]; let row=[],cur="",q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else if(ch==='"') q=true;
    else if(ch==='\n'||ch==='\r'){ if(cur!==""||row.length){row.push(cur);rows.push(row);row=[];cur="";} if(ch==='\r'&&text[i+1]==='\n')i++; }
    else if(ch===','){ row.push(cur); cur=""; }
    else cur+=ch;
  }
  if(cur!==""||row.length){row.push(cur);rows.push(row);}
  return rows;
}
const itDate = s => { const m=String(s||"").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m?`${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`:null; };
const num = s => { const v=parseFloat(String(s??"").replace(/\./g,"").replace(",",".")); return isFinite(v)?v:0; };

/* ============================================================
   TEAM (aggiunta v3) — dashboard /team: KPI per persona
   ============================================================
   Tutto quello che sta sopra questa riga è invariato. Il blocco
   aggiunge soltanto:
   - GET /team           → la dashboard del team (team.html),
                           stessa password del resto del sito
   - GET /api/team-sync  → KPI di setter e closer, giorno per giorno,
                           incrociando GHL (utenti, pipeline,
                           APPUNTAMENTI IN CALENDARIO) con i due
                           fogli Google compilati dal team
   - GET /api/team-debug → diagnosi: utenti, calendari, esempio
                           opportunità (per controllare gli scope)

   PER AGGIUNGERE UNA PERSONA non serve toccare il codice:
   su Render → Environment si possono impostare
     TEAM_SETTERS = "Denise,Donato,Lucas,Juliette,NuovoSetter"
     TEAM_CLOSERS = "Mario,Alberto,Daniela,Gelu,NuovoCloser"
   Il nome deve coincidere con la scheda del foglio e (anche solo
   come nome di battesimo) con l'utente in GHL. Poi: nuova scheda
   nel foglio + utente in GHL, e la dashboard la vede da sola.
   ============================================================ */
const TEAM_SETTERS = (process.env.TEAM_SETTERS || "Denise,Donato,Lucas,Juliette")
  .split(",").map(s=>s.trim()).filter(Boolean);
const TEAM_CLOSERS = (process.env.TEAM_CLOSERS || "Mario,Alberto,Daniela,Gelu")
  .split(",").map(s=>s.trim()).filter(Boolean);
const TEAM_SHEET_SETTING_ID = process.env.TEAM_SHEET_SETTING_ID || "1uS2p_KjisjC_DDAmBM0i1P7SQo0uR0OFO29Y8cScj-Q"; // KPI TEAM SETTING
const TEAM_SHEET_CLOSER_ID  = process.env.TEAM_SHEET_CLOSER_ID  || "197ajwVgd_JPXxyWPidJsBZ7L_gXJDO620-0-z9XP3eg"; // KPI TEAM VENDITA

/* ---------- pagina /team (stessa logica di dashboard.html) ---------- */
let teamHTML = "";
try { teamHTML = readFileSync(join(__dirname, "team.html"), "utf8"); }
catch { teamHTML = "<h1>team.html mancante nel repository</h1>"; }
app.get("/",     (_req, res) => res.type("html").send(teamHTML));
app.get("/team", (_req, res) => res.type("html").send(teamHTML));   /* alias */

/* ---------- accumulatore persona -> giorno -> metriche ---------- */
function teamShape(nomi){
  const m = new Map(nomi.map(n => [n, { nome:n, giorni:{} }]));
  const add = (nome, day, k, v = 1) => {
    const p = m.get(nome); if(!p || !day || !v) return;
    if(!p.giorni[day]) p.giorni[day] = {};
    p.giorni[day][k] = (p.giorni[day][k] || 0) + v;
  };
  const set = (nome, day, k, v) => {           // per i saldi (ultimo valore, non somma)
    const p = m.get(nome); if(!p || !day) return;
    if(!p.giorni[day]) p.giorni[day] = {};
    p.giorni[day][k] = v;
  };
  return { add, set, toArray: () => [...m.values()] };
}

/* ============================================================
   FOGLI GOOGLE DEL TEAM — una scheda per persona
   Nota (verificato sui fogli reali): l'export gviz SALTA le righe
   con la sola data e nessun valore, quindi si leggono solo le
   righe compilate; giorno assente = zero. Le intestazioni hanno
   spazi finali e il refuso "Trattaive": si cercano per parola
   chiave, non per uguaglianza.
   ============================================================ */
async function teamFetchTab(sheetId, tab){
  const tried = new Set(); let lastErr = "";
  for(const t of [tab, tab + " ", tab.trim()]){
    if(tried.has(t)) continue; tried.add(t);
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(t)}`;
    try{
      const r = await fetch(url);
      if(!r.ok){ lastErr = "HTTP " + r.status; continue; }
      const text = await r.text();
      if(text && !/<html|<!doctype/i.test(text.slice(0, 300))) return parseCSVText(text);
      lastErr = "risposta non CSV (nome scheda inesistente?)";
    }catch(e){ lastErr = e.message; }
  }
  throw new Error(`scheda "${tab}" non leggibile (${lastErr || "nome non trovato"}) — il foglio deve essere condiviso "chiunque abbia il link"`);
}

/* colmap: [{k, kw:[parole chiave], not:[esclusioni], money, saldo}] */
function teamParseRows(rows, colmap, since, until, out){
  let idx = null;                                  // k -> indice colonna corrente
  for(const row of rows){
    const cells = row.map(norm);
    /* riga di intestazione? (le parole chiave compaiono in almeno 3 colonne) */
    const cand = {}; let hits = 0;
    for(const c of colmap){
      const i = cells.findIndex(h => h && c.kw.some(k => h.includes(k)) && !(c.not || []).some(k => h.includes(k)));
      if(i >= 0){ cand[c.k] = i; hits++; }
    }
    if(hits >= Math.min(3, colmap.length)){ idx = cand; continue; }
    /* riga di dati? (prima colonna = data gg/mm/aaaa) */
    const day = itDate(row[0]);
    if(!day || !idx || day < since || day > until) continue;
    for(const c of colmap){
      const i = idx[c.k]; if(i == null || i < 0) continue;
      const raw = row[i]; if(raw == null || String(raw).trim() === "") continue;
      const v = c.money ? money(raw) : num(raw);
      if(!v && !c.saldo) continue;
      if(!out[day]) out[day] = {};
      out[day][c.k] = c.saldo ? v : (out[day][c.k] || 0) + v;
    }
  }
}

const TEAM_COLS_CLOSER = [
  { k:"sLead",   kw:["lead assegnati"] },
  { k:"sChiam",  kw:["chiamate"] },                       // closer full-stack: dial sui lead (colonna da aggiungere al foglio)
  { k:"sFixMe",  kw:["fissati da me"] },
  { k:"sTratt",  kw:["numero tratta"] },                 // "Numero Trattaive/Trattative"
  { k:"sCallSv", kw:["call svolte"] },
  { k:"sVend",   kw:["vendite"] },
  { k:"sPerse",  kw:["perse"] },                          // "Trattaive Perse"
  { k:"sNoShow", kw:["no show"] },                        // non intercetta "% Show Up"
  { k:"sRisch",  kw:["rischedulate"] },
  { k:"sFatt",   kw:["fatturato"], money:true },
  { k:"sInc",    kw:["incassato"], money:true },
];
const TEAM_COLS_SETTER = [
  { k:"sAss",    kw:["lead assegnati"] },
  { k:"sCall",   kw:["chiamate"] },
  { k:"sFix",    kw:["appuntamenti fissati"] },
  { k:"sNonFix", kw:["non fissati"], saldo:true },        // saldo di fine giornata, non si somma
  { k:"sFatt",   kw:["fatturato"], money:true },
];

async function teamFetchSheets(since, until, S, C, warn){
  for(const nome of TEAM_CLOSERS){
    try{
      const rows = await teamFetchTab(TEAM_SHEET_CLOSER_ID, nome);
      const giorni = {}; teamParseRows(rows, TEAM_COLS_CLOSER, since, until, giorni);
      for(const [d, rec] of Object.entries(giorni))
        for(const [k, v] of Object.entries(rec)) C.add(nome, d, k, v);
    }catch(e){ warn.push(`Foglio vendita · ${nome}: ${e.message}`); }
  }
  for(const nome of TEAM_SETTERS){
    try{
      const rows = await teamFetchTab(TEAM_SHEET_SETTING_ID, nome);
      const giorni = {}; teamParseRows(rows, TEAM_COLS_SETTER, since, until, giorni);
      for(const [d, rec] of Object.entries(giorni))
        for(const [k, v] of Object.entries(rec))
          (k === "sNonFix" ? S.set : S.add)(nome, d, k, v);
    }catch(e){ warn.push(`Foglio setting · ${nome}: ${e.message}`); }
  }
}

/* ============================================================
   GHL PER PERSONA — utenti, calendari, opportunità
   (scansione separata: fetchGHL del funnel resta com'è)
   Date, come concordato:
   - appuntamenti / show / no show → GIORNO DELL'APPUNTAMENTO in calendario
   - vendite / fatturato / cash   → DATA VENDITA (campo custom), altrimenti
                                    giorno del passaggio a "Vinto"
   - trattative                   → giorno di creazione nella pipeline closer
   ============================================================ */
async function teamFetchGHL(since, until, S, C, warn){
  if(!GHL_TOKEN || !GHL_LOCATION_ID){ warn.push("GHL non configurato (mancano GHL_TOKEN / GHL_LOCATION_ID)."); return; }

  /* 1) utenti → abbina i nomi configurati agli utenti GHL */
  const byId = new Map(); const userIdOf = {};
  try{
    const ju = await ghlGET(`/users/?locationId=${GHL_LOCATION_ID}`);
    const users = ju.users || [];
    for(const n of [...TEAM_SETTERS, ...TEAM_CLOSERS]){
      const nn = norm(n);
      const u = users.find(u => [u.name, u.firstName, `${u.firstName||""} ${u.lastName||""}`]
        .some(x => norm(x).includes(nn)));
      if(u){ byId.set(u.id, n); userIdOf[n] = u.id; }
    }
    const mancanti = [...TEAM_SETTERS, ...TEAM_CLOSERS].filter(n => !userIdOf[n]);
    if(users.length && mancanti.length)
      warn.push("Utenti GHL non abbinati per nome: " + mancanti.join(", ") + " — il nome della scheda nel foglio deve coincidere con il nome utente in GHL.");
    if(!users.length) warn.push("GHL: elenco utenti vuoto.");
  }catch(e){
    warn.push('GHL utenti non leggibili (' + e.message + '): aggiungi lo scope "View Users" all\'integrazione privata.');
  }

  /* 2) calendari → appuntamenti dei closer, contati alla data dell'appuntamento */
  const t0 = Date.parse(since + "T00:00:00Z") - 864e5;   // margine per il fuso orario
  const t1 = Date.parse(until + "T23:59:59Z") + 864e5;
  for(const nome of TEAM_CLOSERS){
    const uid = userIdOf[nome]; if(!uid) continue;
    try{
      const je = await ghlGET(`/calendars/events?locationId=${GHL_LOCATION_ID}&userId=${uid}&startTime=${t0}&endTime=${t1}`);
      for(const ev of (je.events || [])){
        let day = dayOf(String(ev.startTime || ""));
        if(!day && ev.startTime) { try{ day = new Date(+ev.startTime || ev.startTime).toISOString().slice(0,10); }catch(_){} }
        if(!day || day < since || day > until) continue;
        const st = norm(ev.appointmentStatus || ev.appoinmentStatus || "");
        if(st === "cancelled" || st === "invalid"){ C.add(nome, day, "gCanc"); continue; }
        C.add(nome, day, "gApp");
        /* NB: show e no-show NON si leggono qui: il team segna l'esito nelle
           FASI della pipeline closer (come nel Funnel), non sullo stato
           dell'appuntamento in calendario — si contano più sotto. */
      }
    }catch(e){
      warn.push(`GHL calendario di ${nome}: ${e.message} — se è un errore di permessi, aggiungi lo scope "View Calendars / Calendar Events" all'integrazione privata.`);
    }
  }

  /* 2b) CHIAMATE dal dialer GHL — messaggi TYPE_CALL in USCITA, per persona/giorno.
     Non esiste un endpoint "registro chiamate" nell'API pubblica: si passa dalle
     conversazioni del periodo assegnate ai membri del team e dai loro messaggi,
     con tetti di sicurezza per non appesantire il sync. */
  try{
    const sinceMs = Date.parse(since + "T00:00:00Z") - 864e5;
    const convDi = new Map();                               // convId -> nome assegnatario (riserva)
    const MAX_PAG_UT = 6, MAX_CONV = 900;
    let convParziale = false;
    for(const [nome, uid] of Object.entries(userIdOf)){
      let cursore = sinceMs, pagine = 0;
      while(pagine++ < MAX_PAG_UT && convDi.size < MAX_CONV){
        const jc = await ghlGET(`/conversations/search?locationId=${GHL_LOCATION_ID}&assignedTo=${uid}&limit=100&sort=asc&sortBy=last_message_date&startAfterDate=${cursore}`);
        const lista = jc.conversations || [];
        for(const c of lista) if(!convDi.has(c.id)) convDi.set(c.id, nome);
        if(lista.length < 100) break;
        const ultima = lista[lista.length - 1] || {};
        const md = +ultima.lastMessageDate || +ultima.dateUpdated || 0;
        if(!md || md <= cursore){ convParziale = true; break; }
        cursore = md;
      }
      if(pagine > MAX_PAG_UT) convParziale = true;
    }
    if(convDi.size >= MAX_CONV) convParziale = true;

    const voci = [...convDi.entries()];
    const MAX_MSG = 900, LOTTO = 8;
    let letteConv = 0;
    for(let i = 0; i < voci.length && letteConv < MAX_MSG; i += LOTTO){
      await Promise.all(voci.slice(i, i + LOTTO).map(async ([cid, nomeRiserva]) => {
        letteConv++;
        try{
          const jm = await ghlGET(`/conversations/${cid}/messages?type=TYPE_CALL&limit=100`);
          const msgs = (jm.messages && jm.messages.messages) || jm.messages || [];
          for(const msg of (Array.isArray(msgs) ? msgs : [])){
            if(!norm(msg.direction || "").includes("outbound")) continue;
            const day = dayOf(String(msg.dateAdded || ""));
            if(!day || day < since || day > until) continue;
            const nome = byId.get(msg.userId) || nomeRiserva;
            if(TEAM_SETTERS.includes(nome)) S.add(nome, day, "gChiam");
            else if(TEAM_CLOSERS.includes(nome)) C.add(nome, day, "gChiam");
          }
        }catch(e){ /* conversazione illeggibile: si salta */ }
      }));
    }
    if(convParziale || voci.length > MAX_MSG)
      warn.push("Chiamate GHL: periodo molto pieno, conteggio dialer parziale (tetto di sicurezza) — il totale reale può essere più alto; fa fede anche la colonna del foglio.");
  }catch(e){
    warn.push('Chiamate dal dialer GHL non leggibili (' + e.message + '): servono gli scope "View Conversations" e "View Conversation Messages" sull\'integrazione privata; intanto vale la colonna del foglio.');
  }

  /* 3) opportunità → per persona assegnata */
  const stages = new Map();
  try{
    const pipes = await ghlGET(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    (pipes.pipelines || []).forEach(p => (p.stages || []).forEach(s => stages.set(s.id, { pipe:norm(p.name), stage:norm(s.name) })));
  }catch(e){ warn.push("GHL pipeline non leggibili: " + e.message); return; }

  const cf = new Map(Object.entries(FIELD_FALLBACK));
  let scopeOk = false;
  for(const q of ["?model=opportunity","?model=contact","?model=all",""]){
    try{
      const defs = await ghlGET(`/locations/${GHL_LOCATION_ID}/customFields${q}`);
      (defs.customFields || []).forEach(f => cf.set(f.id, norm(f.name)));
      scopeOk = true;
    }catch(e){ /* variante non disponibile */ }
  }
  if(!scopeOk){
    warn.push('Token GHL senza permesso sui campi personalizzati: Incassato (Cash Collected), Contrattualizzato e Data Vendita restano a zero. Aggiungi lo scope "View Custom Fields" all\'integrazione privata in GHL e risincronizza.');
  } else {
    const trovato = n => [...cf.values()].some(v => v.includes(n));
    const mancanti = ["cash collected","contrattualizzato","data vendita"].filter(n => !trovato(n));
    if(mancanti.length) warn.push("Campi GHL non trovati per nome: " + mancanti.join(", ") + " — controlla come si chiamano in GHL (Impostazioni → Campi personalizzati): Incassato e data vendita dipendono da questi.");
  }
  const cfVal = (opp, ...names) => {
    const arr = opp.customFields || opp.customField || opp.custom_fields || [];
    for(const f of arr){
      const nm = cf.get(f.id || f.customFieldId) || norm(f.name || f.key || "");
      if(names.some(n => nm.includes(n))){
        const v = f.fieldValue ?? f.fieldValueString ?? f.field_value ?? f.value;
        if(Array.isArray(v)) return v.join(", ");
        return v ?? null;
      }
    }
    return null;
  };
  const setterOf = v => { const nv = norm(v || ""); if(!nv) return null; return TEAM_SETTERS.find(n => nv.includes(norm(n))) || null; };
  const inR = d => d && d >= since && d <= until;

  /* i campi custom (Cash Collected, Contrattualizzato, Data Vendita, Setter)
     spesso NON arrivano dalla ricerca opportunità: quando mancano, l'opportunità
     viene riletta in dettaglio più sotto e poi ripassata da qui. */
  const needDetail = [];
  const processCloser = (o) => {
    const st = stages.get(o.pipelineStageId) || { pipe:"", stage:"" };
    const s = st.stage;
    const who = byId.get(o.assignedTo) || null;
    const created = dayOf(o.createdAt);
    const changed = dayOf(o.lastStageChangeAt || o.lastStatusChangeAt || o.updatedAt) || created;
    const nome = who && TEAM_CLOSERS.includes(who) ? who : null;
    if(nome){
      if(inR(created)) C.add(nome, created, "gTratt");
      /* show / no-show dagli ESITI di pipeline, come nel Funnel:
         No Show → no-show · Follow Up / Vinto / Perso → la call c'è stata */
      if(s.includes("no show") && inR(changed)) C.add(nome, changed, "gNoShow");
      if(["follow","vinto","perso"].some(x => s.includes(x)) && inR(changed)) C.add(nome, changed, "gShow");
      if(s.includes("perso") && inR(changed)) C.add(nome, changed, "gPerse");
      if(s.includes("vinto")){
        const saleDay = dayOf(cfVal(o, "data vendita")) || changed;
        if(inR(saleDay)){
          C.add(nome, saleDay, "gVend");
          const contr   = money(cfVal(o, "contrattualizzato"));
          const venduto = contr || (+o.monetaryValue || 0);
          const cash    = money(cfVal(o, "cash collected"));
          if(contr)   C.add(nome, saleDay, "gContr", contr);
          if(venduto) C.add(nome, saleDay, "gFatt", venduto);
          if(cash)    C.add(nome, saleDay, "gInc",  cash);
        }
      }
    }
    /* la fissata del SETTER: se l'opportunità porta il campo custom "setter" */
    const se = setterOf(cfVal(o, "setter"));
    if(se && inR(created)) S.add(se, created, "gFix");
  };

  let got = 0, startAfter = null, startAfterId = null, guardia = 0;
  while(guardia++ < 500){
    let path = `/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=100`;
    if(startAfterId) path += `&startAfterId=${encodeURIComponent(startAfterId)}&startAfter=${encodeURIComponent(startAfter)}`;
    const j = await ghlGET(path);
    const list = j.opportunities || [];
    if(!list.length) break;
    got += list.length;

    for(const o of list){
      const st = stages.get(o.pipelineStageId) || { pipe:"", stage:"" };
      const who = byId.get(o.assignedTo) || null;
      const created = dayOf(o.createdAt);
      const changed = dayOf(o.lastStageChangeAt || o.lastStatusChangeAt || o.updatedAt) || created;

      if(st.pipe.includes("closer")){
        const arr = o.customFields || o.customField || o.custom_fields || [];
        const rilevante = inR(created) || inR(changed) || st.stage.includes("vinto");
        if(arr.length || !rilevante) processCloser(o);
        else needDetail.push({ o, r: (inR(created) || inR(changed)) ? 0 : 1 });
      }
      else if(st.pipe.includes("setter")){
        /* pipeline di setting: la lavorano i setter MA ANCHE i closer full-stack */
        const s = st.stage;
        const tgt = who && TEAM_SETTERS.includes(who) ? { sh:S, nome:who }
                  : who && TEAM_CLOSERS.includes(who) ? { sh:C, nome:who } : null;
        if(!tgt) continue;
        if(inR(created)) tgt.sh.add(tgt.nome, created, "gAss");
        const contattato = ["contattato","call 1","call 2","call 3","non interessato","non in target","semina","appuntamento fissato"].some(x => s.includes(x));
        if(contattato && inR(changed)) tgt.sh.add(tgt.nome, changed, "gCont");
        if(s.includes("non interessato") && inR(changed)) tgt.sh.add(tgt.nome, changed, "gNonInt");
        if(s.includes("non in target")   && inR(changed)) tgt.sh.add(tgt.nome, changed, "gNonTarget");
      }
    }
    const m = j.meta || {};
    if(list.length < 100 || !m.startAfterId) break;
    startAfterId = m.startAfterId; startAfter = m.startAfter;
  }
  if(!got) warn.push("GHL: nessuna opportunità ricevuta per il team — controlla token e Location ID.");

  /* rilettura in DETTAGLIO delle opportunità closer arrivate senza campi custom */
  if(needDetail.length){
    needDetail.sort((a, b) => a.r - b.r);                 // prima quelle del periodo
    const MAXD = 600;
    if(needDetail.length > MAXD)
      warn.push(`GHL: ${needDetail.length} opportunità closer da rileggere in dettaglio, lette le prime ${MAXD} — Incassato/Contrattualizzato potrebbero essere leggermente parziali.`);
    const lista = needDetail.slice(0, MAXD);
    let illeggibili = 0;
    const LOTTO = 8;
    for(let i = 0; i < lista.length; i += LOTTO){
      await Promise.all(lista.slice(i, i + LOTTO).map(async ({ o }) => {
        try{
          const jd = await ghlGET(`/opportunities/${o.id}`);
          const det = jd.opportunity || jd;
          const arr = det && (det.customFields || det.customField || det.custom_fields);
          if(arr && arr.length) o.customFields = arr;
        }catch(e){ illeggibili++; }
        processCloser(o);
      }));
    }
    if(illeggibili) warn.push(`GHL: ${illeggibili} dettagli opportunità non leggibili (le altre sono state lette).`);
    else warn.push(`GHL: Cash/Contrattualizzato/Data vendita/Setter letti dal dettaglio di ${lista.length} opportunità (la ricerca non includeva i campi custom).`);
  }
}

/* ---------- /api/team-sync ---------- */
app.get("/api/team-sync", checkKey, async (req, res) => {
  try{
    const until = req.query.until || new Date().toISOString().slice(0, 10);
    const since = req.query.since || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const warn = [];
    const S = teamShape(TEAM_SETTERS), C = teamShape(TEAM_CLOSERS);
    try{ await teamFetchGHL(since, until, S, C, warn); }catch(e){ warn.push("GHL team: " + e.message); }
    await teamFetchSheets(since, until, S, C, warn);
    res.json({ ok:true, since, until, warn,
               setter: S.toArray(), closer: C.toArray(),
               config: { setters: TEAM_SETTERS, closers: TEAM_CLOSERS } });
  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:String(err.message || err) });
  }
});

/* ---------- diagnosi team: utenti, calendari, esempio opportunità ---------- */
app.get("/api/team-debug", checkKey, async (_req, res) => {
  const out = { config:{ setters:TEAM_SETTERS, closers:TEAM_CLOSERS } };
  try{
    const ju = await ghlGET(`/users/?locationId=${GHL_LOCATION_ID}`);
    out.utenti = (ju.users || []).map(u => ({ id:u.id, nome:u.name || `${u.firstName||""} ${u.lastName||""}`.trim(), email:u.email }));
  }catch(e){ out.utenti = "ERRORE: " + e.message; }
  try{
    const primo = out.utenti && out.utenti[0] && out.utenti[0].id;
    if(primo){
      const t1 = Date.now(), t0 = t1 - 14 * 864e5;
      const je = await ghlGET(`/calendars/events?locationId=${GHL_LOCATION_ID}&userId=${primo}&startTime=${t0}&endTime=${t1}`);
      out.esempioCalendario = (je.events || []).slice(0, 5).map(ev => ({ inizio:ev.startTime, stato:ev.appointmentStatus, assegnatoA:ev.assignedUserId, titolo:ev.title }));
      out.eventiUltimi14gg = (je.events || []).length;
    }
  }catch(e){ out.esempioCalendario = "ERRORE: " + e.message; }
  try{
    const j = await ghlGET(`/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=3`);
    out.esempioOpportunita = (j.opportunities || []).map(o => ({ nome:o.name, assignedTo:o.assignedTo, creata:o.createdAt, fase:o.pipelineStageId, campiCustomNellaRicerca:(o.customFields||o.customField||[]).length }));
    const prima = (j.opportunities || [])[0];
    if(prima){
      try{
        const jd = await ghlGET(`/opportunities/${prima.id}`);
        const det = jd.opportunity || jd;
        out.dettaglioPrimaOpp = { campiCustomNelDettaglio:(det.customFields||det.customField||[]).length };
      }catch(e){ out.dettaglioPrimaOpp = "ERRORE: " + e.message; }
    }
  }catch(e){ out.esempioOpportunita = "ERRORE: " + e.message; }
  try{
    const primo = Array.isArray(out.utenti) && out.utenti[0] && out.utenti[0].id;
    if(primo){
      const da = Date.now() - 7 * 864e5;
      const jc = await ghlGET(`/conversations/search?locationId=${GHL_LOCATION_ID}&assignedTo=${primo}&limit=20&sort=desc&sortBy=last_message_date&startAfterDate=${da}`);
      const convs = jc.conversations || [];
      out.chiamateProbe = { conversazioniUltimi7gg: convs.length };
      if(convs[0]){
        const jm = await ghlGET(`/conversations/${convs[0].id}/messages?type=TYPE_CALL&limit=100`);
        const msgs = (jm.messages && jm.messages.messages) || jm.messages || [];
        out.chiamateProbe.chiamatePrimaConversazione = (Array.isArray(msgs)?msgs:[]).filter(m=>norm(m.direction||"").includes("outbound")).length;
      }
    }
  }catch(e){ out.chiamateProbe = "ERRORE: " + e.message + ' — servono gli scope "View Conversations" e "View Conversation Messages".'; }
  res.json(out);
});


app.listen(PORT, ()=>console.log(`KPI TEAM server attivo sulla porta ${PORT}`));
