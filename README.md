# fattureincloud-mcp

Server [MCP](https://modelcontextprotocol.io) per **[Fatture in Cloud](https://www.fattureincloud.it)**: gestisci la fatturazione parlando con Claude (o con qualsiasi client MCP) invece di cliccare nell'interfaccia.

Fa quello che l'app non fa:

- **Fatture ricorrenti.** «Ogni 5 del mese rifai la fattura ad Acme con il mese precedente nell'oggetto, inviala allo SdI e mandala per email.» Fatture in Cloud non ha una funzione nativa per farlo.
- **Duplicazione vera.** Copia una fattura con nuova data, numero successivo, scadenze ricalcolate, bollo e conto di pagamento, cambiando solo le righe che vuoi.
- **Operazioni in blocco.** Duplicare, inviare allo SdI, mandare per email o segnare come pagate decine di fatture con un comando, con anteprima obbligatoria prima di agire.
- **Controlli e report.** Crediti scaduti per cliente, fatturato e incassato per mese, distanza dalla **soglia del forfettario** (85.000 €, principio di cassa), **bollo mancante**, fatture elettroniche non inviate o scartate, buchi nella numerazione.
- **Riconciliazione bancaria.** Carichi l'estratto conto (Intesa, UniCredit, Fineco, BPER, Poste, ING, Revolut, N26, Qonto o qualsiasi CSV/XLSX), oppure colleghi il conto via PSD2, e ogni bonifico viene abbinato alla fattura giusta e registrato come incasso con la sua data.
- **Previsione di cassa.** Mese per mese: incassi attesi, fatture ricorrenti, scadenze fiscali e spese fisse, con quanto accantonare ogni mese per arrivare coperto a giugno e novembre.
- **Pacchetto per il commercialista.** Un solo zip con CSV, PDF, XML e riepilogo dell'anno.
- **Tasse del forfettario.** Imposta sostitutiva e contributi INPS stimati dagli incassi reali: quanto pagare il 30 giugno (saldo e 1° acconto) e il 30 novembre (2° acconto), il totale annuo e la percentuale da accantonare.
- **Tutta l'API v2.** Documenti emessi e ricevuti, clienti, fornitori, prodotti, corrispettivi, F24, archivio, prima nota, allegati, cestino, impostazioni. Quello che non ha un tool dedicato passa da `api_request`.

> English: MCP server for the Italian invoicing SaaS Fatture in Cloud. Recurring invoices, real document duplication, bulk e-invoice (SdI) sending, receivables and *regime forfettario* reports, plus full CRUD over the v2 API. Tool descriptions are in Italian because the domain is Italian.

## Esempi di cose da chiedere

- «Rifai tutte le fatture di settembre con la data di oggi, fammi vedere l'anteprima.»
- «Imposta la fattura mensile per Acme il giorno 5, importo fisso, inviala allo SdI e per email.»
- «Chi mi deve ancora pagare? Segna come pagata la 26, incassata ieri.»
- «Quanto mi manca alla soglia del forfettario? A questo ritmo la supero?»
- «Trasforma la proforma 12 in fattura elettronica e verifica l'XML.»
- «Ci sono fatture sopra 77,47 € senza bollo?»
- «Scarica i PDF delle fatture di ottobre in ~/Documenti/fatture.»
- «Quante tasse pago il 30 giugno e il 30 novembre? Quanto devo accantonare per ogni fattura?»
- «Ecco l'estratto conto di Intesa (~/Downloads/movimenti.xlsx): segna come pagate le fatture incassate.»
- «A novembre avrò abbastanza sul conto per l'acconto? Quanto metto da parte al mese?»
- «Metti le scadenze fiscali nel mio calendario e negli F24 di Fatture in Cloud.»
- «Prepara il pacchetto 2026 per il commercialista.»

## Installazione

Serve Node.js 20 o superiore.

### 1. Token

In Fatture in Cloud:

1. Apri **Impostazioni → App e API** (area sviluppatori) e crea un'**applicazione privata**, ad esempio `mcp-fattureincloud`.
2. In «Autenticazione e accesso» spunta **solo «Token personale»** e togli OAuth 2.0: così il Redirect URL non serve. Salva.
3. Dalla pagina dell'app genera il token: scegli l'azienda e i permessi. Servono almeno lettura e scrittura su documenti emessi e clienti; per report e tasse basta la lettura sul resto; aggiungi la scrittura sulle altre risorse che vuoi gestire.
4. Copia il token: non viene più mostrato. Non incollarlo in chat. Mettilo nella configurazione del client MCP o in `~/.config/fattureincloud-mcp/.env`.

I token personali non scadono e si revocano dalla stessa pagina ([guida ufficiale](https://developers.fattureincloud.it/docs/authentication/manual-authentication/)).

### 2. Client MCP

**Claude Desktop, con un clic.** Scarica `fattureincloud-mcp-x.y.z.mcpb` dall'ultima [release](https://github.com/NiccoloSalvini/fattureincloud-mcp/releases), aprilo con doppio clic e incolla il token quando te lo chiede. Non serve modificare file di configurazione, e il token viene salvato nel portachiavi di sistema.

**Claude Code**

```bash
claude mcp add --scope user fattureincloud -e FIC_ACCESS_TOKEN=il-tuo-token -- npx -y fattureincloud-mcp
```

**Configurazione manuale** (`claude_desktop_config.json`, Cursor, Windsurf e simili):

```json
{
  "mcpServers": {
    "fattureincloud": {
      "command": "npx",
      "args": ["-y", "fattureincloud-mcp"],
      "env": { "FIC_ACCESS_TOKEN": "il-tuo-token" }
    }
  }
}
```

Altri esempi in [`examples/`](examples/). Finché il pacchetto non è su npm, al posto di `fattureincloud-mcp` usa `github:NiccoloSalvini/fattureincloud-mcp`.

### Variabili

| Variabile | |
| --- | --- |
| `FIC_ACCESS_TOKEN` | obbligatoria |
| `FIC_COMPANY_ID` | facoltativa: se il token vede una sola azienda viene scelta da sola, altrimenti ogni tool accetta `company_id` |
| `FIC_TOOLSETS` | facoltativa: carica solo alcuni gruppi di tool, es. `documents,automation,reports,taxes,bank` (vedi sotto). I tool sono 93: con meno gruppi il modello sceglie meglio e consuma meno contesto. |
| `FIC_QUOTA_RESERVE` | facoltativa: richieste orarie da lasciare libere (default 25). L'API concede 1.000 richieste all'ora e 40.000 al mese, condivise tra le app private; il server legge i contatori a ogni risposta e si ferma prima di esaurirli. `api_quota` mostra quante ne restano |
| `FIC_MCP_DATA_DIR` | dove salvare le ricorrenze, default `~/.config/fattureincloud-mcp` |

Le variabili possono stare anche in `~/.config/fattureincloud-mcp/.env`, nella forma `FIC_ACCESS_TOKEN=...`. È il modo consigliato per il job pianificato.

## Fatture ricorrenti

Fatture in Cloud non ha la pianificazione, quindi le ricorrenze vivono sul tuo computer, in `~/.config/fattureincloud-mcp/schedules.json`, e un job giornaliero le esegue.

1. Chiedi a Claude di crearne una, ad esempio con il prompt `nuova_ricorrenza`. Ogni ricorrenza ha:
   - un **documento modello**, che viene copiato a ogni scadenza;
   - una **cadenza**: ogni N mesi, un certo giorno, dove 31 significa l'ultimo del mese;
   - un'**azione**: `create` lascia la fattura da controllare e inviare (consigliato se l'importo cambia), `create_and_send_sdi` verifica l'XML e la invia;
   - l'**email** facoltativa al cliente;
   - le **modifiche**: righe, importi e testi con segnaposto.
2. Installa il job (una volta sola):

   ```bash
   npm i -g fattureincloud-mcp
   ```

   ```bash
   fattureincloud-mcp install-scheduler --hour 8
   ```

   Su macOS crea un LaunchAgent che gira ogni mattina e manda una notifica con l'esito. Se il Mac era in stop parte al risveglio; se era spento, la fattura viene creata alla prima esecuzione successiva. Su Linux stampa la riga da mettere in crontab.

Comandi utili:

```bash
fattureincloud-mcp schedules
```

```bash
fattureincloud-mcp run-due --dry-run
```

**Segnaposto** utilizzabili in oggetto, note e righe: `{{mese}}`, `{{anno}}`, `{{mese_precedente}}`, `{{anno_mese_precedente}}`, `{{mese_successivo}}`, `{{trimestre}}`, `{{data}}`. Aggiungi `|maiuscolo` per la maiuscola iniziale. Per esempio `Consulenza {{mese_precedente}} {{anno_mese_precedente}}` diventa, il 5 novembre, «Consulenza ottobre 2026».

**Garanzie:**
- Ogni ricorrenza produce al massimo un documento per scadenza: la prossima data viene salvata *prima* di creare la fattura, e un lock impedisce esecuzioni sovrapposte tra il job e Claude. Se qualcosa va storto la fattura manca, non viene duplicata, e l'errore resta nello storico.
- Se il computer è rimasto spento per più periodi, al riavvio viene creato un solo documento, datato oggi, e non uno per ogni periodo arretrato. La numerazione resta così in ordine cronologico.
- Se la verifica dell'XML fallisce, la fattura viene creata ma non inviata, e l'errore viene segnalato.

## Strumenti

93 tool divisi in gruppi, attivabili con `FIC_TOOLSETS`. Il gruppo `admin` è sempre attivo.

**documents**: documenti emessi
- `list_/get_/create_/update_/delete_issued_document(s)`
- `duplicate_document`: copia con nuova data, numero, scadenze e modifiche
- `transform_document`: proforma → fattura, preventivo → ordine o fattura, DDT → fattura
- `join_documents`: unisce più DDT, ordini o preventivi in un solo documento
- `mark_paid` / `mark_unpaid`
- `email_document`
- `verify_einvoice`, `send_einvoice` (con `dry_run`), `get_einvoice_xml`, `einvoice_rejection_reason`
- `get_document_pdf`: link o download
- `upload_attachment`
- `get_new_document_defaults`: prossimi numeri e valori predefiniti
- `list_deleted_documents`, `recover_document`

**automation**: in blocco e ricorrenze
- `bulk_duplicate`, `bulk_send_einvoice`, `bulk_email`: `dry_run` attivo di default; accettano una lista di id o un filtro
- `schedule_create`, `schedule_list`, `schedule_get`, `schedule_update`, `schedule_delete`
- `schedule_run_due`, `schedule_run_now`

**reports**
- `receivables_report`: crediti aperti, scaduto per fasce, per cliente
- `revenue_summary`: fatturato (competenza) e incassato (cassa) per mese e cliente, soglia del forfettario con proiezione
- `audit_documents`: fatture elettroniche non inviate o scartate, bollo mancante, pagamenti scaduti, numerazione
- `client_statement`: estratto conto di un cliente

**taxes**
- `tax_profile_set`, `tax_profile_get`: coefficiente, aliquota, previdenza, versamenti reali
- `tax_estimate`: scadenze del 30 giugno e del 30 novembre, totale annuo, quota da accantonare

**planning**
- `cashflow_forecast`: previsione di cassa e accantonamento mensile
- `tax_deadlines_export`: scadenze fiscali in `.ics` e negli F24 di Fatture in Cloud
- `accountant_package`: zip annuale per il commercialista

**bank**
- `bank_reconcile`: abbina gli accrediti alle fatture e registra gli incassi
- `bank_parse_statement`, `bank_formats`
- `bank_link_start`, `bank_link_finish`, `bank_accounts`, `bank_list_banks`: collegamento PSD2 via Enable Banking

**registry**: CRUD su `clients`, `suppliers`, `products`

**received**: CRUD su `received_documents` (spese, note di credito passive)

**accounting**: CRUD su `receipts` (corrispettivi), `f24`, `archive_documents`, `cashbook_entries` (prima nota)

**admin**
- `list_companies`, `get_company_info` (anche uso del piano)
- `api_quota`: richieste API rimaste nell'ora e nel mese
- `lookup`: aliquote IVA, metodi di pagamento, conti, centri di costo e ricavo, categorie, modelli, valute, paesi…
- `list_sent_emails`
- `api_request`: qualsiasi altro endpoint dell'[API v2](https://developers.fattureincloud.it/api-reference/)

I filtri `q` usano la sintassi di Fatture in Cloud, ad esempio `date >= '2026-01-01' and entity.name like '%rossi%'` oppure `amount_gross > 1000`.

**Prompt inclusi**
- `chiusura_mese`: controllo di fine mese completo, senza azioni irreversibili
- `nuova_ricorrenza`: crea una fattura ricorrente guidata

## Tasse (regime forfettario)

`tax_estimate` stima quanto versi e quando, partendo dagli incassi registrati in Fatture in Cloud. Prima imposti il profilo una volta sola con `tax_profile_set`, ad esempio chiedendo a Claude: «sono un professionista in gestione separata, coefficiente 78%, aliquota 15%, partita IVA aperta nel 2024».

Il calcolo:

| | |
| --- | --- |
| Reddito lordo | incassi dell'anno × coefficiente di redditività (78% professionisti, 67%, 40%, 86%, 62% secondo l'ATECO) |
| Contributi | gestione separata 26,07% sul reddito lordo, oppure artigiani/commercianti (fissi più eccedenza, con riduzione del 35% facoltativa), oppure cassa professionale |
| Imponibile | reddito lordo − contributi **versati** nell'anno (saldo dell'anno prima + acconti) |
| Imposta sostitutiva | 15%, o 5% per i primi cinque anni se spetta |
| 30 giugno | saldo dell'anno prima + 1° acconto (imposta e contributi) |
| 30 novembre | 2° acconto |
| Acconti | imposta: 100% dell'anno prima in due rate al 50%, nessun acconto sotto 51,65 €, rata unica a novembre sotto 257,52 €; gestione separata: 80% in due rate al 40% |

