import { BaseParser } from './base-parser.js';
import { ParseResult } from '../../../types/transaction.js';
import pdfParse from 'pdf-parse';

export class KotakPdfParser extends BaseParser {
  constructor() {
    super('kotak');
  }

  async parse(fileBuffer: Buffer, _fileName: string): Promise<ParseResult> {
    const transactions: ParseResult['transactions'] = [];
    const errors: string[] = [];

    try {
      // Parse PDF file
      const pdfData = await pdfParse(fileBuffer);
      const text = pdfData.text;

      if (!text || text.trim().length === 0) {
        errors.push('PDF file is empty or could not extract text');
        return { transactions, errors };
      }

      // Extract currency and account number (usually mentioned in the document)
      let currency = 'INR'; // default
      const currencyMatch = text.match(/currency[:\s]+([A-Z]{3})/i);
      if (currencyMatch) {
        currency = currencyMatch[1].toUpperCase();
      }
      
      let accountNumber: string | null = null;
      // Look for account number patterns
      const accountPatterns = [
        /account\s*#\s*(\d{10,})/i,  // "Account # 1512397527"
        /account\s+no[.:\s]+(\d{10,})/i,
        /account\s+number[.:\s]+(\d{10,})/i,
        /a\/c\s+no[.:\s]+(\d{10,})/i,
      ];
      
      for (const pattern of accountPatterns) {
        const match = text.match(pattern);
        if (match) {
          accountNumber = match[1].trim();
          break;
        }
      }

      // Split text into lines
      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);

      // Find the header row (usually contains "Transaction Date" or similar)
      let headerLineIndex = -1;
      const headerKeywords = ['transaction date', 'date', 'description', 'amount', 'ref', 'chq', 'balance', 'dr', 'cr'];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        // Check if line contains multiple transaction-related keywords
        const keywordCount = headerKeywords.filter(keyword => line.includes(keyword)).length;
        if (keywordCount >= 3) {
          headerLineIndex = i;
          break;
        }
        // Also check for specific patterns
        if (line.includes('transaction date') || 
            (line.includes('date') && line.includes('description') && line.includes('amount')) ||
            (line.includes('sl.') && line.includes('no') && line.includes('date'))) {
          headerLineIndex = i;
          break;
        }
      }

      if (headerLineIndex === -1) {
        // Debug: show first 20 lines to help diagnose
        const debugLines = lines.slice(0, 20).map((line, idx) => 
          `Line ${idx}: ${line.substring(0, 100)}`
        ).join('\n');
        errors.push(`Could not find transaction header in PDF. First 20 lines:\n${debugLines}`);
        return { transactions, errors };
      }

      // Process lines after header
      // In Kotak PDF, transactions are split across multiple lines:
      // Line 1: "101 Nov 2025" (transaction number + date)
      // Line 2: "12:10 PM" (time)
      // Line 3: "01 Nov 2025REV:BILLDESK..." (value date + description)
      // Line 4: "0235251814" (reference number part)
      // Line 5: "REVPG-008971188+500.00" (ext_id + amount with sign)
      // Line 6: "8,75,968.84" (balance)
      
      const monthMap: { [key: string]: number } = {
        'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
        'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
      };
      
      let processedCount = 0;
      let skippedCount = 0;
      let currentTransaction: any = null;
      
