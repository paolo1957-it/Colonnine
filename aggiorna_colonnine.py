#!/usr/bin/env python3
"""
Colonnine – scarica i punti di ricarica dalla PUN (Piattaforma Unica Nazionale, MASE/GSE) e li
salva nel sito, divisi in "tessere" da 0,25 gradi (circa 28 × 20 km), come Distributori.

Lo esegue GitHub da solo più volte al giorno (vedi .github/workflows/pubblica.yml).
I dati NON vengono salvati nel repository: finiscono solo nel sito pubblicato.
Se la PUN non risponde, lo script recupera i dati già pubblicati sul sito.

Come si leggono i dati della PUN (stesso metodo della mappa ufficiale):
  1. region e IdentityPoolId da https://www.piattaformaunicanazionale.it/config.json
  2. credenziali "ospite" AWS Cognito (nessun login) e firma SigV4 delle richieste
  3. POST /v1/chargepoints/public/map/search (a pagine)   → elenco degli evse_id
  4. POST /v1/chargepoints/group (100 evse_id alla volta) → dettagli di ogni punto di ricarica
Ogni EVSE è un punto dove ricarica UNA auto: i punti con le stesse coordinate formano una colonnina
(o un'area di ricarica) e il loro numero è il numero di posti.

Prezzo: se la PUN lo fornisce (tariffa OCPI senza abbonamento, "AD_HOC_PAYMENT") viene usato quello;
altrimenti, se c'è, il prezzo indicativo dell'operatore scritto a mano in prezzi_operatori.json.
Dipendenze: boto3 e requests (le installa il workflow).
"""
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.request
from collections import Counter
from datetime import datetime, timezone

SITO_PUN = "https://www.piattaformaunicanazionale.it"
API = "https://api.pun.piattaformaunicanazionale.it"
# Valori noti (estate 2026), usati se config.json cambia forma
REGIONE_RISERVA = "eu-south-1"
POOL_RISERVA = "eu-south-1:e3b2ab05-2046-43dd-8ed0-c0f14c69d507"
USER_AGENT = "Colonnine/1.0 (app web personale; dati PUN)"

CARTELLA = "dati"
PASSO = 0.25          # lato della tessera in gradi
PAGINA = 1000
GRUPPO = 100

# Stati che non contano come posti (punto tolto o non ancora costruito)
ESCLUSI = {"REMOVED", "PLANNED"}
GUASTI = {"OUTOFORDER", "INOPERATIVE", "BLOCKED"}
DC = {"CHADEMO", "IEC_62196_T2_COMBO", "IEC_62196_T1_COMBO", "TESLA_R", "TESLA_S", "NACS", "GBT_DC"}
CONNETTORI = {
    "IEC_62196_T2": "Tipo 2", "IEC_62196_T2_COMBO": "CCS", "IEC_62196_T1_COMBO": "CCS1",
    "CHADEMO": "CHAdeMO", "IEC_62196_T3A": "Tipo 3A", "IEC_62196_T3C": "Tipo 3C",
    "IEC_62196_T1": "Tipo 1", "DOMESTIC_F": "Schuko", "DOMESTIC_L": "Presa italiana",
    "TESLA_R": "Tesla", "TESLA_S": "Tesla", "NACS": "Tesla",
}

