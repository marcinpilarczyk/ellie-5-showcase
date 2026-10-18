export type ActionState =
  | 'STAGED'
  | 'APPROVED'
  | 'EXECUTING'
  | 'PROVIDER_CONFIRMED'
  | 'VERIFIED'
  | 'DENIED'
  | 'FAILED_SAFE'
  | 'RECONCILIATION_REQUIRED';

export interface ActionLedgerRecord {
  id: string;
  action_type: string;
  payload_json: string;
  payload_hash: string;
  state: ActionState;
  created_at: string;
  updated_at: string;
  expires_at: string;
  approved_at?: string | null;
  executed_at?: string | null;
  verified_at?: string | null;
  origin_run_id?: string | null;
  slack_channel?: string | null;
  slack_thread_ts?: string | null;
  slack_card_ts?: string | null;
  batch_id?: string | null;
  last_error?: string | null;
  execution_attempts: number;
  idempotency_key?: string | null;
}

export interface ActionLedgerEvent {
  id: number;
  action_id: string;
  from_state: ActionState;
  to_state: ActionState;
  actor: string;
  reason?: string | null;
  event_data?: string | null;
  created_at: string;
}

export interface StageProposalInput {
  actionId?: string;
  actionType: string;
  payload: Record<string, any>;
  originRunId?: string;
  slackChannel?: string;
  slackThreadTs?: string;
  batchId?: string;
  expiryMinutes?: number;
}
