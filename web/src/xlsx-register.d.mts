export type RegisterImportRow = {
  source_row: number
  [field: string]: string | number | null
}

export function parseRegisterWorkbook(file: File): Promise<RegisterImportRow[]>
