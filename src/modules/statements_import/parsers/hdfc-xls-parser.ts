import { BaseParser } from './base-parser.js';
import { ParseResult } from '../../../types/transaction.js';
import * as XLSX from 'xlsx';

export class HdfcXlsParser extends BaseParser {
  constructor() {
    super('hdfc');
  }

  async parse(fileBuffer: Buffer, _fileName: string): Promise<ParseResult> {
    const transactions: ParseResult['transactions'] = [];
    const errors: string[] = [];

    try {
      // Parse XLS file
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      
      // Get the first sheet (usually transactions are in the first sheet)
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      
      // Convert to JSON array
      const rows: any[] = XLSX.utils.sheet_to_json(worksheet, { 
        header: 1,
        defval: null,
        raw: false 
      });

      if (rows.length === 0) {
        errors.push('Empty file or no data found');
        return { transactions, errors };
      }

      // Find header row (look for "Narration" column)
      let headerRowIndex = -1;
      let headerRow: any[] = [];
      
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (Array.isArray(row)) {
          const rowStr = row.map(cell => String(cell || '').toLowerCase()).join(' ');
          if (rowStr.includes('narration')) {
            headerRowIndex = i;
            headerRow = row;
            break;
          }
        }
      }

      if (headerRowIndex === -1) {
        errors.push('Could not find header row with "Narration" column');
        return { transactions, errors };
      }

      // Find column indices
      const narrationIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('narration')
      );
      const dateIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('date') && 
        !String(cell || '').toLowerCase().includes('value')
      );
      const valueDateIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('value date')
      );
      const amountIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('amount') &&
        !String(cell || '').toLowerCase().includes('balance')
      );
      const debitIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('debit') ||
        String(cell || '').toLowerCase().includes('withdrawal')
      );
      const creditIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('credit') ||
        String(cell || '').toLowerCase().includes('deposit')
      );
      const balanceIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('balance')
      );

      // Extract currency and account number (usually in header or first few rows)
      let currency = 'INR'; // default
      let accountNumber: string | null = null;
      
      for (let i = 0; i < Math.min(30, rows.length); i++) {
        const row = rows[i];
        if (Array.isArray(row)) {
          const rowStr = row.map(cell => String(cell || '')).join(' ');
          if (rowStr.toLowerCase().includes('currency')) {
            const currencyMatch = rowStr.match(/currency[:\s]+([A-Z]{3})/i);
            if (currencyMatch) {
              currency = currencyMatch[1].toUpperCase();
            }
          }
          
          // Look for account number in the row string (e.g., "Account No :50200113925204")
          const accountMatch = rowStr.match(/account\s+no\s*[:\s]+(\d{10,})/i);
          if (accountMatch) {
            accountNumber = accountMatch[1].trim();
          }
          
          // Also check individual cells
          for (let j = 0; j < row.length; j++) {
            const cell = String(row[j] || '');
            const cellLower = cell.toLowerCase();
            
            // Check if cell contains "Account No" and extract number from same cell or next
            if (cellLower.includes('account no') || cellLower.includes('account number') || cellLower.includes('a/c no')) {
              // Try to extract from same cell (e.g., "Account No :50200113925204")
              const sameCellMatch = cell.match(/account\s+no\s*[:\s]+(\d{10,})/i);
              if (sameCellMatch) {
                accountNumber = sameCellMatch[1].trim();
              } else if (j + 1 < row.length && row[j + 1]) {
                // Account number might be in the next cell
                const nextCell = String(row[j + 1]).trim();
                if (/^\d{10,}$/.test(nextCell)) {
                  accountNumber = nextCell;
                }
              }
            }
            
            // Also check for numeric account numbers (usually 10+ digits) with account label nearby
            if (/^\d{10,}$/.test(cell.trim())) {
              // Check if previous cell mentions account
              if (j > 0) {
                const prevCell = String(row[j - 1] || '').toLowerCase();
                if (prevCell.includes('account')) {
                  accountNumber = cell.trim();
                }
              }
            }
          }
        }
      }

      // Process transaction rows
      for (let i = headerRowIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        
        if (!Array.isArray(row) || row.length === 0) {
          continue;
        }

        // Skip empty rows or summary rows
        const firstCell = String(row[0] || '').toLowerCase();
        if (!firstCell || 
            firstCell.includes('total') || 
            firstCell.includes('closing') ||
            firstCell.includes('opening')) {
          continue;
        }

        try {
          // Get narration (ext_id)
          const narration = row[narrationIndex];
          if (!narration || String(narration).trim() === '') {
            continue; // Skip rows without narration
          }
          const extId = String(narration).trim();

          // Get date (prefer Value Date, fallback to Transaction Date)
          let dateStr = '';
          if (valueDateIndex >= 0 && row[valueDateIndex]) {
            dateStr = String(row[valueDateIndex]);
          } else if (dateIndex >= 0 && row[dateIndex]) {
            dateStr = String(row[dateIndex]);
          }

          if (!dateStr || dateStr.trim() === '') {
            continue; // Skip rows without date
          }

          // Parse date (no time in HDFC files)
          const date = this.parseHdfcDate(dateStr.trim());
          if (isNaN(date.getTime())) {
            errors.push(`Invalid date format in row ${i + 1}: ${dateStr}`);
            continue;
          }

          // Get amount and determine debit/credit
          let amount = 0;
          let isDebit = false;

          // Try to get from Debit/Credit columns first (most reliable)
          if (debitIndex >= 0 && row[debitIndex]) {
            const debitAmount = this.parseAmount(String(row[debitIndex]));
            if (debitAmount > 0) {
              amount = debitAmount;
              isDebit = true;
            }
          }

          if (creditIndex >= 0 && row[creditIndex]) {
            const creditAmount = this.parseAmount(String(row[creditIndex]));
            if (creditAmount > 0) {
              amount = creditAmount;
              isDebit = false;
            }
          }

          // Fallback to Amount column if Debit/Credit columns not found
          if (amount === 0 && amountIndex >= 0 && row[amountIndex]) {
            amount = this.parseAmount(String(row[amountIndex]));
            
            // Try to determine debit/credit from balance change
            if (balanceIndex >= 0 && i > headerRowIndex + 1) {
              const prevRow = rows[i - 1];
              if (prevRow && Array.isArray(prevRow) && prevRow[balanceIndex]) {
                const prevBalance = this.parseAmount(String(prevRow[balanceIndex]));
                const currBalance = this.parseAmount(String(row[balanceIndex]));
                // If balance decreased, it's a debit (payment)
                // If balance increased, it's a credit (deposit)
                isDebit = currBalance < prevBalance;
              } else {
                // If no previous balance, check narration for hints
                const narrationLower = extId.toLowerCase();
                if (narrationLower.includes('debit') || 
                    narrationLower.includes('dr') ||
                    narrationLower.includes('payment') ||
                    narrationLower.includes('withdrawal')) {
                  isDebit = true;
                } else if (narrationLower.includes('credit') || 
                           narrationLower.includes('cr') ||
                           narrationLower.includes('deposit')) {
                  isDebit = false;
                }
              }
            }
          }

          if (amount === 0 || isNaN(amount)) {
            continue; // Skip rows with zero or invalid amounts
          }

          const finalAmount = isDebit ? -Math.abs(amount) : Math.abs(amount);

          transactions.push(
            this.createTransaction(date, extId, finalAmount, currency, accountNumber)
          );
        } catch (error) {
          errors.push(`Error parsing row ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      errors.push(`Error parsing HDFC XLS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return { transactions, errors: errors.length > 0 ? errors : undefined };
  }

  private parseHdfcDate(dateString: string): Date {
    // HDFC dates can be in various formats:
    // - DD/MM/YY (e.g., "03/11/25" = 3 November 2025)
    // - DD/MM/YYYY (e.g., "03/11/2025")
    // - DD-MM-YYYY
    // - Excel serial date (number)
    
    // Try DD/MM/YY first (2-digit year)
    const ddmmyy = dateString.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
    if (ddmmyy) {
      const [, day, month, year] = ddmmyy;
      // Convert 2-digit year to 4-digit (assume 2000-2099)
      const fullYear = parseInt(year) < 50 ? 2000 + parseInt(year) : 1900 + parseInt(year);
      return new Date(fullYear, parseInt(month) - 1, parseInt(day));
    }
    
    // Try DD/MM/YYYY (4-digit year)
    const ddmmyyyy = dateString.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ddmmyyyy) {
      const [, day, month, year] = ddmmyyyy;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }

    // Try YYYY-MM-DD
    const yyyymmdd = dateString.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
    if (yyyymmdd) {
      const [, year, month, day] = yyyymmdd;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }

    // Try Excel serial date (number)
    const serialDate = parseFloat(dateString);
    if (!isNaN(serialDate) && serialDate > 0 && serialDate < 1000000) {
      // Excel epoch starts from 1900-01-01, but Excel incorrectly treats 1900 as leap year
      const excelEpoch = new Date(1899, 11, 30);
      const date = new Date(excelEpoch.getTime() + serialDate * 86400000);
      return date;
    }

    // Fallback to default parser
    return this.parseDate(dateString);
  }
}