Per l'anno in corso gli incassi vengono proiettati a fine anno, oppure usi solo quelli avvenuti (`projection: "to_date"`) o una tua stima (`revenue_estimate`). Se hai versato importi diversi da quelli calcolati, o hai incassi fuori da Fatture in Cloud, inseriscili per anno in `overrides`: la stima diventa esatta. Il risultato include anche la percentuale da accantonare su ogni incasso e l'avviso quando gli acconti superano l'imposta, caso in cui conviene il metodo previsionale.

È una stima per pianificare la liquidità, non un calcolo da dichiarazione: aliquote e massimali cambiano ogni anno (i default sono quelli del 2025 e si possono modificare nel profilo), e prima di pagare conviene il controllo del commercialista.

## Banca: riconciliazione degli incassi

`bank_reconcile` prende i movimenti, cerca per ogni accredito la fattura aperta corrispondente e la segna come pagata con la **data dell'accredito**. Per il forfettario quella data è quella che conta, perché le tasse si calcolano per cassa.

**Abbinamento.** Per ogni accredito il punteggio considera:

| Criterio | Punti |
| --- | --- |
| Importo uguale alla rata o al residuo della fattura | +50 |
| Importo inferiore fino a 2 € (bollo o commissioni non pagati) | +30 |
| Numero di fattura nella causale (`FT 26`, `fattura n. 26`, `26/2026`) | +30 |
| P.IVA o codice fiscale del cliente nella causale | +30 |
| Nome del cliente nella causale | fino a +25 |
| Pagamento datato prima della fattura | −40 |