      for (let i = headerLineIndex + 1; i < lines.length; i++) {
        const line = lines[i];

        // Skip empty lines, closing balance, and footer text
        if (!line || 
            line.toLowerCase().includes('closing balance') ||
            line.toLowerCase().includes('you may call') ||
            line.toLowerCase().includes('write to us') ||
            line.toLowerCase().includes('kotak mahindra bank') ||
            line.toLowerCase().includes('page')) {
          skippedCount++;
          continue;
        }

        try {
          // Check if this is a new transaction
          // Format: "101 Nov 2025" where "101" = "1" (transaction number) + "01" (day)
          // We need to distinguish between:
          // - Transaction start: "101 Nov 2025", "201 Nov 2025" (ends with just date, no description)
          // - Value date line: "01 Nov 2025REV:BILLDESK..." (date followed by description)
          
          // Pattern for transaction start: digits + month + year, and line ends there (no description)
          // Examples: "101 Nov 2025", "201 Nov 2025", "1001 Nov 2025"
          let transactionStartMatch = null;
          
          // Try pattern: digits + month + year (line should end here, no description)
          const concatMatch = line.match(/^(\d{2,})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i);
          if (concatMatch) {
            const [, digits, month, year] = concatMatch;
            // Extract last 2 digits as day
            if (digits.length >= 2) {
              const day = parseInt(digits.substring(digits.length - 2));
              // Day must be valid (01-31)
              if (day >= 1 && day <= 31) {
                const txNum = digits.substring(0, digits.length - 2);
                // Transaction number should be reasonable (1-9999, but can be longer)
                // The key is that this line ends with just the date, no description
                transactionStartMatch = [null, txNum, digits.substring(digits.length - 2), month, year] as any;
              }
            }
          }
          
          // Also try pattern with space: "1 01 Nov 2025" (must end with date)
          if (!transactionStartMatch) {
            const spacedMatch = line.match(/^(\d+)\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i);
            if (spacedMatch) {
              const [, , day] = spacedMatch;
              const dayNum = parseInt(day);
              if (dayNum >= 1 && dayNum <= 31) {
                transactionStartMatch = spacedMatch;
              }
            }
          }
          
          if (transactionStartMatch) {
            // Save previous transaction if exists
            if (currentTransaction) {
              // Try to save even if some fields are missing - we'll use fallbacks
              // Priority: if we have both amount and ext_id, save it
              if (currentTransaction.amount !== 0 && currentTransaction.extId) {
                transactions.push(
                  this.createTransaction(
                    currentTransaction.date,
                    currentTransaction.extId,
                    currentTransaction.amount,
                    currency,
                    accountNumber
                  )
                );
                processedCount++;
              } else if (currentTransaction.amount !== 0) {
                // Has amount but no ext_id - try to extract from description or generate one
                let fallbackExtId = '';
                if (currentTransaction.description) {
                  // Try to extract ext_id from description
                  const descExtIdMatch = currentTransaction.description.match(/(REVPG-[A-Z0-9-]+|KPG-[A-Z0-9-]+|NACH[A-Z]+[A-Z0-9-]+|RTGS[A-Z]+[A-Z0-9-]+|KKBKH[A-Z0-9]+)/i);
                  if (descExtIdMatch) {
                    fallbackExtId = descExtIdMatch[1].trim();
                  }
                }
                if (!fallbackExtId) {
                  fallbackExtId = `${currentTransaction.date.getTime()}-${i}`;
                }
                transactions.push(
                  this.createTransaction(
                    currentTransaction.date,
                    fallbackExtId,
                    currentTransaction.amount,
                    currency,
                    accountNumber
                  )
                );
                processedCount++;
              } else if (currentTransaction.extId) {
                // Has ext_id but no amount - might be a zero amount transaction or we missed it
                // Try to find amount in description or use 0
                let amount = 0;
                if (currentTransaction.description) {
                  const descAmountMatch = currentTransaction.description.match(/([+-])\s*([\d,]+\.?\d*)/);
                  if (descAmountMatch) {
                    const [, sign, amountStr] = descAmountMatch;
                    amount = this.parseAmount(amountStr);
                    if (sign === '-') amount = -Math.abs(amount);
                    else amount = Math.abs(amount);
                  }
                }
                // Only save if we found an amount, otherwise skip (zero amounts are usually not real transactions)
                if (amount !== 0) {
                  transactions.push(
                    this.createTransaction(
                      currentTransaction.date,
                      currentTransaction.extId,
                      amount,
                      currency,
                      accountNumber
                    )
                  );
                  processedCount++;
                }
              }
            }
            
            // Start new transaction
            const [, , day, month, year] = transactionStartMatch;
            const monthNum = monthMap[month.toLowerCase()];
            if (monthNum !== undefined) {
              currentTransaction = {
                date: new Date(parseInt(year), monthNum, parseInt(day)),
                extId: '',
                amount: 0,
                isDebit: false,
                time: '',
                valueDate: '',
                description: '',
              };
            }
            continue;
          }
          
          // If we have a current transaction, try to extract data from current line
          if (currentTransaction) {
            // Check for time (e.g., "12:10 PM")
            const timeMatch = line.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
            if (timeMatch) {
              let hour = parseInt(timeMatch[1]);
              const minute = parseInt(timeMatch[2]);
              const ampm = timeMatch[3].toUpperCase();
              if (ampm === 'PM' && hour !== 12) hour += 12;
              if (ampm === 'AM' && hour === 12) hour = 0;
              currentTransaction.date.setHours(hour, minute, 0);
              currentTransaction.time = timeMatch[0];
              continue;
            }
            
            // Check for value date + description (e.g., "01 Nov 2025REV:BILLDESK...")
            const valueDateMatch = line.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})(.+)/i);
            if (valueDateMatch) {
              const [, vDay, vMonth, vYear, desc] = valueDateMatch;
              const vMonthNum = monthMap[vMonth.toLowerCase()];
              if (vMonthNum !== undefined) {
                currentTransaction.valueDate = `${vDay} ${vMonth} ${vYear}`;
                currentTransaction.description = desc.trim();
              }
              continue;
            }
            
