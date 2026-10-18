# Colonnine

Web app per il telefono che mostra le colonnine di ricarica per auto elettriche vicino a te: marca, numero di posti
(auto che possono ricaricare insieme), potenza e prezzo in centesimi/kWh senza abbonamento.
Dati della PUN (Piattaforma Unica Nazionale dei punti di ricarica, MASE/GSE). Stesso aspetto e funzionamento di Distributori.

## Come funziona

- Più volte al giorno GitHub esegue `aggiorna_colonnine.py` (workflow `.github/workflows/pubblica.yml`):
  legge i punti di ricarica dall'API pubblica della PUN (la stessa della sua mappa, credenziali "ospite" senza login),
  li raggruppa per colonnina e li salva nella cartella `dati/` del sito pubblicato, divisi in tessere da 0,25°.
- Ogni punto di ricarica (EVSE) è un posto: i punti con le stesse coordinate e lo stesso operatore formano una colonnina.
- La cartella `dati/` **non** sta nel repository: viene creata a ogni pubblicazione.
  Se la PUN non risponde, lo script ricopia i dati già pubblicati, così il sito non resta mai vuoto.
- `dati/diagnosi.json` contiene l'elenco dei campi trovati nei dati della PUN e qualche esempio: serve a controllare se e dove ci sono i prezzi.
- Prezzo: se la PUN lo fornisce (tariffa senza abbonamento) si usa quello; altrimenti, se c'è, il prezzo indicativo
  dell'operatore scritto a mano in `prezzi_operatori.json`.

## Pubblicazione

Impostazioni del repository → Pages → Source: **GitHub Actions**.
Per aggiornare i dati subito: Actions → *Pubblica sito e aggiorna colonnine* → *Run workflow*.

## File

- `index.html`, `style.css`: interfaccia
- `core.js`: logica (distanze, potenza, prezzi, fasce di prezzo)
- `app.js`: mappa, GPS, elenco, impostazioni
- `config.js`: impostazioni iniziali e numero di versione
- `aggiorna_colonnine.py`, `prezzi_operatori.json`, `.github/workflows/pubblica.yml`: scaricamento dei dati e pubblicazione
- `sw.js`, `manifest.webmanifest`, `icon.svg`: installazione come app
- `icon-512.png`, `icon-192.png`, `apple-touch-icon.png`: logo in PNG (dall'icona SVG)
- `guida.html`: guida all'app come pagina a sé (https://paolo1957-it.github.io/Colonnine/guida.html)

## Fonte dei dati

Colonnine: PUN – Piattaforma Unica Nazionale dei punti di ricarica (MASE/GSE). Mappa: © OpenStreetMap.
Il prezzo che vale è sempre quello mostrato dalla colonnina o dall'app con cui paghi.
