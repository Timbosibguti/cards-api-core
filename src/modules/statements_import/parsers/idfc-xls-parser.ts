import { BaseParser } from './base-parser.js';
import { ParseResult } from '../../../types/transaction.js';
import * as XLSX from 'xlsx';

export class IdfcXlsParser extends BaseParser {
  constructor() {
    super('idfc');
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

      // Find header row (look for "Particulars" or other transaction-related columns)
      let headerRowIndex = -1;
      let headerRow: any[] = [];
      
      // Try to find header row by looking for common transaction-related keywords
      const headerKeywords = ['particulars', 'transaction date', 'value date', 'cheque no', 'debit', 'credit', 'balance'];
      
      // Start looking from row 20 onwards to skip summary rows
      for (let i = 20; i < rows.length; i++) {
        const row = rows[i];
        if (Array.isArray(row) && row.length >= 4) {
          const rowStr = row.map(cell => String(cell || '').toLowerCase()).join(' ');
          // Check if row contains multiple transaction-related keywords
          const keywordCount = headerKeywords.filter(keyword => rowStr.includes(keyword)).length;
          if (keywordCount >= 3) { // Require at least 3 keywords to be more specific
            headerRowIndex = i;
            headerRow = row;
            break;
          }
        }
      }

      if (headerRowIndex === -1) {
        // Debug: show first few rows to help diagnose
        const debugRows = rows.slice(0, 10).map((row, idx) => 
          `Row ${idx}: ${Array.isArray(row) ? row.map(cell => String(cell || '')).join(' | ') : 'Not an array'}`
        ).join('\n');
        errors.push(`Could not find header row. First 10 rows:\n${debugRows}`);
        return { transactions, errors };
      }

      // Find column indices based on IDFC header structure
      const transactionDateIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('transaction date');
      });
      const valueDateIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('value date');
      });
      const particularsIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('particulars');
      });
      const debitIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('debit');
      });
      const creditIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('credit');
      });
      const balanceIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('balance');
      });

      // Debug: log found column indices
      if (particularsIndex < 0) {
        errors.push(`Warning: Could not find Particulars/Description column. Header columns: ${headerRow.map((c, i) => `${i}:${String(c || '')}`).join(', ')}`);
      }

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
          
          // Look for account number in the row string (e.g., "ACCOUNT NUMBER	10253443257")
          const accountMatch = rowStr.match(/account\s+number\s*[:\-\s]+(\d+)/i);
          if (accountMatch) {
            accountNumber = accountMatch[1].trim();
          }
          
          // Also check individual cells
          for (let j = 0; j < row.length; j++) {
            const cell = String(row[j] || '');
            const cellLower = cell.toLowerCase();
            
            // Check if cell contains "Account Number" and extract number from same cell or next
            if (cellLower.includes('account number') || cellLower.includes('account no')) {
              // Try to extract from same cell (e.g., "ACCOUNT NUMBER	10253443257")
              const sameCellMatch = cell.match(/account\s+number\s*[:\-\s]+(\d+)/i);
              if (sameCellMatch) {
                accountNumber = sameCellMatch[1].trim();
              } else if (j + 1 < row.length && row[j + 1]) {
                // Account number might be in the next cell
                const nextCell = String(row[j + 1]).trim();
                if (/^\d+$/.test(nextCell)) {
                  accountNumber = nextCell;
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
            firstCell.includes('opening') ||
            firstCell.includes('number of')) {
          continue;
        }

        try {
          // Get particulars (ext_id)
          let extId = '';
          
          if (particularsIndex >= 0) {
            const particulars = row[particularsIndex];
            if (particulars && String(particulars).trim() !== '') {
              extId = String(particulars).trim();
            }
          }
          
          // If no particulars found, try to use description or other text fields
          if (!extId) {
            // Try to find any text field that might contain transaction ID
            for (let colIdx = 0; colIdx < row.length; colIdx++) {
              const cell = row[colIdx];
              if (cell && String(cell).trim().length > 5 &&
                  colIdx !== transactionDateIndex &&
                  colIdx !== valueDateIndex &&
                  colIdx !== balanceIndex &&
                  colIdx !== debitIndex &&
                  colIdx !== creditIndex) {
                extId = String(cell).trim();
                break;
              }
            }
          }
          
          // If still no ext_id, generate one from date and row index
          if (!extId) {
            extId = `idfc-${i}-${Date.now()}`;
          }

          // Get date (prefer Value Date, fallback to Transaction Date)
          let dateStr = '';
          if (valueDateIndex >= 0 && row[valueDateIndex]) {
            dateStr = String(row[valueDateIndex]);
          } else if (transactionDateIndex >= 0 && row[transactionDateIndex]) {
            dateStr = String(row[transactionDateIndex]);
          }

          if (!dateStr || dateStr.trim() === '') {
            continue; // Skip rows without date
          }

          // Parse date (no time in IDFC files)
          const date = this.parseIdfcDate(dateStr.trim());
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
          if (amount === 0) {
            // Try to parse from Debit or Credit columns directly
            if (debitIndex >= 0 && row[debitIndex] && String(row[debitIndex]).trim() !== '') {
              amount = this.parseAmount(String(row[debitIndex]));
              isDebit = true;
            } else if (creditIndex >= 0 && row[creditIndex] && String(row[creditIndex]).trim() !== '') {
              amount = this.parseAmount(String(row[creditIndex]));
              isDebit = false;
            }
            
            // Try to determine debit/credit from balance change if we have balance info
            if (amount === 0 && balanceIndex >= 0 && i > headerRowIndex + 1) {
              const prevRow = rows[i - 1];
              if (prevRow && Array.isArray(prevRow) && prevRow[balanceIndex] && row[balanceIndex]) {
                const prevBalance = this.parseAmount(String(prevRow[balanceIndex]));
                const currBalance = this.parseAmount(String(row[balanceIndex]));
                if (!isNaN(prevBalance) && !isNaN(currBalance)) {
                  // If balance decreased, it's a debit (payment)
                  // If balance increased, it's a credit (deposit)
                  amount = Math.abs(currBalance - prevBalance);
                  isDebit = currBalance < prevBalance;
                }
              }
            }
            
            // If still no amount, check particulars for hints and try to extract amount
            if (amount === 0) {
              const particularsLower = extId.toLowerCase();
              if (particularsLower.includes('debit') ||
                  particularsLower.includes('dr') ||
                  particularsLower.includes('payment') ||
                  particularsLower.includes('withdrawal')) {
                // Try to extract amount from particulars
                const amountMatch = extId.match(/[\d,]+\.\d{2}/);
                if (amountMatch) {
                  amount = this.parseAmount(amountMatch[0]);
                  isDebit = true;
                }
              } else if (particularsLower.includes('credit') ||
                         particularsLower.includes('cr') ||
                         particularsLower.includes('deposit')) {
                // Try to extract amount from particulars
                const amountMatch = extId.match(/[\d,]+\.\d{2}/);
                if (amountMatch) {
                  amount = this.parseAmount(amountMatch[0]);
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
      errors.push(`Error parsing IDFC XLS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return { transactions, errors: errors.length > 0 ? errors : undefined };
  }

  private parseIdfcDate(dateString: string): Date {
    // IDFC dates can be in various formats: DD-MMM-YYYY (e.g., 04-Nov-2025)
    // Try DD-MMM-YYYY format first
    const ddmmyyyy = dateString.match(/(\d{2})-(\w{3})-(\d{4})/);
    if (ddmmyyyy) {
      const [, day, month, year] = ddmmyyyy;
      const monthIndex = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(month.toLowerCase());
      if (monthIndex !== -1) {
        return new Date(parseInt(year), monthIndex, parseInt(day));
      }
    }

    // Try DD/MM/YYYY
    const ddmmyyyySlash = dateString.match(/(\d{2})[\/](\d{2})[\/](\d{4})/);
    if (ddmmyyyySlash) {
      const [, day, month, year] = ddmmyyyySlash;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }

    // Try YYYY-MM-DD
    const yyyymmdd = dateString.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
    if (yyyymmdd) {
      const [, year, month, day] = yyyymmdd;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }

    // Fallback to default parser
    return this.parseDate(dateString);
  }
}