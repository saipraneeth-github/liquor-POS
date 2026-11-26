import { fileURLToPath } from 'node:url';

export const supplierInvoicesDir = fileURLToPath(new URL('./local/supplier-invoices/', import.meta.url));
export const telanganaCatalogCsv = fileURLToPath(new URL('./catalog/telangana-master-products.csv', import.meta.url));
