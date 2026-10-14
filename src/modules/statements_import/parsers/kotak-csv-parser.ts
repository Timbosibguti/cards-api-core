import { BaseParser } from './base-parser.js';
import { ParseResult } from '../../../types/transaction.js';
import { parse } from 'csv-parse/sync';

export class KotakCsvParser extends BaseParser {
  constructor() {
    super('kotak');
  }

  async parse(fileBuffer: Buffer, _fileName: string): Promise<ParseResult> {
    const transactions: ParseResult['transactions'] = [];
    const errors: string[] = [];

    try {
      const content = fileBuffer.toString('utf-8');
      
      // Auto-detect delimiter: try both ';' and ',' and use the one that works better
      let records: any[];
      
      const tryDelimiter = (delim: string) => {
        try {
          const parsed = parse(content, {
            skip_empty_lines: true,
            relax_column_count: true,
            delimiter: delim,
            quote: '"', // Handle quoted values (e.g., "8,75,968.84")
          });
          
          // Check if we can find the header row with "Transaction Date"
          const headerRow = parsed.find((row: any) => 
            row && row.some((cell: string) => 
              cell && cell.toLowerCase().includes('transaction date')
            )
          );
          
          if (headerRow && headerRow.length > 3) {
            // Check if we can find required columns
            const hasDate = headerRow.some((h: string) => h && h.toLowerCase().includes('transaction date'));
            const hasRef = headerRow.some((h: string) => {
              if (!h) return false;
              const hLower = h.toLowerCase();
              return (hLower.includes('chq') && hLower.includes('ref')) || 
                     (hLower.includes('ref') && hLower.includes('no'));
            });
            const hasAmount = headerRow.some((h: string) => 
              h && h.toLowerCase().includes('amount') && !h.toLowerCase().includes('balance')
            );
            
            // If we found all required columns, this delimiter works
            if (hasDate && hasRef && hasAmount) {
              return { records: parsed, delimiter: delim, success: true };
            }
          }
          
          return { records: parsed, delimiter: delim, success: false };
        } catch (e) {
          return { records: [], delimiter: delim, success: false };
        }
      };
      
      // Try semicolon first (more common for Kotak files)
      const semicolonResult = tryDelimiter(';');
      if (semicolonResult.success) {
        records = semicolonResult.records;
      } else {
        // Try comma
        const commaResult = tryDelimiter(',');
        if (commaResult.success) {
          records = commaResult.records;
        } else {
          // Fallback to semicolon if comma also fails
          records = semicolonResult.records;
          errors.push('Warning: Could not reliably detect delimiter, using semicolon');
        }
      }

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
            
            if (cell.includes('account no') || cell.includes('account number')) {
              // Account number is usually in the next cell
              if (i + 1 < row.length && row[i + 1]) {
                accountNumber = String(row[i + 1]).trim() || null;
              }
            }
          }
        }
      }

      // Find the header row (usually contains "Transaction Date")
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
      // Look for "Chq / Ref No." or "Chq/Ref No." column - should contain both "chq" and "ref"
      const refIndex = headers.findIndex((h: string) => {
        if (!h) return false;
        const hLower = h.toLowerCase();
        // Look for column that contains both "chq" and "ref", or "ref" and "no" (for "Ref No.")
        return (hLower.includes('chq') && hLower.includes('ref')) || 
               (hLower.includes('ref') && hLower.includes('no') && !hLower.includes('balance'));
      });
      const amountIndex = headers.findIndex((h: string) => 
        h && h.toLowerCase().includes('amount') && !h.toLowerCase().includes('balance')
      );
      // Find first "Dr / Cr" column (before Balance column)
      let drCrIndex = -1;
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        if (h && (h.toLowerCase().includes('dr / cr') || h.toLowerCase().includes('dr/cr'))) {
          // Check if next column is Balance - if so, this is the amount Dr/Cr column
          if (i + 1 < headers.length && headers[i + 1] && headers[i + 1].toLowerCase().includes('balance')) {
            drCrIndex = i;
            break;
          }
          // If we haven't found one yet, use this one
          if (drCrIndex === -1) {
            drCrIndex = i;
          }
        }
      }
      
      // Debug: log found column indices
      if (refIndex < 0) {
        errors.push(`Warning: Could not find Chq/Ref column. Headers: ${headers.map((h: string, i: number) => `${i}:${String(h || '')}`).join(', ')}`);
      } else {
        // Log first few transactions to verify parsing
        let sampleCount = 0;
        for (let j = headerIndex + 1; j < Math.min(headerIndex + 6, records.length); j++) {
          const sampleRow = records[j];
          if (sampleRow && sampleRow[refIndex]) {
            sampleCount++;
          }
        }
        if (sampleCount === 0) {
          errors.push(`Warning: Found Chq/Ref column at index ${refIndex}, but no data in first 5 rows. Sample row: ${records[headerIndex + 1]?.map((c: string) => String(c || '')).join(' | ')}`);
        }
      }

      // Process transaction rows
      for (let i = headerIndex + 1; i < records.length; i++) {
        const row = records[i];
        
        // Skip empty rows
        if (!row || row.length === 0) {
          continue;
        }

        // Skip closing balance and footer rows
        const firstCell = row[0]?.toString().toLowerCase() || '';
        if (firstCell.includes('closing balance') || 
            firstCell.includes('you may call') ||
            firstCell.includes('write to us')) {
          continue;
        }

        try {
          const dateStr = row[dateIndex];
          const refNo = row[refIndex] || '';
          const amountStr = row[amountIndex] || '0';
          const drCr = row[drCrIndex] || '';

          // Skip if no date (likely not a transaction row)
          if (!dateStr || dateStr.toString().trim() === '') {
            continue;
          }

          // Parse date: format "DD-MM-YYYY HH:mm:ss"
          const date = this.parseKotakDate(dateStr.toString().trim());
          if (isNaN(date.getTime())) {
            errors.push(`Invalid date format in row ${i + 1}: ${dateStr}`);
            continue;
          }

          // Parse amount: remove commas and parse
          const amount = this.parseAmount(amountStr.toString());
          if (isNaN(amount)) {
            errors.push(`Invalid amount in row ${i + 1}: ${amountStr}`);
            continue;
          }
          if (amount === 0) {
            // Don't skip zero amounts - they might be valid transactions
            // But we'll skip them for now to avoid noise
            continue;
          }
          
          // Determine if it's debit (DR) or credit (CR)
          // DR = Debit (оплата/расход) → отрицательное значение
          // CR = Credit (приход/пополнение) → положительное значение
          const isDebit = drCr.toString().toUpperCase().includes('DR');
          const finalAmount = isDebit ? -Math.abs(amount) : Math.abs(amount);

          // Use ref number as ext_id (required field)
          const extId = refNo.toString().trim();
          if (!extId) {
            // Debug: log the row to understand structure
            errors.push(`Missing ext_id in row ${i + 1}. Row data: ${row.map((c: string) => String(c || '')).join(' | ')}`);
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

  private parseKotakDate(dateString: string): Date {
    // Format: "DD-MM-YYYY HH:mm:ss", "DD-MM-YYYY", "DD.MM.YYYY HH:mm", or "DD.MM.YYYY"
    // Try dash-separated format first (DD-MM-YYYY HH:mm:ss)
    let match = dateString.match(/(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
      const [, day, month, year, hour = '0', minute = '0', second = '0'] = match;
      return new Date(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour),
        parseInt(minute),
        parseInt(second)
      );
    }
    
    // Try dot-separated format (DD.MM.YYYY HH:mm)
    match = dateString.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
      const [, day, month, year, hour = '0', minute = '0', second = '0'] = match;
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
}

