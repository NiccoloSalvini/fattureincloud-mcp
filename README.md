# fattureincloud-mcp

Server [MCP](https://modelcontextprotocol.io) per **[Fatture in Cloud](https://www.fattureincloud.it)**: gestisci la fatturazione parlando con Claude (o con qualsiasi client MCP) invece di cliccare nell'interfaccia.

Fa quello che l'app non fa:

- **Fatture ricorrenti.** «Ogni 5 del mese rifai la fattura ad Acme con il mese precedente nell'oggetto, inviala allo SdI e mandala per email.» Fatture in Cloud non ha una funzione nativa per farlo.
- **Duplicazione vera.** Copia una fattura con nuova data, numero successivo, scadenze ricalcolate, bollo e conto di pagamento, cambiando solo le righe che vuoi.
- **Operazioni in blocco.** Duplicare, inviare allo SdI, mandare per email o segnare come pagate decine di fatture con un comando, con anteprima obbligatoria prima di agire.
- **Controlli e report.** Crediti scaduti per cliente, fatturato e incassato per mese, distanza dalla **soglia del forfettario** (85.000 €, principio di cassa), **bollo mancante**, fatture elettroniche non inviate o scartate, buchi nella numerazione.
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

**Claude Code**

```bash
claude mcp add --scope user fattureincloud -e FIC_ACCESS_TOKEN=il-tuo-token -- npx -y github:NiccoloSalvini/fattureincloud-mcp
```

**Claude Desktop** (`claude_desktop_config.json`), Cursor, Windsurf e simili:

```json
{
  "mcpServers": {
    "fattureincloud": {
      "command": "npx",
      "args": ["-y", "github:NiccoloSalvini/fattureincloud-mcp"],
      "env": { "FIC_ACCESS_TOKEN": "il-tuo-token" }
    }
  }
}
```

Altri esempi in [`examples/`](examples/).

### Variabili

| Variabile | |
| --- | --- |
| `FIC_ACCESS_TOKEN` | obbligatoria |
| `FIC_COMPANY_ID` | facoltativa: se il token vede una sola azienda viene scelta da sola, altrimenti ogni tool accetta `company_id` |
| `FIC_TOOLSETS` | facoltativa: carica solo alcuni gruppi di tool, es. `documents,automation,reports` (vedi sotto) |
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
   npm i -g github:NiccoloSalvini/fattureincloud-mcp
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

82 tool divisi in gruppi, attivabili con `FIC_TOOLSETS`. Il gruppo `admin` è sempre attivo.

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

**registry**: CRUD su `clients`, `suppliers`, `products`

**received**: CRUD su `received_documents` (spese, note di credito passive)

**accounting**: CRUD su `receipts` (corrispettivi), `f24`, `archive_documents`, `cashbook_entries` (prima nota)

**admin**
- `list_companies`, `get_company_info` (anche uso del piano)
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

## Server HTTP

Per un'installazione condivisa (team, server, n8n…):

```bash
fattureincloud-mcp http --port 3000 --host 0.0.0.0
```

Il server è stateless e non conserva credenziali. Ogni richiesta porta le proprie: `Authorization: Bearer <token>` (oppure `X-FIC-Token`) e, se serve, `X-FIC-Company`. L'endpoint è `POST /mcp`, il controllo di stato è `GET /health`. Se lo esponi su Internet, mettilo dietro HTTPS.

## Sicurezza

- Le azioni verso l'esterno (invio allo SdI, email) sono marcate come distruttive, quindi i client MCP chiedono conferma. Gli strumenti in blocco partono in anteprima.
- **Una fattura elettronica inviata allo SdI non si cancella**: si corregge solo con una nota di credito. Per questo `send_einvoice` verifica sempre l'XML prima di inviare.
- Il token resta sul tuo computer, oppure nell'header di ogni richiesta in modalità HTTP. Le ricorrenze sono un file JSON locale.

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

I test girano su un'API Fatture in Cloud simulata (`test/fake-api.ts`) con un vero client MCP collegato in memoria, senza toccare il tuo account. Per provare con un account reale, usa un'azienda di prova e `dry_run`.

Struttura:
- `src/client.ts`: client HTTP dell'API v2 (retry su 429, errori leggibili)
- `src/copy.ts`: logica di duplicazione e segnaposto
- `src/schedules.ts`, `src/runner.ts`: ricorrenze
- `src/reports.ts`: crediti, ricavi, controlli (funzioni pure)
- `src/taxes.ts`: modello di imposta e contributi del forfettario
- `src/tools/`: definizione dei tool; i CRUD sono generati da una tabella in `crud.ts`

Le PR sono benvenute. Il progetto non è affiliato a Fatture in Cloud né a TeamSystem.

## Licenza

MIT
