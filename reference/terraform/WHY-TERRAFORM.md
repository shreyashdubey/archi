# Why Terraform? (and what `main.tf` actually does)

Short answer: our monitoring isn't one thing in one place — it's **~15 resources split across
two different clouds (New Relic + AWS) that must reference each other by name and ARN**. Terraform
is the one tool that can create *both* in a single, reviewable, repeatable graph and wire them
together automatically. Doing it by hand in two web consoles is slow, error-prone, and impossible
to reproduce.

---

## 1. What we're actually provisioning

The daily-report architecture is not just "a Lambda". It's a chain that crosses providers:

```
NEW RELIC                                   AWS
─────────                                   ───
Synthetics monitor  ─┐
NRQL alert conditions├─► Workflow ─► Webhook ──► Lambda Function URL ─► Lambda (incident email)
Alert policy        ─┘                               ▲                        │
                                                     │                        ├─► SES
                          EventBridge cron ──────────┼──► Lambda (digest)     │
                                                     │                        └─► SQS DLQ
                          Secrets Manager (NR key) ──┘   IAM roles/policies
```

`main.tf` declares all of it:

| Provider | Resources in `main.tf` |
|----------|------------------------|
| **New Relic** | `newrelic_synthetics_monitor`, `newrelic_alert_policy`, 3× `newrelic_nrql_alert_condition` (downtime + slow SSR + slow LCP, all pinned to `var.url_pattern`), `newrelic_notification_destination`/`_channel`, `newrelic_workflow` |
| **AWS** | `aws_secretsmanager_secret(+version)`, `aws_sqs_queue` (DLQ), `aws_iam_role`/`_policy` (least-privilege), `aws_lambda_function` ×2, `aws_lambda_function_url`, `aws_scheduler_schedule` (cron) |

---

## 2. The core reason: it spans New Relic *and* AWS

This is the decisive point. The monitoring lives half in New Relic, half in AWS, **and the two
halves must agree**:

- The synthetic monitor's `name` must match the `monitorName` in the NRQL alert condition.
- The New Relic **webhook** must point at the **exact URL** of the AWS Lambda Function URL.
- The Lambda must read the New Relic API key from AWS Secrets Manager.

AWS-only tools (**CloudFormation, CDK, SAM, the Serverless Framework**) physically *cannot* create
New Relic resources. Terraform can, because it's **multi-provider** — `newrelic` and `aws` providers
in one configuration, one dependency graph. That's why Terraform specifically, not CDK/CFN.

Terraform also resolves the cross-cloud wiring for you. We literally write:

```hcl
resource "newrelic_notification_destination" "webhook" {
  property { key = "url", value = aws_lambda_function_url.incident.function_url }
}
```

Terraform sees that the New Relic webhook *depends on* the AWS Lambda URL, creates the Lambda first,
then feeds its real URL into New Relic — no copy-pasting an ARN between two browser tabs.

---

## 3. What Terraform buys us (vs clicking in consoles)

| Without IaC ("click-ops") | With Terraform |
|---------------------------|----------------|
| Set up ~15 resources by hand in 2 consoles | `terraform apply` builds them all |
| "Which prod alert thresholds are live?" → unknown | The `.tf` file *is* the source of truth, in git |
| Recreate for `uat` and `prod` → repeat by hand, drift | Re-apply with different `var` values |
| Change a threshold → hope you found every place | Edit one value, `plan` shows the exact diff |
| Tear down a POC → hunt for orphaned resources | `terraform destroy` removes everything |
| Someone edits an alert in the UI | `terraform plan` detects the drift |
| No review/audit of monitoring changes | Changes go through PR review like code |

In one line: **reproducible, reviewable, version-controlled, single source of truth, easy to
tear down** — across both clouds at once.

---

## 4. Parameterised for the URL pattern we monitor

Because monitoring targets `/investments/*-growth`, that lives in **one variable** and flows into
every alert condition:

```hcl
variable "url_pattern" { default = "%/investments/%-growth%" }
# used by the NRQL conditions:
#   ... FROM Transaction      WHERE request.uri LIKE '${var.url_pattern}'
#   ... FROM PageViewTiming   WHERE pageUrl    LIKE '${var.url_pattern}'
```

Change the pattern (or point at staging) by changing one value — not editing five alerts in a UI.

---

## 5. What Terraform does NOT do here

It provisions infrastructure; it doesn't run application logic:

- It **doesn't build/zip the Lambda code** — you compile the handlers (esbuild) into `report.zip`;
  Terraform just uploads and wires that artifact.
- It **doesn't run the crawler or send emails** — those are runtime (EventBridge triggers them).
- The **mock-app needs none of this** — it runs locally (`npm run dev/crawl/report`) with a
  file-based collector, precisely so you can see the whole pipeline without any cloud setup.
  Terraform is for the *real* deployment.

---

## 6. Could we use something else?

| Option | Fits here? |
|--------|-----------|
| **Terraform** | ✅ Manages New Relic **and** AWS in one graph — the reason we chose it. |
| CloudFormation / SAM / CDK | ❌ AWS-only; can't create New Relic monitors/alerts/workflows. |
| Pulumi | ✅ Also multi-provider (has a New Relic provider) — viable if you prefer real code (TS/Go) over HCL. |
| Serverless Framework | ⚠️ Great for the Lambda half, weak/none for the New Relic half. |
| Click-ops (web consoles) | ❌ Not reproducible, not reviewable, drifts immediately. |

Terraform wins because it's the simplest tool that owns the **whole** cross-cloud stack.

---

## 7. Day-to-day commands

```bash
cd reference/terraform
terraform init                              # download newrelic + aws providers
terraform plan  -var-file=prod.tfvars       # preview the exact changes
terraform apply -var-file=prod.tfvars       # create/update everything
terraform destroy -var-file=prod.tfvars     # tear it all down
```

`*.tfvars` carries the per-environment values (`nr_account_id`, `nr_api_key`, `url_pattern`,
`ses_from`, `recipients`), so the same `main.tf` deploys `uat` and `prod` from one definition.
