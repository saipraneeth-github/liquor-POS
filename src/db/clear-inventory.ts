import { db } from './client.js';
import {
  stock,
  stockAudit,
  stockByType,
  breakageLogs,
  supplierInvoiceItems,
  supplierInvoices,
  products,
  dailyCounterSheetLines,
  dailyCounterSheets,
  dailyClosings,
  billItems,
  bills,
  billCounters,
  shiftSessions,
  kotItems,
  kotOrders,
  tableSessions,
  creditTransactions,
  customers,
  journalLines,
  journalVouchers,
  expenses,
  schemePurchases,
  priceAudit,
} from './schema.js';

export async function clearAllInventoryAndTransactions(): Promise<void> {
  console.log('🧹 Clearing inventory and transactional data while preserving users, catalog products, and branches...');

  await db.transaction(async (tx) => {
    // 1. Transactional & financial tables
    await tx.delete(expenses);
    await tx.delete(journalLines);
    await tx.delete(journalVouchers);

    // 2. Bar KOTs & sessions
    await tx.delete(kotItems);
    await tx.delete(kotOrders);
    await tx.delete(tableSessions);

    // 3. Billing & sales
    await tx.delete(billItems);
    await tx.delete(bills);
    await tx.delete(billCounters);

    // 4. Counter sheets & closings & shifts
    await tx.delete(dailyCounterSheetLines);
    await tx.delete(dailyCounterSheets);
    await tx.delete(dailyClosings);
    await tx.delete(shiftSessions);

    // 5. Customer credit transactions
    await tx.delete(creditTransactions);
    await tx.update(customers).set({ currentCredit: '0.00' });

    // 6. Schemes
    await tx.delete(schemePurchases);

    // 7. Inventory: Supplier Invoices & items
    await tx.delete(supplierInvoiceItems);
    await tx.delete(supplierInvoices);

    // 8. Stock, audit & breakage logs
    await tx.delete(stockAudit);
    await tx.delete(breakageLogs);
    await tx.delete(priceAudit);
    await tx.delete(stockByType);
    const deletedStock = await tx.delete(stock).returning({ id: stock.id });

    // 9. Reset product inventory tracking columns to clean state
    await tx.update(products).set({
      costPrice: null,
      previousCostPrice: null,
      costPerCase: null,
      lastInvoiceId: null,
      lastInvoiceNumber: null,
      lastInvoiceDate: null,
      costUpdatedAt: null,
    });

    console.log(`✅ Success! Cleared ${deletedStock.length} stock entries, reset products inventory tracking.`);
  });
}

const isEntryPoint = process.argv[1]?.replace(/\\/g, '/').endsWith('src/db/clear-inventory.ts');
if (isEntryPoint) {
  clearAllInventoryAndTransactions()
    .then(() => {
      console.log('Inventory and transactions cleared successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to clear inventory:', err);
      process.exit(1);
    });
}

