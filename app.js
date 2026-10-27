/* Prüfungstrainer – generische App-Logik (abgeleitet vom PRINCE2 Foundation Trainer, Stand 20.10.2026)
   Alles Prüfungsspezifische steht in config.js (window.APP_CONFIG).
   Datenbasis: data/katalog.json (ein Eintrag pro Frage, siehe README „Datenmodell“).
   Änderungshistorie und Begründungen: docs/PROTOKOLL.md */

/* ---------- Konstanten aus der Konfiguration ---------- */
const CFG = window.APP_CONFIG;
const EXAMS = CFG.exams;
const COUNT_STEP = CFG.countStep || 10;
const PASS_RATE = CFG.passRate;
const PASS_PCT = Math.round(PASS_RATE * 100);
const SECONDS_PER_QUESTION = CFG.secondsPerQuestion;
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];   // angezeigte Buchstaben je Position; Fragen haben 4 (klassisch) bis 6 Optionen (Zuordnung)
const SOURCE_NOTE = CFG.sourceNote;
const minutesFor = n => Math.round(n * SECONDS_PER_QUESTION / 60);

/* ---------- Einstellungen (pro Browser gemerkt) ---------- */
const DEFAULT_SETTINGS = {
  mode: 'exam',                              // 'exam' = Reale Prüfung, 'training' = Trainieren
  exam: EXAMS[0].code,
  count: 20,                                 // Fragen im Training; 0 = „Alle“ (alle Fragen der Auswahl)
  examOpts: { sim: true, shuffle: false },   // Reale Prüfung: Simulation standardmäßig an, Mischen aus
  scenDesk: false,                           // Szenario-Seitenleiste am Desktop beim Start einer Prüfung geöffnet
  trainingOpts: { sim: false, source: 'all', topics: [], exams: [] },  // Trainieren: immer gemischt; Quelle siehe SOURCES; topics/exams leer = alle
};
/* Fragenquellen im Training (Fehler = zuletzt falsch beantwortet, Markiert = beim letzten Vorkommen markiert) */
const SOURCES = [
  { id: 'all',     label: 'Alle Fragen',       title: 'Training' },
  { id: 'errors',  label: 'Fehlerfragen',      title: 'Fehlertraining' },
  { id: 'flagged', label: 'Markierte Fragen',  title: 'Markierte Fragen' },
  { id: 'both',    label: 'Fehler + markierte', title: 'Fehler + markierte Fragen' },
];
function loadSettings(){
  try {
    const s = JSON.parse(localStorage.getItem(CFG.storagePrefix + 'settings') || '{}');
    const t = { ...DEFAULT_SETTINGS.trainingOpts, ...(s.trainingOpts || {}) };
    // Abwärtskompatibel: bis 15.10.2026 gab es nur den Schalter „errorsOnly“
    if(!(s.trainingOpts && s.trainingOpts.source)) t.source = s.trainingOpts && s.trainingOpts.errorsOnly ? 'errors' : 'all';
    if(!SOURCES.some(x => x.id === t.source)) t.source = 'all';
    if(!Array.isArray(t.topics)) t.topics = [];          // Abwärtskompatibel: Einstellungen vor dem 20.10.2026 ohne Themenauswahl
    if(!Array.isArray(t.exams)) t.exams = [];            // Abwärtskompatibel: Einstellungen vor dem 26.10.2026 ohne Fragequellen
    // Gültig: 0 = „Alle“ oder ein Vielfaches der Schrittweite (frühere Knöpfe 10–70 bleiben damit gültig)
    if(s.count !== undefined && s.count !== 0 && !(Number.isInteger(s.count) && s.count > 0 && s.count % COUNT_STEP === 0)) s.count = DEFAULT_SETTINGS.count;
    delete t.errorsOnly;
    if(!EXAMS.some(e => e.code === s.exam)) delete s.exam;   // gemerkte Prüfung gibt es nicht mehr → Standard
    return { ...DEFAULT_SETTINGS, ...s, examOpts: { ...DEFAULT_SETTINGS.examOpts, ...(s.examOpts || {}) }, trainingOpts: t };
  } catch(e) { return structuredClone(DEFAULT_SETTINGS); }
}
function saveSettings(){ try { localStorage.setItem(CFG.storagePrefix + 'settings', JSON.stringify(settings)); } catch(e) {} }
const settings = loadSettings();

/* ---------- Verlauf: Speicherschicht ----------
   Gekapselt, damit sie später (Roadmap Schritt 4: Konten/Server) ausgetauscht werden kann.
   Ein Durchlauf („run“) speichert je Frage nur ID, angezeigte Optionsreihenfolge, Antwort-Schlüssel und Markierung;
   Fragetexte kommen beim Ansehen wieder aus dem Katalog. */
const store = {
  key: CFG.storagePrefix + 'history',
  load(){ try { const h = JSON.parse(localStorage.getItem(this.key) || '[]'); return Array.isArray(h) ? h : []; } catch(e) { return []; } },
  save(history){ try { localStorage.setItem(this.key, JSON.stringify(history)); return true; } catch(e) { return false; } },
};
let HISTORY = store.load();

/* ---------- Zustand ---------- */
let CATALOG = [];
let BY_ID = {};
let GROUPS = {};        // Zuordnungsblöcke: group → Teilfragen in Originalreihenfolge
let SCENARIO = null;    // data/szenario.json (optional; ohne Datei gibt es keinen Szenario-Knopf)
const state = {
  view: 'start',        // 'start' | 'exam' | 'result'
  loading: true, loadError: null,
  session: null,        // laufende Prüfung / Trainingseinheit, siehe newSession()
  pos: 0,
  reviewMode: false,
  modal: null,
  timerId: null,
  scenOpen: false,      // Szenario-Panel sichtbar (nur in der Prüfungsansicht)
  filterOpen: null,     // Trainings-Filter aufgeklappt; null = automatisch (offen, wenn ein Filter aktiv ist)
};