# Marchi conosciuti: (codice operatore PUN, parola nella ragione sociale) → nome da mostrare
MARCHI = [
    ("ENX", r"ENEL\s*X", "Enel X Way"), ("BEC", r"BE\s*CHARGE", "Plenitude (ex Be Charge)"),
    ("", r"PLENITUDE|ENI\s*PLENITUDE", "Plenitude"), ("TSL", r"TESLA", "Tesla"),
    ("EWI", r"EWIVA", "Ewiva"), ("", r"\bA2A\b", "A2A"), ("DUF", r"DUFERCO", "Duferco"),
    ("ION", r"IONITY", "Ionity"), ("", r"FREE\s*TO\s*X", "Free To X"), ("", r"ATLANTE", "Atlante"),
    ("", r"ELECTRA", "Electra"), ("", r"\bACEA\b", "Acea"), ("", r"\bHERA\b", "Hera"),
    ("", r"\bIREN\b", "Iren"), ("", r"EDISON", "Edison"), ("", r"NEOGY", "Neogy"),
    ("", r"EMOBITALY", "Emobitaly"), ("", r"FASTNED", "Fastned"), ("", r"ALLEGO", "Allego"),
    ("", r"ENERCOOP", "Enercoop"), ("", r"SPARK", "Spark"), ("", r"ZEDDY|ZEST", "Zest"),
    ("", r"POWY|THEF\s*CHARGING", "Powy"), ("", r"EVWAY|ROUTE\s*220", "EVWay"), ("", r"DRIWE", "DriWe"),
    ("", r"ON\s*ELECTRIC", "On Electric Charge"), ("", r"REPOWER", "Repower"), ("", r"FASTWAY", "Fastway"),
    ("", r"IPLANET", "iPlanet"), ("", r"VIAFAST", "Viafast"), ("", r"SMATRICS|ENBW", "Smatrics EnBW"),
    ("", r"ELECTRIP", "Electrip"), ("", r"PORSCHE", "Porsche"), ("", r"GASGAS", "GasGas"),
    ("", r"E-?SHORE", "E-Shore"), ("", r"ENERMIA", "Enermia"), ("", r"WROOM", "Wroom"),
]
FORME = r"\b(S\.?\s?R\.?\s?L\.?\s?S?|S\.?\s?P\.?\s?A\.?|S\.?\s?A\.?\s?S\.?|S\.?\s?N\.?\s?C\.?|SOCIET[AÀ]'?\s+BENEFIT|SB|SOCIET[AÀ]\s+AGRICOLA|ITALIA|ITALY|GMBH|B\.?V\.?)\b\.?"


# ---------- Accesso alla PUN ----------

class Pun:
    def __init__(self):
        import boto3
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        from botocore.credentials import Credentials
        self._Sig, self._Req, self._Cred = SigV4Auth, AWSRequest, Credentials
        self.regione, self.pool = self._config(requests)
        self.cognito = boto3.client("cognito-identity", region_name=self.regione,
                                    aws_access_key_id="", aws_secret_access_key="")
        self.http = requests.Session()
        self.http.headers["User-Agent"] = USER_AGENT
        self.cred, self.scade = None, 0

    @staticmethod
    def _config(requests):
        try:
            r = requests.get(SITO_PUN + "/config.json", headers={"User-Agent": USER_AGENT}, timeout=20)
            r.raise_for_status()
            testo = json.dumps(r.json())
            pool = re.search(r"([a-z]{2}-[a-z]+-\d:[0-9a-f-]{36})", testo)
            pool = pool.group(1) if pool else POOL_RISERVA
            reg = re.search(r'"(?:region|awsRegion|aws_region)"\s*:\s*"([a-z0-9-]+)"', testo)
            return (reg.group(1) if reg else pool.split(":")[0]), pool
        except Exception as ex:
            print(f"  config.json non leggibile ({ex}): uso i valori noti")
            return REGIONE_RISERVA, POOL_RISERVA

    def _credenziali(self):
        if self.cred and time.time() < self.scade - 120:
            return
        iid = self.cognito.get_id(IdentityPoolId=self.pool)["IdentityId"]
        c = self.cognito.get_credentials_for_identity(IdentityId=iid)["Credentials"]
        self.cred = self._Cred(c["AccessKeyId"], c["SecretKey"], c["SessionToken"])
        self.scade = c["Expiration"].timestamp()

    def chiama(self, metodo, percorso, dati=None, tentativi=4):
        ultimo = None
        for i in range(tentativi):
            try:
                self._credenziali()
                url = API + percorso
                corpo = json.dumps(dati) if dati is not None else None
                req = self._Req(method=metodo, url=url, data=corpo,
                                headers={"Content-Type": "application/json"} if corpo else {})
                self._Sig(self.cred, "execute-api", self.regione).add_auth(req)
                r = self.http.request(metodo, url, data=corpo, headers=dict(req.headers), timeout=60)
                if r.status_code in (401, 403):
                    self.cred = None
                if r.status_code >= 500 or r.status_code in (401, 403, 429):
                    raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
                return r
            except Exception as ex:
                ultimo = ex
                print(f"  {percorso}: {ex}")
                time.sleep(5 * (i + 1))
        raise RuntimeError(f"{percorso} non raggiungibile: {ultimo}")


