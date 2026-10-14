export const BANK_IDS = ['adscards', 'ecards', 'multicards', 'stellarcards'] as const;

export type BankId = (typeof BANK_IDS)[number];


