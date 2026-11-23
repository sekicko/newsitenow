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
          status: 'pending' | 'completed' | 'declined';
          amount_usd: number;
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
    };
    Views: Record<string, never>;
    Functions: {
      marketpilot_payment_attach_request: {
        Args: { p_transaction_id: string; p_request_id: string };
        Returns: undefined;
      };
      marketpilot_payment_complete_deposit: {
        Args: {
          p_request_id: string;
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
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type PaymentAdminClient = SupabaseClient<PaymentAdminDatabase>;
