import { BaseParser } from './base-parser.js';
import { ParseResult } from '../../../types/transaction.js';
import * as XLSX from 'xlsx';

export class AxisXlsParser extends BaseParser {
  constructor() {
    super('axis');
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
      const headerKeywords = ['particulars', 'date', 'amount', 'debit', 'credit', 'balance', 'transaction'];
      
      for (let i = 0; i < Math.min(20, rows.length); i++) {
        const row = rows[i];
        if (Array.isArray(row)) {
          const rowStr = row.map(cell => String(cell || '').toLowerCase()).join(' ');
          // Check if row contains multiple transaction-related keywords
          const keywordCount = headerKeywords.filter(keyword => rowStr.includes(keyword)).length;
          if (keywordCount >= 2) {
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

      // Find column indices
      // Try different variations for particulars/description column
      const particularsIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('particulars') || 
               cellStr.includes('description') || 
               cellStr.includes('narration') ||
               cellStr.includes('transaction') ||
               cellStr.includes('details') ||
               cellStr.includes('remarks') ||
               cellStr.includes('narration/particulars');
      });
      const dateIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return (cellStr.includes('date') || cellStr.includes('dt')) && 
               !cellStr.includes('value');
      });
      const valueDateIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('value date')
      );
      const amountIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return (cellStr.includes('amount') || cellStr.includes('amt')) &&
               !cellStr.includes('balance');
      });
      const debitIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('debit') ||
               cellStr.includes('withdrawal') ||
               cellStr.includes('dr') ||
               (cellStr.includes('withdraw') && !cellStr.includes('deposit'));
      });
      const creditIndex = headerRow.findIndex((cell: any) => {
        const cellStr = String(cell || '').toLowerCase();
        return cellStr.includes('credit') ||
               cellStr.includes('deposit') ||
               cellStr.includes('cr');
      });
      const balanceIndex = headerRow.findIndex((cell: any) => 
        String(cell || '').toLowerCase().includes('balance')
      );

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
          
          // Look for account number in the row string (e.g., "Statement of Account No - 920020052294090")
          const accountMatch = rowStr.match(/(?:statement\s+of\s+)?account\s+no\s*[:\-\s]+(\d{10,})/i);
          if (accountMatch) {
            accountNumber = accountMatch[1].trim();
          }
          
          // Also check individual cells
          for (let j = 0; j < row.length; j++) {
            const cell = String(row[j] || '');
            const cellLower = cell.toLowerCase();
            
            // Check if cell contains "Account No" and extract number from same cell or next
            if (cellLower.includes('account no') || cellLower.includes('account number') || cellLower.includes('a/c no')) {
              // Try to extract from same cell (e.g., "Statement of Account No - 920020052294090")
              const sameCellMatch = cell.match(/(?:statement\s+of\s+)?account\s+no\s*[:\-\s]+(\d{10,})/i);
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
                  colIdx !== dateIndex && 
                  colIdx !== amountIndex && 
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
            extId = `axis-${i}-${Date.now()}`;
          }

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

          // Parse date (no time in Axis files)
          const date = this.parseAxisDate(dateStr.trim());
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
                // If no previous balance, check particulars for hints
                const particularsLower = extId.toLowerCase();
                if (particularsLower.includes('debit') || 
                    particularsLower.includes('dr') ||
                    particularsLower.includes('payment') ||
                    particularsLower.includes('withdrawal')) {
                  isDebit = true;
                } else if (particularsLower.includes('credit') || 
                           particularsLower.includes('cr') ||
                           particularsLower.includes('deposit')) {
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
      errors.push(`Error parsing Axis XLS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return { transactions, errors: errors.length > 0 ? errors : undefined };
  }

  private parseAxisDate(dateString: string): Date {
    // Axis dates can be in various formats: DD/MM/YYYY, DD-MM-YYYY, or Excel serial date
    // Try DD/MM/YYYY first
    const ddmmyyyy = dateString.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
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
    if (!isNaN(serialDate) && serialDate > 0) {
      // Excel epoch starts from 1900-01-01, but Excel incorrectly treats 1900 as leap year
      const excelEpoch = new Date(1899, 11, 30);
      const date = new Date(excelEpoch.getTime() + serialDate * 86400000);
      return date;
    }

    // Fallback to default parser
    return this.parseDate(dateString);
  }
}
