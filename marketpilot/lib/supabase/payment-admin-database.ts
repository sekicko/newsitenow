import type { SupabaseClient } from '@supabase/supabase-js';

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type PaymentAdminDatabase = {
  public: {
    Tables: {
      marketpilot_transactions: {
        Row: {
          id: string;
          user_id: string;
          transaction_type: 'deposit' | 'withdrawal';
          status: 'pending' | 'completed' | 'declined' | 'failed';
          amount_usd: number;
          welcome_bonus_usd: number;
          amount_kes: number;
          phone_e164: string;
          reference: string;
          megapay_request_id: string | null;
          megapay_receipt: string | null;
          admin_receipt: string | null;
          created_at: string;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      marketpilot_wallets: {
        Row: {
          user_id: string;
          account_type: 'real' | 'demo';
          balance: number;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      marketpilot_practice_trades: {
        Row: {
          id: string;
          user_id: string;
          account_type: 'real' | 'demo';
          symbol: string;
          contract_type: string;
          barrier: number | null;
          duration: number;
          duration_unit: 't';
          stake: number;
          quoted_payout: number;
          entry_price: number;
          entry_pip_size: number;
          entry_digit: number;
          entry_epoch: number;
          elapsed: number;
          status: 'open' | 'won' | 'lost';
          exit_price: number | null;
          exit_pip_size: number | null;
          exit_digit: number | null;
          exit_epoch: number | null;
          payout: number;
          profit: number | null;
          created_at: string;
          outcome_source: string;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      marketpilot_payment_attach_request: {
        Args: { p_transaction_id: string; p_request_id: string };
        Returns: undefined;
      };
      marketpilot_payment_complete_deposit: {
        Args: {
          p_request_id: string | null;
          p_provider_transaction_id: string;
          p_receipt: string | null;
          p_amount_kes: number;
          p_msisdn: string;
          p_reference: string;
        };
        Returns: Json;
      };
      marketpilot_payment_mark_deposit_declined: {
        Args: { p_transaction_id: string; p_reason: string };
        Returns: undefined;
      };
      marketpilot_payment_mark_deposit_failed: {
        Args: { p_transaction_id: string; p_reason: string };
        Returns: undefined;
      };
      marketpilot_open_real_simulated_trade: {
        Args: {
          p_user_id: string;
          p_trade_id: string;
          p_symbol: string;
          p_contract_type: string;
          p_barrier: number | null;
          p_duration: number;
          p_stake: number;
          p_quoted_payout: number;
          p_entry_price: number;
          p_entry_pip_size: number;
          p_entry_digit: number;
          p_entry_epoch: number;
        };
        Returns: number;
      };
      marketpilot_settle_real_market_trade: {
        Args: {
          p_user_id: string;
          p_trade_id: string;
          p_exit_price: number;
          p_exit_pip_size: number;
          p_exit_digit: number;
          p_exit_epoch: number;
        };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type PaymentAdminClient = SupabaseClient<PaymentAdminDatabase>;
