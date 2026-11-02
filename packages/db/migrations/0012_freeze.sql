-- The freeze for the move (docs/multi-user.md 8.2), enforced by the database itself: while move_state.phase is
-- 'frozen' or 'moved', every write to every table aborts, so no write can land after the copy starts and none is
-- lost. 'none' (today) and 'restoring' (the way back) allow writes. Each trigger costs one extra row read per row
-- written. move_state and move_queue are exempt: move_queue holds what arrives during a freeze (Plaid webhooks, a
-- finished link) for the new databases to replay.
CREATE TABLE move_queue (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER freeze_account_ins BEFORE INSERT ON account WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_account_upd BEFORE UPDATE ON account WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_account_del BEFORE DELETE ON account WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_account_month_total_ins BEFORE INSERT ON account_month_total WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_account_month_total_upd BEFORE UPDATE ON account_month_total WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_account_month_total_del BEFORE DELETE ON account_month_total WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_alert_ins BEFORE INSERT ON alert WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_alert_upd BEFORE UPDATE ON alert WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_alert_del BEFORE DELETE ON alert WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_apply_counter_ins BEFORE INSERT ON apply_counter WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_apply_counter_upd BEFORE UPDATE ON apply_counter WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_apply_counter_del BEFORE DELETE ON apply_counter WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_assignment_ins BEFORE INSERT ON assignment WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_assignment_upd BEFORE UPDATE ON assignment WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_assignment_del BEFORE DELETE ON assignment WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_audit_log_ins BEFORE INSERT ON audit_log WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_audit_log_upd BEFORE UPDATE ON audit_log WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_audit_log_del BEFORE DELETE ON audit_log WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_auth_challenge_ins BEFORE INSERT ON auth_challenge WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_auth_challenge_upd BEFORE UPDATE ON auth_challenge WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_auth_challenge_del BEFORE DELETE ON auth_challenge WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_auth_session_ins BEFORE INSERT ON auth_session WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_auth_session_upd BEFORE UPDATE ON auth_session WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_auth_session_del BEFORE DELETE ON auth_session WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_event_ins BEFORE INSERT ON bank_event WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_event_upd BEFORE UPDATE ON bank_event WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_event_del BEFORE DELETE ON bank_event WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_page_ins BEFORE INSERT ON bank_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_page_upd BEFORE UPDATE ON bank_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_page_del BEFORE DELETE ON bank_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_txn_ins BEFORE INSERT ON bank_txn WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_txn_upd BEFORE UPDATE ON bank_txn WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_bank_txn_del BEFORE DELETE ON bank_txn WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_ins BEFORE INSERT ON budget WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_upd BEFORE UPDATE ON budget WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_del BEFORE DELETE ON budget WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_line_ins BEFORE INSERT ON budget_line WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_line_upd BEFORE UPDATE ON budget_line WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_line_del BEFORE DELETE ON budget_line WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_member_ins BEFORE INSERT ON budget_member WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_member_upd BEFORE UPDATE ON budget_member WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_budget_member_del BEFORE DELETE ON budget_member WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_category_ins BEFORE INSERT ON category WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_category_upd BEFORE UPDATE ON category WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_category_del BEFORE DELETE ON category WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_category_group_ins BEFORE INSERT ON category_group WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_category_group_upd BEFORE UPDATE ON category_group WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_category_group_del BEFORE DELETE ON category_group WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_connection_ins BEFORE INSERT ON connection WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_connection_upd BEFORE UPDATE ON connection WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_connection_del BEFORE DELETE ON connection WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_device_link_ins BEFORE INSERT ON device_link WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_device_link_upd BEFORE UPDATE ON device_link WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_device_link_del BEFORE DELETE ON device_link WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_expected_reimbursement_ins BEFORE INSERT ON expected_reimbursement WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_expected_reimbursement_upd BEFORE UPDATE ON expected_reimbursement WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_expected_reimbursement_del BEFORE DELETE ON expected_reimbursement WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_health_status_ins BEFORE INSERT ON health_status WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_health_status_upd BEFORE UPDATE ON health_status WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_health_status_del BEFORE DELETE ON health_status WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_holding_snapshot_ins BEFORE INSERT ON holding_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_holding_snapshot_upd BEFORE UPDATE ON holding_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_holding_snapshot_del BEFORE DELETE ON holding_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_lease_guard_ins BEFORE INSERT ON lease_guard WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_lease_guard_upd BEFORE UPDATE ON lease_guard WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_lease_guard_del BEFORE DELETE ON lease_guard WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_liability_snapshot_ins BEFORE INSERT ON liability_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_liability_snapshot_upd BEFORE UPDATE ON liability_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_liability_snapshot_del BEFORE DELETE ON liability_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_manual_pending_ins BEFORE INSERT ON manual_pending WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_manual_pending_upd BEFORE UPDATE ON manual_pending WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_manual_pending_del BEFORE DELETE ON manual_pending WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_month_snapshot_ins BEFORE INSERT ON month_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_month_snapshot_upd BEFORE UPDATE ON month_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_month_snapshot_del BEFORE DELETE ON month_snapshot WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_month_total_done_ins BEFORE INSERT ON month_total_done WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_month_total_done_upd BEFORE UPDATE ON month_total_done WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_month_total_done_del BEFORE DELETE ON month_total_done WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_passkey_ins BEFORE INSERT ON passkey WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_passkey_upd BEFORE UPDATE ON passkey WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_passkey_del BEFORE DELETE ON passkey WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_payee_ins BEFORE INSERT ON payee WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_payee_upd BEFORE UPDATE ON payee WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_payee_del BEFORE DELETE ON payee WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_payee_alias_ins BEFORE INSERT ON payee_alias WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_payee_alias_upd BEFORE UPDATE ON payee_alias WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_payee_alias_del BEFORE DELETE ON payee_alias WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_provider_account_ins BEFORE INSERT ON provider_account WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_provider_account_upd BEFORE UPDATE ON provider_account WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_provider_account_del BEFORE DELETE ON provider_account WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_raw_page_ins BEFORE INSERT ON raw_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_raw_page_upd BEFORE UPDATE ON raw_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_raw_page_del BEFORE DELETE ON raw_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_rule_ins BEFORE INSERT ON rule WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_rule_upd BEFORE UPDATE ON rule WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_rule_del BEFORE DELETE ON rule WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_setting_ins BEFORE INSERT ON setting WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_setting_upd BEFORE UPDATE ON setting WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_setting_del BEFORE DELETE ON setting WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_sync_page_ins BEFORE INSERT ON sync_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_sync_page_upd BEFORE UPDATE ON sync_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_sync_page_del BEFORE DELETE ON sync_page WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_sync_run_ins BEFORE INSERT ON sync_run WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_sync_run_upd BEFORE UPDATE ON sync_run WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_sync_run_del BEFORE DELETE ON sync_run WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_target_ins BEFORE INSERT ON target WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_target_upd BEFORE UPDATE ON target WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_target_del BEFORE DELETE ON target WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_link_ins BEFORE INSERT ON txn_link WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_link_upd BEFORE UPDATE ON txn_link WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_link_del BEFORE DELETE ON txn_link WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_overlay_ins BEFORE INSERT ON txn_overlay WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_overlay_upd BEFORE UPDATE ON txn_overlay WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_overlay_del BEFORE DELETE ON txn_overlay WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_split_ins BEFORE INSERT ON txn_split WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_split_upd BEFORE UPDATE ON txn_split WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_txn_split_del BEFORE DELETE ON txn_split WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_daily_ins BEFORE INSERT ON usage_daily WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_daily_upd BEFORE UPDATE ON usage_daily WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_daily_del BEFORE DELETE ON usage_daily WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_day_ins BEFORE INSERT ON usage_day WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_day_upd BEFORE UPDATE ON usage_day WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_day_del BEFORE DELETE ON usage_day WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_event_ins BEFORE INSERT ON usage_event WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_event_upd BEFORE UPDATE ON usage_event WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_event_del BEFORE DELETE ON usage_event WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_note_ins BEFORE INSERT ON usage_note WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_note_upd BEFORE UPDATE ON usage_note WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_usage_note_del BEFORE DELETE ON usage_note WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_user_ins BEFORE INSERT ON user WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_user_upd BEFORE UPDATE ON user WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;
CREATE TRIGGER freeze_user_del BEFORE DELETE ON user WHEN (SELECT phase FROM move_state WHERE id = 1) IN ('frozen', 'moved')
BEGIN SELECT RAISE(ABORT, 'frozen'); END;

-- Raw bank data stays append-only, except while the way back rewrites D1 from the new databases (8.6).
DROP TRIGGER bank_event_no_delete;
CREATE TRIGGER bank_event_no_delete BEFORE DELETE ON bank_event WHEN (SELECT phase FROM move_state WHERE id = 1) != 'restoring'
BEGIN SELECT RAISE(ABORT, 'bank_event is append-only'); END;
DROP TRIGGER bank_page_no_delete;
CREATE TRIGGER bank_page_no_delete BEFORE DELETE ON bank_page WHEN (SELECT phase FROM move_state WHERE id = 1) != 'restoring'
BEGIN SELECT RAISE(ABORT, 'bank_page is append-only'); END;
DROP TRIGGER raw_page_no_delete;
CREATE TRIGGER raw_page_no_delete BEFORE DELETE ON raw_page WHEN (SELECT phase FROM move_state WHERE id = 1) != 'restoring'
BEGIN SELECT RAISE(ABORT, 'raw_page is append-only'); END;