def scarica_pun():
    pun = Pun()
    print(f"PUN: regione {pun.regione}")
    voci, pagina = [], 0
    while True:
        r = pun.chiama("POST", "/v1/chargepoints/public/map/search", {"page": pagina, "size": PAGINA})
        r.raise_for_status()
        d = r.json()
        voci.extend(d.get("content", []))
        if pagina == 0:
            print(f"  map/search: {d.get('totalElements', '?')} punti in {d.get('totalPages', '?')} pagine")
        if d.get("last", True) or not d.get("content"):
            break
        pagina += 1
    ids = list(dict.fromkeys(v["evse_id"] for v in voci if v.get("evse_id")))
    print(f"  {len(ids)} evse_id")
    record = []
    for i in range(0, len(ids), GRUPPO):
        r = pun.chiama("POST", "/v1/chargepoints/group", ids[i:i + GRUPPO])
        r.raise_for_status()
        record.extend(r.json())
        if i and i % 10000 == 0:
            print(f"  dettagli: {i}/{len(ids)}")
        time.sleep(0.05)
    print(f"  {len(record)} punti di ricarica con i dettagli")
    return pun, voci, record


# ---------- Diagnostica (serve a capire se e dove la PUN mette i prezzi) ----------

def censimento(record):
    """Conta tutti i campi presenti nei record (percorsi tipo connectors[].standard)."""
    conta = Counter()

    def giro(v, via):
        if isinstance(v, dict):
            for k, x in v.items():
                giro(x, f"{via}.{k}" if via else k)
        elif isinstance(v, list):
            for x in v[:20]:
                giro(x, via + "[]")
        else:
            conta[via] += 1
    for r in record:
        giro(r, "")
    return conta


def sonda_prezzi(pun, record):
    """Prova qualche indirizzo dove la PUN potrebbe tenere le tariffe e scrive cosa risponde."""
    esiti = []
    if not record:
        return esiti
    evse = record[0].get("evse_id", "")
    loc = (record[0].get("location") or {}).get("id") or ""
    tariffe = [t for c in record[0].get("connectors") or [] for t in (c.get("tariff_ids") or [])]
    prove = [("GET", f"/v1/chargepoints/{evse}", None), ("GET", f"/v1/chargepoints/public/{evse}", None),
             ("POST", "/v1/tariffs/group", tariffe[:5] or [evse]), ("GET", "/v1/tariffs", None)]
    if loc:
        prove.append(("GET", f"/v1/locations/{loc}", None))
    for metodo, percorso, dati in prove:
        try:
            r = pun.chiama(metodo, percorso, dati, tentativi=1)
            esiti.append({"prova": f"{metodo} {percorso}", "http": r.status_code, "risposta": r.text[:800]})
        except Exception as ex:
            esiti.append({"prova": f"{metodo} {percorso}", "errore": str(ex)[:300]})
    return esiti


# ---------- Prezzo €/kWh ----------

def _num(v):
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def _euro_kwh(p):
    """Riporta il valore a €/kWh: accetta anche centesimi (es. 59 → 0,59)."""
    if p is None:
        return None
    if 5 <= p <= 200:
        p = p / 100
    return round(p, 3) if 0.05 <= p <= 2.5 else None


def tariffa_pun(rec, kw, corrente):
    """Tariffa senza abbonamento comunicata alla PUN (campo punTariffsDetails, con le voci
    acTariff, dcTariff, hpcTariff e per ognuna energy, activation, parking, time).
    Usa la voce della potenza del punto (DC da 150 kW = hpc), poi le altre della stessa corrente.
    Restituisce (€/kWh, € di attivazione, €/minuto) o None."""
    det = rec.get("punTariffsDetails")
    if not isinstance(det, dict):
        return None
    if corrente == "AC":
        ordine = ["acTariff"]
    else:
        ordine = ["hpcTariff", "dcTariff"] if kw >= 150 else ["dcTariff", "hpcTariff"]
    for voce in ordine:
        t = det.get(voce)
        if not isinstance(t, dict):
            continue
        energia = _euro_kwh(_num(t.get("energy")))
        if energia:
            att, minuto = _num(t.get("activation")), _num(t.get("time"))
            return (energia,
                    round(att, 2) if att and 0 < att < 20 else None,
                    round(minuto, 3) if minuto and 0 < minuto < 5 else None)
    return None


