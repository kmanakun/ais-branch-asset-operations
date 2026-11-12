export type MenuKey = 'overview' | 'work_orders' | 'assets' | 'pending' | 'completed' | 'discovery' | 'imports' | 'people'

export const demoStats = [
  { label: 'สาขาในทะเบียน', value: '580', change: 'ข้อมูลตัวอย่าง', icon: 'branches', tone: 'blue' },
  { label: 'เครื่องสแกน', value: '1,284', change: 'หลายเครื่องต่อสาขา', icon: 'scanner', tone: 'violet' },
  { label: 'ใบงานที่ยังไม่เสร็จ', value: '36', change: 'รวมรายการ Pending', icon: 'activity', tone: 'orange' },
  { label: 'Completed', value: '214', change: 'จากประวัติงานตัวอย่าง', icon: 'check', tone: 'green' },
]

export const demoTasks = [
  { branch: 'สาขาตัวอย่าง 001', province: 'กรุงเทพมหานคร', code: 'DEMO-001', model: 'Zebra DS9308', serial: '••••••0001', status: 'กำลังติดตั้ง', tone: 'progress' },
  { branch: 'สาขาตัวอย่าง 001', province: 'กรุงเทพมหานคร', code: 'DEMO-001', model: 'Honeywell HF680', serial: '••••••0002', status: 'กำลังดำเนินการ', tone: 'progress' },
  { branch: 'สาขาตัวอย่าง 002', province: 'ปทุมธานี', code: 'DEMO-002', model: 'Zebra DS9308', serial: '••••••0003', status: 'Pending', tone: 'blocked' },
  { branch: 'สาขาตัวอย่าง 003', province: 'กรุงเทพมหานคร', code: 'DEMO-003', model: 'Zebra DS9308', serial: '••••••0004', status: 'กำลังดำเนินการ', tone: 'progress' },
]

export const demoAssets = [
  { branch: 'สาขาตัวอย่าง 001', province: 'กรุงเทพมหานคร', code: 'DEMO-001', model: 'Zebra DS9308', serial: '••••••0001', year: '2022', status: 'กำลังดำเนินการ', tone: 'progress' },
  { branch: 'สาขาตัวอย่าง 004', province: 'กรุงเทพมหานคร', code: 'DEMO-004', model: 'Honeywell HF680', serial: '••••••0002', year: '2021', status: 'open', tone: 'ready' },
  { branch: 'สาขาตัวอย่าง 002', province: 'ปทุมธานี', code: 'DEMO-002', model: 'Zebra DS9308', serial: '••••••0003', year: '2020', status: 'Pending', tone: 'blocked' },
  { branch: 'สาขาตัวอย่าง 003', province: 'กรุงเทพมหานคร', code: 'DEMO-003', model: 'Zebra DS9308', serial: '••••••0004', year: '2021', status: 'open', tone: 'ready' },
]
