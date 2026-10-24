/*
 * Colonnine – configurazione
 */
window.COLONNINE_CONFIG = {
  // Versione dell'app, mostrata in diagonale sulla mappa. Aumentala a ogni aggiornamento
  // (insieme alla cache in sw.js e a ?v= in index.html).
  versione: "9",

  // Raggio di ricerca iniziale in metri (modificabile anche dall'app)
  raggioMetri: 5000,

  // Ricentra e ricalcola quando ti sposti di più di questi metri
  ricaricaDopoMetri: 300,

  // Potenza iniziale: "tutte", "ac" (lenta), "dc" (veloce), "hpc" (ultraveloce, 150 kW e oltre)
  potenza: "tutte",

  // Auto-refresh predefinito in secondi (0 = spento). Si cambia anche dalla pagina elenco.
  autoRefreshSecondi: 120
};