            // Check for ext_id + amount (e.g., "REVPG-008971188+500.00" or "REVPG-008971188-500.00")
            // Also handle cases where there might be spaces: "REVPG-008971188 +500.00"
            const extIdAmountMatch = line.match(/([A-Z0-9-]+)\s*([+-])\s*([\d,]+\.?\d*)/);
            if (extIdAmountMatch) {
              const [, extId, sign, amountStr] = extIdAmountMatch;
              currentTransaction.extId = extId.trim();
              const amount = this.parseAmount(amountStr);
              currentTransaction.isDebit = sign === '-';
              currentTransaction.amount = currentTransaction.isDebit ? -Math.abs(amount) : Math.abs(amount);
              continue;
            }
            
            // Check if line contains only ext_id pattern (e.g., "REVPG-008971188" or "KPG-0237795162")
            // Support more patterns
            if (!currentTransaction.extId) {
              const extIdMatch = line.match(/(REVPG-[A-Z0-9-]+|KPG-[A-Z0-9-]+|NACH[A-Z]+[A-Z0-9-]+|RTGS[A-Z]+[A-Z0-9-]+|KKBKH[A-Z0-9]+|[A-Z]{2,}\d{8,})/i);
              if (extIdMatch) {
                currentTransaction.extId = extIdMatch[1].trim();
                // Don't continue - might also have amount on same line
              }
            }
            
            // Check for amount with sign (e.g., "+500.00" or "-500.00")
            // Also check for amount without sign if we already have ext_id
            if (currentTransaction.amount === 0) {
              // First try with sign
              let amountMatch = line.match(/([+-])\s*([\d,]+\.?\d*)/);
              if (amountMatch) {
                const [, sign, amountStr] = amountMatch;
                const amount = this.parseAmount(amountStr);
                currentTransaction.isDebit = sign === '-';
                currentTransaction.amount = currentTransaction.isDebit ? -Math.abs(amount) : Math.abs(amount);
                continue;
              }
              
              // If we have ext_id but no amount yet, try to find amount without sign
              // Look for numbers that could be amounts (reasonable size, not too large)
              if (currentTransaction.extId) {
                const amountOnlyMatch = line.match(/([\d,]+\.?\d{2})/);
                if (amountOnlyMatch) {
                  const amount = this.parseAmount(amountOnlyMatch[1]);
                  // Reasonable transaction amount (not balance)
                  if (amount > 0 && amount < 10000000) {
                    // Try to determine debit/credit from context
                    const lineLower = line.toLowerCase();
                    if (lineLower.includes('dr') || lineLower.includes('debit')) {
                      currentTransaction.isDebit = true;
                      currentTransaction.amount = -Math.abs(amount);
                    } else {
                      currentTransaction.amount = Math.abs(amount);
                    }
                    continue;
                  }
                }
              }
            }
            
