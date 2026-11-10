import type { ReactNode } from 'react'

export type ProvinceGroup<T extends Record<string, unknown>> = {
  province: string
  rows: T[]
  branchCount: number
}

export function groupRowsByProvince<T extends Record<string, unknown>>(rows: readonly T[]): ProvinceGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const province = String(row.province || '').trim() || 'ไม่ระบุจังหวัด'
    const items = groups.get(province) || []
    items.push(row)
    groups.set(province, items)
  }
  return Array.from(groups, ([province, groupedRows]) => {
    const branchKeys = new Set(groupedRows.map((row, index) => {
      const branchId = String(row.branch_id || '').trim()
      if (branchId) return branchId
      const locationCode = String(row.location_code || row.code || '').trim()
      const branchName = String(row.branch_name || row.branch || '').trim()
      return locationCode || branchName ? `${locationCode}\u0000${branchName}` : `row-${index}`
    }))
    return { province, rows: groupedRows, branchCount: branchKeys.size }
  }).sort((left, right) => {
    if (left.province === 'ไม่ระบุจังหวัด') return right.province === 'ไม่ระบุจังหวัด' ? 0 : 1
    if (right.province === 'ไม่ระบุจังหวัด') return -1
    return left.province.localeCompare(right.province, 'th')
  })
}

export function ProvinceTableGroup<T extends Record<string, unknown>>({
  group,
  colSpan,
  summary,
}: {
  group: ProvinceGroup<T>
  colSpan: number
  summary?: string
}) {
  return <tr className="province-table-group"><th scope="rowgroup" colSpan={colSpan}><span>จังหวัด{group.province}</span><small>{summary || `${group.branchCount} สาขา · ${group.rows.length} รายการ`}</small></th></tr>
}

export function ProvinceCardGroup<T extends Record<string, unknown>>({
  group,
  children,
  summary,
}: {
  group: ProvinceGroup<T>
  children: ReactNode
  summary?: string
}) {
  return <section className="province-card-group"><div className="province-group-heading"><strong>จังหวัด{group.province}</strong><span>{summary || `${group.branchCount} สาขา · ${group.rows.length} รายการ`}</span></div>{children}</section>
}
