export declare const MAX_STOCK_SERIAL_LENGTH: number

export type SerialValidationResult = {
  valid: boolean
  serial: string
  reason: string | null
}

export function normalizeSerialInput(value: unknown): string
export function validateSerialFormat(rawValue: unknown): SerialValidationResult
export function maskSerialForViewer(serialValue: unknown): string
export function sanitizeCsvCell(value: unknown): string
