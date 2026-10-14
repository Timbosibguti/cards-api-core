import type { BankId } from '../transactions/types.js';

/** Совпадает с банками, у которых в адаптере реализован `blockCard`. */
export type SupportedCardBlockBank = BankId;

export type BlockCardResult =
  | { ok: true; bank: SupportedCardBlockBank; detail?: string; profile_name: string | null; buyer: string | null; }
  | {
      ok: false;
      error:
        | 'card_not_found'
        | 'unsupported_bank'
        | 'missing_ext_id'
        | 'provider_error';
      message: string;
    };
