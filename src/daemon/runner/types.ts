/**
 * Shared event shape emitted by the runner sub-modules and consumed by
 * the SSE multiplex in daemon/index.ts. Kept here (not in agents/types)
 * so doer/reviewer/runner can import without the circular runner.ts
 * dependency we'd hit if RunnerEvent stayed in the entry file.
 */
export interface RunnerEvent {
  chatId: string;
  type:
    | 'phase_start'
    | 'phase_progress'
    | 'phase_done'
    | 'phase_failed'
    | 'cli_error'
    | 'cli_warning'
    | 'chat_done'
    /**
     * Emitted by doer/reviewer runners immediately after `message_done`
     * is processed and `## DONE` has been written to answer.md. The
     * cockpit listens for this to flip the participant card from
     * "WORKING" to "DONE" without waiting for the next polling tick.
     * Without this signal, a card whose answer.md is fully on-disk with
     * `## DONE` still rendered as WORKING for up to 8 seconds.
     */
    | 'participant_done'
    /**
     * Emitted by the chat-gate while a chat is waiting for admission
     * (cap hit, low swap, high load). Payload carries `reason`
     * (chats_at_cap | swap_low | load_high), `position` (1-indexed
     * queue slot), and a human-readable `message`. Re-fires whenever
     * the gate's state changes (another waiter joins, recheck fires).
     * Cockpit renders "Queued — N chats ahead" or similar.
     */
    | 'chat_queued';
  payload: Record<string, unknown>;
  ts: number;
}
