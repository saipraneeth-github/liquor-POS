// src/lib/print/generator.ts
import { EscPosBuilder } from './escpos.js';

export interface PrintItem {
  name: string;
  qty: number;
  rate: number;
  net: number;
}

export interface PrintBill {
  branchName: string;
  branchAddress: string;
  gstin?: string;
  billNumber: string;
  date: string; // ISO or formatted
  cashierName: string;
  items: PrintItem[];
  subtotal: number;
  discount: number;
  taxAmount: number;
  total: number;
  paymentMode: string;
  paperWidth?: '58mm' | '80mm'; // Defaults to 58mm
}

function formatMoney(amount: number): string {
  return amount.toFixed(2); // Assuming amount is in decimal. If it's paise, divide by 100 first!
}

export function generateReceiptBuffer(bill: PrintBill): Uint8Array {
  // 58mm usually fits ~32 chars, 80mm ~48 chars per line.
  const is80mm = bill.paperWidth === '80mm';
  const width = is80mm ? 48 : 32;
  const builder = new EscPosBuilder(width);

  builder.alignCenter().boldOn().size(1, 1).addLine(bill.branchName).size(0, 0).boldOff();
  builder.addLine(bill.branchAddress);
  if (bill.gstin) {
    builder.addLine(`GSTIN: ${bill.gstin}`);
  }
  builder.addLine('TAX INVOICE');
  builder.separator('=');

  builder.alignLeft();
  builder.twoColumn(`Bill No: ${bill.billNumber}`, `Date: ${bill.date}`);
  builder.twoColumn(`Cashier: ${bill.cashierName}`, '');
  builder.separator('-');

  // Items Header (Qty, Item, Rate, Net)
  const colWidths = is80mm ? [5, 25, 8, 10] as [number, number, number, number] : [4, 14, 6, 8] as [number, number, number, number];
  builder.boldOn().fourColumn('Qty', 'Item', 'Rate', 'Net', colWidths).boldOff();
  builder.separator('-');

  for (const item of bill.items) {
    // Truncate item name to fit column 2
    let itemName = item.name;
    if (itemName.length > colWidths[1] - 1) {
      itemName = itemName.substring(0, colWidths[1] - 1);
    }
    builder.fourColumn(
      item.qty.toString(),
      itemName,
      formatMoney(item.rate),
      formatMoney(item.net),
      colWidths
    );
  }
  builder.separator('-');

  // Totals
  builder.twoColumn('Subtotal:', formatMoney(bill.subtotal));
  if (bill.discount > 0) {
    builder.twoColumn('Discount:', `-${formatMoney(bill.discount)}`);
  }
  if (bill.taxAmount > 0) {
    builder.twoColumn('GST Amount:', formatMoney(bill.taxAmount));
  }

  builder.separator('-');
  builder.boldOn().size(0, 1).twoColumn('TOTAL:', formatMoney(bill.total)).size(0, 0).boldOff();
  builder.separator('-');

  builder.twoColumn('Payment Mode:', bill.paymentMode);

  builder.alignCenter().addLine('Thank you for your visit!');
  builder.addLine('Please come again.');

  builder.addLine().addLine().addLine(); // Feed lines
  builder.cut();
  builder.kickDrawer();

  return builder.build();
}
