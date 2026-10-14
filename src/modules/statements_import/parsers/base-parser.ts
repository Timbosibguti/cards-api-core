import { BankTransaction, ParseResult } from '../../../types/transaction.js';

export abstract class BaseParser {
  protected bankName: string;

  constructor(bankName: string) {
    this.bankName = bankName;
  }

  abstract parse(fileBuffer: Buffer, fileName: string): Promise<ParseResult>;

  protected createTransaction(
    date: Date,
    extId: string,
    amount: number,
    currency: string = 'INR',
    accountNumber?: string | null,
    affId?: number | null
  ): BankTransaction {
    return {
      created_at: date,
      bank: this.bankName,
      ext_id: extId,
      amount: amount,
      currency: currency,
      account_number: accountNumber || null,
      aff_id: affId || null,
    };
  }

  protected parseDate(dateString: string): Date {
    // Common date parsing logic
    // Format: DD-MM-YYYY HH:mm:ss or DD/MM/YYYY
    const cleaned = dateString.trim();
    const dateMatch = cleaned.match(/(\d{2})[-\/](\d{2})[-\/](\d{4})/);
    
    if (dateMatch) {
      const [, day, month, year] = dateMatch;
      return new Date(`${year}-${month}-${day}`);
    }
    
    return new Date(dateString);
  }

  protected parseAmount(amountString: string): number {
    // Remove commas, quotes, and parse
    const cleaned = amountString.replace(/,/g, '').replace(/"/g, '').trim();
    return parseFloat(cleaned) || 0;
  }
}

