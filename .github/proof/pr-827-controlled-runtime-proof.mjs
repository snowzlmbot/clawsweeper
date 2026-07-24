#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const baseUrl = String(process.env.PROOF_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const secret = String(process.env.PROOF_WEBHOOK_SECRET || "");
const subjectSha = String(process.env.PROOF_SUBJECT_SHA || "");
const output = path.resolve(
  process.env.PROOF_OUTPUT || ".artifacts/pr-827-controlled-runtime-proof/report.json",
);

assert.match(subjectSha, /^[0-9a-f]{40}$/i, "PROOF_SUBJECT_SHA must be an exact commit SHA");
assert.ok(secret, "PROOF_WEBHOOK_SECRET must be set");

const startedAt = new Date().toISOString();

function publicationPayload({ deliveryId, itemNumber, runId, sourceRevision = 1 }) {
  const targetRepo = "proof/runtime";
  const producerDecision = {
    targetRepo,
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  return {
    delivery_id: deliveryId,
    decision: {
      ...producerDecision,
      sourceAction: "exact_review_artifact_publish",
      publication: {
        artifactName: `exact-review-${runId}-1`,
        producerRunId: String(runId),
        producerRunAttempt: 1,
        sourceSha: "a".repeat(40),
        itemKey: `${targetRepo}#${itemNumber}`,
        protocolVersion: 2,
        leaseRevision: sourceRevision,
        claimGeneration: 1,
        liveProceeded: true,
        liveTerminalNoop: false,
        liveTerminalMissing: false,
        liveGuardedOpen: false,
        producerDecision,
      },
    },
  };
}

async function signedPost(pathname, payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
  const result = await response.json().catch(() => null);
  assert.ok(response.ok, `${pathname} returned ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function enqueue(options) {
  return signedPost("/internal/exact-review/enqueue", publicationPayload(options));
}

async function queueStats() {
  const response = await fetch(`${baseUrl}/api/exact-review-queue`, { cache: "no-store" });
  const result = await response.json().catch(() => null);
  assert.ok(response.ok, `queue stats returned ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function claim(claimId, leaseOwner) {
  const result = await signedPost("/internal/exact-review/publication-batches/claim", {
    claim_id: claimId,
    lease_owner: leaseOwner,
    max_items: 50,
  });
  assert.equal(result.claimed, true, `${claimId} did not claim a batch`);
  return result;
}

async function completeAsPublished(claimResult, leaseOwner) {
  const members = claimResult.batch.items;
  const result = await signedPost("/internal/exact-review/publication-batches/complete", {
    batch_id: claimResult.batch.batch_id,
    lease_owner: leaseOwner,
    items: members.map((member) => ({
      item_key: member.item_key,
      revision: member.revision,
      claim_generation: member.claim_generation,
      terminal_outcome: "published",
    })),
  });
  assert.equal(result.accepted, members.length, "controlled completion did not accept every member");
  return result;
}

function itemNumber(itemKey) {
  const match = itemKey.match(/#(\d+)@publish:/);
  assert.ok(match, `unexpected publication key: ${itemKey}`);
  return Number(match[1]);
}

const healthResponse = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
const health = await healthResponse.json();
assert.equal(health.ok, true, "local Worker health check failed");

for (let number = 1001; number <= 1008; number += 1) {
  await enqueue({
    deliveryId: `historical-${number}`,
    itemNumber: number,
    runId: 100_000 + number,
  });
}

// The controlled runtime shortens only the recency window from 15 minutes to
// the implementation's one-minute minimum. Production defaults remain covered
// by the exact-head configuration assertion in the normal CI suite.
await new Promise((resolve) => setTimeout(resolve, 61_000));

for (let number = 1090; number <= 1092; number += 1) {
  await enqueue({
    deliveryId: `fresh-${number}`,
    itemNumber: number,
    runId: 100_000 + number,
  });
}

const beforeClaim = await queueStats();
assert.deepEqual(beforeClaim.lanes.publication.batches.fresh_lane, {
  enabled: true,
  reserved_items: 2,
  max_age_seconds: 60,
  ready_items: 3,
  historical_ready_items: 8,
});

const first = await claim("pr-827-proof-first", "pr-827-proof-worker-1");
const firstNumbers = first.batch.items.map((member) => itemNumber(member.item_key));
const firstFresh = firstNumbers.filter((number) => number >= 1090);
const firstHistorical = firstNumbers.filter((number) => number < 1090);
assert.deepEqual(firstFresh, [1090, 1091], "fresh reservation did not provide two bounded slots");
assert.deepEqual(
  firstHistorical,
  [1001, 1002, 1003, 1004, 1005, 1006],
  "historical FIFO did not retain six batch positions",
);
await completeAsPublished(first, "pr-827-proof-worker-1");

const second = await claim("pr-827-proof-second", "pr-827-proof-worker-2");
const secondNumbers = second.batch.items.map((member) => itemNumber(member.item_key));
assert.deepEqual(
  new Set(secondNumbers),
  new Set([1092, 1007, 1008]),
  "unused capacity did not continue historical progress while serving remaining fresh work",
);
await completeAsPublished(second, "pr-827-proof-worker-2");

await enqueue({
  deliveryId: "drift-source-1",
  itemNumber: 1200,
  runId: 201_200,
  sourceRevision: 1,
});
const driftClaim = await claim("pr-827-proof-drift", "pr-827-proof-worker-3");
assert.equal(driftClaim.batch.items.length, 1);

await enqueue({
  deliveryId: "drift-source-2",
  itemNumber: 1200,
  runId: 201_201,
  sourceRevision: 2,
});
const driftFetch = await signedPost("/internal/exact-review/publication-batches/fetch", {
  batch_id: driftClaim.batch.batch_id,
  lease_owner: "pr-827-proof-worker-3",
});
assert.equal(driftFetch.superseded, 1, "source drift did not supersede the captured member");
assert.equal(driftFetch.items.length, 0, "source-drifted work escaped into preparation");
assert.equal(driftFetch.batch.items[0].terminal_outcome, "superseded");

const current = await claim("pr-827-proof-current", "pr-827-proof-worker-4");
assert.equal(itemNumber(current.batch.items[0].item_key), 1200);
await completeAsPublished(current, "pr-827-proof-worker-4");

const after = await queueStats();
assert.equal(after.lanes.publication.pending, 0);
assert.equal(after.lanes.publication.published_total, 12);
assert.equal(after.lanes.publication.superseded_total, 1);

const report = {
  schema_version: 1,
  passed: true,
  subject_sha: subjectSha,
  runtime: "wrangler-local-workerd-durable-object",
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  policy: {
    batch_size: 8,
    fresh_reserved_items: 2,
    proof_recency_window_seconds: 60,
    production_recency_window_seconds: 900,
  },
  evidence: {
    first_batch_item_numbers: firstNumbers,
    first_batch_fresh: firstFresh,
    first_batch_historical: firstHistorical,
    second_batch_item_numbers: secondNumbers,
    source_drift_terminal_outcome: driftFetch.batch.items[0].terminal_outcome,
    final_pending: after.lanes.publication.pending,
    controlled_published: after.lanes.publication.published_total,
    controlled_superseded: after.lanes.publication.superseded_total,
  },
  safety: {
    external_github_mutations: 0,
    production_queue_mutations: 0,
    local_ephemeral_storage_only: true,
  },
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
