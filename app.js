/*
 * Colonnine – interfaccia: mappa, posizione, caricamento dati, elenco.
 * Stessa struttura di Distributori e PostoLibero.
 */
(function () {
  "use strict";
  const cfg = window.COLONNINE_CONFIG;
  const $ = (id) => document.getElementById(id);
  const PREF = "colonnine.";
  const leggiPref = (k, def) => { try { const v = localStorage.getItem(PREF + k); return v === null ? def : v; } catch (e) { return def; } };
  const salvaPref = (k, v) => { try { localStorage.setItem(PREF + k, String(v)); } catch (e) { /* ignora */ } };

  const stato = {
    gps: null,          // ultima posizione GPS {lat, lon, acc}
    centro: null,       // punto della ricerca {lat, lon, daGps}
    raggio: +leggiPref("raggio", cfg.raggioMetri || 5000),
    potenza: leggiPref("potenza", cfg.potenza || "tutte"),
    ordine: leggiPref("ordine", "prezzo"),
    tutti: [],          // colonnine delle tessere scaricate
    vicini: [],         // colonnine entro il raggio con la potenza scelta, con prezzo e fascia
    filtri: new Set(),
    caricando: false,
    seguiGps: true
  };
  if (![1000, 2000, 5000, 10000].includes(stato.raggio)) stato.raggio = 5000;
  if (!DL.POTENZE[stato.potenza]) stato.potenza = "tutte";
  if (!["prezzo", "distanza"].includes(stato.ordine)) stato.ordine = "prezzo";

  // ---------- Mappa ----------
  const mappa = L.map("mappa", { zoomControl: false, attributionControl: true })
    .setView([41.9, 12.5], 6);
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const sfondi = {
    stradale: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Colonnine: PUN'
    }),
    satellite: L.layerGroup([
      L.tileLayer(ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, maxNativeZoom: 19,
        attribution: "Immagini: Esri, Vantor, Earthstar Geographics, GIS User Community · Strade: Esri, HERE, Garmin, © OpenStreetMap · Colonnine: PUN"
      }),
      L.tileLayer(ESRI + "Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, opacity: .8 }),
      L.tileLayer(ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 })
    ])
  };
  let sfondoAttivo = leggiPref("sfondo", "stradale") === "satellite" ? "satellite" : "stradale";
  function impostaSfondo(nome) {
    Object.values(sfondi).forEach((l) => mappa.removeLayer(l));
    sfondoAttivo = sfondi[nome] ? nome : "stradale";
    sfondi[sfondoAttivo].addTo(mappa);
    $("mappa").classList.toggle("satellite", sfondoAttivo === "satellite");
    salvaPref("sfondo", sfondoAttivo);
  }
  impostaSfondo(sfondoAttivo);

  const livelli = {
    raggio: L.layerGroup().addTo(mappa),
    senzaPrezzo: L.layerGroup().addTo(mappa),
    colonnine: L.layerGroup().addTo(mappa),
    io: L.layerGroup().addTo(mappa)
  };
  const markerPerId = new Map();
  mappa.on("dragstart", () => { stato.seguiGps = false; });

  const icona = (cls, html) => L.divIcon({ className: "", html: `<div class="mk ${cls}">${html ?? ""}</div>`, iconSize: null });

  // ---------- Utilità UI ----------
  function messaggio(testo, errore) {
    const el = $("stato");
    el.textContent = testo;
    el.classList.toggle("errore", !!errore);
    if (errore && $("pannello").hidden) toast(testo);
  }
  let timerToast;
  function toast(testo) {
    const t = $("toast");
    t.textContent = testo;
    t.hidden = false;
    clearTimeout(timerToast);
    timerToast = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const attr = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const linkNavigazione = (lat, lon) =>
    `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
  const nomePotenza = () => DL.POTENZE[stato.potenza].breve;
  // Prezzo in centesimi con la "c" piccola accanto (un solo elemento, per restare centrato)
  const conC = (p) => `<span>${DL.formattaCent(p)}<small>c</small></span>`;

  // Scarica e legge il JSON entro "ms" millisecondi in tutto (risposta + dati)
  async function fetchJson(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // ---------- Colonnine salvate nel sito ----------
  // Più volte al giorno GitHub scarica i dati della PUN e li salva nella cartella "dati" del sito,
  // divisi in tessere da 0,25 gradi. L'app scarica solo le tessere intorno a te.
  let indice = null, indiceLetto = 0;
  const tessere = new Map();   // nome → { t: quando, lista }
  async function leggiIndice(forza) {
    if (!forza && indice && Date.now() - indiceLetto < 15 * 60000) return indice;
    const nuovo = await fetchJson("dati/indice.json", {}, 10000);
    if (!indice || nuovo.aggiornato !== indice.aggiornato) tessere.clear(); // dati nuovi: via le tessere vecchie
    indice = nuovo;
    indiceLetto = Date.now();
    return indice;
  }
  async function caricaColonnine(lat, lon, raggio, forza) {
    const ind = await leggiIndice(forza);
    const esistenti = new Set(ind.tessere || []);
    const nomi = DL.tessereNelRaggio(lat, lon, raggio, ind.passo || 0.25).filter((t) => esistenti.has(t));
    const mancanti = nomi.filter((t) => !tessere.has(t));
    const parti = await Promise.all(mancanti.map((t) => fetchJson("dati/" + t, {}, 15000)));
    mancanti.forEach((t, i) => tessere.set(t, parti[i].d || []));
    return nomi.flatMap((t) => tessere.get(t) || []);
  }

  // ---------- Suoni ----------
  let audio = null;
  let suoniAttivi = leggiPref("suoni", "1") !== "0";
  function sbloccaAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state !== "running") audio.resume();
    } catch (e) { /* audio non disponibile */ }
  }
  document.addEventListener("pointerdown", sbloccaAudio, { passive: true });
  document.addEventListener("touchend", sbloccaAudio, { passive: true });
  function suona(note, volume) {
    if (!suoniAttivi || !audio || document.hidden) return;
    if (audio.state !== "running") { audio.resume().catch(() => {}); if (audio.state !== "running") return; }
    const t0 = audio.currentTime + 0.02;
    for (const [freq, inizio, durata] of note) {
      const osc = audio.createOscillator(), g = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + inizio);
      g.gain.exponentialRampToValueAtTime(volume || 0.35, t0 + inizio + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + inizio + durata);
      osc.connect(g).connect(audio.destination);
      osc.start(t0 + inizio);
      osc.stop(t0 + inizio + durata + 0.05);
    }
  }
  const SUONO = {
    aggiornato: () => suona([[1318.5, 0, 0.6], [2637, 0, 0.25]], 0.3),   // "bing"
    errore: () => suona([[392, 0, 0.25], [311, 0.22, 0.45]], 0.3)        // due note che scendono
  };

  // ---------- Caricamento ----------
  let giroCarica = 0;
  async function carica(forza, silenzioso) {
    if (!stato.centro) return;
    const giro = ++giroCarica;
    stato.caricando = true;
    $("btn-aggiorna").classList.add("gira");
    const { lat, lon } = stato.centro;
    if (!silenzioso) messaggio("Cerco colonnine entro " + DL.formattaDistanza(stato.raggio) + "…");
    let errore = null;
    try {
      const lista = await caricaColonnine(lat, lon, stato.raggio, forza);
      if (giro !== giroCarica) return;
      stato.tutti = lista;
      stato.tentativi = 0;
    } catch (e) {
      errore = e;
      console.warn("Dati non disponibili", e);
    }
    if (giro !== giroCarica) return;
    stato.caricando = false;
    $("btn-aggiorna").classList.remove("gira");
    ricalcola();

    clearTimeout(stato.timerRiprova);
    if (errore) {
      const attese = [30, 60, 120, 300];
      const sec = attese[Math.min(stato.tentativi || 0, attese.length - 1)];
      stato.tentativi = (stato.tentativi || 0) + 1;
      stato.timerRiprova = setTimeout(() => carica(true), sec * 1000);
      SUONO.errore();
      messaggio(`Non riesco a scaricare le colonnine. Riprovo da solo tra ${sec >= 60 ? sec / 60 + " min" : sec + " secondi"}.`, true);
      return;
    }
    SUONO.aggiornato();
    const ora = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const dove = stato.centro.daGps ? "dalla tua posizione" : "dal punto cercato";
    let delGiorno = "";
    if (indice && indice.aggiornato) {
      const d = new Date(indice.aggiornato);
      if (!isNaN(d)) {
        const oggi = new Date().toDateString() === d.toDateString();
        delGiorno = " · dati PUN " + (oggi ? "di oggi" : "del " + d.toLocaleDateString("it-IT", { day: "numeric", month: "long" })) +
          " alle " + d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
      }
    }
    messaggio(`Entro ${DL.formattaDistanza(stato.raggio)} ${dove}${delGiorno} · controllato alle ${ora}`);
  }

  // Ricalcola distanze, prezzi e colori senza riscaricare (cambio potenza, filtri)
  function ricalcola() {
    if (!stato.centro) return;
    stato.vicini = DL.preparaColonnine(stato.tutti, stato.centro.lat, stato.centro.lon, stato.raggio, stato.potenza)
      .filter(passaFiltri);
    DL.classifica(stato.vicini);
    render();
  }

  function passaFiltri(d) {
    if (stato.filtri.has("h24") && !d.h) return false;
    if (stato.filtri.has("prezzo") && d.prezzo == null) return false;
    if (stato.filtri.has("funzionanti") && d.guasti >= d.posti) return false;
    return true;
  }
  // Tutti i posti della colonnina (per la potenza scelta) sono segnalati fuori servizio
  const guasta = (d) => d.posti > 0 && d.guasti >= d.posti;

  // ---------- Rendering ----------
  const OPZ_POPUP = { maxWidth: 360, minWidth: 270, autoPanPadding: [16, 90] };
  function distanzaParlata(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " metri";
    return (m / 1000).toFixed(1).replace(".", ",") + " chilometri";
  }

  function popupColonnina(d) {
    const tit = DL.titolo(d);
    const ind = DL.indirizzo(d);
    const voce = [tit + ".", ind + "."];
    const righe = [];
    if (d.r && d.r.toLowerCase() !== tit.toLowerCase()) righe.push(`<p class="ragione">${esc(d.r)}</p>`);
    righe.push(`<p>${esc(ind)}</p>`);
    const tag = [];
    if (d.h) tag.push('<span class="tag h24">Aperta 24 ore</span>');
    righe.push(`<p class="pop-posti"><b>${DL.testoPosti(d.posti)}</b> · fino a <b>${DL.formattaKw(d.kw)}</b> ${tag.join(" ")}</p>`);
    voce.push(`${DL.testoPosti(d.posti)}, fino a ${String(d.kw).replace(".", ",")} chilowatt.`);
    if (d.prezzo != null) {
      righe.push(`<p class="pop-prezzo ${d.fascia}"><b>${DL.formattaCent(d.prezzo)}</b> centesimi/kWh</p>`);
      voce.push(`${DL.formattaCent(d.prezzo)} centesimi al chilowattora senza abbonamento.`);
      if (d.fascia === "economico") voce.push("Tra le più economiche in zona.");
      else if (d.fascia === "caro") voce.push("Tra le più care in zona.");
      righe.push(d.fontePrezzo === "O"
        ? '<p class="avviso-lieve">Prezzo indicativo dell\'operatore senza abbonamento: controlla nell\'app di pagamento</p>'
        : "<p>Prezzo senza abbonamento comunicato alla PUN</p>");
    } else {
      righe.push('<p class="avviso-lieve">Prezzo non comunicato</p>');
      voce.push("Prezzo non comunicato.");
    }
    if (d.guasti) {
      righe.push(`<p class="avviso">${d.guasti === d.posti ? "Tutti i posti segnalati" : DL.testoPosti(d.guasti) + " segnalat" + (d.guasti === 1 ? "o" : "i")} fuori servizio</p>`);
      voce.push(d.guasti === d.posti ? "Attenzione: segnalata fuori servizio." : `Attenzione: ${DL.testoPosti(d.guasti)} fuori servizio.`);
    }
    righe.push(`<table class="pop-tab"><tr><th>Potenza</th><th>Presa</th><th>Posti</th><th>c/kWh</th></tr>${d.gruppi.map((g) =>
      `<tr><td>${DL.formattaKw(g[0])} <small>${g[1]}</small></td><td>${esc(g[2] || "–")}</td><td>${g[3]}${g[4] ? ` <small class="rosso">(${g[4]} ko)</small>` : ""}</td><td>${DL.formattaCent(g[5])}</td></tr>`).join("")}</table>`);
    const altri = (d.e || []).length - d.gruppi.length;
    if (altri > 0) righe.push(`<p class="nota">Ci sono anche altri posti di potenza diversa: scegli "Tutte" in alto per vederli.</p>`);
    righe.push(`<p>${DL.formattaDistanza(d.distanza)} · circa ${DL.minutiInAuto(d.distanza)} min in auto</p>`);
    voce.push(distanzaParlata(d.distanza) + ".");
    righe.push('<p class="fonte">Fonte: PUN – Piattaforma Unica Nazionale dei punti di ricarica</p>');
    return `<div class="pop" data-voce="${attr(voce.join(" "))}"><h3>${esc(tit)}</h3>${righe.join("")}
      <a class="pop-vai" href="${linkNavigazione(d.la, d.lo)}" target="_blank" rel="noopener">Portami qui</a></div>`;
  }

  function piuEconomico() {
    return stato.vicini.filter((d) => d.prezzo != null)
      .sort((a, b) => a.prezzo - b.prezzo || a.distanza - b.distanza)[0] || null;
  }
  function piuVicino() {
    return stato.vicini.filter((d) => !guasta(d)).sort((a, b) => a.distanza - b.distanza)[0] || null;
  }

  function render() {
    Object.entries(livelli).forEach(([k, g]) => { if (k !== "io") g.clearLayers(); });
    markerPerId.clear();
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;

    L.circle([lat, lon], {
      radius: stato.raggio, color: getComputedStyle(document.documentElement).getPropertyValue("--blu").trim() || "#1b4f9c",
      weight: 1.5, opacity: .6, fillOpacity: .04, dashArray: "6 6", interactive: false
    }).addTo(livelli.raggio);
    if (!stato.centro.daGps) {
      L.circleMarker([lat, lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#172033", fillOpacity: 1 }).addTo(livelli.io);
    }

    const migliore = piuEconomico();
    for (const d of stato.vicini) {
      let m;
      if (d.prezzo == null) {
        // senza prezzo: rettangolo grigio con la potenza massima
        m = L.marker([d.la, d.lo], { icon: icona("kw" + (guasta(d) ? " guasta" : ""), DL.formattaKw(d.kw)), title: DL.titolo(d) })
          .bindPopup(popupColonnina(d), OPZ_POPUP).addTo(livelli.senzaPrezzo);
      } else {
        const cls = ["prezzo", d.fascia, guasta(d) ? "guasta" : "", migliore && migliore.id === d.id ? "top" : ""].join(" ");
        // le più economiche sopra le altre quando si sovrappongono
        const z = d.fascia === "economico" ? 300 : d.fascia === "medio" ? 200 : 100;
        m = L.marker([d.la, d.lo], { icon: icona(cls, conC(d.prezzo)), title: DL.titolo(d), zIndexOffset: z + (migliore && migliore.id === d.id ? 500 : 0) })
          .bindPopup(popupColonnina(d), OPZ_POPUP).addTo(livelli.colonnine);
      }
      markerPerId.set(d.id, m);
    }

    const st = DL.statistiche(stato.vicini);
    $("k-min").textContent = st.min != null ? DL.formattaCent(st.min) : "–";
    $("k-media").textContent = st.media != null ? DL.formattaCent(st.media) : "–";
    $("k-n").textContent = st.n;
    $("k-posti").textContent = DL.testoPosti(st.posti);
    $("btn-economico").disabled = !migliore;
    $("btn-vicino").disabled = !stato.vicini.length;

    renderLista();
  }

  function voceLista(d) {
    const li = document.createElement("li");
    li.className = "voce";
    li.tabIndex = 0;
    const meta = [`<span>${esc(DL.indirizzo(d))}</span>`, `<span><b>${DL.testoPosti(d.posti)}</b> · ${DL.formattaKw(d.kw)}</span>`];
    if (d.h) meta.push('<span class="tag h24">24 ore</span>');
    if (guasta(d)) meta.push('<span class="tag vecchio">fuori servizio</span>');
    else if (d.guasti) meta.push(`<span class="tag vecchio">${d.guasti} ko</span>`);
    if (d.prezzo == null) meta.push("<span>prezzo non comunicato</span>");
    else if (d.fontePrezzo === "O") meta.push("<span>prezzo indicativo</span>");
    li.innerHTML = `
      <div class="icona prezzo ${d.prezzo != null ? d.fascia : "nd"}${guasta(d) ? " vecchio" : ""}">${d.prezzo != null ? conC(d.prezzo) : "–"}</div>
      <div class="voce-testo">
        <div class="voce-titolo">${esc(DL.titolo(d))}</div>
        <div class="voce-meta">${meta.join("")}</div>
      </div>
      <div class="voce-dist"><b>${DL.formattaDistanza(d.distanza)}</b><small>~${DL.minutiInAuto(d.distanza)} min</small></div>`;
    const apri = () => { mostra(d); chiudiElenco(); };
    li.addEventListener("click", apri);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apri(); } });
    return li;
  }

  function renderLista() {
    const ol = $("lista");
    ol.innerHTML = "";
    const lista = stato.vicini.slice().sort((a, b) => {
      if (stato.ordine === "prezzo") {
        if ((a.prezzo == null) !== (b.prezzo == null)) return a.prezzo == null ? 1 : -1;
        if (a.prezzo != null && a.prezzo !== b.prezzo) return a.prezzo - b.prezzo;
      }
      return a.distanza - b.distanza;
    });
    if (!lista.length) {
      const li = document.createElement("li");
      li.className = "vuoto";
      li.textContent = stato.filtri.size
        ? "Nessuna colonnina con questi filtri. Prova a toglierne uno o ad allargare il raggio."
        : "Nessuna colonnina di questa potenza nel raggio. Prova ad allargarlo o a scegliere un'altra potenza.";
      ol.appendChild(li);
      return;
    }
    lista.slice(0, 200).forEach((d) => ol.appendChild(voceLista(d)));
  }

  function mostra(d) {
    if (!d) return;
    stato.seguiGps = false;
    mappa.setView([d.la, d.lo], Math.max(mappa.getZoom(), 15));
    const m = markerPerId.get(d.id);
    if (m) setTimeout(() => m.openPopup(), 250);
  }

  // ---------- Posizione ----------
  let marcatoreIo, cerchioPrecisione;

  function impostaCentro(lat, lon, daGps) {
    const prima = stato.centro;
    stato.centro = { lat, lon, daGps };
    const spostato = !prima || prima.daGps !== daGps ||
      DL.distanza(prima.lat, prima.lon, lat, lon) > (cfg.ricaricaDopoMetri || 300);
    if (spostato) {
      mappa.fitBounds(L.latLng(lat, lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  }

  function suPosizione(p) {
    const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
    stato.gps = { lat, lon, acc };
    if (!marcatoreIo) {
      marcatoreIo = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="io"></div>', iconSize: [18, 18] }), zIndexOffset: 1000, interactive: false }).addTo(livelli.io);
      cerchioPrecisione = L.circle([lat, lon], { radius: acc, color: "#2f7cf6", weight: 0, fillOpacity: .12, interactive: false }).addTo(livelli.io);
    } else {
      marcatoreIo.setLatLng([lat, lon]);
      cerchioPrecisione.setLatLng([lat, lon]).setRadius(acc);
    }
    if (stato.seguiGps) impostaCentro(lat, lon, true);
  }

  function erroreGps(e) {
    const testi = {
      1: "Posizione non autorizzata. Consenti l'accesso alla posizione oppure cerca un indirizzo.",
      2: "Posizione non disponibile. Cerca un indirizzo qui sopra.",
      3: "Il GPS non risponde. Cerca un indirizzo qui sopra."
    };
    if (!stato.gps) messaggio(testi[e.code] || testi[2], true);
  }

  function avviaGps() {
    if (!("geolocation" in navigator)) {
      messaggio("Questo browser non fornisce la posizione. Cerca un indirizzo qui sopra.", true);
      return;
    }
    if (!window.isSecureContext) {
      messaggio("Il GPS funziona solo su HTTPS. Pubblica l'app su un sito https o cerca un indirizzo.", true);
    }
    navigator.geolocation.watchPosition(suPosizione, erroreGps, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  // ---------- Ricerca indirizzo ----------
  $("form-cerca").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("cerca-indirizzo").value.trim();
    if (!q) return;
    messaggio("Cerco “" + q + "”…");
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=it&accept-language=it&q=" + encodeURIComponent(q);
      const [primo] = await fetchJson(url, { headers: { Accept: "application/json" } }, 12000);
      if (!primo) { messaggio("Indirizzo non trovato. Prova ad aggiungere la città.", true); return; }
      stato.seguiGps = false;
      $("cerca-indirizzo").blur();
      impostaCentro(+primo.lat, +primo.lon, false);
    } catch (err) {
      messaggio("Ricerca non riuscita. Controlla la connessione.", true);
    }
  });

  // ---------- Controlli ----------
  $("btn-centra").addEventListener("click", () => {
    stato.seguiGps = true;
    if (stato.gps) {
      impostaCentro(stato.gps.lat, stato.gps.lon, true);
      mappa.fitBounds(L.latLng(stato.gps.lat, stato.gps.lon).toBounds(stato.raggio * 2.1));
    } else toast("Posizione non ancora disponibile.");
  });
  $("btn-aggiorna").addEventListener("click", () => carica(true));
  $("btn-economico").addEventListener("click", () => {
    const d = piuEconomico();
    if (d) mostra(d); else toast("Nessun prezzo disponibile in questo raggio.");
  });
  $("btn-vicino").addEventListener("click", () => {
    const d = piuVicino();
    if (d) mostra(d); else toast("Nessuna colonnina funzionante in questo raggio.");
  });

  $("raggio").value = String(stato.raggio);
  $("raggio").addEventListener("change", (e) => {
    stato.raggio = +e.target.value;
    salvaPref("raggio", stato.raggio);
    if (stato.centro) {
      mappa.fitBounds(L.latLng(stato.centro.lat, stato.centro.lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  });
  $("potenza").value = stato.potenza;
  $("potenza").addEventListener("change", (e) => {
    stato.potenza = e.target.value;
    salvaPref("potenza", stato.potenza);
    mappa.closePopup();
    ricalcola();
    toast("Ora vedi: " + nomePotenza());
  });
  function aggiornaChipOrdine() {
    document.querySelectorAll(".chip.ordine").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.ordine === stato.ordine)));
  }
  aggiornaChipOrdine();
  document.querySelectorAll(".chip.ordine").forEach((c) => c.addEventListener("click", () => {
    stato.ordine = c.dataset.ordine;
    salvaPref("ordine", stato.ordine);
    aggiornaChipOrdine();
    renderLista();
  }));
  document.querySelectorAll(".chip.filtro").forEach((c) => c.addEventListener("click", () => {
    const f = c.dataset.filtro;
    const on = !stato.filtri.has(f);
    on ? stato.filtri.add(f) : stato.filtri.delete(f);
    c.setAttribute("aria-pressed", String(on));
    ricalcola();
  }));
  function apriElenco() {
    $("pannello").hidden = false;
    $("btn-elenco").setAttribute("aria-expanded", "true");
    $("btn-chiudi").focus();
  }
  function chiudiElenco() {
    if ($("pannello").hidden) return;
    $("pannello").hidden = true;
    $("btn-elenco").setAttribute("aria-expanded", "false");
    $("btn-elenco").focus();
  }
  $("btn-elenco").addEventListener("click", apriElenco);
  $("btn-chiudi").addEventListener("click", chiudiElenco);

  // ---------- Guida ----------
  let tornaA = null;
  function apriGuida(e) {
    tornaA = e && e.currentTarget ? e.currentTarget : $("btn-guida");
    $("guida").hidden = false;
    $("guida").querySelector(".pannello-corpo").scrollTop = 0;
    $("btn-guida").setAttribute("aria-expanded", "true");
    $("btn-chiudi-guida").focus();
  }
  function chiudiGuida() {
    if ($("guida").hidden) return false;
    $("guida").hidden = true;
    $("btn-guida").setAttribute("aria-expanded", "false");
    if (tornaA && tornaA.offsetParent) tornaA.focus();
    return true;
  }
  $("btn-guida").addEventListener("click", apriGuida);
  $("btn-guida-elenco").addEventListener("click", apriGuida);
  $("btn-chiudi-guida").addEventListener("click", chiudiGuida);
  $("guida").querySelectorAll(".g-indice a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const dest = $("guida").querySelector(a.getAttribute("href"));
    if (dest) dest.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("guida-versione").textContent = "Versione " + (cfg.versione || "");
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !chiudiGuida()) chiudiElenco(); });

  // ---------- Lettura vocale dei riquadri ----------
  let letturaAttiva = leggiPref("lettura", "1") !== "0";
  const sintesi = window.speechSynthesis;
  function vocItaliana() {
    const voci = sintesi ? sintesi.getVoices() : [];
    return voci.find((v) => /^it[-_]IT/i.test(v.lang) && v.localService) || voci.find((v) => /^it/i.test(v.lang)) || null;
  }
  function leggi(testo) {
    if (!sintesi || !testo) return;
    sintesi.cancel();
    const u = new SpeechSynthesisUtterance(testo);
    u.lang = "it-IT";
    const v = vocItaliana();
    if (v) u.voice = v;
    u.rate = 1;
    sintesi.speak(u);
  }
  mappa.on("popupopen", (e) => {
    if (!letturaAttiva) return;
    const el = e.popup.getElement && e.popup.getElement();
    const pop = el ? el.querySelector(".pop") : null;
    if (pop) leggi(pop.dataset.voce);
  });
  mappa.on("popupclose", () => { if (sintesi) sintesi.cancel(); });
  if (!sintesi) { $("riga-lettura").hidden = true; }
  $("lettura").value = letturaAttiva ? "1" : "0";
  $("lettura").addEventListener("change", (e) => {
    letturaAttiva = e.target.value === "1";
    salvaPref("lettura", letturaAttiva ? "1" : "0");
    if (letturaAttiva) leggi("Lettura vocale attiva.");
    else if (sintesi) sintesi.cancel();
  });

  // ---------- Auto-refresh ----------
  // Ogni N secondi torna sulla tua posizione e ricalcola le colonnine vicine.
  // I dati vengono riscaricati solo se il sito ne ha di nuovi (controllo ogni 15 minuti).
  let timerAuto;
  function autoAggiorna() {
    if (document.hidden || !stato.gps) return;
    stato.seguiGps = true;
    stato.centro = { lat: stato.gps.lat, lon: stato.gps.lon, daGps: true };
    mappa.setView([stato.gps.lat, stato.gps.lon], Math.max(mappa.getZoom(), 13));
    carica(false, true);
  }
  function impostaAuto(sec) {
    clearInterval(timerAuto);
    if (sec > 0) timerAuto = setInterval(autoAggiorna, sec * 1000);
    autoAttivo = sec > 0;
    aggiornaSchermoAcceso();
    salvaPref("auto", sec);
  }

  // ---------- Schermo sempre acceso (Wake Lock) ----------
  let autoAttivo = false, bloccoSchermo = null, richiestaInCorso = false;
  function mostraOcchio() { $("occhio").hidden = !bloccoSchermo; }
  async function aggiornaSchermoAcceso() {
    const vuole = autoAttivo && document.visibilityState === "visible";
    if (!vuole) {
      if (bloccoSchermo) { const b = bloccoSchermo; bloccoSchermo = null; b.release().catch(() => {}); }
      mostraOcchio();
      return;
    }
    if (bloccoSchermo || richiestaInCorso || !("wakeLock" in navigator)) { mostraOcchio(); return; }
    richiestaInCorso = true;
    try {
      const b = await navigator.wakeLock.request("screen");
      b.addEventListener("release", () => { if (bloccoSchermo === b) { bloccoSchermo = null; mostraOcchio(); } });
      if (autoAttivo && document.visibilityState === "visible") bloccoSchermo = b;
      else b.release().catch(() => {});
    } catch (e) { /* non supportato o negato: l'app funziona lo stesso */ }
    richiestaInCorso = false;
    mostraOcchio();
  }
  document.addEventListener("visibilitychange", aggiornaSchermoAcceso);
  document.addEventListener("pointerdown", () => { if (autoAttivo && !bloccoSchermo) aggiornaSchermoAcceso(); }, { passive: true });
  $("occhio").addEventListener("click", () => toast("Schermo sempre acceso finché l'AUTO-REFRESH è attivo"));

  let secAuto = cfg.autoRefreshSecondi ?? 120;
  const salvato = leggiPref("auto", null);
  if (salvato !== null && ["0", "30", "60", "120"].includes(salvato)) secAuto = +salvato;
  $("auto-refresh").value = String(secAuto);
  impostaAuto(secAuto);
  $("auto-refresh").addEventListener("change", (e) => {
    impostaAuto(+e.target.value);
    toast(+e.target.value ? `Auto-refresh ogni ${e.target.value} secondi` : "Auto-refresh disattivato");
  });
  $("sfondo").value = sfondoAttivo;
  $("sfondo").addEventListener("change", (e) => impostaSfondo(e.target.value));
  $("suoni").value = suoniAttivi ? "1" : "0";
  $("suoni").addEventListener("change", (e) => {
    suoniAttivi = e.target.value === "1";
    salvaPref("suoni", suoniAttivi ? "1" : "0");
    sbloccaAudio();
    if (suoniAttivi) setTimeout(SUONO.aggiornato, 150); // prova
  });

  // Ogni 15 minuti controlla se il sito ha dati nuovi
  setInterval(() => { if (stato.centro && !stato.caricando && !document.hidden) carica(false, true); }, 15 * 60000);

  // Numero di versione lungo la diagonale della mappa
  $("filigrana-testo").textContent = "Versione " + (cfg.versione || "");
  function posizionaFiligrana() {
    const f = $("filigrana"), w = f.clientWidth, h = f.clientHeight;
    if (!w || !h) return;
    const diag = Math.hypot(w, h);
    f.style.setProperty("--fil-ang", (Math.atan2(h, w) * 180 / Math.PI).toFixed(1) + "deg");
    f.style.setProperty("--fil-size", Math.round(diag / 10.5) + "px");
  }
  posizionaFiligrana();
  window.addEventListener("resize", posizionaFiligrana);

  $("btn-economico").disabled = true;
  $("btn-vicino").disabled = true;
  avviaGps();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    const cerano = !!navigator.serviceWorker.controller;
    let ricaricata = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (cerano && !ricaricata) { ricaricata = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
  }
})();