const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const shuffled = arr => { const a = [...arr]; for(let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const examOf = code => EXAMS.find(e => e.code === code);
const passMark = n => Math.ceil(n * PASS_RATE);

/* ---------- Fragen & Antworten ----------
   Antworten werden intern über feste Schlüssel (A–D der Katalogfrage) gespeichert.
   Angezeigt wird ein Buchstabe je Position: item.perm[i] ist der Schlüssel, der an Position LETTERS[i] steht. */
const keysOf = q => Object.keys(q.opts).sort();               // Optionsschlüssel der Katalogfrage (A–D bzw. A–F)
const hasExpl = q => keysOf(q).every(k => q.expl[k]);          // Begründung zu jeder Option vorhanden
const rightKeys = q => Array.isArray(q.answer) ? q.answer : [q.answer];
const isRight = (q, key) => !!key && rightKeys(q).includes(key);
const shown = (item, key) => LETTERS[item.perm.indexOf(key)];
/* Gespeicherte Reihenfolge nur übernehmen, wenn sie zur heutigen Frage passt (Fragen können durch eine neue Fassung
   ersetzt sein, z. B. Musterprüfung 2 am 27.10.2026) – sonst Originalreihenfolge. Ebenso nur Antworten mit gültigem Schlüssel. */
const fitPerm = (q, perm) => { const k = keysOf(q); return perm && [...perm].sort().join('') === [...k].sort().join('') ? perm.split('') : k; };
const fitAns = (q, a) => a && keysOf(q).includes(a) ? a : null;
const rightLabel = item => rightKeys(item.q).map(k => shown(item, k)).sort().join(' oder ');
const rightText = item => rightKeys(item.q).map(k => `${shown(item, k)} – ${esc(item.q.opts[k])}`).join(' / ');
const originNo = (q, code) => { const o = q.origin.find(o => o.startsWith(code + '-')); return o ? Number(o.split('-')[1]) : 0; };
/* Zuordnungsblöcke (Feld group): gemeinsame Einleitung + Optionsliste, die Einleitung nennt die Buchstaben („A–F“).
   Daher werden ihre Optionen nie gemischt und die Teilfragen eines Blocks bleiben immer zusammen und in Reihenfolge. */
const qLabel = q => q.group ? `Zuordnung: ${q.question}` : q.question;
const groupPos = q => GROUPS[q.group].indexOf(q) + 1;
/* Fragen zu „Einheiten“ bündeln: ein Block = eine Einheit (alle Teilfragen), sonst jede Frage einzeln */
function unitsFrom(questions){
  const seen = new Set(), units = [];
  questions.forEach(q => {
    if(!q.group){ units.push([q]); return; }
    if(seen.has(q.group)) return;
    seen.add(q.group); units.push(GROUPS[q.group]);
  });
  return units;
}
/* Größte erreichbare Fragenanzahl ≤ target, wenn Blöcke nur ganz gezogen werden */
function unitTotal(units, target){
  const blocks = units.filter(u => u.length > 1), singles = units.length - blocks.length;
  let best = 0;
  for(let b = 0, sum = 0; b <= blocks.length && sum <= target; sum += (blocks[b] || []).length, b++) best = Math.max(best, sum + Math.min(singles, target - sum));
  return best;
}
/* Zufällige Einheiten bis genau unitTotal(): zuerst zufällig auffüllen, eine Restlücke durch Tausch Einzelfragen → Block schließen */
function pickUnits(units, target){
  const goal = unitTotal(units, target), pool = shuffled(units);
  let chosen = [], n = 0;
  pool.forEach(u => { if(n + u.length <= goal){ chosen.push(u); n += u.length; } });
  for(const blk of pool.filter(u => u.length > 1 && !chosen.includes(u))){
    const need = blk.length - (goal - n), singles = chosen.filter(u => u.length === 1);
    if(n >= goal) break;
    if(need >= 0 && singles.length >= need){ const drop = new Set(singles.slice(0, need)); chosen = chosen.filter(u => !drop.has(u)); chosen.push(blk); n = n - need + blk.length; }
  }
  return shuffled(chosen);
}

/* ---------- Laden ---------- */
function loadCatalog(){
  // Passwortschutz: Die Anmeldemaske in index.html hat die verschlüsselten Daten (data/inhalt.enc.json) bereits entschlüsselt
  const pre = window.APP_DATA;
  // cache: 'no-cache' = beim Server nachfragen (ETag); Katalog-Korrekturen kommen sofort an, unverändert kostet es kaum etwas
  (pre ? Promise.resolve(pre.katalog) : fetch('data/katalog.json', { cache: 'no-cache' }).then(r => { if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }))
    .then(data => {
      CATALOG = data; BY_ID = Object.fromEntries(data.map(q => [q.id, q]));
      GROUPS = {};
      data.filter(q => q.group).forEach(q => (GROUPS[q.group] ||= []).push(q));
      Object.values(GROUPS).forEach(g => g.sort((a, b) => a.origin[0].localeCompare(b.origin[0], 'de', { numeric: true })));
      state.loading = false;
      const saved = loadCurrent();                          // unterbrochener Durchlauf (Neuladen, Tab geschlossen …)?
      if(saved) state.modal = { type: 'restore', saved };
      render();
    })
    .catch(err => {
      state.loading = false;
      state.loadError = location.protocol === 'file:'
        ? 'Die Fragen können nicht direkt aus dem Dateisystem geladen werden. Bitte die App über einen Webserver öffnen (siehe README).'
        : `Der Fragenkatalog konnte nicht geladen werden (${err.message}). Bitte die Seite neu laden.`;
      render();
    });
  (pre ? Promise.resolve(pre.szenario) : fetch('data/szenario.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null))
    .then(data => { SCENARIO = data; renderScenario(); if(state.view === 'exam') render(); })
    .catch(() => {});
}

/* ---------- Sitzung erzeugen ---------- */
function newSession(){
  let items, title, sim, shuffle;
  if(settings.mode === 'exam'){
    const code = settings.exam;
    sim = settings.examOpts.sim; shuffle = settings.examOpts.shuffle;
    const qs = CATALOG.filter(q => q.origin.some(o => o.startsWith(code + '-')))
      .sort((a, b) => originNo(a, code) - originNo(b, code));
    // Gemischt: Einheiten mischen (Blöcke bleiben zusammen und in Reihenfolge)
    items = (shuffle ? shuffled(unitsFrom(qs)).flat() : qs).map(q => {
        const own = q.origin.find(o => o.startsWith(code + '-'));
        // Originalreihenfolge der Optionen dieser Prüfung, oder gemischt (Zuordnungsblöcke nie)
        const perm = shuffle && !q.group ? shuffled(keysOf(q)) : (q.optOrder?.[own] || keysOf(q).join('')).split('');
        return { q, perm, origNo: originNo(q, code) };
      });
    title = examOf(code).title;
  } else {
    sim = settings.trainingOpts.sim; shuffle = true;
    const src = SOURCES.find(x => x.id === settings.trainingOpts.source) || SOURCES[0];
    const st = questionStatus(), pool = narrow(sourcePool(src.id, st)), inPool = new Set(pool.map(q => q.id));
    // Blöcke nur komplett (jeder Block gehört ganz zu einem Thema); bei Fehler-/Markiert-Training wird die betroffene Teilfrage gekennzeichnet
    items = pickUnits(unitsFrom(pool), wantedCount()).flat().map(q => ({
      q, perm: q.group ? keysOf(q) : shuffled(keysOf(q)),
      focus: src.id !== 'all' && q.group && inPool.has(q.id) ? [st.wrong[q.id] && 'zuletzt falsch', st.flagged[q.id] && 'markiert'].filter(Boolean).join(' · ') : '',
    }));
    title = `${src.title}${filterTitle(chosenTopics(), chosenExams())} · ${items.length} Frage${items.length === 1 ? '' : 'n'}`;
  }
  return { mode: settings.mode, exam: settings.mode === 'exam' ? settings.exam : null, title, sim, shuffle, items,
           answers: {}, flags: new Set(), elapsed: 0,
           pending: {},     // ohne Simulation: ausgewählt, aber noch nicht bestätigt (zählt als offen, wird nicht gespeichert)
           limit: sim ? Math.round(items.length * SECONDS_PER_QUESTION) : 0,   // 0 = Stoppuhr ohne Limit
           timeout: false };
}

/* ---------- Szenario-Panel ----------
   Statisches Element außerhalb von #app (index.html), damit Scrollposition und Inhalt beim Neuzeichnen der Frage
   erhalten bleiben. Desktop: Seitenleiste, der Inhalt rückt nach links; Handy (≤ 900 px): Overlay über der Frage. */
const scenPanel = document.getElementById('scenPanel');
const isDesktop = () => window.matchMedia('(min-width: 901px)').matches;
function renderScenario(){
  if(!SCENARIO) return;
  scenPanel.innerHTML = `<div class="scen-head"><b>${esc(SCENARIO.title)}</b><button class="btn small" id="scenClose">Schließen ✕</button></div>
    <div class="scen-body">${scenarioBody(SCENARIO)}<p class="time-note">${esc(SCENARIO.source)}</p></div>`;
  document.getElementById('scenClose').onclick = () => setScen(false);
}
function setScen(open, remember = true){
  state.scenOpen = !!open && !!SCENARIO && state.view === 'exam';
  scenPanel.hidden = !state.scenOpen;
  document.body.classList.toggle('scen-open', state.scenOpen);
  if(remember && isDesktop()){ settings.scenDesk = state.scenOpen; saveSettings(); }
  document.querySelectorAll('[data-scen]').forEach(b => {
    b.classList.toggle('active', state.scenOpen); b.setAttribute('aria-expanded', state.scenOpen);
    b.textContent = state.scenOpen ? 'Szenario ausblenden' : 'Szenario';
  });
  if(state.scenOpen && !isDesktop()) scenPanel.focus();
}
// Panel beginnt unter der (klebenden) Kopfzeile – deren Höhe ändert sich mit Schriftgröße und Breite
const headerEl = document.querySelector('header');
const setHdr = () => document.documentElement.style.setProperty('--hdr', headerEl.offsetHeight + 'px');
new ResizeObserver(setHdr).observe(headerEl); setHdr();

/* ---------- Zeit: Simulation an = Countdown (1 Min./Frage), sonst Stoppuhr ---------- */
function fmt(s){ return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function showTimer(){
  const s = state.session;
  const countdown = s.limit > 0;
  timer.hidden = false;
  // Tempo-Leiste (immer): Ø Zeit pro Antwort im Vergleich zum Prüfungstempo (150 min / 70 Fragen ≈ 2:09).
  // Punkt links = schneller (Türkis), rechts = langsamer (Rosé). Ohne Simulation zählen bestätigte Antworten,
  // in der Simulation alle gegebenen (dort gibt es kein „Bestätigen“).
  const done = Object.keys(s.answers).length, avg = done ? s.elapsed / done : 0;
  const ratio = done ? avg / SECONDS_PER_QUESTION : 1;
  const pos = Math.max(4, Math.min(96, 50 + (ratio - 1) * 50));            // 0,5× … 1,5× Prüfungstempo → 4 … 96 %
  const slow = done && ratio > 1;
  const fill = pos < 50 ? `left:${pos}%;right:50%` : `left:50%;right:${100 - pos}%`;
  const target = fmt(Math.round(SECONDS_PER_QUESTION));
  const pace = `<div class="tbar pace${slow ? ' slow' : ''}" title="Prüfungstempo: ${target} pro Frage (150 min für 70 Fragen). Punkt links = schneller, rechts = langsamer."
      aria-label="Dauer ${fmt(s.elapsed)} Minuten${done ? `, durchschnittlich ${fmt(Math.round(avg))} pro Frage, Prüfungstempo ${target}` : ''}">
      <span class="pv">Dauer <b>${fmt(s.elapsed)}</b></span>
      <span class="pace-m" aria-hidden="true">${done ? `<i class="pace-f" style="${fill}"></i><i class="pace-d" style="left:${pos}%"></i>` : ''}</span>
      <span class="pv pv-r">Ø <b>${done ? fmt(Math.round(avg)) : '–'}</b><span class="pf"> pro Frage</span></span></div>`;
  let count = '';
  if(countdown){
    // Simulation: Restzeit-Leiste füllt sich mit der verstrichenen Zeit; Text mittig, zweimal gesetzt
    // (normal auf dem leeren Teil, Kontrastfarbe auf dem gefüllten Teil – per clip-path exakt an der Füllkante getrennt)
    const left = s.limit - s.elapsed, warn = left <= Math.min(300, s.limit / 5);
    const pct = Math.min(100, s.elapsed / s.limit * 100).toFixed(2);
    const label = `Restzeit <b>${fmt(left)}</b>`;
    count = `<div class="tbar count${warn ? ' warn' : ''}" role="timer" aria-label="Restzeit ${fmt(left)} Minuten">
      <i class="tb-fill" style="width:${pct}%"></i><span class="tb-lbl" aria-hidden="true">${label}</span><span class="tb-lbl on" style="clip-path:inset(0 ${100 - pct}% 0 0)" aria-hidden="true">${label}</span></div>`;
  }
  timer.innerHTML = pace + count;
}
/* Pause: Zeit anhalten, ganze App mit undurchsichtigem Bildschirm abdecken (Frage nicht lesbar), Tastatur gesperrt */
function pauseSession(){
  if(state.view !== 'exam' || state.reviewMode || state.modal || !state.session) return;
  stopTimer(); state.modal = { type: 'pause' }; render();
  document.getElementById('modalResume')?.focus();
}
function resumeSession(){
  if(state.modal?.type !== 'pause') return;
  state.modal = null; render(); startTimer();                // läuft ab dem angehaltenen Stand weiter (elapsed bleibt)
}
document.getElementById('pauseBtn').onclick = pauseSession;
function startTimer(){
  stopTimer(); showTimer();
  state.timerId = setInterval(() => {
    const s = state.session; s.elapsed++; showTimer();
    if(s.limit && s.elapsed >= s.limit){ s.timeout = true; finish(); }
  }, 1000);
}
function stopTimer(){ if(state.timerId){ clearInterval(state.timerId); state.timerId = null; } }

/* ---------- Aktionen ---------- */
/* ---------- Laufenden Durchlauf sichern (Neuladen/Schließen) ----------
   Gesichert wird bei jeder Aktion (render) und beim Verlassen/Ausblenden der Seite (beforeunload, pagehide,
   visibilitychange) – nicht im Sekundentakt, damit die laufende Zeit trotzdem bis zum Verlassen mitgesichert ist. Beim nächsten Öffnen wird angeboten, fortzusetzen;
   die Zeit bleibt während der Unterbrechung stehen (läuft ab dem gesicherten Stand weiter). Nach Abgabe, Abbruch über
   „Startseite“ oder „Verwerfen“ wird die Sicherung gelöscht. Nur Verlauf-Durchläufe (past) werden nie gesichert. */
const CURRENT_KEY = CFG.storagePrefix + 'current';
const isRunning = () => state.view === 'exam' && !state.reviewMode && state.session && !state.session.past;
function currentSnapshot(){
  const s = state.session;
  return { v: 1, savedAt: new Date().toISOString(),
    mode: s.mode, exam: s.exam, title: s.title, sim: s.sim, shuffle: s.shuffle, limit: s.limit, elapsed: s.elapsed,
    items: s.items.map(it => ({ id: it.q.id, perm: it.perm.join(''), focus: it.focus || '' })),
    answers: s.answers, pending: s.pending || {}, flags: [...s.flags], pos: state.pos };
}
function saveCurrent(){
  if(!isRunning()) return;
  try { localStorage.setItem(CURRENT_KEY, JSON.stringify(currentSnapshot())); } catch(e) {}
}
function clearCurrent(){ try { localStorage.removeItem(CURRENT_KEY); } catch(e) {} }
/* Gesicherten Durchlauf prüfen (aus dem Browser-Speicher oder aus einer Sicherungsdatei); null = nicht fortsetzbar */
function checkCurrent(d){
  if(!d || d.v !== 1 || !Array.isArray(d.items) || typeof d.elapsed !== 'number') return null;
  const items = d.items.filter(x => x && BY_ID[x.id]);
  return items.length ? { ...d, items } : null;
}
function loadCurrent(){
  try {
    const raw = JSON.parse(localStorage.getItem(CURRENT_KEY) || 'null'), d = checkCurrent(raw);
    if(raw && !d) clearCurrent();                            // Katalog geändert → nichts mehr fortsetzbar
    return d;
  } catch(e) { return null; }
}
function restoreCurrent(d){
  const ids = new Set(d.items.map(x => x.id)), keep = o => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => ids.has(k) && fitAns(BY_ID[k], v)));
  state.session = { mode: d.mode, exam: d.exam, title: d.title, sim: d.sim, shuffle: d.shuffle, limit: d.limit, elapsed: d.elapsed, timeout: false,
    items: d.items.map(x => ({ q: BY_ID[x.id], perm: fitPerm(BY_ID[x.id], x.perm), focus: x.focus || '', origNo: d.exam ? originNo(BY_ID[x.id], d.exam) : 0 })),
    answers: keep(d.answers), pending: keep(d.pending), flags: new Set((d.flags || []).filter(id => ids.has(id))) };
  state.pos = Math.min(d.pos || 0, state.session.items.length - 1); state.reviewMode = false; state.modal = null;
  state.view = 'exam'; startTimer(); render(); window.scrollTo(0, 0);
}
/* Browser-Rückfrage beim Neuladen/Schließen, solange ein Durchlauf läuft (Text gibt der Browser vor) */
/* Eigene Knöpfe erlaubt der Browser dort nicht. Bleibt man auf der Seite („Abbrechen“), läuft der Zeitgeber danach weiter
   und bietet die Sicherung an; verlässt man sie, wird er nie ausgeführt (pagehide setzt leaving). */
let leaving = false;
addEventListener('beforeunload', e => {
  if(!isRunning()) return;
  saveCurrent(); e.preventDefault(); e.returnValue = '';
  setTimeout(() => { if(!leaving && isRunning() && !state.modal){ state.modal = { type: 'stay' }; render(); } }, 400);
});
addEventListener('pagehide', () => { leaving = true; saveCurrent(); });   // Handy/Safari: beforeunload kommt dort nicht zuverlässig
addEventListener('pageshow', () => { leaving = false; });
document.addEventListener('visibilitychange', () => { if(document.hidden) saveCurrent(); });

function start(){
  if(state.loading || state.loadError || !CATALOG.length) return;
  state.session = newSession(); state.pos = 0; state.reviewMode = false; state.modal = null;
  state.view = 'exam'; startTimer(); render(); window.scrollTo(0, 0);
  setScen(isDesktop() && settings.scenDesk, false);
}
function current(){ return state.session.items[state.pos]; }
/* Simulation: Klick = Antwort (jederzeit änderbar, Feedback erst nach Abgabe).
   Ohne Simulation: Klick = nur Auswahl (frei wechselbar); erst „Bestätigen“ wertet und zeigt die Begründung. */
function choose(letter){
  const s = state.session, item = current(), key = item.perm[LETTERS.indexOf(letter)];
  if(state.reviewMode) return;
  if(s.sim){ s.answers[item.q.id] = key; render(); return; }
  if(s.answers[item.q.id]) return;               // bestätigte Antwort bleibt stehen
  s.pending[item.q.id] = key;
  render();
}
function confirmAnswer(){
  const s = state.session, id = current().q.id;
  if(state.reviewMode || s.sim || s.answers[id] || !s.pending[id]) return;
  s.answers[id] = s.pending[id]; delete s.pending[id];
  render();
}
function go(pos){ state.pos = Math.max(0, Math.min(state.session.items.length - 1, pos)); render(); window.scrollTo({top: 0, behavior: 'smooth'}); }
function toggleFlag(){ const f = state.session.flags, id = current().q.id; f.has(id) ? f.delete(id) : f.add(id); render(); }
function askFinish(){
  const s = state.session; const open = s.items.length - Object.keys(s.answers).length;
  if(open === 0) return finish();
  state.modal = { type: 'finish', open }; render();
}
function finish(){
  stopTimer(); timer.hidden = true; state.modal = null; clearCurrent();
  if(!state.session.past) recordRun();
  state.view = 'result'; render(); window.scrollTo(0, 0);
}

/* ---------- Verlauf: aufzeichnen, wiederherstellen, auswerten ---------- */
function recordRun(){
  const s = state.session;
  if(s.runId) return;
  const run = {
    v: 1,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(),
    mode: s.mode, exam: s.exam, title: s.title, sim: s.sim, shuffle: s.shuffle,
    limit: s.limit, elapsed: s.elapsed, timeout: s.timeout,
    total: s.items.length, score: score(),
    items: s.items.map(it => ({ id: it.q.id, perm: it.perm.join(''), a: s.answers[it.q.id] || null, f: s.flags.has(it.q.id) ? 1 : 0 })),
  };
  HISTORY.push(run);
  s.runId = run.id; s.date = run.date;
  s.saved = store.save(HISTORY);
}
function sessionFromRun(run){
  const known = run.items.filter(x => BY_ID[x.id]);
  return {
    mode: run.mode, exam: run.exam, title: run.title, sim: run.sim, shuffle: run.shuffle,
    items: known.map(x => ({ q: BY_ID[x.id], perm: fitPerm(BY_ID[x.id], x.perm), origNo: run.exam ? originNo(BY_ID[x.id], run.exam) : 0 })),
    answers: Object.fromEntries(known.filter(x => fitAns(BY_ID[x.id], x.a)).map(x => [x.id, x.a])),
    flags: new Set(known.filter(x => x.f).map(x => x.id)),
    elapsed: run.elapsed, limit: run.limit, timeout: run.timeout,
    runId: run.id, date: run.date, saved: true, past: true,
  };
}
const byDate = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
/* Status je Frage über alle Durchläufe (chronologisch):
   - wrong:   Ergebnis der letzten *beantworteten* Vorlage (true = falsch). Unbeantwortete Vorlagen ändern nichts –
              so landen bei einem Abbruch die offenen Fragen nicht im Fehlertraining (für die Bewertung zählen sie weiter als falsch).
   - flagged: Markierung bei der letzten Vorlage (wer eine Frage später nicht mehr markiert, nimmt sie wieder heraus). */
function questionStatus(){
  const wrong = {}, flagged = {};
  [...HISTORY].sort(byDate).forEach(run => run.items.forEach(x => {
    const q = BY_ID[x.id]; if(!q) return;
    if(x.a) wrong[x.id] = !isRight(q, x.a);
    flagged[x.id] = !!x.f;
  }));
  return { wrong, flagged };
}
function sourcePool(source, st = questionStatus()){
  if(source === 'errors')  return CATALOG.filter(q => st.wrong[q.id]);
  if(source === 'flagged') return CATALOG.filter(q => st.flagged[q.id]);
  if(source === 'both')    return CATALOG.filter(q => st.wrong[q.id] || st.flagged[q.id]);
  return CATALOG;
}
function errorPool(){ return sourcePool('errors'); }
/* Themenbereiche in Katalogreihenfolge (= Reihenfolge der Abschnitte in der Prüfung) */
const topicList = () => [...new Set(CATALOG.map(q => q.topic).filter(Boolean))];
/* Gewählte Themen; unbekannte (z. B. nach Katalogänderung) werden ignoriert, leer = alle */
const chosenTopics = () => settings.trainingOpts.topics.filter(t => topicList().includes(t));
const byTopics = (qs, topics = chosenTopics()) => topics.length ? qs.filter(q => topics.includes(q.topic)) : qs;
const wantedCount = () => settings.count || Infinity;     // 0 = „Alle“
const countLabel = (v, max) => v >= max ? `Alle ${CATALOG.length} Fragen` : `${v} Fragen`;
const topicTitle = topics => !topics.length ? '' : topics.length === 1 ? ` · ${topics[0].replace(/^Practice: /, '')}` : ` · ${topics.length} Themen`;
/* Fragequellen = Prüfungen aus config.js (Musterprüfungen, später Mocks); leer = alle. Eine Frage zählt zu jeder Prüfung in origin. */
const inExam = (q, code) => q.origin.some(o => o.startsWith(code + '-'));
const chosenExams = () => settings.trainingOpts.exams.filter(c => EXAMS.some(e => e.code === c));
const byExams = (qs, exams = chosenExams()) => exams.length ? qs.filter(q => exams.some(c => inExam(q, c))) : qs;
const narrow = (qs, topics = chosenTopics(), exams = chosenExams()) => byExams(byTopics(qs, topics), exams);
const examTitle = exams => !exams.length ? '' : exams.length === 1 ? ` · ${examOf(exams[0]).title}` : ` · ${exams.length} Prüfungen`;
const filterTitle = (topics, exams) => examTitle(exams) + topicTitle(topics);
function review(pos){ state.view = 'exam'; state.reviewMode = true; state.pos = pos; render(); window.scrollTo(0, 0); }
function score(){ const s = state.session; return s.items.filter(it => isRight(it.q, s.answers[it.q.id])).length; }

/* Begründungszeilen: richtige Option(en) zuerst, dann die eigene falsche Antwort, dann die übrigen.
   Falsche Optionen mit identischem Text (Zuordnungsblöcke: nur Handbuch-Verweis, z. B. „Siehe 5.5“) werden zusammengefasst. */
function explRows(item, chosen){
  const q = item.q, ok = isRight(q, chosen), rows = [];
  const order = [...item.perm].sort((a, b) => (isRight(q, b) - isRight(q, a)) || ((b === chosen) - (a === chosen)) || (item.perm.indexOf(a) - item.perm.indexOf(b)));
  order.forEach(key => {
    const right = isRight(q, key), mine = key === chosen && !ok;
    const same = !right && !mine && rows.find(r => !r.right && !r.mine && r.text === q.expl[key]);
    if(same) same.keys.push(key); else rows.push({ keys: [key], right, mine, text: q.expl[key] });
  });
  return rows.map(r => ({ ...r, letters: r.keys.map(k => shown(item, k)).sort() }));
}
const scenarioBody = sc => `${sc.intro.map(b => `${b.heading ? `<h4>${esc(b.heading)}</h4>` : ''}${b.text ? `<p>${esc(b.text)}</p>` : ''}${b.list ? `<ul>${b.list.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}`).join('')}
  <h3>${esc(sc.extraTitle)}</h3>
  <dl>${sc.roles.map(r => `<dt>${esc(r.name)}</dt><dd>${esc(r.text)}</dd>`).join('')}</dl>`;

/* ---------- Bericht zum Herunterladen (offline lesbar) ----------
   Eine einzelne HTML-Datei ohne externe Abhängigkeiten: öffnet in jedem Browser, druckbar / als PDF speicherbar.
   Reihenfolge: zuerst falsch und nicht beantwortete Fragen (aufgeklappt), dann richtige (zugeklappt). */
const fmtDate = iso => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
function download(name, content, type){
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function reportFileName(s){
  const d = new Date(s.date || Date.now());
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const what = (s.mode === 'exam' ? examOf(s.exam).title : s.title).replace(/[^\wäöüÄÖÜß]+/g, '-').replace(/-+$/, '');
  return `${CFG.reportPrefix}-Bericht_${what}_${stamp}.html`;
}
function reportQuestion(s, it, i){
  const q = it.q, chosen = s.answers[q.id], ok = isRight(q, chosen);
  const withExpl = hasExpl(q);
  // Zusammengefasste Begründungen (identischer Text bei mehreren falschen Optionen) nur einmal unter der Liste
  const rows = withExpl ? explRows(it, chosen) : [], shared = rows.filter(r => r.keys.length > 1);
  const opts = it.perm.map((key, k) => {
    const right = isRight(q, key), mine = key === chosen;
    const cls = right ? 'right' : mine ? 'wrong' : '';
    const tag = right && mine ? 'Richtig · deine Antwort' : right ? 'Richtige Antwort' : mine ? 'Deine Antwort' : '';
    const own = withExpl && !shared.some(r => r.keys.includes(key));
    return `<li class="${cls}"><b>${right ? ICON_CHECK : mine ? ICON_X : LETTERS[k]}</b><div><span class="ot">${esc(q.opts[key])}</span>${tag ? `<i>${tag}</i>` : ''}${own ? `<em>${esc(q.expl[key])}</em>` : ''}</div></li>`;
  }).join('');
  const sharedHtml = shared.map(r => `<p class="sh"><b>Übrige Optionen ${r.letters.join(', ')}: falsch.</b> ${esc(r.text)}</p>`).join('');
  const st = ok ? 'ok' : chosen ? 'bad' : 'open';
  const status = ok ? 'Richtig' : chosen ? 'Falsch' : 'Nicht beantwortet';
  return `<details class="q ${st}" ${ok ? '' : 'open'}>
  <summary><span class="nr">${i + 1}</span><span class="qt">${esc(qLabel(q))}</span><span class="tp">${esc(q.topic || '')}</span><span class="st">${status}</span></summary>
  <div class="qb">
  ${q.group ? `<p class="sc">${esc(q.groupIntro)}</p><p class="gp">Zuordnung · Aussage ${groupPos(q)} von ${GROUPS[q.group].length}</p>` : ''}
  ${q.scenario ? `<p class="sc">${esc(q.scenario)}</p>` : ''}
  <p class="qq">${esc(q.question)}</p>
  ${q.items.length ? `<ol class="it">${q.items.map(t => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}
  <ul class="op">${opts}</ul>${sharedHtml}
  ${!withExpl && q.rationale ? `<div class="ra"><b>Begründung</b><p>${esc(q.rationale)}</p></div>` : ''}
  ${!withExpl && !q.rationale ? `<div class="ra"><b>Lösung</b><p>Richtig ist ${rightLabel(it)}. Für diese Frage liegt keine Begründung vor.</p></div>` : ''}
  <p class="meta">${q.topic ? `${esc(q.topic)} · ` : ''}${q.ref ? `Lehrplan ${esc(q.ref)} · ` : ''}Herkunft ${esc(q.origin.join(', '))} · ${q.id}</p>
  </div>
</details>`;
}
function buildReport(s){
  const total = s.items.length, sc = s.items.filter(it => isRight(it.q, s.answers[it.q.id])).length, pass = passMark(total);
  const passed = sc >= pass, pct = Math.round(sc / total * 100);
  const rows = s.items.map((it, i) => ({ it, i }));
  const notOk = rows.filter(({it}) => !isRight(it.q, s.answers[it.q.id]));
  const okRows = rows.filter(({it}) => isRight(it.q, s.answers[it.q.id]));
  const openN = notOk.filter(({it}) => !s.answers[it.q.id]).length, wrongN = notOk.length - openN;
  const topics = {};
  s.items.forEach(it => { if(!it.q.topic) return; const t = topics[it.q.topic] ||= {c: 0, n: 0}; t.n++; if(isRight(it.q, s.answers[it.q.id])) t.c++; });
  // Themenbereiche wie in der App: schwächster zuerst, Balken rosé unter der Bestehensgrenze
  const topicRows = Object.entries(topics).map(([t, v]) => ({ t, ...v, p: Math.round(v.c / v.n * 100) })).sort((a, b) => a.p - b.p || a.t.localeCompare(b.t, 'de'));
  const timeVal = fmt(s.elapsed), timeSub = s.limit ? `von ${fmt(s.limit)} min${s.timeout ? ' · Zeit abgelaufen' : ''}` : 'min · Stoppuhr';
  const kind = [s.mode === 'exam' ? 'Reale Prüfung' : 'Training', s.sim ? 'Prüfungssimulation' : '', s.shuffle ? 'gemischt' : ''].filter(Boolean).join(' · ');
  const R = 52, C = 2 * Math.PI * R;                       // Ergebnis-Ring (SVG)
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(CFG.appTitle)} · Bericht · ${esc(s.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Montserrat:wght@500;600;700&display=swap" rel="stylesheet">
<style>
/* Farben und Formen wie in der App (Redesign A): weiße Flächen mit feinem Rahmen, Türkis = richtig/Aktion, Rosé = falsch */
:root{--bg:#fff;--surf:#fff;--surf2:#f2f4f4;--border:#d6e1de;--line:#b3c4c0;--ink:#1c2b2f;--muted:#5b6d72;
  --acc:#29bca3;--accsoft:#e2f4f1;--accink:#0b6b5b;--ok:#29bca3;--oksoft:#c8eee6;--okink:#0b4a40;--onok:#04342c;
  --bad:#e58a7f;--badsoft:#fcecea;--badink:#94403a;--onbad:#3d1410;--open:#c9a24a;--opensoft:#f8f0dc;--openink:#7a5a12}
@media screen and (prefers-color-scheme:dark){:root{--bg:#0f1716;--surf:#152120;--surf2:#1c2a28;--border:#2a3b38;--line:#3b504c;--ink:#e3ecea;--muted:#9bb0ab;
  --accsoft:#183a34;--accink:#6fd8c4;--oksoft:#17423a;--okink:#a6eadb;--badsoft:#43231f;--badink:#f2b3aa;--opensoft:#3a3220;--openink:#e6c77a}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{font:15px/1.6 'Figtree',system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--ink);background:var(--bg);max-width:880px;margin:0 auto;padding:0 20px 56px;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,.kpi b,.ring text,.eyebrow,.nr,.bw{font-family:'Montserrat',system-ui,sans-serif}
svg{flex:none}
.rh{display:flex;align-items:center;gap:14px;padding:22px 0 18px;border-bottom:1px solid var(--border);margin-bottom:32px}
.rh img{height:26px;width:auto}
.bw{font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:16px;color:var(--acc)}
.rh .doc{margin-left:auto;font-family:'Montserrat',system-ui,sans-serif;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accink);margin:0 0 6px}
h1{font-size:30px;line-height:1.15;font-weight:600;margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 22px}
h2{font-size:20px;font-weight:600;margin:40px 0 14px;display:flex;align-items:baseline;gap:10px}
h2 small{font-family:'Figtree',sans-serif;font-size:14px;font-weight:500;color:var(--muted)}
.card{background:var(--surf);border:1px solid var(--border);border-radius:18px}
/* Ergebnis */
.hero{display:flex;align-items:center;gap:28px;padding:24px 28px}
.ring{width:132px;height:132px}
.ring .tr{stroke:var(--surf2)}.ring .fg{stroke:${passed ? 'var(--ok)' : 'var(--bad)'}}
.ring text{fill:var(--ink)}
.res{flex:1;min-width:0}
.pill{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:6px 14px;font-weight:700;font-size:15px}
.pill.pass{background:var(--oksoft);color:var(--okink)}.pill.fail{background:var(--badsoft);color:var(--badink)}
.res p{margin:10px 0 14px;color:var(--muted)}
.res p b{color:var(--ink)}
.pbar{position:relative;height:10px;border-radius:999px;background:var(--surf2)}
.pbar i{position:absolute;inset:0 auto 0 0;border-radius:999px;background:${passed ? 'var(--ok)' : 'var(--bad)'}}
.pbar u{position:absolute;top:-5px;bottom:-5px;width:2px;background:var(--ink);opacity:.55;border-radius:1px}
.pbar-l{position:relative;height:18px;font-size:12px;color:var(--muted);margin-top:8px}
.pbar-l span{position:absolute;top:0;white-space:nowrap}.pbar-l .m{transform:translateX(-50%)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:12px}
.kpi{padding:14px 16px}.kpi b{display:block;font-size:22px;font-weight:600;line-height:1.2}.kpi span{color:var(--muted);font-size:13px}
.kpi.ok b{color:var(--okink)}.kpi.bad b{color:var(--badink)}.kpi.open b{color:var(--openink)}
/* Themenbereiche */
.topics{padding:8px 22px}
.tr-row{display:grid;grid-template-columns:minmax(0,1fr) 180px 92px;gap:16px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
.tr-row:last-child{border-bottom:0}
.tr-row .b{height:8px;border-radius:999px;background:var(--surf2);overflow:hidden}.tr-row .b i{display:block;height:100%;border-radius:999px;background:var(--ok)}
.tr-row.low .b i{background:var(--bad)}
.tr-row .v{text-align:right;font-variant-numeric:tabular-nums;font-size:14px;color:var(--muted)}.tr-row .v b{color:var(--ink);font-weight:600}
.note{font-size:13px;color:var(--muted);margin:10px 2px 0}
/* Fragen */
details.q{background:var(--surf);border:1px solid var(--border);border-radius:16px;margin:0 0 12px;break-inside:avoid}
summary{display:flex;gap:14px;align-items:center;padding:14px 18px;cursor:pointer;list-style:none}
summary::-webkit-details-marker{display:none}
.nr{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:14px}
.q.ok .nr{background:var(--oksoft);color:var(--okink)}.q.bad .nr{background:var(--badsoft);color:var(--badink)}.q.open .nr{background:var(--opensoft);color:var(--openink)}
.qt{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp{display:none;flex:1;min-width:0;font-size:13px;color:var(--muted)}
details[open] .qt{display:none}details[open] .tp{display:block}         /* aufgeklappt: Frage steht im Inhalt, oben nur der Themenbereich */
.st{flex:none;font-size:12px;font-weight:700;border-radius:999px;padding:4px 11px}
.q.ok .st{background:var(--oksoft);color:var(--okink)}.q.bad .st{background:var(--badsoft);color:var(--badink)}.q.open .st{background:var(--opensoft);color:var(--openink)}
.qb{padding:0 18px 16px 66px}
.sc{background:var(--surf2);border-radius:12px;padding:12px 16px;margin:0 0 12px;white-space:pre-line;font-size:14px}
.gp{font-family:'Montserrat',sans-serif;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--accink);margin:0 0 6px}
.qq{font-weight:600;font-size:16px;margin:4px 0 12px}
ol.it{margin:0 0 12px;padding-left:22px}
ul.op{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:8px}
ul.op li{display:flex;gap:12px;border:1px solid var(--border);border-radius:14px;padding:10px 14px}
ul.op li>b{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-size:13px;background:var(--surf2);color:var(--muted)}
ul.op li>div{flex:1;min-width:0}
ul.op li .ot{display:inline}
ul.op li i{display:inline-block;margin-left:8px;font-style:normal;font-size:11.5px;font-weight:700;border-radius:999px;padding:2px 9px;vertical-align:1px}
ul.op li.right{background:var(--oksoft);border-color:transparent}ul.op li.right>b{background:var(--ok);color:var(--onok)}ul.op li.right i{background:var(--surf);color:var(--okink)}
ul.op li.wrong{background:var(--badsoft);border-color:transparent}ul.op li.wrong>b{background:var(--bad);color:var(--onbad)}ul.op li.wrong i{background:var(--surf);color:var(--badink)}
ul.op li em{display:block;font-style:normal;color:var(--muted);font-size:13.5px;margin-top:6px;line-height:1.55}
ul.op li.right em{color:var(--okink);opacity:.85}ul.op li.wrong em{color:var(--badink);opacity:.9}
.sh{font-size:13.5px;color:var(--muted);margin:0 0 10px;padding:0 4px}.sh b{color:var(--ink);font-weight:600}
.ra{background:var(--surf2);border-radius:12px;padding:10px 14px;margin:0 0 10px}.ra p{margin:4px 0 0;white-space:pre-line}
.meta{font-size:12px;color:var(--muted);margin:6px 0 0}
.empty{padding:18px 22px;color:var(--muted)}
/* Szenario-Anhang */
.scen{padding:6px 24px 18px}.scen h3{font-size:16px;margin:20px 0 6px}.scen h4{margin:14px 0 4px}.scen ul{margin:4px 0}
.scen dt{font-weight:700;margin-top:10px}.scen dd{margin:2px 0 0}
.foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}
.foot b{color:var(--ink);font-weight:600}
@media (max-width:640px){
  .hero{flex-direction:column;text-align:center;padding:22px}.res p{margin:10px 0}
  .kpis{grid-template-columns:repeat(2,1fr)}
  .tr-row{grid-template-columns:1fr 70px;gap:6px 12px}.tr-row .b{grid-column:1/-1;grid-row:2}
  .qb{padding:0 14px 14px}summary{padding:12px 14px;gap:10px}.qt{white-space:normal}
  .pbar-l span:first-child,.pbar-l span:last-child{display:none}
  .rh .doc{display:none}.rh img{height:22px}.bw{font-size:14px}
  h1{font-size:25px}
}
@media print{body{max-width:none;padding:0}.rh{padding-top:0}details.q,.card{break-inside:avoid}h2{break-after:avoid}}
</style>
<script>addEventListener('beforeprint',()=>document.querySelectorAll('details').forEach(d=>d.open=true))<\/script>
</head><body>
<header class="rh">${LOGO_DATA ? `<img src="${LOGO_DATA}" alt="PRINCE2">` : `<b>${esc(CFG.brand)}</b>`}${CFG.brandWord ? `<span class="bw">${esc(CFG.brandWord)}</span>` : ''}<span class="doc">Prüfungsbericht</span></header>
<p class="eyebrow">Auswertung · ${esc(kind)}</p>
<h1>${esc(s.title)}</h1>
<p class="sub">${fmtDate(s.date || new Date().toISOString())}</p>
<section class="card hero">
  <svg class="ring" viewBox="0 0 132 132" role="img" aria-label="${pct} Prozent richtig">
    <circle class="tr" cx="66" cy="66" r="${R}" fill="none" stroke-width="12"/>
    <circle class="fg" cx="66" cy="66" r="${R}" fill="none" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * sc / total).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 66 66)"/>
    <text x="66" y="66" text-anchor="middle" font-size="28" font-weight="700">${pct} %</text>
    <text x="66" y="88" text-anchor="middle" font-size="13" font-weight="500" opacity=".65">${sc} / ${total}</text>
  </svg>
  <div class="res">
    <span class="pill ${passed ? 'pass' : 'fail'}">${passed ? ICON_CHECK : ICON_X}${passed ? 'Bestanden' : 'Nicht bestanden'}</span>
    <p><b>${sc} von ${total}</b> Fragen richtig – zum Bestehen nötig: <b>${pass}</b> (${PASS_PCT} %).</p>
    <div class="pbar"><i style="width:${pct}%"></i><u style="left:${PASS_PCT}%"></u></div>
    <div class="pbar-l"><span style="left:0">0 %</span><span class="m" style="left:${PASS_PCT}%">Bestehensgrenze ${PASS_PCT} %</span><span style="right:0">100 %</span></div>
  </div>
</section>
<div class="kpis">
  <div class="card kpi ok"><b>${sc}</b><span>richtig</span></div>
  <div class="card kpi bad"><b>${wrongN}</b><span>falsch</span></div>
  <div class="card kpi open"><b>${openN}</b><span>nicht beantwortet</span></div>
  <div class="card kpi"><b>${timeVal}</b><span>${timeSub}</span></div>
</div>
${topicRows.length ? `<h2>Ergebnis nach Themenbereich</h2>
<section class="card topics">${topicRows.map(r => `<div class="tr-row${r.p < PASS_PCT ? ' low' : ''}"><span>${esc(r.t)}</span><div class="b"><i style="width:${r.p}%"></i></div><span class="v"><b>${r.p} %</b> · ${r.c}/${r.n}</span></div>`).join('')}</section>
<p class="note">Sortiert vom schwächsten zum stärksten Bereich; rosé = unter der Bestehensgrenze von ${PASS_PCT} %.</p>` : ''}
<h2>Falsch oder nicht beantwortet <small>${notOk.length} ${notOk.length === 1 ? 'Frage' : 'Fragen'}</small></h2>
${notOk.length ? notOk.map(({it, i}) => reportQuestion(s, it, i)).join('') : '<div class="card empty">Keine – alle Fragen richtig beantwortet.</div>'}
<h2>Richtig beantwortet <small>${okRows.length} ${okRows.length === 1 ? 'Frage' : 'Fragen'} · zum Aufklappen</small></h2>
${okRows.length ? okRows.map(({it, i}) => reportQuestion(s, it, i)).join('') : '<div class="card empty">Noch keine.</div>'}
${SCENARIO ? `<h2>Anhang: ${esc(SCENARIO.title)}</h2><section class="card scen">${scenarioBody(SCENARIO)}<p class="meta">${esc(SCENARIO.source)}</p></section>` : ''}
<footer class="foot"><b>Erstellt mit dem ${esc(CFG.appTitle)}</b> · ${esc(CFG.liveUrl)}<br>${esc(SOURCE_NOTE)} PRINCE2® ist eine eingetragene Marke von PeopleCert. Nur für das persönliche Lernen.</footer>
</body></html>`;
}
function downloadReport(s){ download(reportFileName(s), buildReport(s), 'text/html;charset=utf-8'); }

/* ---------- Ansichten ---------- */
function render(){
  if(state.view === 'start') app.innerHTML = viewStart();
  else if(state.view === 'exam') app.innerHTML = viewExam();
  else if(state.view === 'progress') app.innerHTML = viewProgress();
  else app.innerHTML = viewResult();
  if(state.modal) app.insertAdjacentHTML('beforeend', viewModal());
  updateChrome();
  bind();
  saveCurrent();
}
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19h16"/><path d="M6 15l4-5 4 3 5-7"/></svg>';
const ICON_HOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg>';
function updateChrome(){
  const s = state.session;
  footSource.textContent = SOURCE_NOTE;
  // Während einer laufenden Bearbeitung kein Wechsel in den Lernfortschritt (sonst ginge die Sitzung verloren)
  progressBtn.hidden = state.view === 'exam' && !state.reviewMode;
  if(state.view !== 'exam' || state.reviewMode){ if(!state.reviewMode) stopTimer(); timer.hidden = true; }
  // Im Lernfortschritt wird der Knopf zu „⌂ Zurück“ (zur Startseite), sonst „Lernfortschritt“
  const inProgress = state.view === 'progress';
  if(progressBtn.dataset.mode !== (inProgress ? 'back' : 'progress')){
    progressBtn.dataset.mode = inProgress ? 'back' : 'progress';
    progressBtn.innerHTML = inProgress ? `${ICON_HOME}<span>Zurück</span>` : `${ICON_CHART}<span>Lernfortschritt</span>`;
    progressBtn.setAttribute('aria-label', inProgress ? 'Zurück zur Startseite' : 'Lernfortschritt');
    progressBtn.title = inProgress ? 'Zurück zur Startseite' : 'Lernfortschritt';
  }
  if(state.view !== 'exam' && state.scenOpen) setScen(false, false);
}

function switchRow(id, checked, title, text){
  return `<div class="opt-row">
        <label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><i></i></label>
        <label for="${id}"><b>${title}</b><span>${text}</span></label>
      </div>`;
}

function viewStart(){
  const ready = !state.loading && !state.loadError;
  const isExam = settings.mode === 'exam';
  const opts = isExam ? settings.examOpts : settings.trainingOpts;
  const st = ready ? questionStatus() : { wrong: {}, flagged: {} };
  const topicsSel = ready ? chosenTopics() : [], examsSel = ready ? chosenExams() : [];
  // Zahlen der Quellen beziehen sich auf die gewählten Themen; Zahlen der Themen auf die gewählte Quelle
  const poolSize = Object.fromEntries(SOURCES.map(x => [x.id, ready ? narrow(sourcePool(x.id, st), topicsSel, examsSel).length : 0]));
  const src = SOURCES.find(x => x.id === settings.trainingOpts.source) || SOURCES[0];
  const examSize = code => CATALOG.filter(q => q.origin.some(o => o.startsWith(code + '-'))).length;
  const srcPool = ready ? sourcePool(src.id, st) : [];
  const n = isExam ? examSize(settings.exam) : ready ? unitTotal(unitsFrom(narrow(srcPool, topicsSel, examsSel)), wantedCount()) : 0;
  state.startN = n;                                    // für die Kopfzeile (updateChrome)
  // Zahlen je Knopf: Themen innerhalb der gewählten Quelle + Prüfungen, Prüfungen innerhalb der gewählten Quelle + Themen
  const srcByExams = byExams(srcPool, examsSel), srcByTopics = byTopics(srcPool, topicsSel);
  const topicCount = Object.fromEntries((ready ? topicList() : []).map(t => [t, srcByExams.filter(q => q.topic === t).length]));
  const examCount = Object.fromEntries((ready ? EXAMS : []).map(e => [e.code, srcByTopics.filter(q => inExam(q, e.code)).length]));
  const canStart = ready && n > 0;
  const ex = examOf(settings.exam);

  const modeCards = [
    ['exam', 'Reale Prüfung', `${EXAMS.length > 1 ? `Eine von ${EXAMS.length} Prüfungen` : 'Die Musterprüfung'} in Originalumfang, wie in der echten Prüfung.`],
    ['training', 'Trainieren', `Zufällige Fragen aus dem Gesamtkatalog${ready ? ` mit ${CATALOG.length} Fragen` : ''}.`],
  ].map(([v, t, d]) => `
        <label class="pick mode">
          <input type="radio" name="mode" value="${v}" ${settings.mode === v ? 'checked' : ''}>
          <span class="dot" aria-hidden="true"></span>
          <span><b>${t}</b><small>${d}</small></span>
        </label>`).join('');

  const examCards = EXAMS.map(e => `
        <label class="pick">
          <input type="radio" name="exam" value="${e.code}" ${e.code === settings.exam ? 'checked' : ''}>
          <span class="dot" aria-hidden="true"></span>
          <span><b>${esc(e.title)}</b><small>${esc(e.sub)}</small>
            <span class="badge ${e.official ? 'official' : ''}">${e.official ? 'mit Begründungen' : 'nur Lösungen'}</span></span>
        </label>`).join('');

  // Schieberegler: 10er-Schritte bis zur Katalogsgröße (aufgerundet); ganz rechts = „Alle“ (gespeichert als 0)
  const countMax = Math.max(COUNT_STEP, Math.ceil(CATALOG.length / COUNT_STEP) * COUNT_STEP);
  const countVal = settings.count && settings.count < countMax ? settings.count : countMax;
  const countPct = v => ((v - COUNT_STEP) / (countMax - COUNT_STEP || 1) * 100).toFixed(2) + '%';   // Füllstand der Leiste
  const countSlider = `
        <div class="cnt-slider">
          <output id="countOut" for="countRange">${countLabel(countVal, countMax)}</output>
          <input type="range" id="countRange" min="${COUNT_STEP}" max="${countMax}" step="${COUNT_STEP}" value="${countVal}" style="--p:${countPct(countVal)}" aria-label="Anzahl der Fragen" aria-valuetext="${countLabel(countVal, countMax)}">
          <div class="cnt-ticks" aria-hidden="true">${'<i></i>'.repeat(countMax / COUNT_STEP)}</div>
          <div class="cnt-scale" aria-hidden="true"><span>${COUNT_STEP}</span><span>Alle (${CATALOG.length})</span></div>
        </div>`;
  // Filter-Chips: kompakte Pillen mit Zahl; jede Zeile beginnt mit „Alle“ (bei Themen/Quellen = keine Einzelauswahl)
  const chip = (type, name, value, label, count, checked, disabled) => `
          <label class="fchip"><input type="${type}" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${esc(label)}<small>${count}</small></span></label>`;
  const SHORT = { all: 'Alle', errors: 'Fehler', flagged: 'Markiert', both: 'Fehler + markiert' };   // kurz, damit die Zeile passt
  const sourceChips = SOURCES.map(x => chip('radio', 'source', x.id, SHORT[x.id] || x.label, poolSize[x.id], x.id === src.id, x.id !== 'all' && !poolSize[x.id] && x.id !== src.id)).join('');
  const topicButtons = chip('checkbox', 'topicAll', 'all', 'Alle', srcByExams.length, !topicsSel.length, false) + Object.entries(topicCount).map(([t, c]) => chip('checkbox', 'topic', t, t.replace(/^Practice: /, ''), c, topicsSel.includes(t), !c && !topicsSel.includes(t))).join('');
  const examButtons = chip('checkbox', 'qsrcAll', 'all', 'Alle', srcByTopics.length, !examsSel.length, false) + Object.entries(examCount).map(([c, k]) => chip('checkbox', 'qsrc', c, examOf(c).title, k, examsSel.includes(c), !k && !examsSel.includes(c))).join('');
  // Kurzbeschreibung aktiver Filter (für den eingeklappten Zustand)
  const filterParts = [src.id !== 'all' ? src.label : '', examsSel.length === 1 ? examOf(examsSel[0]).title : examsSel.length ? `${examsSel.length} Prüfungen` : '',
    topicsSel.length === 1 ? topicsSel[0].replace(/^Practice: /, '') : topicsSel.length ? `${topicsSel.length} Themen` : ''].filter(Boolean);
  const filterOpen = state.filterOpen ?? filterParts.length > 0;
  const frow = (title, help, body) => `<div class="frow"><div class="frow-head">${title}${tip('tip' + title.replace(/\W/g, ''), title, help)}</div><div class="fchips">${body}</div></div>`;

  const topics = {};
  if(isExam) CATALOG.filter(q => q.origin.some(o => o.startsWith(settings.exam + '-')))
    .forEach(q => { if(q.topic) topics[q.topic] = (topics[q.topic] || 0) + 1; });

  const timeText = opts.sim ? `${minutesFor(n)} min` : 'Stoppuhr';
  // Fehler-/Markiert-Training: Teilfragen von Zuordnungsblöcken ziehen ihren ganzen Block mit
  const topicPhrase = !topicsSel.length ? '' : topicsSel.length === 1 ? ` im Themenbereich „${esc(topicsSel[0])}“` : ` in ${topicsSel.length} Themenbereichen`;
  const examName = !examsSel.length ? '' : examsSel.length === 1 ? examOf(examsSel[0]).title : `${examsSel.length} Prüfungen`;
  const plusBlocks = (examName ? ` in ${esc(examName)}` : '') + topicPhrase + (ready && src.id !== 'all' && unitsFrom(narrow(srcPool, topicsSel, examsSel)).flat().length > poolSize[src.id] ? ', ergänzt um die übrigen Teilfragen ihrer Zuordnungsblöcke' : '');
  const lead = isExam
    ? `${ex.title}: ${n} Fragen ${settings.examOpts.shuffle ? 'in zufälliger Reihenfolge, Antworten gemischt' : 'in Originalreihenfolge'}. ${ex.official
        ? 'Mit offizieller Begründung zu jeder Antwortoption und Referenz ins PRINCE2-Handbuch.'
        : 'Für diese Prüfung liegen nur die Lösungen vor, keine Begründungen.'}`
    : src.id === 'errors' ? `${n} zufällige Frage${n === 1 ? '' : 'n'} aus ${poolSize.errors === 1 ? 'deiner 1 Fehlerfrage' : `deinen ${poolSize.errors} Fehlerfragen`} (zuletzt falsch beantwortet)${plusBlocks}. Fragen und Antwortoptionen werden jedes Mal neu gemischt.`
    : src.id === 'flagged' ? `${n} zufällige Frage${n === 1 ? '' : 'n'} aus ${poolSize.flagged === 1 ? 'deiner 1 markierten Frage' : `deinen ${poolSize.flagged} markierten Fragen`}${plusBlocks}. Fragen und Antwortoptionen werden jedes Mal neu gemischt.`
    : src.id === 'both' ? `${n} zufällige Fragen aus ${poolSize.both} Fehler- und markierten Fragen${plusBlocks}. Fragen und Antwortoptionen werden jedes Mal neu gemischt.`
    : `${settings.count ? `${n} zufällige Fragen` : `Alle ${n} Fragen`} aus ${examName ? esc(examName) + topicPhrase : topicsSel.length ? (topicsSel.length === 1 ? `dem Themenbereich „${esc(topicsSel[0])}“` : `${topicsSel.length} Themenbereichen`) : 'dem Gesamtkatalog'}, ${settings.count ? 'ohne Wiederholung' : 'in zufälliger Reihenfolge'}. Fragen und Antwortoptionen werden jedes Mal neu gemischt. Begründungen gibt es, wo die Quelle sie liefert.`;
  const blockNote = GROUPS && Object.keys(GROUPS).length ? ' Zuordnungsblöcke (3 Teilfragen mit gemeinsamer Optionsliste) werden immer vollständig gezogen; ihre Optionen bleiben in Originalreihenfolge.' : '';

  return `
  <section class="hero">
    <div>
      <h1>Prüfungstrainer – üben wie in der echten Prüfung</h1>
      <fieldset class="picker">
        <legend>1 · Was möchtest du tun?</legend>
        <div class="picker-grid">${modeCards}</div>
      </fieldset>
      ${isExam ? `
      <fieldset class="picker">
        <legend>2 · Welche Prüfung möchtest du schreiben?</legend>
        <div class="picker-grid">${examCards}</div>
      </fieldset>` : `
      <fieldset class="picker">
        <legend>2 · Mit wie vielen Fragen möchtest du üben?</legend>
        ${countSlider}
      </fieldset>
      <section class="filter${filterOpen ? ' open' : ''}">
        <button type="button" class="filter-head" data-ftoggle aria-expanded="${filterOpen}" aria-controls="filterBody">
          <span class="fh-title">Filter<svg class="fh-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></span>
          ${filterParts.length ? `<span class="filter-sum">${esc(filterParts.join(' · '))}</span>` : ''}
          <span class="sr">${filterOpen ? 'Filter ausblenden' : 'Filter einblenden'}</span>
        </button>
        ${filterOpen ? `<div class="filter-body" id="filterBody">
          ${filterParts.length ? `<div class="filter-reset"><button type="button" class="linkbtn" data-freset>Filter zurücksetzen</button></div>` : ''}
          ${frow('Fragenart', 'Alle Fragen, nur deine Fehlerfragen (zuletzt falsch beantwortet), nur markierte oder beides. Es gilt immer genau eine Auswahl.', sourceChips)}
          ${EXAMS.length > 1 ? frow('Fragequellen', 'Aus welchen Prüfungen geübt wird: „Alle“ oder eine bzw. mehrere Prüfungen (Mehrfachauswahl).', examButtons) : ''}
          ${frow('Themenbereiche', 'Welche Themenbereiche geübt werden: „Alle“ oder ein bzw. mehrere Themen (Mehrfachauswahl).', topicButtons)}
        </div>` : ''}
        ${(src.id !== 'all' || topicsSel.length || examsSel.length) && settings.count && n < settings.count ? `<p class="time-note">${poolSize[src.id] ? `Es gibt nur ${poolSize[src.id]} passende Fragen${n !== poolSize[src.id] ? ` (mit vollständigen Zuordnungsblöcken ${n})` : ''} – die Übung wird entsprechend kürzer.` : 'Dafür gibt es noch keine Fragen. Fehlerfragen entstehen aus falsch beantworteten Fragen, markierte über „Markieren“ während einer Prüfung oder Übung.'}</p>` : ''}
      </section>`}
      <p class="lead wide">${lead}${isExam ? '' : blockNote}</p>
      <div class="facts">
        <div class="fact"><b>${n}</b><span>Fragen</span></div>
        <div class="fact"><b>${passMark(n)}</b><span>richtig zum Bestehen (${PASS_PCT}&nbsp;%)</span></div>
        <div class="fact"><b>${timeText}</b><span>${opts.sim ? 'Zeitlimit wie in der echten Prüfung' : 'ohne Zeitlimit, Zeit wird gemessen'}</span></div>
      </div>
      ${isExam && ready ? `<div class="topics">${Object.entries(topics).map(([t, c]) => `<span class="chip"><b>${c}</b> ${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="card">
      <h2>3 · Einstellungen</h2>
      ${switchRow('optSim', opts.sim, 'Reale Prüfungssimulation',
        `Kein Feedback während der ${isExam ? 'Prüfung' : 'Übung'}. Rückmeldungen (korrekte Antworten und ggf. Begründungen) werden erst nach Abgabe der ${isExam ? 'Prüfung' : 'Übung'} angezeigt. Zeitlimit: ${minutesFor(n)} Minuten für ${n} Fragen (Verhältnis wie in der echten Prüfung).`)}
      ${isExam ? switchRow('optShuffle', settings.examOpts.shuffle, 'Fragen mischen',
        `Zufällige Reihenfolge der Fragen und der Antwortoptionen statt Originalreihenfolge.${Object.keys(GROUPS).length ? ' Zuordnungsblöcke bleiben zusammen, ihre Optionsliste bleibt unverändert.' : ''}`) : `
      <div class="opt-row info"><span class="info-icon" aria-hidden="true">↻</span>
        <span><b>Immer gemischt</b><span>Fragen und Antwortoptionen werden bei jedem Training neu gemischt.</span></span>
      </div>`}
      <p class="time-note">${opts.sim
        ? `Zeit: Countdown ${minutesFor(n)} Minuten, danach wird automatisch abgegeben.`
        : 'Zeit: Stoppuhr läuft mit, kein Zeitlimit.'}</p>
      <div class="nav" style="margin-top:var(--space-5)">
        <button class="btn primary" id="startBtn" style="width:100%;justify-content:center" ${canStart ? '' : 'disabled'}>${isExam ? `${esc(ex.title)} starten` : `${src.title}${esc(filterTitle(topicsSel, examsSel))} · ${n} Frage${n === 1 ? '' : 'n'} starten`}</button>
      </div>
      ${state.loading ? '<p class="load-note">Fragenkatalog wird geladen …</p>' : ''}
      ${state.loadError ? `<p class="load-note err">${esc(state.loadError)}</p>` : ''}
    </div>
  </section>`;
}

function originHint(item){
  const s = state.session;
  if(s.mode === 'exam') return s.shuffle ? ` · Original-Nr. ${item.origNo}` : '';
  return ` · Herkunft: ${item.q.origin.join(', ')}`;
}

function viewExam(){
  const s = state.session, item = current(), q = item.q, total = s.items.length;
  const chosen = s.answers[q.id];                      // gespeicherter Schlüssel
  const answered = Object.keys(s.answers).length;
  const hidden = s.sim && !state.reviewMode;           // Simulation: Lösung erst nach Abgabe
  const reveal = !hidden && (chosen || state.reviewMode);
  const locked = state.reviewMode || (chosen && !s.sim);
  const awaiting = !s.sim && !state.reviewMode && !chosen;   // ohne Simulation: Frage noch nicht bestätigt
  const picked = awaiting ? s.pending?.[q.id] : null;       // aktuelle, unbestätigte Auswahl
  const noun = s.mode === 'exam' ? 'Prüfung' : 'Übung';

  const options = item.perm.map((key, i) => {
    const L = LETTERS[i];
    let cls = 'opt', tag = '', mark = '';
    if(hidden){
      if(key === chosen){ cls += ' selected'; tag = 'Deine Antwort'; }
    } else if(awaiting){
      if(key === picked){ cls += ' selected'; tag = 'Ausgewählt'; }
    } else if(reveal){
      if(isRight(q, key)){ cls += ' correct'; tag = 'Richtige Antwort'; mark = ICON_CHECK; }
      else if(key === chosen){ cls += ' wrong'; tag = 'Deine Antwort'; mark = ICON_X; }
    }
    return `<button class="${cls}" data-choose="${L}" ${locked ? 'disabled' : ''} aria-pressed="${(chosen || picked) === key}">
      <span class="letter">${mark ? `${mark}<span class="sr">${L}</span>` : L}</span><span>${esc(q.opts[key])}</span>${tag ? `<span class="tag">${tag}</span>` : ''}
    </button>`;
  }).join('');

  let feedback = '';
  if(reveal){
    const ok = isRight(q, chosen);
    const withExpl = hasExpl(q);
    const body = withExpl
      ? explRows(item, chosen).map(r => `<div class="expl ${r.right ? 'right' : 'other'}${r.mine ? ' mine' : ''}"><span class="letter${r.letters.length > 1 ? ' multi' : ''}">${r.letters.join(' · ')}</span><div><span class="verdict">${r.right ? 'Richtig' : r.keys.length > 1 ? 'Übrige Optionen: falsch' : 'Falsch'}${r.mine ? ' – deine Auswahl' : ''}</span><p>${esc(r.text)}</p></div></div>`).join('')
      : rightKeys(q).map((key, i, all) => `<div class="expl right"><span class="letter">${shown(item, key)}</span><div><span class="verdict">Richtig ist ${shown(item, key)} (${esc(q.opts[key])})</span>${q.rationale && i === all.length - 1 ? `<p>${esc(q.rationale)}</p>` : ''}</div></div>`).join('');
    feedback = `
    <div class="feedback">
      <div class="fb-head ${ok ? 'ok' : 'bad'}">
        ${ok ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg><span>Richtig – gut gemacht.</span>'
             : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg><span>${chosen ? 'Leider falsch.' : 'Nicht beantwortet.'} Richtig ist <strong>${rightLabel(item)}</strong>.</span>`}
      </div>
      <div class="fb-body">
        <h3>${withExpl || q.rationale ? 'Begründung' : 'Lösung'}</h3>
        ${body}
        <div class="ref">${q.ref ? `<span>Lehrplan-Referenz: <code>${esc(q.ref)}</code></span><span>${esc(CFG.refHint)}</span>` : ''}<span>Frage-ID: <code>${q.id}</code> · ${esc(q.origin.join(', '))}</span></div>
      </div>
    </div>`;
  }

  const cells = s.items.map((it, i) => {
    const a = s.answers[it.q.id];
    let cls = 'cell';
    if(a) cls += hidden ? ' done' : (isRight(it.q, a) ? ' ok' : ' bad');
    if(i === state.pos) cls += ' cur';
    if(s.flags.has(it.q.id)) cls += ' flag';
    return `<button class="${cls}" data-go="${i}" aria-label="Frage ${i + 1}">${i + 1}</button>`;
  }).join('');
  const flagged = s.flags.has(q.id);
  // Navigationsleiste – identisch über der Frage und unter den Antworten (daher data-Attribute statt IDs)
  const navBar = where => `<div class="nav ${where}">
        <button class="btn" data-nav="-1" ${state.pos === 0 ? 'disabled' : ''}>← Zurück</button>
        <button class="btn ${flagged ? 'flagged' : ''}" data-flag>${flagged ? '⚑ Markiert' : '⚐ Markieren'}</button>
        ${awaiting ? `<button class="btn primary" data-confirm ${picked ? '' : 'disabled'} title="Antwort werten (Enter)">Bestätigen</button>` : ''}
        <span class="spacer"></span>
        ${state.reviewMode ? `<button class="btn" data-back>Zur Auswertung</button>` : ''}
        ${state.pos < total - 1
          ? (awaiting ? `<button class="btn" data-nav="1">Überspringen →</button>` : `<button class="btn primary" data-nav="1">Weiter →</button>`)
          : (state.reviewMode ? '' : `<button class="btn primary" data-finish>${noun} abgeben</button>`)}
      </div>`;

  return `
  <div class="exam">
    <section>
      <div class="progress" role="progressbar" aria-valuenow="${answered}" aria-valuemax="${total}"><i style="width:${answered / total * 100}%"></i></div>
      <div class="qmeta">
        <span class="qnum">Frage ${state.pos + 1} von ${total}</span>
        ${hidden ? '<span class="mode-badge">Prüfungssimulation</span>' : ''}
        <span class="qtopic">${q.topic ? `· ${esc(q.topic)}` : ''}${originHint(item)}</span>
        ${item.focus ? `<span class="focus-badge">${esc(item.focus)}</span>` : ''}
        ${SCENARIO ? `<button class="btn small scen-btn${state.scenOpen ? ' active' : ''}" data-scen aria-expanded="${!!state.scenOpen}" aria-controls="scenPanel">${state.scenOpen ? 'Szenario ausblenden' : 'Szenario'}</button>` : ''}
      </div>
      ${navBar('top')}
      ${q.group ? `<div class="scenario group-intro">${esc(q.groupIntro)}</div>
      <div class="group-pos">Zuordnung · Aussage ${groupPos(q)} von ${GROUPS[q.group].length}</div>` : ''}
      ${q.scenario ? `<div class="scenario">${esc(q.scenario)}</div>` : ''}
      <p class="qtext">${esc(q.question)}</p>
      ${q.items.length ? `<ol class="items">${q.items.map((it, i) => `<li><b>${i + 1}.</b><span>${esc(it)}</span></li>`).join('')}</ol>` : ''}
      <div class="options">${options}</div>
      ${feedback}
      ${navBar('bottom')}
    </section>
    <aside class="side">
      <h2>Übersicht <span>${answered}/${total} beantwortet</span></h2>
      <div class="grid">${cells}</div>
      <div class="legend">
        ${hidden
          ? `<span><i style="background:var(--accent);border-color:var(--accent)"></i> beantwortet</span>`
          : `<span><i style="background:var(--ok);border-color:var(--ok)"></i> richtig</span>
        <span><i style="background:var(--bad);border-color:var(--bad)"></i> falsch</span>`}
        <span><i></i> offen</span>
        <span><i style="background:var(--flag);border-color:var(--flag);border-radius:999px"></i> markiert</span>
      </div>
      ${state.reviewMode ? `<button class="btn" id="backToResult2">Zur Auswertung</button>` : `<button class="btn" id="finishBtn2">${noun} abgeben</button>`}
    </aside>
  </div>`;
}

function viewResult(){
  const s = state.session, total = s.items.length, pass = passMark(total);
  const sc = score(); const passed = sc >= pass; const pct = Math.round(sc / total * 100);
  const r = 74, circ = 2 * Math.PI * r;
  const topics = {};
  s.items.forEach(it => { if(!it.q.topic) return; const t = topics[it.q.topic] ||= {c: 0, n: 0}; t.n++; if(isRight(it.q, s.answers[it.q.id])) t.c++; });
  const rows = s.items.map((it, i) => ({ it, i }));
  const wrong = rows.filter(({it}) => s.answers[it.q.id] && !isRight(it.q, s.answers[it.q.id]));
  const open = rows.filter(({it}) => !s.answers[it.q.id]);
  const noun = s.mode === 'exam' ? 'Prüfung' : 'Übung';
  const time = s.limit ? `Benötigte Zeit: ${fmt(s.elapsed)} von ${fmt(s.limit)} Minuten.` : `Benötigte Zeit: ${fmt(s.elapsed)} Minuten.`;
  const line = ({it, i}, cls, extra) => `<button class="rv" data-review="${i}"><span class="n ${cls}">${i + 1}</span><span>${esc(qLabel(it.q))}<small>${extra}Richtig: ${rightText(it)} · ${esc(it.q.origin.join(', '))}</small></span></button>`;
  return `
  <section class="result-head">
    <div class="ring ${passed ? '' : 'fail'}">
      <svg viewBox="0 0 170 170"><circle class="track" cx="85" cy="85" r="${r}"/><circle class="val" cx="85" cy="85" r="${r}" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - sc / total)}"/></svg>
      <div class="num"><div><b>${sc}/${total}</b><br><span>${pct} % richtig</span></div></div>
    </div>
    <div>
      <div class="eyebrow">Auswertung · ${esc(s.title)}${s.sim ? ' · Prüfungssimulation' : ''}</div>
      <div class="verdict-big ${passed ? 'ok' : 'bad'}">${passed ? 'Bestanden' : 'Nicht bestanden'}</div>
      <p class="lead" style="margin-bottom:var(--space-4)">${passed
        ? `Du hast ${sc} von ${total} Fragen richtig beantwortet – die Bestehensgrenze liegt bei ${pass} (${PASS_PCT} %).`
        : `Du hast ${sc} von ${total} Fragen richtig beantwortet. Für das Bestehen fehlen dir noch ${pass - sc} richtige Antwort${pass - sc === 1 ? '' : 'en'} (Grenze: ${pass}).`}
        ${s.timeout ? ` Die Zeit ist abgelaufen – die ${noun} wurde automatisch abgegeben.` : ''}
        ${time}
      </p>
      <div class="nav" style="margin-top:0">
        ${s.past ? '<button class="btn" id="backToProgress">← Lernfortschritt</button>' : ''}
        <button class="btn primary" id="restartBtn">Neue ${s.mode === 'exam' ? 'Prüfung' : 'Übung'} starten</button>
        <button class="btn" id="reviewAllBtn">Alle Fragen durchsehen</button>
        <button class="btn" id="reportBtn">⤓ Bericht herunterladen</button>
      </div>
      <p class="time-note">${s.past ? `Durchlauf vom ${fmtDate(s.date)}.` : s.saved
        ? 'Dieser Durchlauf ist im Lernfortschritt gespeichert. Der Bericht enthält alle Fragen mit Lösungen und Begründungen zum Offline-Lernen.'
        : 'Achtung: Dieser Durchlauf konnte nicht gespeichert werden (Browser-Speicher nicht verfügbar). Lade den Bericht herunter, um ihn zu behalten.'}</p>
    </div>
  </section>
  ${s.past ? '' : `<div class="backup-hint"><p><b>Lernfortschritt sichern</b>Der Verlauf liegt nur in diesem Browser. Lade eine Sicherung herunter und lege sie z. B. in iCloud, Google Drive oder OneDrive ab – für ein anderes Gerät oder falls Browserdaten gelöscht werden.</p>${state.notice === 'Sicherung erstellt.' ? (state.notice = null, '<span class="backup-done">✓ Sicherung erstellt</span>') : '<button class="btn" data-backup>⤓ Sicherung herunterladen</button>'}</div>`}

  ${Object.keys(topics).length ? `<h2 class="section-title">Ergebnis nach Themenbereich</h2>
  <div class="topic-list">
    ${Object.entries(topics).map(([t, v]) => `<div class="topic-row"><span>${esc(t)} <span style="color:var(--text-muted)">(${v.c}/${v.n})</span></span><div class="bar"><i style="width:${v.c / v.n * 100}%"></i></div><span class="pct">${Math.round(v.c / v.n * 100)} %</span></div>`).join('')}
  </div>${s.mode === 'training' && Object.values(topics).reduce((a, v) => a + v.n, 0) < total ? '<p class="time-note">Mock-Fragen ohne Themenzuordnung sind hier nicht enthalten.</p>' : ''}` : ''}

  ${wrong.length ? `<h2 class="section-title">Falsch beantwortet (${wrong.length})</h2>
  <div class="review">${wrong.map(w => line(w, 'bad', `Deine Antwort: ${shown(w.it, s.answers[w.it.q.id])} · `)).join('')}</div>` : ''}

  ${open.length ? `<h2 class="section-title">Nicht beantwortet (${open.length})</h2>
  <div class="review">${open.map(o => line(o, 'skip', '')).join('')}</div>` : ''}

  ${!wrong.length && !open.length ? `<p class="lead" style="margin-top:var(--space-6)">Alle ${total} Fragen richtig – volle Punktzahl.</p>` : ''}`;
}

/* Sicherungsknopf für Fenster; nach dem Herunterladen Bestätigung statt Knopf */
const backupBtn = (label = '⤓ Sicherung herunterladen') => state.modal?.backedUp
  ? '<span class="backup-done">✓ Sicherung erstellt</span>' : `<button class="btn" data-backup>${label}</button>`;
const BACKUP_HINT = 'Die Datei enthält deinen Lernfortschritt und diesen Durchlauf. Lege sie z. B. in iCloud, Google Drive oder OneDrive ab, um auf einem anderen Gerät oder nach dem Löschen der Browserdaten weiterzumachen.';
function runInfo(d, newer){
  const done = Object.keys(d.answers || {}).filter(id => d.items.some(x => x.id === id)).length;
  return `<strong>${esc(d.title)}</strong>${d.sim ? ' · Prüfungssimulation' : ''}<br>${done} von ${d.items.length} Fragen beantwortet · ${d.limit ? `Restzeit ${fmt(d.limit - d.elapsed)}` : `Dauer bisher ${fmt(d.elapsed)}`}<br>Stand vom ${fmtDate(d.savedAt)}${newer ? ' · <b>neuer</b>' : ''}`;
}
function viewModal(){
  if(state.modal.type === 'stay'){ const noun = state.session.mode === 'exam' ? 'Prüfung' : 'Übung'; return `<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="stayTitle"><div class="card">
    <h2 id="stayTitle">Fortschritt sichern?</h2>
    <p>Deine ${noun} ist in diesem Browser zwischengespeichert und lässt sich nach dem Neuladen fortsetzen. Sicherer ist eine Sicherungsdatei: Sie enthält deinen Lernfortschritt und diesen Durchlauf. Lege sie z. B. in iCloud, Google Drive oder OneDrive ab, um auf einem anderen Gerät oder nach dem Löschen der Browserdaten weiterzumachen.</p>
    <div class="nav">${backupBtn()}<span class="spacer"></span><button class="btn primary" id="modalStay">Weiter üben</button></div>
  </div></div>`; }
  if(state.modal.type === 'choose'){ const m = state.modal; return `<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="chooseTitle"><div class="card">
    <h2 id="chooseTitle">Welchen Durchlauf fortsetzen?</h2>
    <p>Die Sicherung enthält einen unterbrochenen Durchlauf – auf diesem Gerät ist aber schon ein anderer unterbrochen. Nur einer kann fortgesetzt werden, der andere wird verworfen.</p>
    <p><b>Aus der Sicherung:</b><br>${runInfo(m.fromFile, m.fromFile.savedAt > m.local.savedAt)}</p>
    <p><b>Auf diesem Gerät:</b><br>${runInfo(m.local, m.local.savedAt > m.fromFile.savedAt)}</p>
    <div class="nav"><button class="btn" id="modalPickLocal">Stand auf diesem Gerät</button><span class="spacer"></span><button class="btn primary" id="modalPickFile">Stand aus der Sicherung</button></div>
  </div></div>`; }
  if(state.modal.type === 'restore'){
    const d = state.modal.saved, noun = d.mode === 'exam' ? 'Prüfung' : 'Übung';
    const done = Object.keys(d.answers || {}).filter(id => d.items.some(x => x.id === id)).length;
    const timeInfo = d.limit ? `Restzeit ${fmt(d.limit - d.elapsed)}` : `Dauer bisher ${fmt(d.elapsed)}`;
    return `<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="restoreTitle"><div class="card">
    <h2 id="restoreTitle">Unterbrochene ${noun} ${state.modal.fromFile ? 'aus der Sicherung ' : ''}fortsetzen?</h2>
    <p><strong>${esc(d.title)}</strong>${d.sim ? ' · Prüfungssimulation' : ''}<br>${done} von ${d.items.length} Fragen beantwortet · ${timeInfo}<br>
      Unterbrochen am ${fmtDate(d.savedAt)}. Die Zeit ist seitdem angehalten.</p>
    <div class="nav"><button class="btn danger" id="modalDiscard">Verwerfen</button><span class="spacer"></span><button class="btn primary" id="modalRestore">Fortsetzen</button></div>
  </div></div>`;
  }
  if(state.modal.type === 'pause'){
    const s = state.session, noun = s.mode === 'exam' ? 'Prüfung' : 'Übung';
    const timeInfo = s.limit ? `Restzeit <b>${fmt(s.limit - s.elapsed)}</b> · bisher ${fmt(s.elapsed)}` : `Dauer bisher <b>${fmt(s.elapsed)}</b>`;
    return `<div class="modal pause" id="modal" role="dialog" aria-modal="true" aria-labelledby="pauseTitle"><div class="card">
    <div class="pause-ico"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg></div>
    <h2 id="pauseTitle">${noun} pausiert</h2>
    <p>Die Zeit ist angehalten. ${timeInfo}<br>${Object.keys(s.answers).length} von ${s.items.length} Fragen beantwortet.</p>
    <div class="nav"><button class="btn primary" id="modalResume">Weitermachen</button></div>
    <div class="pause-backup">${backupBtn()}<p class="time-note">${BACKUP_HINT}</p></div>
  </div></div>`;
  }
  if(state.modal.type === 'leave'){ const noun = state.session.mode === 'exam' ? 'Prüfung' : 'Übung'; return `<div class="modal" id="modal"><div class="card">
    <h2>${noun} abbrechen?</h2>
    <p>Du bist mitten in einer ${noun}. Wenn du zur Startseite wechselst, wird dieser Durchlauf <strong>nicht gespeichert</strong>. Willst du ihn behalten, gib ihn zuerst ab – oder lade eine Sicherung herunter, um ihn später oder auf einem anderen Gerät fortzusetzen.</p>
    <div class="nav">${backupBtn()}<span class="spacer"></span><button class="btn" id="modalCancel">Weiter bearbeiten</button><button class="btn primary danger" id="modalLeave">${noun} abbrechen</button></div>
  </div></div>`; }
  if(state.modal.type === 'clear') return `<div class="modal" id="modal"><div class="card">
    <h2>Gesamten Verlauf löschen?</h2>
    <p>Alle ${HISTORY.length} gespeicherten Durchläufe werden aus diesem Browser entfernt. Das lässt sich nicht rückgängig machen – lade vorher eine Sicherung herunter, wenn du ihn behalten willst.</p>
    <div class="nav"><button class="btn" id="modalCancel">Abbrechen</button><span class="spacer"></span><button class="btn primary danger" id="modalClear">Verlauf löschen</button></div>
  </div></div>`;
  const noun = state.session.mode === 'exam' ? 'Prüfung' : 'Übung';
  return `<div class="modal" id="modal"><div class="card">
    <h2>${noun} wirklich abgeben?</h2>
    <p>Du hast noch <strong>${state.modal.open}</strong> ${state.modal.open === 1 ? 'Frage' : 'Fragen'} nicht beantwortet. Unbeantwortete Fragen zählen als falsch.</p>
    <div class="nav"><button class="btn" id="modalCancel">Weiter bearbeiten</button><span class="spacer"></span><button class="btn primary" id="modalOk">Jetzt abgeben</button></div>
  </div></div>`;
}

/* ---------- Lernfortschritt ---------- */
const progressFilter = { pmode: 'all', psim: 'all' };
function showProgress(){ stopTimer(); timer.hidden = true; state.reviewMode = false; state.view = 'progress'; render(); window.scrollTo(0, 0); }
function openRun(id){
  const run = HISTORY.find(r => r.id === id); if(!run) return;
  state.session = sessionFromRun(run); state.reviewMode = false; state.view = 'result'; render(); window.scrollTo(0, 0);
}
const runPct = run => Math.round(run.score / run.total * 100);
const runPassed = run => run.score >= passMark(run.total);

function progressChart(runs){
  if(runs.length < 2) return `<p class="time-note">Das Diagramm erscheint ab zwei Durchläufen.</p>`;
  // Breite an den verfügbaren Platz anpassen, damit die Beschriftung auf dem Handy lesbar bleibt (1:1 statt verkleinert)
  const W = Math.max(300, Math.min(900, (app.clientWidth || 680) - 40)), H = 230, L = 40, R = 14, T = 14, B = 30;
  const x = i => L + i / (runs.length - 1) * (W - L - R);
  const y = p => T + (1 - p / 100) * (H - T - B);
  const grid = [0, 20, 40, 60, 80, 100].map(p => `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" class="grid"/><text x="${L - 8}" y="${y(p) + 4}" text-anchor="end" class="axis">${p} %</text>`).join('');
  const pts = runs.map((r, i) => `${x(i).toFixed(1)},${y(runPct(r)).toFixed(1)}`).join(' ');
  const step = Math.ceil(runs.length / 10);
  const xl = runs.map((r, i) => (i % step === 0 || i === runs.length - 1) ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" class="axis">${i + 1}</text>` : '').join('');
  const dots = runs.map((r, i) => `<circle cx="${x(i)}" cy="${y(runPct(r))}" r="5" class="${runPassed(r) ? 'dot-ok' : 'dot-bad'}"><title>${fmtDate(r.date)} · ${esc(r.title)} · ${r.score}/${r.total} (${runPct(r)} %)</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ergebnis in Prozent je Durchlauf">
    ${grid}
    <line x1="${L}" x2="${W - R}" y1="${y(PASS_PCT)}" y2="${y(PASS_PCT)}" class="passline"/>
    <polyline points="${pts}" class="line"/>${dots}${xl}
  </svg>
  <div class="legend chart-legend">
    <span><i class="lg-pass"></i> Bestehensgrenze ${PASS_PCT} %</span>
    <span><i style="background:var(--ok);border-color:var(--ok);border-radius:999px"></i> bestanden</span>
    <span><i style="background:var(--bad);border-color:var(--bad);border-radius:999px"></i> nicht bestanden</span>
    <span>Waagerecht: Durchläufe in zeitlicher Reihenfolge</span>
  </div>`;
}

/* Kleines „?“ mit Erklärung: erscheint beim Darüberfahren/Fokus (CSS) und beim Antippen (Klasse .open, siehe bind) */
const tip = (id, label, text) => `<span class="tip"><button type="button" class="tip-btn" aria-label="Erklärung: ${esc(label)}" aria-expanded="false" aria-describedby="${id}" data-tip>?</button><span class="tip-text" role="tooltip" id="${id}">${esc(text)}</span></span>`;

function viewProgress(){
  const notice = state.notice; state.notice = null;
  const backup = `<div class="card backup">
      <h2>Datensicherung</h2>
      <p class="time-note">Verlauf, Einstellungen und ein unterbrochener Durchlauf liegen nur in diesem Browser auf diesem Gerät. Lade eine Sicherung herunter (z. B. nach iCloud, Google Drive oder OneDrive), um sie gegen gelöschte Browserdaten zu schützen oder auf ein anderes Gerät mitzunehmen. Beim Laden werden Verläufe zusammengeführt, die Einstellungen übernommen und ein unterbrochener Durchlauf zum Fortsetzen angeboten.<br>
        ${lastBackup() ? `Letzte Sicherung: ${fmtDate(lastBackup())}` : 'Noch keine Sicherung erstellt.'}</p>
      <div class="nav">
        <button class="btn" data-backup>⤓ Sicherung herunterladen</button>
        <button class="btn" id="importBtn">⤒ Sicherung laden</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
        <span class="spacer"></span>
        <button class="btn danger" id="clearBtn" ${HISTORY.length ? '' : 'disabled'}>Verlauf löschen</button>
      </div>
    </div>`;
  const head = `<div class="eyebrow">Lernfortschritt</div><h1>Dein Lernfortschritt</h1>
    ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}`;
  if(!HISTORY.length) return `${head}
    <div class="card empty">
      <h2>Noch keine Durchläufe gespeichert</h2>
      <p class="lead">Starte eine Prüfung oder ein Training. Jeder abgegebene Durchlauf erscheint hier mit Ergebnis, Dauer und allen Antworten – und lässt sich jederzeit erneut ansehen oder als Bericht herunterladen.</p>
      <button class="btn primary" id="homeBtn">Zur Startseite</button>
    </div>${backup}`;

  const runs = [...HISTORY].sort(byDate).filter(r =>
    (progressFilter.pmode === 'all' || r.mode === progressFilter.pmode) && (progressFilter.psim === 'all' || r.sim));
  const avg = runs.length ? Math.round(runs.reduce((a, r) => a + runPct(r), 0) / runs.length) : 0;
  // Quote der beantworteten Fragen: gewichtet über alle Antworten der gefilterten Durchläufe (offene Fragen ausgeschlossen),
  // damit ein kurzes Training nicht so viel zählt wie eine ganze Prüfung. „Bestanden“ und „Ø richtig“ bleiben bei der
  // Prüfungsregel (offen = falsch).
  const answeredAll = runs.flatMap(r => r.items.filter(x => x.a && BY_ID[x.id]));
  const answeredOk = answeredAll.filter(x => isRight(BY_ID[x.id], x.a)).length;
  const passedN = runs.filter(runPassed).length;
  const seen = new Set(HISTORY.flatMap(r => r.items.filter(x => x.a && BY_ID[x.id]).map(x => x.id)));   // nur Fragen, die es im Katalog noch gibt
  const qst = questionStatus();
  const errN = sourcePool('errors', qst).length, flagN = sourcePool('flagged', qst).length;

  // Statistik je Frage und Thema (über die gefilterten Durchläufe)
  const stat = {}, topics = {};
  runs.forEach(r => r.items.forEach(x => {
    const q = BY_ID[x.id]; if(!q) return;
    const ok = isRight(q, x.a), st = stat[x.id] ||= { n: 0, wrong: 0 };
    if(x.a){ st.n++; if(!ok) st.wrong++; }   // „Am häufigsten falsch“: nur beantwortete Vorlagen
    if(q.topic){ const t = topics[q.topic] ||= { c: 0, n: 0 }; t.n++; if(ok) t.c++; }
  }));
  const hard = Object.entries(stat).filter(([, v]) => v.wrong > 0)
    .sort((a, b) => b[1].wrong - a[1].wrong || b[1].wrong / b[1].n - a[1].wrong / a[1].n).slice(0, 10);

  const seg = (name, val, opts) => `<div class="seg small" role="radiogroup">${opts.map(([v, t]) =>
    `<label class="seg-opt"><input type="radio" name="${name}" value="${v}" data-pfilter ${val === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>`;

  return `${head}
  <div class="filters">
    ${seg('pmode', progressFilter.pmode, [['all', 'Alle'], ['exam', 'Reale Prüfung'], ['training', 'Training']])}
    ${seg('psim', progressFilter.psim, [['all', 'Mit und ohne Simulation'], ['sim', 'Nur Simulation']])}
  </div>
  <div class="facts five">
    <div class="fact"><b>${runs.length}</b><span>Durchläufe</span></div>
    <div class="fact"><b>${runs.length ? `Ø ${avg} %` : '–'}</b><span>(Prüfungswertung)${tip('tipExam', 'Prüfungswertung',
      `Durchschnitt der Ergebnisse aller angezeigten Durchläufe. Unbeantwortete Fragen zählen als falsch – wie in der echten Prüfung. Danach richtet sich auch „bestanden“.`)}</span></div>
    <div class="fact"><b>${answeredAll.length ? `Ø ${Math.round(answeredOk / answeredAll.length * 100)} %` : '–'}</b><span>(Trainingswertung)${tip('tipTrain', 'Trainingswertung',
      `Anteil richtiger Antworten an allen beantworteten Fragen: ${answeredOk} von ${answeredAll.length}. Unbeantwortete Fragen bleiben außen vor – das zeigt den reinen Wissensstand, unabhängig von der Zeit.`)}</span></div>
    <div class="fact"><b>${passedN} / ${runs.length}</b><span>bestanden</span></div>
    <div class="fact"><b>${seen.size} / ${CATALOG.length}</b><span>Katalogfragen bearbeitet</span></div>
  </div>

  <h2 class="section-title">Ergebnis je Durchlauf</h2>
  ${runs.length ? progressChart(runs) : '<p class="time-note">Keine Durchläufe für diesen Filter.</p>'}

  <div class="card errcard">
    <div><b>${errN} Fehlerfrage${errN === 1 ? '' : 'n'} · ${flagN} markierte Frage${flagN === 1 ? '' : 'n'}</b><span>Fehlerfragen: zuletzt falsch beantwortet (offen gelassene zählen nicht). Markiert: beim letzten Vorkommen markiert.</span></div>
    <span class="run-actions"><button class="btn primary" data-train="errors" ${errN ? '' : 'disabled'}>Fehlertraining</button><button class="btn" data-train="flagged" ${flagN ? '' : 'disabled'}>Markierte üben</button></span>
  </div>

  <h2 class="section-title">Alle Durchläufe (${runs.length})</h2>
  <div class="runs">${[...runs].reverse().map(r => `
    <div class="run">
      <span class="n ${runPassed(r) ? 'ok' : 'bad'}">${runPct(r)}%</span>
      <span class="run-main"><b>${esc(r.title)}</b>
        <small>${fmtDate(r.date)} · ${r.score}/${r.total} richtig · ${runPassed(r) ? 'bestanden' : 'nicht bestanden'} · ${fmt(r.elapsed)} min${r.sim ? ' · Simulation' : ''}${r.timeout ? ' · Zeit abgelaufen' : ''}</small></span>
      ${r.items.some(x => BY_ID[x.id])
        ? `<span class="run-actions"><button class="btn" data-run="${r.id}">Ansehen</button><button class="btn" data-run-report="${r.id}" aria-label="Bericht herunterladen">⤓ Bericht</button></span>`
        : `<small class="run-actions">Fragen nicht mehr im Katalog<br>(ersetzte Fassung)</small>`}
    </div>`).join('')}</div>

  ${Object.keys(topics).length ? `<h2 class="section-title">Ergebnis nach Themenbereich</h2>
  <div class="topic-list">${Object.entries(topics).sort((a, b) => a[1].c / a[1].n - b[1].c / b[1].n).map(([t, v]) => `<div class="topic-row"><span>${esc(t)} <span style="color:var(--text-muted)">(${v.c}/${v.n})</span></span><div class="bar"><i style="width:${v.c / v.n * 100}%"></i></div><span class="pct">${Math.round(v.c / v.n * 100)} %</span></div>`).join('')}</div>
  <p class="time-note">Sortiert vom schwächsten zum stärksten Bereich. Fragen ohne Themenzuordnung sind nicht enthalten.</p>` : ''}

  ${hard.length ? `<h2 class="section-title">Am häufigsten falsch</h2>
  <div class="review">${hard.map(([id, v]) => { const q = BY_ID[id]; return `<div class="rv static"><span class="n bad">${v.wrong}×</span><span>${esc(qLabel(q))}<small>${v.wrong} von ${v.n} Mal falsch beantwortet · ${id} · ${esc(q.origin.join(', '))}</small></span></div>`; }).join('')}</div>` : ''}

  ${backup}`;
}

/* ---------- Sicherung: alle Daten als eine Datei ----------
   Enthält Verlauf, Einstellungen und – falls vorhanden – den laufenden bzw. unterbrochenen Durchlauf. Damit lässt sich der
   Stand gegen gelöschte Browserdaten sichern und auf ein anderes Gerät mitnehmen. Auf Handy/Tablet öffnet sich das
   Teilen-Menü (iCloud, Google Drive, OneDrive …), sonst ein normaler Download. Dateiformat v2; Exporte v1 (nur
   Durchläufe) und ältere reine Listen werden weiter gelesen. */
const BACKUP_KEY = CFG.storagePrefix + 'backupAt';
const lastBackup = () => { try { return localStorage.getItem(BACKUP_KEY); } catch(e) { return null; } };
function backupData(){
  let current = null;
  if(isRunning()) current = currentSnapshot();
  else try { current = JSON.parse(localStorage.getItem(CURRENT_KEY) || 'null'); } catch(e) {}
  return { app: CFG.appId, kind: 'backup', version: 2, exported: new Date().toISOString(), runs: HISTORY, settings, current };
}
function backupName(d){
  const p = n => String(n).padStart(2, '0');
  return `${CFG.reportPrefix}-Sicherung_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
}
function saveBackup(){
  const data = backupData(), name = backupName(new Date(data.exported)), json = JSON.stringify(data, null, 1);
  const done = () => {
    try { localStorage.setItem(BACKUP_KEY, data.exported); } catch(e) {}
    if(state.modal) state.modal.backedUp = true; else state.notice = 'Sicherung erstellt.';
    render();
  };
  // Teilen-Menü nur auf Touch-Geräten – am PC ist der Download erwartbarer
  const file = typeof File === 'function' ? new File([json], name, { type: 'application/json' }) : null;
  if(file && matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })){
    navigator.share({ files: [file], title: name }).then(done).catch(err => {
      if(err && err.name === 'AbortError') return;          // im Teilen-Menü abgebrochen
      download(name, json, 'application/json'); done();
    });
    return;
  }
  download(name, json, 'application/json'); done();
}
function loadBackup(file){
  if(!file) return;
  let restore = null;
  file.text().then(text => {
    const data = JSON.parse(text);
    // Nur Dateien dieser App annehmen – sonst könnten Verläufe einer anderen Trainer-App (andere Fragen) hineingeraten
    if(!Array.isArray(data) && data.app && data.app !== CFG.appId) throw new Error(`Datei stammt aus „${data.app}“, nicht aus dieser App`);
    const runs = Array.isArray(data) ? data : data.runs;
    if(!Array.isArray(runs)) throw new Error('keine Durchläufe gefunden');
    const valid = runs.filter(r => r && typeof r.id === 'string' && typeof r.date === 'string' && Array.isArray(r.items) && r.total > 0);
    const known = new Set(HISTORY.map(r => r.id));
    const fresh = valid.filter(r => !known.has(r.id));
    HISTORY = [...HISTORY, ...fresh];
    const ok = store.save(HISTORY);
    const msg = [`${fresh.length} ${fresh.length === 1 ? 'Durchlauf' : 'Durchläufe'} übernommen${valid.length - fresh.length ? `, ${valid.length - fresh.length} ${valid.length - fresh.length === 1 ? 'war' : 'waren'} schon vorhanden` : ''}${runs.length - valid.length ? `, ${runs.length - valid.length} ungültig übersprungen` : ''}.`];
    // Einstellungen übernehmen (Entscheidung Felix 27.10.2026) – über loadSettings, damit ungültige Werte abgefangen werden
    if(data.settings && typeof data.settings === 'object'){
      try { localStorage.setItem(CFG.storagePrefix + 'settings', JSON.stringify(data.settings)); } catch(e) {}
      Object.assign(settings, loadSettings()); saveSettings(); msg.push('Einstellungen übernommen.');
    }
    const cur = checkCurrent(data.current);
    if(cur){
      const local = loadCurrent();
      restore = local && local.savedAt !== cur.savedAt ? { type: 'choose', fromFile: cur, local } : { type: 'restore', saved: cur, fromFile: true };
    } else if(data.current) msg.push('Der unterbrochene Durchlauf passt nicht mehr zum Fragenkatalog und wurde nicht übernommen.');
    state.notice = msg.join(' ') + (ok ? '' : ' Achtung: Speichern im Browser nicht möglich.');
  }).catch(err => { state.notice = `Laden fehlgeschlagen: Die Datei ist keine gültige Sicherung dieser App (${err.message}).`; })
    .finally(() => { state.modal = restore; render(); });
}
/* Unterbrochenen Durchlauf übernehmen: in den Browser-Speicher schreiben, dann wie nach dem Neuladen fortsetzen */
function adoptCurrent(d){ try { localStorage.setItem(CURRENT_KEY, JSON.stringify(d)); } catch(e) {} restoreCurrent(d); }

/* ---------- Bindings ---------- */
function bind(){
  const $ = id => document.getElementById(id);
  const $c = (name, fn) => document.querySelectorAll(`input[name="${name}"]`).forEach(fn);
  const change = (fn, focusSel) => e => { fn(e); saveSettings(); render(); const el = focusSel && document.querySelector(focusSel); el && el.focus(); };
  document.querySelectorAll('input[name="mode"]').forEach(r => r.onchange = change(() => settings.mode = r.value, `input[name="mode"][value="${r.value}"]`));
  document.querySelectorAll('input[name="exam"]').forEach(r => r.onchange = change(() => settings.exam = r.value, `input[name="exam"][value="${r.value}"]`));
  const cr = $('countRange');
  if(cr){
    const max = Number(cr.max);
    const min = Number(cr.min);
    cr.oninput = () => { const v = Number(cr.value), t = countLabel(v, max); $('countOut').textContent = t; cr.setAttribute('aria-valuetext', t);
      cr.style.setProperty('--p', ((v - min) / (max - min || 1) * 100).toFixed(2) + '%'); };
    cr.onchange = change(() => { const v = Number(cr.value); settings.count = v >= max ? 0 : v; }, '#countRange');
  }
  $('optSim') && ($('optSim').onchange = change(e => (settings.mode === 'exam' ? settings.examOpts : settings.trainingOpts).sim = e.target.checked, '#optSim'));
  $('optShuffle') && ($('optShuffle').onchange = change(e => settings.examOpts.shuffle = e.target.checked, '#optShuffle'));
  document.querySelectorAll('input[name="topic"]').forEach(r => r.onchange = change(() => {
    const t = new Set(chosenTopics()); r.checked ? t.add(r.value) : t.delete(r.value);
    // Alle Themen einzeln gewählt = „Alle“ (gleiches Ergebnis, eindeutigere Anzeige)
    settings.trainingOpts.topics = t.size === topicList().length ? [] : topicList().filter(x => t.has(x));
  }, `input[name="topic"][value="${CSS.escape(r.value)}"]`));

  $c('qsrc', r => r.onchange = change(() => {
    const e = new Set(chosenExams()); r.checked ? e.add(r.value) : e.delete(r.value);
    // Alle Prüfungen einzeln gewählt = „Alle“
    settings.trainingOpts.exams = e.size === EXAMS.length ? [] : EXAMS.map(x => x.code).filter(c => e.has(c));
  }, `input[name="qsrc"][value="${CSS.escape(r.value)}"]`));
  $c('topicAll', r => r.onchange = change(() => settings.trainingOpts.topics = [], 'input[name="topicAll"]'));
  $c('qsrcAll', r => r.onchange = change(() => settings.trainingOpts.exams = [], 'input[name="qsrcAll"]'));
  document.querySelectorAll('[data-ftoggle]').forEach(b => b.onclick = () => { state.filterOpen = !(b.getAttribute('aria-expanded') === 'true'); render(); document.querySelector('[data-ftoggle]').focus(); });
  document.querySelectorAll('[data-freset]').forEach(b => b.onclick = () => { Object.assign(settings.trainingOpts, { source: 'all', topics: [], exams: [] }); saveSettings(); render(); document.querySelector('[data-ftoggle]').focus(); });
  document.querySelectorAll('input[name="source"]').forEach(r => r.onchange = change(() => settings.trainingOpts.source = r.value, `input[name="source"][value="${r.value}"]`));
  $('reportBtn') && ($('reportBtn').onclick = () => downloadReport(state.session));
  $('backToProgress') && ($('backToProgress').onclick = showProgress);
  document.querySelectorAll('[data-run]').forEach(b => b.onclick = () => openRun(b.dataset.run));
  document.querySelectorAll('[data-run-report]').forEach(b => b.onclick = () => { const run = HISTORY.find(r => r.id === b.dataset.runReport); run && downloadReport(sessionFromRun(run)); });
  document.querySelectorAll('[data-pfilter]').forEach(b => b.onchange = () => { progressFilter[b.name] = b.value; render(); });
  document.querySelectorAll('[data-train]').forEach(b => b.onclick = () => { settings.mode = 'training'; settings.trainingOpts.source = b.dataset.train; settings.trainingOpts.topics = []; settings.trainingOpts.exams = []; saveSettings(); state.view = 'start'; render(); window.scrollTo(0, 0); });
  document.querySelectorAll('[data-backup]').forEach(b => b.onclick = saveBackup);
  $('importBtn') && ($('importBtn').onclick = () => $('importFile').click());
  $('importFile') && ($('importFile').onchange = e => loadBackup(e.target.files[0]));
  $('modalStay') && ($('modalStay').onclick = () => { state.modal = null; render(); });
  $('modalPickFile') && ($('modalPickFile').onclick = () => adoptCurrent(state.modal.fromFile));
  $('modalPickLocal') && ($('modalPickLocal').onclick = () => adoptCurrent(state.modal.local));
  $('clearBtn') && ($('clearBtn').onclick = () => { state.modal = { type: 'clear' }; render(); });
  $('modalClear') && ($('modalClear').onclick = () => { HISTORY = []; store.save(HISTORY); state.modal = null; state.notice = 'Verlauf gelöscht.'; render(); });
  $('startBtn') && ($('startBtn').onclick = start);
  document.querySelectorAll('[data-choose]').forEach(b => b.onclick = () => choose(b.dataset.choose));
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => go(state.pos + Number(b.dataset.nav)));
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(Number(b.dataset.go)));
  document.querySelectorAll('[data-flag]').forEach(b => b.onclick = toggleFlag);
  document.querySelectorAll('[data-confirm]').forEach(b => b.onclick = confirmAnswer);
  document.querySelectorAll('[data-scen]').forEach(b => b.onclick = () => setScen(!state.scenOpen));
  document.querySelectorAll('[data-tip]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const open = !b.parentElement.classList.contains('open');
    closeTips(); b.parentElement.classList.toggle('open', open); b.setAttribute('aria-expanded', open);
  });
  document.querySelectorAll('[data-finish]').forEach(b => b.onclick = askFinish);
  document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => { state.view = 'result'; render(); window.scrollTo(0, 0); });
  document.querySelectorAll('[data-review]').forEach(b => b.onclick = () => review(Number(b.dataset.review)));
  ['finishBtn', 'finishBtn2'].forEach(id => $(id) && ($(id).onclick = askFinish));
  ['backToResult', 'backToResult2'].forEach(id => $(id) && ($(id).onclick = () => { state.view = 'result'; render(); window.scrollTo(0, 0); }));
  $('restartBtn') && ($('restartBtn').onclick = () => { state.reviewMode = false; state.view = 'start'; render(); window.scrollTo(0, 0); });
  $('homeBtn') && ($('homeBtn').onclick = () => { state.view = 'start'; render(); window.scrollTo(0, 0); });
  $('reviewAllBtn') && ($('reviewAllBtn').onclick = () => review(0));
  $('modalCancel') && ($('modalCancel').onclick = () => { state.modal = null; render(); });
  $('modalOk') && ($('modalOk').onclick = finish);
  $('modalLeave') && ($('modalLeave').onclick = () => goHome(true));
  $('modalResume') && ($('modalResume').onclick = resumeSession);
  $('modalRestore') && ($('modalRestore').onclick = () => state.modal.fromFile ? adoptCurrent(state.modal.saved) : restoreCurrent(state.modal.saved));
  $('modalDiscard') && ($('modalDiscard').onclick = () => { if(!state.modal.fromFile) clearCurrent(); state.modal = null; render(); });
}

/* Offene Erklärungen schließen: Klick daneben oder Esc */
function closeTips(){ document.querySelectorAll('.tip.open').forEach(t => { t.classList.remove('open'); t.querySelector('[data-tip]').setAttribute('aria-expanded', 'false'); }); }
document.addEventListener('click', closeTips);
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeTips(); });

