/*
 * Colonnine – logica pura (nessun accesso a DOM o rete).
 * Funziona sia nel browser (window.DL) sia in Node (module.exports) per i test.
 */
(function (root) {
  "use strict";

  const R_TERRA = 6371000;

  function distanza(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRA * Math.asin(Math.sqrt(a));
  }

  function formattaDistanza(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    return (m / 1000).toFixed(1).replace(".", ",") + " km";
  }

  // Minuti in auto, stima prudente in città (circa 30 km/h)
  function minutiInAuto(m) {
    return Math.max(1, Math.round(m / 500));
  }

  // ---------- Potenza ----------
  // Filtro in alto: tutte, lenta (corrente alternata), veloce (continua), ultraveloce (150 kW e oltre)
  const POTENZE = {
    tutte: { nome: "Tutte", breve: "tutte le potenze" },
    ac: { nome: "Lenta AC", breve: "ricarica lenta (AC)" },
    dc: { nome: "Veloce DC", breve: "ricarica veloce (DC)" },
    hpc: { nome: "Ultra 150+", breve: "ricarica ultraveloce (da 150 kW)" }
  };
  const ULTRA_KW = 150;

  // Ogni gruppo in s.e: [kW, "AC"/"DC", connettore, posti, posti guasti, prezzo €/kWh o null, fonte "P"/"O",
  //                      € di attivazione, €/minuto] (gli ultimi due solo se comunicati)
  function passaPotenza(g, filtro) {
    if (filtro === "ac") return g[1] === "AC";
    if (filtro === "dc") return g[1] === "DC";
    if (filtro === "hpc") return g[1] === "DC" && g[0] >= ULTRA_KW;
    return true;
  }

  // Prezzo in centesimi al kWh, senza decimali (0,519 → "52")
  function formattaCent(p) {
    return p == null ? "–" : String(Math.round(p * 100));
  }
  function formattaEuro(e, decimali) {
    return e.toFixed(decimali ?? 2).replace(".", ",");
  }
  function formattaKw(kw) {
    if (!kw) return "? kW";
    return (Number.isInteger(kw) ? String(kw) : kw.toFixed(1).replace(".", ",")) + " kW";
  }

  /**
   * Colonnine entro il raggio che hanno almeno un posto della potenza scelta, con distanza,
   * posti, potenza massima e prezzo più basso tra i posti della potenza scelta.
   * Fascia di prezzo rispetto alle altre colonnine in zona:
   *   "economico" il terzo più basso, "caro" il terzo più alto, "medio" il resto, "nd" senza prezzo.
   */
  function preparaColonnine(lista, lat, lon, raggio, filtro) {
    const out = [];
    for (const s of lista || []) {
      const dist = distanza(lat, lon, s.la, s.lo);
      if (dist > raggio) continue;
      const gruppi = (s.e || []).filter((g) => passaPotenza(g, filtro));
      if (!gruppi.length) continue;
      let posti = 0, guasti = 0, kw = 0, prezzo = null, fonte = null, attivazione = null, minuto = null;
      for (const g of gruppi) {
        posti += g[3];
        guasti += g[4];
        kw = Math.max(kw, g[0] || 0);
        if (g[5] != null && (prezzo == null || g[5] < prezzo)) { prezzo = g[5]; fonte = g[6]; attivazione = g[7] ?? null; minuto = g[8] ?? null; }
      }
      out.push({ ...s, id: "c/" + s.i, distanza: dist, gruppi, posti, guasti, kw, prezzo, fontePrezzo: fonte, attivazione, minuto, fascia: "nd" });
    }
    classifica(out);
    return out;
  }

  function classifica(lista) {
    for (const d of lista) d.fascia = "nd";
    const con = lista.filter((d) => d.prezzo != null).sort((a, b) => a.prezzo - b.prezzo);
    const n = con.length;
    if (!n) return lista;
    const min = con[0].prezzo, max = con[n - 1].prezzo;
    // Soglie a un terzo e due terzi della classifica; a parità di prezzo stessa fascia
    const soglia1 = con[Math.floor((n - 1) / 3)].prezzo;
    const soglia2 = con[Math.ceil(2 * (n - 1) / 3)].prezzo;
    for (const d of con) {
      if (max - min < 0.005) d.fascia = "economico";        // tutti uguali (al centesimo)
      else if (d.prezzo <= soglia1) d.fascia = "economico";
      else if (d.prezzo >= soglia2 && d.prezzo > soglia1) d.fascia = "caro";
      else d.fascia = "medio";
    }
    return lista;
  }

  function statistiche(lista) {
    const prezzi = lista.filter((d) => d.prezzo != null).map((d) => d.prezzo);
    return {
      min: prezzi.length ? Math.min(...prezzi) : null,
      media: prezzi.length ? prezzi.reduce((s, p) => s + p, 0) / prezzi.length : null,
      nPrezzi: prezzi.length,
      n: lista.length,
      posti: lista.reduce((s, d) => s + d.posti, 0)
    };
  }

  // Tessere (file del sito) che coprono il cerchio di ricerca
  function tessereNelRaggio(lat, lon, raggio, passo) {
    const dLat = raggio / 111320, dLon = raggio / (111320 * Math.cos(lat * Math.PI / 180));
    const nomi = [];
    for (let i = Math.floor((lat - dLat) / passo); i <= Math.floor((lat + dLat) / passo); i++) {
      for (let j = Math.floor((lon - dLon) / passo); j <= Math.floor((lon + dLon) / passo); j++) {
        nomi.push(`t_${i}_${j}.json`);
      }
    }
    return nomi;
  }

  function titolo(s) {
    return (s.o || "").trim() || "Colonnina";
  }
  function capitalizza(s) {
    s = String(s || "").trim();
    if (s && s === s.toUpperCase()) {
      const minuscole = /^(di|de|del|dei|degli|della|delle|dello|da|dal|dalla|al|alla|e|ed|in|sul|sulla|per)$/;
      return s.toLowerCase().replace(/(^|[\s'’.\-/(])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase())
        .replace(/(\s)([A-ZÀ-Ù][a-zà-ù]*)(?=\s)/g, (m, sp, w) => minuscole.test(w.toLowerCase()) ? sp + w.toLowerCase() : m);
    }
    return s;
  }
  function indirizzo(s) {
    return [capitalizza(s.a || ""), capitalizza(s.c || "")].filter((x) => x.trim()).join(", ");
  }
  function testoPosti(n) {
    return n === 1 ? "1 posto" : n + " posti";
  }

  const API = {
    distanza, formattaDistanza, minutiInAuto, POTENZE, ULTRA_KW, passaPotenza, formattaCent, formattaEuro, formattaKw,
    preparaColonnine, classifica, statistiche, tessereNelRaggio, titolo, capitalizza, indirizzo, testoPosti
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.DL = API;
})(typeof window !== "undefined" ? window : globalThis);
