export type StockImportRow = {
  source_row: number
  serial_number?: string | null
  brand?: string | null
  model_name?: string | null
  lot_no?: string | null
  dispatch_area?: string | null
  received_date?: string | null
  note?: string | null
}

export type ParsedStockWorkbookResult = {
  sheet_name: string
  rows: StockImportRow[]
}

export declare const STOCK_IMPORT_TEMPLATE_HEADERS: string[]

export function normalizeExcelDate(rawValue: unknown): string | null
export function parseStockWorkbook(file: File): Promise<ParsedStockWorkbookResult>
export function buildStockTemplateCsv(): string
