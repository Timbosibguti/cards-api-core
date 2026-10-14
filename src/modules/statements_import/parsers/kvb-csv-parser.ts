import { BaseParser } from './base-parser.js';
import { ParseResult } from '../../../types/transaction.js';
import { parse } from 'csv-parse/sync';

export class KvbCsvParser extends BaseParser {
  constructor() {
    super('kvb');
  }

  async parse(fileBuffer: Buffer, _fileName: string): Promise<ParseResult> {
    const transactions: ParseResult['transactions'] = [];
    const errors: string[] = [];

    try {
      const content = fileBuffer.toString('utf-8');
      
      // Preprocess content to remove incorrect CSV syntax like Account Number:,="...."
      const preprocessedContent = content.replace(/([^,]+),\s*="([^"]+)"/g, '$1,$2');
      
      const records = parse(preprocessedContent, {
        skip_empty_lines: true,
        relax_column_count: true,
      });

      // Extract currency and account number from file
      let currency = 'INR'; // default
      let accountNumber: string | null = null;
      
      for (const row of records) {
        if (row && Array.isArray(row)) {
          // Search for currency and account number in any column
          for (let i = 0; i < row.length; i++) {
            const cell = String(row[i] || '').toLowerCase();
            
            if (cell.includes('currency')) {
              // Currency value is usually in the next cell
              if (i + 1 < row.length && row[i + 1]) {
                currency = String(row[i + 1]).trim() || 'INR';
              }
            }
            
            if (cell.includes('account number')) {
              // Account number is usually in the next cell
              if (i + 1 < row.length && row[i + 1]) {
                accountNumber = String(row[i + 1]).trim().replace(/"/g, '') || null;
              }
            }
          }
        }
      }

      // Find the header row (contains "Transaction Date")
      let headerIndex = -1;
      for (let i = 0; i < records.length; i++) {
        if (records[i] && records[i].some((cell: string) => 
          cell && cell.toLowerCase().includes('transaction date')
        )) {
          headerIndex = i;
          break;
        }
      }

      if (headerIndex === -1) {
        errors.push('Could not find transaction header row');
        return { transactions, errors };
      }

      const headers = records[headerIndex];
      const dateIndex = headers.findIndex((h: string) => 
        h && h.toLowerCase().includes('transaction date')
      );
      const refIndex = headers.findIndex((h: string) => 
        h && h.toLowerCase().includes('cheque no')
      );
      const descriptionIndex = headers.findIndex((h: string) => 
        h && h.toLowerCase().includes('description')
      );
      const debitIndex = headers.findIndex((h: string) => 
        h && h.toLowerCase().includes('debit')
      );
      const creditIndex = headers.findIndex((h: string) => 
        h && h.toLowerCase().includes('credit')
      );
      
      // Debug: log found column indices
      if (dateIndex < 0) {
        errors.push(`Could not find Transaction Date column. Headers: ${headers.map((h: string, i: number) => `${i}:${String(h || '')}`).join(', ')}`);
      }
      if (debitIndex < 0) {
        errors.push(`Could not find Debit column. Headers: ${headers.map((h: string, i: number) => `${i}:${String(h || '')}`).join(', ')}`);
      }
      if (creditIndex < 0) {
        errors.push(`Could not find Credit column. Headers: ${headers.map((h: string, i: number) => `${i}:${String(h || '')}`).join(', ')}`);
      }

      // Process transaction rows
      for (let i = headerIndex + 1; i < records.length; i++) {
        const row = records[i];
        
        // Skip empty rows
        if (!row || row.length === 0) {
          continue;
        }

        // Skip footer rows (based on balance patterns)
        const firstCell = row[0]?.toString().toLowerCase() || '';
        if (firstCell.includes('closing balance') || 
            firstCell.includes('opening balance') ||
            firstCell.includes('searched by') ||
            firstCell.includes('from date') ||
            firstCell.includes('to date')) {
          continue;
        }

        try {
          const dateStr = row[dateIndex];
          const refNo = row[refIndex] || '';
          const description = row[descriptionIndex] || '';
          const debitStr = row[debitIndex] || '';
          const creditStr = row[creditIndex] || '';

          // Skip if no date (likely not a transaction row)
          if (!dateStr || dateStr.toString().trim() === '') {
            continue;
          }

          // Parse date: format "DD-MM-YYYY HH:mm:ss"
          const date = this.parseKvbDate(dateStr.toString().trim());
          if (isNaN(date.getTime())) {
            errors.push(`Invalid date format in row ${i + 1}: ${dateStr}`);
            continue;
          }

          // Parse amounts - only one of debit/credit will have a value
          const debitAmount = debitStr.toString().trim() ? this.parseKvbAmount(debitStr.toString()) : 0;
          const creditAmount = creditStr.toString().trim() ? this.parseKvbAmount(creditStr.toString()) : 0;
          
          // Skip if both amounts are zero (likely a balance row)
          if (debitAmount === 0 && creditAmount === 0) {
            continue;
          }
          
          // Determine if it's debit or credit
          // Debit = negative value, Credit = positive value
          const finalAmount = debitAmount > 0 ? -debitAmount : creditAmount;

          // Use description + cheque number as ext_id for uniqueness
          const extId = `${description.toString().trim()}-${refNo.toString().trim()}`.replace(/\s+/g, '_');
          if (!extId || extId === '-') {
            // Use row index as fallback if ext_id is empty
            const fallbackExtId = `kvb_${i}_${date.getTime()}`;
            transactions.push(
              this.createTransaction(date, fallbackExtId, finalAmount, currency, accountNumber)
            );
            continue;
          }

          transactions.push(
            this.createTransaction(date, extId, finalAmount, currency, accountNumber)
          );
        } catch (error) {
          errors.push(`Error parsing row ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      errors.push(`Error parsing CSV: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return { transactions, errors: errors.length > 0 ? errors : undefined };
  }

  private parseKvbDate(dateString: string): Date {
    // Format: "DD-MM-YYYY HH:mm:ss"
    const match = dateString.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      const [, day, month, year, hour, minute, second] = match;
      return new Date(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour),
        parseInt(minute),
        parseInt(second)
      );
    }
    // Fallback to default parser
    return this.parseDate(dateString);
  }

  private parseKvbAmount(amountString: string): number {
    // Remove commas and parse Indian number format (e.g., "50,30,835.47" -> 5030835.47)
    const cleaned = amountString.replace(/,/g, '').trim();
    return parseFloat(cleaned) || 0;
  }
}