def prezzo_pun(rec):
    """Prezzo dell'energia senza abbonamento, se il record della PUN lo contiene.
    Cerca tariffe in formato OCPI (elements[].price_components[] di tipo ENERGY) e, in mancanza,
    campi con un nome da prezzo al kWh."""
    tariffe, sciolti = [], []

    def giro(v, chiave=""):
        if isinstance(v, dict):
            if isinstance(v.get("elements"), list):
                tariffe.append(v)
            for k, x in v.items():
                giro(x, k)
        elif isinstance(v, list):
            for x in v:
                giro(x, chiave)
        elif re.search(r"(price|prezzo|cost|costo)", chiave, re.I) and re.search(r"(kwh|energy|energia)", chiave, re.I):
            p = _euro_kwh(_num(v))
            if p:
                sciolti.append(p)
    giro(rec)

    migliori = []
    for t in tariffe:
        tipo = str(t.get("type") or "").upper()
        if tipo and tipo not in ("AD_HOC_PAYMENT", "REGULAR"):
            continue      # tariffe con abbonamento o profili particolari
        for el in t.get("elements") or []:
            if (el.get("restrictions") or {}).get("min_kwh"):
                continue
            for pc in el.get("price_components") or []:
                if str(pc.get("type", "")).upper() != "ENERGY":
                    continue
                p = _num(pc.get("price"))
                iva = _num(pc.get("vat"))
                if p is not None and iva is not None:   # in OCPI il prezzo è senza IVA
                    p = p * (1 + iva / 100)
                p = _euro_kwh(p)
                if p:
                    migliori.append((0 if tipo == "AD_HOC_PAYMENT" else 1, p))
    if migliori:
        return min(migliori)[1]
    return min(sciolti) if sciolti else None


def leggi_prezzi_operatori():
    """prezzi_operatori.json: prezzi indicativi senza abbonamento scritti a mano (piano B)."""
    try:
        with open("prezzi_operatori.json", encoding="utf-8") as f:
            d = json.load(f)
        return {k.lower(): v for k, v in (d.get("operatori") or {}).items()}, d.get("fonte", "")
    except (OSError, ValueError):
        return {}, ""


def prezzo_operatore(tabella, marca, kw, corrente):
    t = tabella.get(marca.lower())
    if not t:
        return None
    fasce = ["AC"] if corrente == "AC" else (["HPC", "DC"] if kw >= 150 else ["DC", "HPC"])
    for fascia in fasce:          # se manca la voce esatta, usa l'altra in corrente continua
        p = _euro_kwh(_num(t.get(fascia)))
        if p:
            return p
    return None


# ---------- Elaborazione ----------

def marca(rec):
    nome = (rec.get("businessName") or "").strip()
    codice = ((rec.get("location") or {}).get("party_id") or "").strip().upper()
    for cod, regex, mostra in MARCHI:
        if (cod and codice == cod) or re.search(regex, nome, re.I):
            return mostra
    pulito = re.sub(FORME, "", nome, flags=re.I)
    pulito = re.sub(r"[\s,.\-]+$", "", re.sub(r"\s{2,}", " ", pulito)).strip()
    if not pulito:
        return codice or "Colonnina"
    if pulito == pulito.upper() and len(pulito) > 4:
        pulito = pulito.title()
    return pulito


