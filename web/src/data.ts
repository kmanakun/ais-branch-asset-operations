export type MenuKey = 'overview' | 'campaigns' | 'assets' | 'schedule' | 'imports' | 'people'

export const demoStats = [
  { label: 'สาขาในทะเบียน', value: '580', change: 'ข้อมูลตัวอย่าง', icon: 'branches', tone: 'blue' },
  { label: 'เครื่องสแกน', value: '1,284', change: 'หลายเครื่องต่อสาขา', icon: 'scanner', tone: 'violet' },
  { label: 'ใบงานที่ยังไม่เสร็จ', value: '36', change: 'รวมรายการ Pending', icon: 'activity', tone: 'orange' },
  { label: 'Completed', value: '214', change: 'จากประวัติงานตัวอย่าง', icon: 'check', tone: 'green' },
]

export const demoCampaigns = [
  { code: 'DEMO-ROUND-04', name: 'เปลี่ยนเครื่องสแกน — ภาคกลาง', branches: 42, tasks: 68, done: 39, status: 'กำลังดำเนินการ', tone: 'progress', date: '8–28 พ.ย. 2569' },
  { code: 'DEMO-ROUND-03', name: 'เปลี่ยนเครื่องสแกน — กรุงเทพฯ', branches: 26, tasks: 41, done: 41, status: 'เสร็จสิ้น', tone: 'done', date: '15–31 ต.ค. 2569' },
  { code: 'DEMO-ROUND-05', name: 'รายการที่เลือกค้างจาก Campaign เดิม', branches: 18, tasks: 24, done: 0, status: 'ยังไม่เปิดใบงาน', tone: 'neutral', date: 'ประวัติกระบวนการเดิม' },
]

export const demoTasks = [
  { branch: 'สาขาตัวอย่าง 001', province: 'กรุงเทพมหานคร', code: 'DEMO-001', model: 'Zebra DS9308', serial: '••••••0001', status: 'กำลังติดตั้ง', tone: 'progress' },
  { branch: 'สาขาตัวอย่าง 001', province: 'กรุงเทพมหานคร', code: 'DEMO-001', model: 'Honeywell HF680', serial: '••••••0002', status: 'เปิดแล้ว · รอเริ่มงาน', tone: 'scheduled' },
  { branch: 'สาขาตัวอย่าง 002', province: 'ปทุมธานี', code: 'DEMO-002', model: 'Zebra DS9308', serial: '••••••0003', status: 'Pending', tone: 'blocked' },
  { branch: 'สาขาตัวอย่าง 003', province: 'กรุงเทพมหานคร', code: 'DEMO-003', model: 'Zebra DS9308', serial: '••••••0004', status: 'เปิดแล้ว · รอเริ่มงาน', tone: 'scheduled' },
]

export const demoAssets = [
  { branch: 'สาขาตัวอย่าง 001', province: 'กรุงเทพมหานคร', code: 'DEMO-001', model: 'Zebra DS9308', serial: '••••••0001', year: '2022', campaign: 'DEMO-ROUND-04', status: 'เลือกเข้ารอบงาน', tone: 'ready' },
  { branch: 'สาขาตัวอย่าง 004', province: 'กรุงเทพมหานคร', code: 'DEMO-004', model: 'Honeywell HF680', serial: '••••••0002', year: '2021', campaign: 'DEMO-ROUND-04', status: 'นัดหมายแล้ว', tone: 'scheduled' },
  { branch: 'สาขาตัวอย่าง 002', province: 'ปทุมธานี', code: 'DEMO-002', model: 'Zebra DS9308', serial: '••••••0003', year: '2020', campaign: 'DEMO-ROUND-04', status: 'Pending', tone: 'blocked' },
  { branch: 'สาขาตัวอย่าง 003', province: 'กรุงเทพมหานคร', code: 'DEMO-003', model: 'Zebra DS9308', serial: '••••••0004', year: '2021', campaign: '—', status: 'ยังไม่เลือก', tone: 'neutral' },
]

export const dayBars = [
  { day: 'จ.', count: 18, done: 13 },
  { day: 'อ.', count: 27, done: 18 },
  { day: 'พ.', count: 21, done: 12 },
  { day: 'พฤ.', count: 32, done: 22 },
  { day: 'ศ.', count: 26, done: 15 },
  { day: 'ส.', count: 14, done: 9 },
  { day: 'อา.', count: 8, done: 5 },
]