/* Tastatur: A–F wählen (angezeigte Buchstaben der aktuellen Frage), Enter bestätigt (ohne Simulation), Pfeile navigieren, Esc schließt das Szenario */
document.addEventListener('keydown', e => {
  if(state.view !== 'exam' || state.modal) return;
  if(e.target.closest && e.target.closest('input, textarea')) return;
  if(e.key === 'Escape' && state.scenOpen){ setScen(false); return; }
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toUpperCase();
  if(LETTERS.slice(0, current().perm.length).includes(k)) choose(k);
  else if(e.key === 'Enter' && !state.session.sim && !state.reviewMode && state.session.pending?.[current().q.id]){ e.preventDefault(); confirmAnswer(); }
  else if(e.key === 'ArrowRight') go(state.pos + 1);
  else if(e.key === 'ArrowLeft') go(state.pos - 1);
});

document.title = CFG.appTitle;
/* Kopfzeile: Logo + „Startseite“ = Home; Links zu verwandten Apps (neuer Tab, damit ein laufender Durchlauf erhalten bleibt) */
const EXT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
document.getElementById('appLinks').innerHTML = (CFG.otherApps || []).map(a =>
  `<a class="app-link" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.title || a.label)}" aria-label="${esc(a.label)} (öffnet in neuem Tab)"><span class="brand-word">${esc(a.label)}</span>${EXT_ICON}</a>`).join('');