def costruisci(record, tabella_operatori):
    siti = {}
    scartati = Counter()
    for rec in record:
        stato = str(rec.get("status") or "").upper()
        if stato in ESCLUSI:
            scartati["tolti o in progetto"] += 1
            continue
        co = rec.get("coordinates") or {}
        lat, lon = _num(co.get("latitude")), _num(co.get("longitude"))
        if lat is None or lon is None:
            scartati["senza coordinate"] += 1
            continue
        if 6 <= lat <= 19 and 35 <= lon <= 48:   # latitudine e longitudine scambiate
            lat, lon = lon, lat
        if not (35 <= lat <= 47.5 and 6 <= lon <= 19):
            scartati["fuori Italia"] += 1
            continue
        loc = rec.get("location") or {}
        conn = rec.get("connectors") or []
        princ = max(conn, key=lambda c: _num(c.get("max_electric_power")) or 0, default={})
        watt = _num(princ.get("max_electric_power")) or 0
        kw = round(watt / 1000, 1) if watt > 1000 else round(watt, 1)   # alcuni operatori scrivono già i kW
        std = str(princ.get("standard") or "").upper()
        corrente = "DC" if std in DC or str(princ.get("power_type", "")).upper().startswith("DC") else "AC"
        tipo = CONNETTORI.get(std, std.replace("_", " ").title() if std else "")
        m = marca(rec)
        tar = tariffa_pun(rec, kw, corrente)
        extra = (tar[1], tar[2]) if tar else (None, None)
        prezzo, fonte = (tar[0] if tar else prezzo_pun(rec)), "P"
        if prezzo is None:
            prezzo, fonte = prezzo_operatore(tabella_operatori, m, kw, corrente), "O"

        chiave = (round(lat, 5), round(lon, 5), m)
        s = siti.get(chiave)
        if not s:
            s = siti[chiave] = {
                "i": rec.get("evse_id") or f"{lat},{lon}",
                "o": m,
                "r": (rec.get("businessName") or "").strip(),
                "a": (loc.get("address") or "").strip(),
                "c": (loc.get("city") or "").strip(),
                "la": round(lat, 6), "lo": round(lon, 6),
                "e": {},
            }
            if (loc.get("opening_times") or {}).get("twentyfourseven"):
                s["h"] = 1
        if s["r"].lower() == m.lower():
            s["r"] = ""
        # [kW, AC/DC, connettore, posti, posti guasti, prezzo €/kWh o null, fonte prezzo P/O,
        #  € di attivazione o null, €/minuto o null]
        g = s["e"].setdefault((kw, corrente, tipo), [kw, corrente, tipo, 0, 0, None, None, None, None])
        g[3] += 1
        if stato in GUASTI:
            g[4] += 1
        if prezzo is not None and (g[5] is None or (fonte == "P" and g[6] == "O") or
                                   (fonte == g[6] and prezzo < g[5])):
            g[5], g[6] = prezzo, fonte
            g[7], g[8] = extra if fonte == "P" else (None, None)

    for s in siti.values():
        for g in s["e"].values():       # niente null inutili in fondo
            while len(g) > 7 and g[-1] is None:
                g.pop()
        s["e"] = sorted(s["e"].values(), key=lambda g: (-g[0], g[2]))
        if not s["r"]:
            del s["r"]
    n_prezzi = Counter(g[6] for s in siti.values() for g in s["e"] if g[5] is not None)
    print(f"  {len(siti)} colonnine con {sum(g[3] for s in siti.values() for g in s['e'])} posti; "
          f"scartati: {dict(scartati)}; gruppi con prezzo PUN {n_prezzi['P']}, da tabella operatori {n_prezzi['O']}")
    return list(siti.values()), n_prezzi


def nome_tessera(lat, lon):
    return f"t_{math.floor(lat / PASSO)}_{math.floor(lon / PASSO)}.json"


def salva(siti, n_prezzi, fonte_operatori, diagnosi):
    if os.path.isdir(CARTELLA):
        shutil.rmtree(CARTELLA)
    os.makedirs(CARTELLA)
    tessere = {}
    for s in siti:
        tessere.setdefault(nome_tessera(s["la"], s["lo"]), []).append(s)
    for t, lista in tessere.items():
        with open(os.path.join(CARTELLA, t), "w", encoding="utf-8") as f:
            json.dump({"d": lista}, f, separators=(",", ":"), ensure_ascii=False)
    indice = {
        "passo": PASSO,
        "aggiornato": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "colonnine": len(siti),
        "posti": sum(g[3] for s in siti for g in s["e"]),
        "prezzi_pun": n_prezzi.get("P", 0),
        "prezzi_operatori": n_prezzi.get("O", 0),
        "fonte_operatori": fonte_operatori,
        "tessere": sorted(tessere),
        "fonte": "PUN – Piattaforma Unica Nazionale dei punti di ricarica (MASE/GSE)",
    }
    with open(os.path.join(CARTELLA, "indice.json"), "w", encoding="utf-8") as f:
        json.dump(indice, f, indent=1, ensure_ascii=False)
    with open(os.path.join(CARTELLA, "diagnosi.json"), "w", encoding="utf-8") as f:
        json.dump(diagnosi, f, indent=1, ensure_ascii=False)
    print(f"  salvate {len(tessere)} tessere")


