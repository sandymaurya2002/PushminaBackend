import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const o = await p.order.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { statusHistory: { orderBy: { createdAt: 'asc' } }, payments: true },
  })
  if (!o) return console.log('no orders')
  console.log('DB order status :', o.status)
  console.log('confirmedAt     :', o.confirmedAt)
  console.log('payment status  :', o.payments[0]?.status)
  console.log('history         :', o.statusHistory.map(h => (h.fromStatus ?? '-') + '->' + h.toStatus).join(', '))
}
main().finally(() => p.$disconnect())
