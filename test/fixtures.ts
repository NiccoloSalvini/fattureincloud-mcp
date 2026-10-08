import * as XLSX from "xlsx";

export function intesaXlsx(): Uint8Array {
  const rows: unknown[][] = [
    ["Lista movimenti"],
    ["Conti e Carte:", "Conto 1000/12345"],
    ["Data inizio periodo:", "01/09/2026"],
    ...Array.from({ length: 15 }, () => []),
    ["Data", "Operazione", "Dettagli", "Conto o carta", "Contabilizzazione", "Categoria ", "Valuta", "Importo"],
    [46300, "Bonifico a vostro favore", "ACME SRL - SALDO FT 26/2026", "Conto 1000/12345", "CONTABILIZZATO", "Entrate", "EUR", 1202],
    [46301, "Pagamento POS", "AMAZON", "Carta", "CONTABILIZZATO", "Shopping", "EUR", -35.5],
    [46302, "Bonifico a vostro favore", "BETA SPA", "Conto 1000/12345", "NON CONTABILIZZATO", "Entrate", "EUR", 500],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Lista Operazione");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