La confidenza è *alta* da 75 punti, *media* da 60, *bassa* sotto. Ogni accredito va al massimo a una fattura. Se due fatture hanno lo stesso punteggio, l'abbinamento scende a *medio* e viene segnalato come ambiguo. Si parte sempre in anteprima: con `dry_run: false` vengono registrati solo gli abbinamenti con confidenza almeno `min_confidence` (di default `high`). Rilanciarlo sullo stesso file non registra due volte lo stesso incasso.

### Da file (qualsiasi banca)

Scarica la lista movimenti dall'home banking e passa il percorso del file. Formati riconosciuti in automatico (`bank_formats`):

| Banca | File |
| --- | --- |
| Intesa Sanpaolo, Isybank | XLSX «Lista movimenti», solo righe contabilizzate; CSV accrediti/addebiti |
| UniCredit | CSV |
| Fineco | XLSX e CSV |
| BPER | XLS «Movimenti Conto» |
| Poste Italiane / BancoPosta | XLSX |
| ING Italia | CSV |
| Revolut, N26, Qonto | CSV |
| Altre | qualsiasi CSV/XLSX con data, importo (o entrate e uscite) e descrizione: colonne riconosciute da sole o indicate con `mapping` |

I formati vengono dagli export reali usati da altri progetti open source ([ynab-transformer](https://github.com/magobaol/ynab-transformer), [BananaAccounting](https://github.com/BananaAccounting/Italia), [bankr.isp](https://github.com/bankrr/bankr.isp)). Se la tua banca esporta in un formato diverso, apri una issue con le intestazioni delle colonne.

### Collegamento diretto (PSD2, facoltativo)

Le banche italiane, Intesa compresa, non danno l'API PSD2 ai privati: è riservata agli intermediari autorizzati. Si passa da **[Enable Banking](https://enablebanking.com)**, che offre una modalità gratuita per uso personale e non commerciale, con i tuoi conti. Copre Intesa Sanpaolo, UniCredit, BPER, Banco BPM, Poste, Fineco, ING, Mediolanum, Crédit Agricole, MPS e BCC.

1. Registrati su [enablebanking.com/cp](https://enablebanking.com/cp) e crea un'applicazione di **produzione**. Come redirect URL metti `https://localhost:8765/callback`: non deve esistere davvero.
2. Scarica la chiave privata `.pem` generata e attiva l'app con «Activate by linking accounts», collegando il tuo conto. L'app passa in modalità *restricted* e vede solo i tuoi conti.
3. In `~/.config/fattureincloud-mcp/.env`:

   ```
   ENABLE_BANKING_APP_ID=...
   ENABLE_BANKING_KEY_PATH=~/.config/fattureincloud-mcp/enablebanking.pem
   ENABLE_BANKING_REDIRECT_URL=https://localhost:8765/callback
   ```

4. Chiedi a Claude «collega il mio conto Intesa» (`bank_link_start`). Apri il link, autorizza nell'app della banca e incolla l'indirizzo della pagina finale, anche se il browser dà errore (`bank_link_finish`). Il consenso dura fino a 180 giorni, poi va rinnovato. Molte banche ammettono un solo consenso attivo per volta.
5. Da lì basta `bank_reconcile` senza file: legge gli ultimi 90 giorni dal conto collegato.

Le sessioni sono salvate in `bank-sessions.json`, leggibile solo dal tuo utente. La chiave resta sul tuo computer.

## Pianificazione

- **`cashflow_forecast`**: entrate e uscite previste mese per mese per 12 mesi. Conta le rate da incassare (le scadute nel mese corrente), le fatture ricorrenti future con il loro ritardo di pagamento tipico, le scadenze fiscali stimate e le spese fisse che indichi. Con `opening_balance` ottieni il saldo previsto e l'avviso sui mesi in rosso. Calcola anche l'**accantonamento mensile** minimo per coprire tutte le scadenze fiscali in tempo; con `tax_fund` tiene conto di quanto hai già da parte.
- **`tax_deadlines_export`**: porta le scadenze fiscali stimate in un file `.ics`, con promemoria 7 giorni e 1 giorno prima, da importare in Calendario, Google o Outlook. Le crea anche come F24 da pagare nello scadenziario di Fatture in Cloud. Rilanciato, aggiorna gli importi invece di duplicare e non tocca gli F24 già pagati.
- **`accountant_package`**: `commercialista-AAAA.zip` con `fatture.csv`, `incassi.csv`, `crediti_aperti.csv` e `spese.csv` (separatore `;` e virgola decimale, si aprono direttamente in Excel), PDF di fatture e note di credito, XML FatturaPA e `riepilogo.md` con ricavi, soglia del forfettario, stima delle tasse e controlli.

## Server HTTP

Per un'installazione condivisa (team, server, n8n…):

```bash
fattureincloud-mcp http --port 3000 --host 0.0.0.0
```

Il server è stateless e non conserva credenziali. Ogni richiesta porta le proprie: `Authorization: Bearer <token>` (oppure `X-FIC-Token`) e, se serve, `X-FIC-Company`. L'endpoint è `POST /mcp`, il controllo di stato è `GET /health`. Se lo esponi su Internet, mettilo dietro HTTPS.

Per collegarlo a claude.ai senza copiare token usa invece la modalità OAuth, descritta qui sotto.

## Server remoto (claude.ai)

Con `--oauth` il server diventa un connettore che chiunque aggiunge a claude.ai (web, desktop e app mobile) con un indirizzo e un clic su **«Accedi con Fatture in Cloud»**: niente token da generare né da incollare. Lo installi una volta su un server con HTTPS; chi lo usa fa solo il login.

Il server implementa la [specifica di autorizzazione MCP](https://modelcontextprotocol.io/specification/latest/basic/authorization) (OAuth 2.1 con PKCE, registrazione dinamica dei client, metadati RFC 9728 e RFC 8414) e passa il login al [flusso OAuth di Fatture in Cloud](https://developers.fattureincloud.it/docs/authentication/code-flow/). Non usa database: i token sono cifrati (AES-256-GCM) con una chiave del server e contengono quelli di Fatture in Cloud, quindi gira anche su servizi che si spengono quando non servono, come Cloud Run.

### 1. App Fatture in Cloud con OAuth

1. In Fatture in Cloud apri **Impostazioni → App e API** e crea un'**applicazione privata** (o modifica quella che hai).
2. In «Autenticazione e accesso» spunta **OAuth 2.0** e come **Redirect URL** inserisci `https://<il-tuo-dominio>/oauth/callback`, cioè `PUBLIC_URL` seguito da `/oauth/callback`, identico carattere per carattere.
3. Salva e copia **Client ID** e **Client Secret**.

Un'app privata accetta il login solo dell'account che l'ha creata (e degli utenti che Fatture in Cloud ti consente di autorizzare, se l'opzione è disponibile per il tuo piano). Per farla usare ad altre persone o clienti devi aggiungere i loro indirizzi tra quelli ammessi oppure pubblicare l'app tramite la procedura di Fatture in Cloud.

I permessi chiesti al login sono, di default, lettura e scrittura su anagrafiche, prodotti, documenti emessi e ricevuti, corrispettivi, F24, archivio, prima nota e impostazioni, più la lettura di email e situazione. Al login l'utente sceglie l'azienda. Per chiedere meno permessi imposta `FIC_OAUTH_SCOPES`, ad esempio `entity.clients:r issued_documents.invoices:r` per un accesso in sola lettura alle fatture.

### 2. Variabili

| Variabile | |
| --- | --- |
| `PUBLIC_URL` | obbligatoria: indirizzo pubblico HTTPS, solo l'origine, es. `https://fic.example.com` |
| `FIC_OAUTH_CLIENT_ID`, `FIC_OAUTH_CLIENT_SECRET` | obbligatorie: dall'app Fatture in Cloud. Se `FIC_OAUTH_CLIENT_ID` è impostata la modalità OAuth si attiva anche senza `--oauth` |
| `OAUTH_ENCRYPTION_KEY` | obbligatoria: chiave casuale di almeno 32 caratteri, generala con `openssl rand -base64 32`. Cambiarla scollega tutti. Per ruotarla senza scollegare nessuno metti la nuova davanti alla vecchia, separate da virgola, e togli la vecchia dopo un anno |
| `FIC_OAUTH_SCOPES` | facoltativa: permessi Fatture in Cloud separati da spazi (default: vedi sopra) |
| `FIC_TOOLSETS` | facoltativa, come in locale |
| `TRUST_PROXY` | facoltativa: numero di proxy davanti al server (default `1`, giusto per Cloud Run, Fly e un reverse proxy), serve per i limiti di richieste per IP |
| `PORT`, `HOST` | il Dockerfile usa `8080` e `0.0.0.0` |

Per provarlo in locale:

```bash
PUBLIC_URL=https://fic.example.com FIC_OAUTH_CLIENT_ID=... FIC_OAUTH_CLIENT_SECRET=... \
OAUTH_ENCRYPTION_KEY="$(openssl rand -base64 32)" fattureincloud-mcp http --oauth --host 0.0.0.0 --port 8080
```

Endpoint: `/mcp` (protetto), `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/oauth/callback`, `/token`, `/health`.

### 3. Deploy con Docker e Google Cloud Run

Nel repository c'è un `Dockerfile` che compila il progetto e avvia `http --oauth` sulla porta 8080:

```bash
docker build -t fattureincloud-mcp .
```

```bash
docker run -p 8080:8080 -e PUBLIC_URL=https://fic.example.com -e FIC_OAUTH_CLIENT_ID=... -e FIC_OAUTH_CLIENT_SECRET=... -e OAUTH_ENCRYPTION_KEY=... fattureincloud-mcp
```

Esempio su Cloud Run (servono un progetto Google Cloud e `gcloud` configurato). I segreti vanno in Secret Manager:

```bash
printf %s "il-client-secret" | gcloud secrets create fic-oauth-client-secret --data-file=-
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create fic-oauth-encryption-key --data-file=-
```

Il service account di Cloud Run deve poterli leggere (ruolo `roles/secretmanager.secretAccessor`). L'indirizzo di un servizio Cloud Run è prevedibile, `https://<servizio>-<numero-progetto>.<regione>.run.app`, quindi `PUBLIC_URL` si imposta già al primo deploy. Dalla cartella del repository:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$(gcloud config get-value project)" --format 'value(projectNumber)')
URL=https://fattureincloud-mcp-$PROJECT_NUMBER.europe-west1.run.app
gcloud run deploy fattureincloud-mcp --source . --region europe-west1 --allow-unauthenticated \
  --set-env-vars PUBLIC_URL=$URL,FIC_OAUTH_CLIENT_ID=il-client-id \
  --set-secrets FIC_OAUTH_CLIENT_SECRET=fic-oauth-client-secret:latest,OAUTH_ENCRYPTION_KEY=fic-oauth-encryption-key:latest
```

Controlla che `$URL` coincida con l'indirizzo stampato da `gcloud run deploy`, poi metti `$URL/oauth/callback` come Redirect URL nell'app Fatture in Cloud. Con un dominio tuo (mappatura di dominio o load balancer) usa quello in `PUBLIC_URL` e nel Redirect URL. `--allow-unauthenticated` serve perché claude.ai deve raggiungere il server: l'accesso ai dati è protetto dal login OAuth.

### 4. Aggiungerlo in claude.ai

1. In claude.ai apri **Impostazioni → Connettori → Aggiungi connettore personalizzato**. Nei piani Team ed Enterprise lo aggiunge un amministratore per tutta l'organizzazione.
2. Nome a piacere, URL `https://<il-tuo-dominio>/mcp`. Lascia vuoti Client ID e Client Secret nelle opzioni avanzate: claude.ai si registra da solo.
3. Premi **Connetti**: si apre una pagina del server che indica chi chiede l'accesso; premi **Accedi con Fatture in Cloud**, fai il login, scegli l'azienda e conferma i permessi. Da lì il connettore è disponibile anche nell'app mobile e in Claude Desktop.

Claude rinnova da solo il token ogni 24 ore; il login va rifatto solo se Fatture in Cloud rifiuta il rinnovo, al più tardi dopo un anno o se revochi l'accesso. Per scollegare un account rimuovi il connettore in claude.ai oppure revoca l'accesso dell'app da Fatture in Cloud.

### Strumenti disponibili in remoto

Su un server condiviso non ci sono il tuo disco né il job giornaliero, quindi in modalità OAuth sono disponibili 72 strumenti su 93. Mancano:

- i gruppi **taxes**, **planning** e **bank**, che leggono o scrivono file locali: profilo fiscale, estratti conto, sessioni bancarie, `.ics` e zip;
- le ricorrenze `schedule_*` e il prompt `nuova_ricorrenza`, che vivono in un file locale eseguito da un job locale;
- `upload_attachment`, che legge un file dal disco, e il parametro `save_to` di `get_document_pdf` e `get_einvoice_xml`, che restituiscono comunque il link o l'XML.

Restano tutti i CRUD, duplicazione, trasformazione, invio SdI ed email, le operazioni in blocco (`bulk_*`), i report (`receivables_report`, `revenue_summary`, `audit_documents`, `client_statement`) e gli strumenti di amministrazione, compreso `api_request`. Con più aziende si usa `company_id` nei tool, oppure l'header `X-FIC-Company`.

### Sicurezza della modalità OAuth

- Prima di mandare l'utente a Fatture in Cloud il server mostra una propria pagina di consenso con il nome del client e il sito a cui tornerà. Fatture in Cloud vede una sola app, la tua, e senza questo passaggio un client qualsiasi potrebbe sfruttare un login già concesso.
- PKCE S256 obbligatorio, `redirect_uri` confrontato esattamente con quelli registrati (per gli indirizzi `localhost` delle app native è ammessa solo una porta diversa, come prevede RFC 8252), `state` cifrato e legato al browser con un cookie per evitare CSRF.
- Il login in corso scade dopo 10 minuti, il codice di autorizzazione dopo 5 ed è legato al client, al `redirect_uri` e alla challenge PKCE. Il token di accesso scade con quello di Fatture in Cloud (24 ore).
- I token sono opachi: dentro c'è il token Fatture in Cloud cifrato, illeggibile senza `OAUTH_ENCRYPTION_KEY`. Il server non li scrive nei log.
- Non essendoci un database, un singolo token non si può revocare dal server: si revoca l'accesso da Fatture in Cloud, oppure si cambia `OAUTH_ENCRYPTION_KEY` per scollegare tutti.
- Registrazione, autorizzazione e token hanno limiti di richieste per IP; i body sono limitati.

## Sicurezza

- Le azioni verso l'esterno (invio allo SdI, email) sono marcate come distruttive, quindi i client MCP chiedono conferma. Gli strumenti in blocco partono in anteprima.
- **Una fattura elettronica inviata allo SdI non si cancella**: si corregge solo con una nota di credito. Per questo `send_einvoice` verifica sempre l'XML prima di inviare.
- Il token resta sul tuo computer, oppure nell'header di ogni richiesta in modalità HTTP. Le ricorrenze sono un file JSON locale.
- In modalità OAuth il server non conserva nulla: i token di Fatture in Cloud viaggiano cifrati dentro quelli emessi per il client MCP (vedi [Server remoto](#server-remoto-claudeai)).

## Sviluppo

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

`node scripts/smoke.mjs` prova il server su un account reale con soli strumenti in lettura (token in `~/.config/fattureincloud-mcp/.env`); `node scripts/smoke.mjs <tool> '<json>'` chiama un singolo strumento.

I test girano su un'API Fatture in Cloud simulata (`test/fake-api.ts`) con un vero client MCP collegato in memoria, senza toccare il tuo account. Per provare con un account reale, usa un'azienda di prova e `dry_run`.

Struttura:
- `src/client.ts`: client HTTP dell'API v2 (retry su 429, errori leggibili)
- `src/copy.ts`: logica di duplicazione e segnaposto
- `src/schedules.ts`, `src/runner.ts`: ricorrenze
- `src/reports.ts`: crediti, ricavi, controlli (funzioni pure)
- `src/taxes.ts`: modello di imposta e contributi del forfettario
- `src/cashflow.ts`, `src/ics.ts`, `src/accountant.ts`: pianificazione
- `src/bank/`: parser degli estratti conto, abbinamento, client Enable Banking
- `src/http.ts`: server HTTP con token nell'header
- `src/oauth.ts`, `src/seal.ts`: modalità OAuth per claude.ai e token cifrati
- `src/tools/`: definizione dei tool; i CRUD sono generati da una tabella in `crud.ts`

### Rilasci

Aggiorna `version` in `package.json`, poi crea e invia il tag:

```bash
git tag v0.3.0 && git push origin v0.3.0
```

La GitHub Action `release.yml` esegue i test e poi:
- pubblica su npm con [trusted publishing](https://docs.npmjs.com/trusted-publishers), via OIDC e senza token, con provenance automatica;
- crea la release con l'estensione `.mcpb` (generabile anche in locale con `npm run build:mcpb`);
- pubblica la scheda sul [registro MCP](https://registry.modelcontextprotocol.io).

Le PR sono benvenute. Il progetto non è affiliato a Fatture in Cloud né a TeamSystem.

## Licenza

MIT