def recupera_dal_sito(sito):
    """Piano B: copia i dati già pubblicati sul sito (quelli dell'aggiornamento precedente)."""
    if not sito:
        raise RuntimeError("indirizzo del sito non indicato")
    sito = sito.rstrip("/") + "/"
    print(f"Recupero i dati già pubblicati da {sito}{CARTELLA}/ …")

    def scarica(url):
        for i in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.read()
            except Exception as ex:
                print(f"  {url}: {ex}")
                time.sleep(5)
        raise RuntimeError(f"{url} non recuperato")
    indice = json.loads(scarica(f"{sito}{CARTELLA}/indice.json").decode("utf-8"))
    if os.path.isdir(CARTELLA):
        shutil.rmtree(CARTELLA)
    os.makedirs(CARTELLA)
    for t in indice["tessere"]:
        with open(os.path.join(CARTELLA, t), "wb") as f:
            f.write(scarica(f"{sito}{CARTELLA}/{t}"))
    with open(os.path.join(CARTELLA, "indice.json"), "w", encoding="utf-8") as f:
        json.dump(indice, f, indent=1, ensure_ascii=False)
    print(f"  recuperate {len(indice['tessere'])} tessere dell'aggiornamento {indice.get('aggiornato')}")


def indice_del_sito(sito):
    """L'indice già pubblicato (serve a sapere quando era stato l'aggiornamento precedente)."""
    try:
        req = urllib.request.Request(sito.rstrip("/") + f"/{CARTELLA}/indice.json", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as ex:
        print(f"  indice del sito non letto: {ex}")
        return {}


def scrivi_esito(nuovi, prima):
    """Lascia al workflow una riga "nuovi|vecchi;aggiornato;colonnine;aggiornato prima" per la notifica sull'iPhone."""
    file = os.environ.get("ESITO")
    if not file:
        return
    try:
        with open(os.path.join(CARTELLA, "indice.json"), encoding="utf-8") as f:
            ora = json.load(f)
    except Exception:
        ora = {}
    with open(file, "w", encoding="utf-8") as f:
        f.write(f"{'nuovi' if nuovi else 'vecchi'};{ora.get('aggiornato', '')};{ora.get('colonnine', '')};"
                f"{prima.get('aggiornato', '')}\n")


def main():
    prima = indice_del_sito(os.environ["SITO"]) if os.environ.get("SITO") else {}
    try:
        print("Scarico i punti di ricarica dalla PUN…")
        pun, voci, record = scarica_pun()
        conta = censimento(record)
        print("Campi presenti nei dati della PUN (quante volte):")
        for via, n in sorted(conta.items()):
            print(f"  {via}: {n}")
        prove = sonda_prezzi(pun, record)
        for p in prove:
            print(f"  prova {p}")
        tabella, fonte_op = leggi_prezzi_operatori()
        siti, n_prezzi = costruisci(record, tabella)
        if len(siti) < 1000:
            raise ValueError(f"troppo poche colonnine ({len(siti)}): dati della PUN incompleti?")
        diagnosi = {"campi": dict(sorted(conta.items())), "prove_tariffe": prove,
                    "esempio_mappa": voci[:3], "esempi": record[:5],
                    "esempi_tariffe": [r for r in record if isinstance(r.get("punTariffsDetails"), dict)][:8]}
        salva(siti, n_prezzi, fonte_op, diagnosi)
        scrivi_esito(True, prima)
    except Exception as ex:
        print(f"PUN non disponibile: {ex}")
        try:
            recupera_dal_sito(os.environ.get("SITO"))
            scrivi_esito(False, prima)
        except Exception as ex2:
            print(f"Nessun dato disponibile: {ex2}. Il sito resta com'era.")
            sys.exit(1)


if __name__ == "__main__":
    main()
