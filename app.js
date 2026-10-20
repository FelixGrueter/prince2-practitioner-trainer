/* Prüfungstrainer – generische App-Logik (abgeleitet vom PRINCE2 Foundation Trainer, Stand 20.10.2026)
   Alles Prüfungsspezifische steht in config.js (window.APP_CONFIG).
   Datenbasis: data/katalog.json (ein Eintrag pro Frage, siehe README „Datenmodell“).
   Änderungshistorie und Begründungen: docs/PROTOKOLL.md */

/* ---------- Konstanten aus der Konfiguration ---------- */
const CFG = window.APP_CONFIG;
const EXAMS = CFG.exams;
const COUNTS = CFG.counts;
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
  count: 20,
  examOpts: { sim: true, shuffle: false },   // Reale Prüfung: Simulation standardmäßig an, Mischen aus
  scenDesk: false,                           // Szenario-Seitenleiste am Desktop beim Start einer Prüfung geöffnet
  trainingOpts: { sim: false, source: 'all' },  // Trainieren: immer gemischt; Fragenquelle siehe SOURCES
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
    delete t.errorsOnly;
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
  // cache: 'no-cache' = beim Server nachfragen (ETag); Katalog-Korrekturen kommen sofort an, unverändert kostet es kaum etwas
  fetch('data/katalog.json', { cache: 'no-cache' }).then(r => { if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(data => {
      CATALOG = data; BY_ID = Object.fromEntries(data.map(q => [q.id, q]));
      GROUPS = {};
      data.filter(q => q.group).forEach(q => (GROUPS[q.group] ||= []).push(q));
      Object.values(GROUPS).forEach(g => g.sort((a, b) => a.origin[0].localeCompare(b.origin[0], 'de', { numeric: true })));
      state.loading = false; render();
    })
    .catch(err => {
      state.loading = false;
      state.loadError = location.protocol === 'file:'
        ? 'Die Fragen können nicht direkt aus dem Dateisystem geladen werden. Bitte die App über einen Webserver öffnen (siehe README).'
        : `Der Fragenkatalog konnte nicht geladen werden (${err.message}). Bitte die Seite neu laden.`;
      render();
    });
  fetch('data/szenario.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null)
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
    const st = questionStatus(), pool = sourcePool(src.id, st), inPool = new Set(pool.map(q => q.id));
    // Blöcke nur komplett; bei Fehler-/Markiert-Training wird die betroffene Teilfrage gekennzeichnet
    items = pickUnits(unitsFrom(pool), settings.count).flat().map(q => ({
      q, perm: q.group ? keysOf(q) : shuffled(keysOf(q)),
      focus: src.id !== 'all' && q.group && inPool.has(q.id) ? [st.wrong[q.id] && 'zuletzt falsch', st.flagged[q.id] && 'markiert'].filter(Boolean).join(' · ') : '',
    }));
    title = `${src.title} · ${items.length} Frage${items.length === 1 ? '' : 'n'}`;
  }
  return { mode: settings.mode, exam: settings.mode === 'exam' ? settings.exam : null, title, sim, shuffle, items,
           answers: {}, flags: new Set(), elapsed: 0,
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
  const value = countdown ? s.limit - s.elapsed : s.elapsed;
  timer.hidden = false;
  timer.innerHTML = `<small>${countdown ? 'Restzeit' : 'Dauer'}</small> ${fmt(value)}`;
  timer.classList.toggle('warn', countdown && value <= Math.min(300, s.limit / 5));
}
function startTimer(){
  stopTimer(); showTimer();
  state.timerId = setInterval(() => {
    const s = state.session; s.elapsed++; showTimer();
    if(s.limit && s.elapsed >= s.limit){ s.timeout = true; finish(); }
  }, 1000);
}
function stopTimer(){ if(state.timerId){ clearInterval(state.timerId); state.timerId = null; } }

/* ---------- Aktionen ---------- */
function start(){
  if(state.loading || state.loadError || !CATALOG.length) return;
  state.session = newSession(); state.pos = 0; state.reviewMode = false; state.modal = null;
  state.view = 'exam'; startTimer(); render(); window.scrollTo(0, 0);
  setScen(isDesktop() && settings.scenDesk, false);
}
function current(){ return state.session.items[state.pos]; }
function choose(letter){
  const s = state.session, item = current();
  if(state.reviewMode) return;
  if(s.answers[item.q.id] && !s.sim) return;     // ohne Simulation bleibt die erste Antwort stehen
  s.answers[item.q.id] = item.perm[LETTERS.indexOf(letter)];
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
  stopTimer(); timer.hidden = true; state.modal = null;
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
    items: known.map(x => ({ q: BY_ID[x.id], perm: x.perm.split(''), origNo: run.exam ? originNo(BY_ID[x.id], run.exam) : 0 })),
    answers: Object.fromEntries(known.filter(x => x.a).map(x => [x.id, x.a])),
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
    const tag = right && mine ? 'richtig · deine Antwort' : right ? 'richtige Antwort' : mine ? 'deine Antwort' : '';
    const own = withExpl && !shared.some(r => r.keys.includes(key));
    return `<li class="${cls}"><b>${LETTERS[k]}</b><span>${esc(q.opts[key])}${own ? `<em>${esc(q.expl[key])}</em>` : ''}</span>${tag ? `<i>${tag}</i>` : ''}</li>`;
  }).join('');
  const sharedHtml = shared.map(r => `<p class="sh">Übrige Optionen ${r.letters.join(', ')}: falsch. ${esc(r.text)}</p>`).join('');
  const status = ok ? 'Richtig' : chosen ? 'Falsch' : 'Nicht beantwortet';
  return `<details class="q ${ok ? 'ok' : 'bad'}" ${ok ? '' : 'open'}>
  <summary><span class="nr">${i + 1}</span><span class="st">${status}</span><span class="qt">${esc(qLabel(q))}</span></summary>
  ${q.group ? `<p class="sc">${esc(q.groupIntro)}</p><p class="gp">Zuordnung · Aussage ${groupPos(q)} von ${GROUPS[q.group].length}</p>` : ''}
  ${q.scenario ? `<p class="sc">${esc(q.scenario)}</p>` : ''}
  <p class="qq">${esc(q.question)}</p>
  ${q.items.length ? `<ol class="it">${q.items.map(t => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}
  <ul class="op">${opts}</ul>${sharedHtml}
  ${!withExpl && q.rationale ? `<div class="ra"><b>Begründung</b><p>${esc(q.rationale)}</p></div>` : ''}
  ${!withExpl && !q.rationale ? `<div class="ra"><b>Lösung</b><p>Richtig ist ${rightLabel(it)}. Für diese Frage liegt keine Begründung vor.</p></div>` : ''}
  <p class="meta">Frage-ID ${q.id} · Herkunft ${esc(q.origin.join(', '))}${q.ref ? ` · Lehrplan ${esc(q.ref)}` : ''}${q.topic ? ` · ${esc(q.topic)}` : ''}</p>
</details>`;
}
function buildReport(s){
  const total = s.items.length, sc = s.items.filter(it => isRight(it.q, s.answers[it.q.id])).length, pass = passMark(total);
  const rows = s.items.map((it, i) => ({ it, i }));
  const notOk = rows.filter(({it}) => !isRight(it.q, s.answers[it.q.id]));
  const okRows = rows.filter(({it}) => isRight(it.q, s.answers[it.q.id]));
  const topics = {};
  s.items.forEach(it => { if(!it.q.topic) return; const t = topics[it.q.topic] ||= {c: 0, n: 0}; t.n++; if(isRight(it.q, s.answers[it.q.id])) t.c++; });
  const time = s.limit ? `${fmt(s.elapsed)} von ${fmt(s.limit)} min${s.timeout ? ' (Zeit abgelaufen)' : ''}` : `${fmt(s.elapsed)} min (Stoppuhr)`;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(CFG.appTitle)} · Bericht · ${esc(s.title)}</title>
<style>
:root{--ink:#1d2733;--muted:#5b6672;--line:#d9dde2;--ok:#1f7a45;--okbg:#e8f5ec;--bad:#b42d2d;--badbg:#fbeaea;--acc:#1d4f6e}
*{box-sizing:border-box}body{font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--ink);max-width:860px;margin:0 auto;padding:24px 16px 48px;background:#fff}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{color:var(--muted);margin:0 0 16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.kpi{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.kpi b{display:block;font-size:20px}.kpi span{color:var(--muted);font-size:13px}
.pass{color:var(--ok)}.fail{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 4px;border-bottom:1px solid var(--line)}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
details.q{border:1px solid var(--line);border-radius:8px;margin:0 0 10px;padding:0 14px;break-inside:avoid}
details.q.bad{border-left:4px solid var(--bad)}details.q.ok{border-left:4px solid var(--ok)}
summary{display:flex;gap:10px;align-items:baseline;padding:10px 0;cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
.nr{font-weight:700;min-width:2em}.st{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;min-width:9em}
.bad .st{color:var(--bad)}.ok .st{color:var(--ok)}.qt{flex:1}
details[open] .qt{display:none}
.sc{background:#f3f5f7;border-left:3px solid var(--acc);padding:8px 12px;margin:0 0 8px;white-space:pre-line}
.gp{font-size:12px;font-weight:700;color:var(--acc);margin:0 0 4px}
.sh{font-size:13px;color:var(--muted);margin:0 0 10px}
.scen{border:1px solid var(--line);border-radius:8px;padding:4px 16px 12px}.scen h4{margin:12px 0 4px}.scen ul{margin:4px 0}
.scen dt{font-weight:700;margin-top:10px}.scen dd{margin:2px 0 0}
.qq{font-weight:600;margin:4px 0 8px}
ol.it{margin:0 0 10px;padding-left:22px}
ul.op{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:6px}
ul.op li{display:flex;gap:10px;border:1px solid var(--line);border-radius:6px;padding:8px 10px}
ul.op li b{min-width:1.2em}ul.op li span{flex:1}ul.op li i{font-style:normal;font-size:12px;font-weight:700;white-space:nowrap}
ul.op li.right{background:var(--okbg);border-color:var(--ok)}ul.op li.right i{color:var(--ok)}
ul.op li.wrong{background:var(--badbg);border-color:var(--bad)}ul.op li.wrong i{color:var(--bad)}
ul.op li em{display:block;font-style:normal;color:var(--muted);font-size:13px;margin-top:4px}
.ra{background:#f3f5f7;border-radius:6px;padding:8px 12px;margin:0 0 10px}.ra p{margin:4px 0 0;white-space:pre-line}
.meta{font-size:12px;color:var(--muted);margin:0 0 12px}
.foot{margin-top:32px;font-size:12px;color:var(--muted)}
@media print{details.q{page-break-inside:avoid}}
</style>
<script>addEventListener('beforeprint',()=>document.querySelectorAll('details').forEach(d=>d.open=true))<\/script>
</head><body>
<h1>${esc(CFG.brand)} · ${esc(s.title)}</h1>
<p class="sub">${fmtDate(s.date || new Date().toISOString())} · ${s.mode === 'exam' ? 'Reale Prüfung' : 'Training'}${s.sim ? ' · Prüfungssimulation' : ''}${s.shuffle ? ' · gemischt' : ''}</p>
<div class="kpis">
  <div class="kpi"><b class="${sc >= pass ? 'pass' : 'fail'}">${sc >= pass ? 'Bestanden' : 'Nicht bestanden'}</b><span>Grenze ${pass} von ${total} (${PASS_PCT} %)</span></div>
  <div class="kpi"><b>${sc} / ${total}</b><span>${Math.round(sc / total * 100)} % richtig</span></div>
  <div class="kpi"><b>${notOk.length}</b><span>falsch oder offen</span></div>
  <div class="kpi"><b>${time.split(' ')[0]}</b><span>${time.split(' ').slice(1).join(' ')}</span></div>
</div>
${Object.keys(topics).length ? `<h2>Ergebnis nach Themenbereich</h2><table>${Object.entries(topics).map(([t, v]) => `<tr><td>${esc(t)}</td><td>${v.c} / ${v.n} · ${Math.round(v.c / v.n * 100)} %</td></tr>`).join('')}</table>` : ''}
<h2>Falsch oder nicht beantwortet (${notOk.length})</h2>
${notOk.length ? notOk.map(({it, i}) => reportQuestion(s, it, i)).join('') : '<p>Keine – alle Fragen richtig.</p>'}
<h2>Richtig beantwortet (${okRows.length})</h2>
${okRows.map(({it, i}) => reportQuestion(s, it, i)).join('')}
${SCENARIO ? `<h2>Anhang: ${esc(SCENARIO.title)}</h2><div class="scen">${scenarioBody(SCENARIO)}<p class="meta">${esc(SCENARIO.source)}</p></div>` : ''}
<p class="foot">Erstellt mit dem ${esc(CFG.appTitle)} (${esc(CFG.liveUrl)}). ${esc(SOURCE_NOTE)} PRINCE2® ist eine eingetragene Marke von PeopleCert. Nur für das persönliche Lernen.</p>
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
}
function updateChrome(){
  const s = state.session;
  examLabel.textContent = state.view !== 'start' && s ? s.title
    : settings.mode === 'exam' ? `Reale Prüfung · ${examOf(settings.exam).title}` : `Trainieren · ${settings.count} Fragen`;
  if(state.view === 'progress') examLabel.textContent = 'Lernfortschritt';
  footSource.textContent = SOURCE_NOTE;
  // Während einer laufenden Bearbeitung kein Wechsel in den Lernfortschritt (sonst ginge die Sitzung verloren)
  progressBtn.hidden = state.view === 'exam' && !state.reviewMode;
  if(state.view !== 'exam' || state.reviewMode){ if(!state.reviewMode) stopTimer(); timer.hidden = true; }
  progressBtn.classList.toggle('active', state.view === 'progress');
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
  const poolSize = Object.fromEntries(SOURCES.map(x => [x.id, ready ? sourcePool(x.id, st).length : 0]));
  const src = SOURCES.find(x => x.id === settings.trainingOpts.source) || SOURCES[0];
  const examSize = code => CATALOG.filter(q => q.origin.some(o => o.startsWith(code + '-'))).length;
  const n = isExam ? examSize(settings.exam) : ready ? unitTotal(unitsFrom(sourcePool(src.id, st)), settings.count) : 0;
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

  const countButtons = COUNTS.map(c => `
          <label class="seg-opt"><input type="radio" name="count" value="${c}" ${c === settings.count ? 'checked' : ''}><span>${c}</span></label>`).join('');

  const topics = {};
  if(isExam) CATALOG.filter(q => q.origin.some(o => o.startsWith(settings.exam + '-')))
    .forEach(q => { if(q.topic) topics[q.topic] = (topics[q.topic] || 0) + 1; });

  const timeText = opts.sim ? `${minutesFor(n)} min` : 'Stoppuhr';
  // Fehler-/Markiert-Training: Teilfragen von Zuordnungsblöcken ziehen ihren ganzen Block mit
  const plusBlocks = ready && src.id !== 'all' && unitsFrom(sourcePool(src.id, st)).flat().length > poolSize[src.id] ? ', ergänzt um die übrigen Teilfragen ihrer Zuordnungsblöcke' : '';
  const lead = isExam
    ? `${ex.title}: ${n} Fragen ${settings.examOpts.shuffle ? 'in zufälliger Reihenfolge, Antworten gemischt' : 'in Originalreihenfolge'}. ${ex.official
        ? 'Mit offizieller Begründung zu jeder Antwortoption und Referenz ins PRINCE2-Handbuch.'
        : 'Für diese Prüfung liegen nur die Lösungen vor, keine Begründungen.'}`
    : src.id === 'errors' ? `${n} zufällige Fragen aus deinen ${poolSize.errors} Fehlerfragen (zuletzt falsch beantwortet)${plusBlocks}. Fragen und Antwortoptionen werden jedes Mal neu gemischt.`
    : src.id === 'flagged' ? `${n} zufällige Fragen aus deinen ${poolSize.flagged} markierten Fragen${plusBlocks}. Fragen und Antwortoptionen werden jedes Mal neu gemischt.`
    : src.id === 'both' ? `${n} zufällige Fragen aus ${poolSize.both} Fehler- und markierten Fragen${plusBlocks}. Fragen und Antwortoptionen werden jedes Mal neu gemischt.`
    : `${n} zufällige Fragen aus dem Gesamtkatalog, ohne Wiederholung. Fragen und Antwortoptionen werden jedes Mal neu gemischt. Begründungen gibt es, wo die Quelle sie liefert.`;
  const blockNote = GROUPS && Object.keys(GROUPS).length ? ' Zuordnungsblöcke (3 Teilfragen mit gemeinsamer Optionsliste) werden immer vollständig gezogen; ihre Optionen bleiben in Originalreihenfolge.' : '';

  return `
  <section class="hero">
    <div>
      <div class="eyebrow">${esc(CFG.brand)}</div>
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
        <div class="seg" role="radiogroup">${countButtons}</div>
      </fieldset>
      <fieldset class="picker">
        <legend>Aus welchen Fragen?</legend>
        <div class="seg src" role="radiogroup">${SOURCES.map(x => `
          <label class="seg-opt"><input type="radio" name="source" value="${x.id}" ${x.id === src.id ? 'checked' : ''} ${x.id !== 'all' && !poolSize[x.id] && x.id !== src.id ? 'disabled' : ''}><span>${x.label}<small>${poolSize[x.id]}</small></span></label>`).join('')}
        </div>
        ${src.id !== 'all' && n < settings.count ? `<p class="time-note">${poolSize[src.id] ? `Es gibt nur ${poolSize[src.id]} passende Fragen${n !== poolSize[src.id] ? ` (mit vollständigen Zuordnungsblöcken ${n})` : ''} – die Übung wird entsprechend kürzer.` : 'Dafür gibt es noch keine Fragen. Fehlerfragen entstehen aus falsch beantworteten Fragen, markierte über „Markieren“ während einer Prüfung oder Übung.'}</p>` : ''}
      </fieldset>`}
      <p class="lead">${lead}${isExam ? '' : blockNote}</p>
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
        <button class="btn primary" id="startBtn" style="width:100%;justify-content:center" ${canStart ? '' : 'disabled'}>${isExam ? `${esc(ex.title)} starten` : `${src.title} · ${n} Frage${n === 1 ? '' : 'n'} starten`}</button>
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
  const noun = s.mode === 'exam' ? 'Prüfung' : 'Übung';

  const options = item.perm.map((key, i) => {
    const L = LETTERS[i];
    let cls = 'opt', tag = '';
    if(hidden){
      if(key === chosen){ cls += ' selected'; tag = 'Deine Antwort'; }
    } else if(reveal){
      if(isRight(q, key)){ cls += ' correct'; tag = 'Richtige Antwort'; }
      else if(key === chosen){ cls += ' wrong'; tag = 'Deine Antwort'; }
    }
    return `<button class="${cls}" data-choose="${L}" ${locked ? 'disabled' : ''} aria-pressed="${chosen === key}">
      <span class="letter">${L}</span><span>${esc(q.opts[key])}</span>${tag ? `<span class="tag">${tag}</span>` : ''}
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
        <span class="spacer"></span>
        ${state.reviewMode ? `<button class="btn" data-back>Zur Auswertung</button>` : ''}
        ${state.pos < total - 1
          ? `<button class="btn primary" data-nav="1">Weiter →</button>`
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

function viewModal(){
  if(state.modal.type === 'clear') return `<div class="modal" id="modal"><div class="card">
    <h2>Gesamten Verlauf löschen?</h2>
    <p>Alle ${HISTORY.length} gespeicherten Durchläufe werden aus diesem Browser entfernt. Das lässt sich nicht rückgängig machen – exportiere den Verlauf vorher, wenn du ihn behalten willst.</p>
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

function viewProgress(){
  const notice = state.notice; state.notice = null;
  const backup = `<div class="card backup">
      <h2>Datensicherung</h2>
      <p class="time-note">Der Verlauf liegt nur in diesem Browser auf diesem Gerät. Exportiere ihn als Datei, um ihn zu sichern oder auf ein anderes Gerät mitzunehmen.</p>
      <div class="nav">
        <button class="btn" id="exportBtn" ${HISTORY.length ? '' : 'disabled'}>⤓ Verlauf exportieren</button>
        <button class="btn" id="importBtn">⤒ Verlauf importieren</button>
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
  const passedN = runs.filter(runPassed).length;
  const seen = new Set(HISTORY.flatMap(r => r.items.filter(x => x.a).map(x => x.id)));
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
  <div class="facts four">
    <div class="fact"><b>${runs.length}</b><span>Durchläufe</span></div>
    <div class="fact"><b>${runs.length ? avg + ' %' : '–'}</b><span>Ø richtig</span></div>
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
      <span class="run-actions"><button class="btn" data-run="${r.id}">Ansehen</button><button class="btn" data-run-report="${r.id}" aria-label="Bericht herunterladen">⤓ Bericht</button></span>
    </div>`).join('')}</div>

  ${Object.keys(topics).length ? `<h2 class="section-title">Ergebnis nach Themenbereich</h2>
  <div class="topic-list">${Object.entries(topics).sort((a, b) => a[1].c / a[1].n - b[1].c / b[1].n).map(([t, v]) => `<div class="topic-row"><span>${esc(t)} <span style="color:var(--text-muted)">(${v.c}/${v.n})</span></span><div class="bar"><i style="width:${v.c / v.n * 100}%"></i></div><span class="pct">${Math.round(v.c / v.n * 100)} %</span></div>`).join('')}</div>
  <p class="time-note">Sortiert vom schwächsten zum stärksten Bereich. Fragen ohne Themenzuordnung sind nicht enthalten.</p>` : ''}

  ${hard.length ? `<h2 class="section-title">Am häufigsten falsch</h2>
  <div class="review">${hard.map(([id, v]) => { const q = BY_ID[id]; return `<div class="rv static"><span class="n bad">${v.wrong}×</span><span>${esc(qLabel(q))}<small>${v.wrong} von ${v.n} Mal falsch beantwortet · ${id} · ${esc(q.origin.join(', '))}</small></span></div>`; }).join('')}</div>` : ''}

  ${backup}`;
}

function exportHistory(){
  const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  download(`${CFG.reportPrefix}-Lernfortschritt_${stamp}.json`,
    JSON.stringify({ app: CFG.appId, version: 1, exported: d.toISOString(), runs: HISTORY }, null, 1), 'application/json');
}
function importHistory(file){
  if(!file) return;
  file.text().then(text => {
    const data = JSON.parse(text);
    // Nur Exporte dieser App annehmen – sonst könnten Verläufe einer anderen Trainer-App (andere Fragen) hineingeraten
    if(!Array.isArray(data) && data.app && data.app !== CFG.appId) throw new Error(`Export stammt aus „${data.app}“, nicht aus dieser App`);
    const runs = Array.isArray(data) ? data : data.runs;
    if(!Array.isArray(runs)) throw new Error('keine Durchläufe gefunden');
    const valid = runs.filter(r => r && typeof r.id === 'string' && typeof r.date === 'string' && Array.isArray(r.items) && r.total > 0);
    const known = new Set(HISTORY.map(r => r.id));
    const fresh = valid.filter(r => !known.has(r.id));
    HISTORY = [...HISTORY, ...fresh];
    const ok = store.save(HISTORY);
    state.notice = `${fresh.length} Durchläufe importiert${valid.length - fresh.length ? `, ${valid.length - fresh.length} waren schon vorhanden` : ''}${runs.length - valid.length ? `, ${runs.length - valid.length} ungültig übersprungen` : ''}.${ok ? '' : ' Achtung: Speichern im Browser nicht möglich.'}`;
  }).catch(err => { state.notice = `Import fehlgeschlagen: Die Datei ist kein gültiger Lernfortschritts-Export (${err.message}).`; })
    .finally(() => render());
}

/* ---------- Bindings ---------- */
function bind(){
  const $ = id => document.getElementById(id);
  const change = (fn, focusSel) => e => { fn(e); saveSettings(); render(); const el = focusSel && document.querySelector(focusSel); el && el.focus(); };
  document.querySelectorAll('input[name="mode"]').forEach(r => r.onchange = change(() => settings.mode = r.value, `input[name="mode"][value="${r.value}"]`));
  document.querySelectorAll('input[name="exam"]').forEach(r => r.onchange = change(() => settings.exam = r.value, `input[name="exam"][value="${r.value}"]`));
  document.querySelectorAll('input[name="count"]').forEach(r => r.onchange = change(() => settings.count = Number(r.value), `input[name="count"][value="${r.value}"]`));
  $('optSim') && ($('optSim').onchange = change(e => (settings.mode === 'exam' ? settings.examOpts : settings.trainingOpts).sim = e.target.checked, '#optSim'));
  $('optShuffle') && ($('optShuffle').onchange = change(e => settings.examOpts.shuffle = e.target.checked, '#optShuffle'));
  document.querySelectorAll('input[name="source"]').forEach(r => r.onchange = change(() => settings.trainingOpts.source = r.value, `input[name="source"][value="${r.value}"]`));
  $('reportBtn') && ($('reportBtn').onclick = () => downloadReport(state.session));
  $('backToProgress') && ($('backToProgress').onclick = showProgress);
  document.querySelectorAll('[data-run]').forEach(b => b.onclick = () => openRun(b.dataset.run));
  document.querySelectorAll('[data-run-report]').forEach(b => b.onclick = () => { const run = HISTORY.find(r => r.id === b.dataset.runReport); run && downloadReport(sessionFromRun(run)); });
  document.querySelectorAll('[data-pfilter]').forEach(b => b.onchange = () => { progressFilter[b.name] = b.value; render(); });
  document.querySelectorAll('[data-train]').forEach(b => b.onclick = () => { settings.mode = 'training'; settings.trainingOpts.source = b.dataset.train; saveSettings(); state.view = 'start'; render(); window.scrollTo(0, 0); });
  $('exportBtn') && ($('exportBtn').onclick = exportHistory);
  $('importBtn') && ($('importBtn').onclick = () => $('importFile').click());
  $('importFile') && ($('importFile').onchange = e => importHistory(e.target.files[0]));
  $('clearBtn') && ($('clearBtn').onclick = () => { state.modal = { type: 'clear' }; render(); });
  $('modalClear') && ($('modalClear').onclick = () => { HISTORY = []; store.save(HISTORY); state.modal = null; state.notice = 'Verlauf gelöscht.'; render(); });
  $('startBtn') && ($('startBtn').onclick = start);
  document.querySelectorAll('[data-choose]').forEach(b => b.onclick = () => choose(b.dataset.choose));
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => go(state.pos + Number(b.dataset.nav)));
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(Number(b.dataset.go)));
  document.querySelectorAll('[data-flag]').forEach(b => b.onclick = toggleFlag);
  document.querySelectorAll('[data-scen]').forEach(b => b.onclick = () => setScen(!state.scenOpen));
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
}

/* Tastatur: A–F wählen (angezeigte Buchstaben der aktuellen Frage), Pfeile navigieren, Esc schließt das Szenario */
document.addEventListener('keydown', e => {
  if(state.view !== 'exam' || state.modal) return;
  if(e.target.closest && e.target.closest('input, textarea')) return;
  if(e.key === 'Escape' && state.scenOpen){ setScen(false); return; }
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toUpperCase();
  if(LETTERS.slice(0, current().perm.length).includes(k)) choose(k);
  else if(e.key === 'ArrowRight') go(state.pos + 1);
  else if(e.key === 'ArrowLeft') go(state.pos - 1);
});

document.title = CFG.appTitle;
document.getElementById('appTitle').textContent = CFG.appTitle;

/* ---------- Theme ---------- */
let theme = document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function applyTheme(){
  document.documentElement.dataset.theme = theme;
  iconSun.hidden = theme === 'dark'; iconMoon.hidden = theme !== 'dark';
}
themeBtn.onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); };
applyTheme();
progressBtn.onclick = () => state.view === 'progress' ? (state.view = 'start', render()) : showProgress();

render();
loadCatalog();