document.getElementById('brandWord').textContent = CFG.brandWord || '';
if(CFG.brandColor) document.documentElement.style.setProperty('--brand', CFG.brandColor);
function goHome(force = false){
  // Während einer laufenden Prüfung/Übung erst nachfragen – der Durchlauf würde sonst verloren gehen
  if(!force && state.view === 'exam' && !state.reviewMode && state.session && !state.session.past){ state.modal = { type: 'leave' }; render(); return; }
  if(isRunning()) clearCurrent();                         // bewusst abgebrochen → Sicherung verwerfen
  stopTimer(); timer.hidden = true; state.reviewMode = false; state.modal = null; state.view = 'start'; render(); window.scrollTo(0, 0);
}
document.getElementById('homeLogo').onclick = () => goHome();
let LOGO_DATA = '';
if(CFG.logo) fetch(CFG.logo).then(r => r.ok ? r.blob() : null).then(b => {
  if(!b) return; const fr = new FileReader(); fr.onload = () => { LOGO_DATA = fr.result; }; fr.readAsDataURL(b);
}).catch(() => {});
if(CFG.logo){                                              // eigenes Logo statt des eingebauten SVG
  const img = new Image(32, 32); img.src = CFG.logo; img.alt = ''; img.className = 'logo-img';
  img.onerror = () => img.remove();                        // Datei fehlt → Standard-Logo bleibt
  img.onload = () => document.querySelector('#homeLogo svg')?.remove();
  document.getElementById('homeLogo').prepend(img);
}

/* ---------- Theme ---------- */
let theme = document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function applyTheme(){
  document.documentElement.dataset.theme = theme;
  iconSun.hidden = theme === 'dark'; iconMoon.hidden = theme !== 'dark';
}
themeBtn.onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); };
applyTheme();
progressBtn.onclick = () => state.view === 'progress' ? goHome() : showProgress();

render();
loadCatalog();
