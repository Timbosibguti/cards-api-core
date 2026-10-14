export interface BankTransaction {
  created_at: Date;
  bank: string;
  ext_id: string;
  amount: number;
  currency: string;
  account_number?: string | null;
  aff_id?: number | null;
}

export interface ParseResult {
  transactions: BankTransaction[];
  errors?: string[];
}