            // Check for balance (large number, might be the last piece)
            const balanceMatch = line.match(/^([\d,]+\.?\d*)$/);
            if (balanceMatch && currentTransaction.amount === 0) {
              // If we don't have amount yet, this might be it (but it's probably balance)
              // Skip for now
            }
          }
          
          // Old single-line parsing (fallback)
          let dateMatch = line.match(/(\d{2}-\d{2}-\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
          if (!dateMatch) {
            dateMatch = line.match(/(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
          }
          
          if (!dateMatch) {
            skippedCount++;
            continue;
          }
          
          const dateStr = dateMatch[0];
          const date = this.parseKotakDate(dateStr);

          if (isNaN(date.getTime())) {
            skippedCount++;
            continue;
          }

          // Extract remaining parts after date
          const remaining = line.substring(dateMatch.index! + dateMatch[0].length).trim();
          
          // Split by comma, but be careful with quoted values
          const parts = this.splitTransactionLine(remaining);

          // Find amount (usually has commas for thousands, e.g., "500.00" or "8,75,968.84")
          let amount = 0;
          let extId = '';
          let isDebit = false;

          // Look for Dr/Cr indicator
          const drCrMatch = remaining.match(/\b(DR|CR|Dr|Cr)\b/);
          if (drCrMatch) {
            isDebit = drCrMatch[1].toUpperCase() === 'DR';
          }

          // Find amount (number with optional commas and decimal)
          // Try to find amounts in the line
          const amountMatch = remaining.match(/([\d,]+\.?\d*)/g);
          if (amountMatch && amountMatch.length > 0) {
            // Usually there are multiple amounts: transaction amount and balance
            // Transaction amount is usually smaller and appears before balance
            // Try to find amount that's reasonable (not too large, not too small)
            const amounts = amountMatch.map(amtStr => this.parseAmount(amtStr)).filter(amt => amt > 0);
            if (amounts.length > 0) {
              // If multiple amounts, the first reasonable one is usually the transaction amount
              // Balance is usually the largest
              const sortedAmounts = amounts.sort((a, b) => a - b);
              // Take the first reasonable amount (not the largest, which is likely balance)
              for (const amt of sortedAmounts) {
                if (amt > 0 && amt < 100000000) { // Reasonable transaction amount
                  amount = amt;
                  break;
                }
              }
              // If still no amount, use the first one
              if (amount === 0 && amounts.length > 0) {
                amount = amounts[0];
              }
            }
          }

          // Find ext_id (reference number)
          // Look for patterns like REVPG-, KPG-, NACH-, RTGS-, etc.
          const refPatterns = [
            /(REVPG-[A-Z0-9-]+)/i,
            /(KPG-[A-Z0-9-]+)/i,
            /(NACH[A-Z]+[A-Z0-9-]+)/i,
            /(RTGS[A-Z]+[A-Z0-9-]+)/i,
            /(KKBKH[A-Z0-9]+)/i,
            /([A-Z]{2,}\d{10,})/,
            /([A-Z0-9]{8,})/, // Generic alphanumeric ID
          ];

          for (const pattern of refPatterns) {
            const match = remaining.match(pattern);
            if (match) {
              extId = match[1].trim();
              break;
            }
          }

          // If no ref pattern found, try to extract from description
          if (!extId && parts.length > 0) {
            // Usually description is the first part after date
            const description = parts[0];
            if (description && description.length > 5) {
              // Use part of description as ext_id
              extId = description.substring(0, 50).trim();
            }
          }
          
          // Also try to find ext_id in the full line
          if (!extId) {
            for (const pattern of refPatterns) {
              const match = line.match(pattern);
              if (match) {
                extId = match[1].trim();
                break;
              }
            }
          }

          // Fallback: use date + index as ext_id
          if (!extId) {
            extId = `${date.getTime()}-${i}`;
          }

          // If amount is 0, try to extract from the line anyway
          if (amount === 0) {
            // Try to find any number that could be an amount
            const allNumbers = line.match(/([\d,]+\.?\d*)/g);
            if (allNumbers && allNumbers.length > 0) {
              for (const numStr of allNumbers) {
                const num = this.parseAmount(numStr);
                if (num > 0 && num < 100000000) {
                  amount = num;
                  break;
                }
              }
            }
          }
          
          // If still no amount, skip this transaction
          if (amount === 0) {
            skippedCount++;
            continue;
          }

          const finalAmount = isDebit ? -Math.abs(amount) : Math.abs(amount);

          // Only add transaction if we have at least amount and ext_id
          if (amount > 0 && extId) {
            transactions.push(
              this.createTransaction(date, extId, finalAmount, currency, accountNumber)
            );
            processedCount++;
          } else {
            skippedCount++;
          }
        } catch (error) {
          errors.push(`Error parsing line ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          skippedCount++;
        }
      }
      
      // Save last transaction if exists
      if (currentTransaction) {
        // Try to save even if some fields are missing
        if (currentTransaction.amount !== 0 && currentTransaction.extId) {
          transactions.push(
            this.createTransaction(
              currentTransaction.date,
              currentTransaction.extId,
              currentTransaction.amount,
              currency,
              accountNumber
            )
          );
          processedCount++;
        } else if (currentTransaction.amount !== 0) {
          // Has amount but no ext_id - generate one
          const fallbackExtId = `${currentTransaction.date.getTime()}-final`;
          transactions.push(
            this.createTransaction(
              currentTransaction.date,
              fallbackExtId,
              currentTransaction.amount,
              currency,
              accountNumber
            )
          );
          processedCount++;
        } else if (currentTransaction.extId) {
          // Has ext_id but no amount - might be a zero amount transaction
          // Could add with amount 0 if needed, but skip for now
        }
      }
      
      // Add debug info if no transactions found
      if (transactions.length === 0) {
        errors.push(`No transactions found. Processed ${processedCount} potential transactions, skipped ${skippedCount} lines. Header found at line ${headerLineIndex + 1}.`);
        // Show sample lines around header
        const sampleStart = Math.max(0, headerLineIndex - 2);
        const sampleEnd = Math.min(lines.length, headerLineIndex + 15);
        const sampleLines = lines.slice(sampleStart, sampleEnd)
          .map((line, idx) => `Line ${sampleStart + idx + 1}: ${line.substring(0, 200)}`)
          .join('\n');
        errors.push(`Sample lines around header (${sampleStart + 1}-${sampleEnd}):\n${sampleLines}`);
        
        // Also check if we can find any dates in the file
        const dateMatches = text.match(/\d{2}[-\/]\d{2}[-\/]\d{4}/g);
        if (dateMatches) {
          errors.push(`Found ${dateMatches.length} potential dates in PDF (first 5: ${dateMatches.slice(0, 5).join(', ')})`);
        } else {
          errors.push('No dates found in PDF file');
        }
      }
    } catch (error) {
      errors.push(`Error parsing Kotak PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return { transactions, errors: errors.length > 0 ? errors : undefined };
  }

  private splitTransactionLine(line: string): string[] {
    // Split by comma, but handle quoted values
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts;
  }

  private parseKotakDate(dateString: string): Date {
    // Format: "DD-MM-YYYY HH:mm:ss" or "DD-MM-YYYY" or "DD/MM/YYYY"
    // Try DD-MM-YYYY first
    let match = dateString.match(/(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
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
    
    // Try DD/MM/YYYY
    match = dateString.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
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
