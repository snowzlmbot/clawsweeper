# Exact-review publication starvation evidence

Captured from public ClawSweeper production surfaces on July 15, 2026, between
16:13 and 16:16 UTC.

## Live observations

- The public status endpoint reported 1,654 pending exact-review queue items,
  1 dispatching item, 24 leased items, and 39 nominally available review slots.
- The sole dispatching publication exposed a future `oldest_dispatching_at`
  value and the handoff was classified as `healthy`.
- Workflow run
  [29418496158](https://github.com/openclaw/clawsweeper/actions/runs/29418496158)
  had been waiting since 13:16 UTC. GitHub reported that its
  `Publish exact review artifact` job was waiting for 16 broad
  `Publish review artifacts` jobs in the shared concurrency group.
- The publication run corresponds to review generation run
  [29409874087](https://github.com/openclaw/clawsweeper/actions/runs/29409874087)
  for `openclaw/openclaw#107676`.

The screenshot in this directory captures the public GitHub Actions waiting
state. The live machine-readable status surface is:

<https://clawsweeper.openclaw.ai/api/status>

## Source-level reproduction

At upstream commit `98c8c4bdc613bd452e8c55ccb8bf1ec29907b8fd`:

- `.github/workflows/sweep.yml` assigns both exact and broad publishers to
  `clawsweeper-state-publisher` with an extended pending queue.
- `dashboard/worker.ts` admits only one exact publisher and gives an unclaimed
  publication dispatch a seven-day lease.
- `dashboard/exact-review-health.ts` derives dispatch age using the ordinary
  dispatch lease, so the seven-day publication lease produces a future phase
  start and a zero age.

No private logs, credentials, host details, or non-public repository data are
included in this evidence.
