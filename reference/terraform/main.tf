# =============================================================================
# IaC: New Relic alerting + AWS reporting pipeline for a single page.
# Providers: newrelic + aws. This is a reference skeleton — fill in vars,
# package the Lambda zip, and adjust ARNs/regions for your account.
# =============================================================================

terraform {
  required_providers {
    aws      = { source = "hashicorp/aws", version = "~> 5.0" }
    newrelic = { source = "newrelic/newrelic", version = "~> 3.0" }
  }
}

# Monitoring targets the fund-detail template at the URL pattern
#   /investments/{slug}-growth
# `page_name` is just a label for the New Relic resources; `url_pattern` is the
# NRQL LIKE pattern that pins every alert to those URLs.
variable "nr_account_id" { type = number }
variable "nr_api_key"    { type = string, sensitive = true }
variable "page_name"     { type = string, default = "investments-growth" }
variable "page_url"      { type = string, default = "https://app.bajajfinserv.in/investments/nippon-india-taiwan-equity-fund-g-growth" }
variable "url_pattern"   { type = string, default = "%/investments/%-growth%" }
variable "ses_from"      { type = string }
variable "recipients"    { type = string } # comma-separated

provider "aws" { region = "us-east-1" }
provider "newrelic" {
  account_id = var.nr_account_id
  api_key    = var.nr_api_key
  region     = "US"
}

# -----------------------------------------------------------------------------
# NEW RELIC: Synthetics monitor for the page
# -----------------------------------------------------------------------------
resource "newrelic_synthetics_monitor" "page" {
  name             = "${var.page_name}-page-monitor"
  type             = "SIMPLE"          # use SCRIPT_BROWSER for the functional check
  uri              = var.page_url
  period           = "EVERY_MINUTE"
  status           = "ENABLED"
  locations_public = ["AWS_US_EAST_1", "AWS_EU_WEST_1", "AWS_AP_SOUTH_1"]
}

# -----------------------------------------------------------------------------
# NEW RELIC: Alert policy + NRQL conditions (downtime + degradation)
# -----------------------------------------------------------------------------
resource "newrelic_alert_policy" "page" {
  name = "${var.page_name}-page-health"
}

# Downtime — multiple synthetic locations failing.
resource "newrelic_nrql_alert_condition" "downtime" {
  policy_id   = newrelic_alert_policy.page.id
  name        = "${var.page_name} downtime"
  type        = "static"
  nrql {
    query = "SELECT count(*) FROM SyntheticCheck WHERE monitorName = '${newrelic_synthetics_monitor.page.name}' AND result = 'FAILED'"
  }
  critical {
    operator              = "above_or_equals"
    threshold             = 2
    threshold_duration    = 120
    threshold_occurrences = "at_least_once"
  }
}

# Degradation — server p95 latency.
resource "newrelic_nrql_alert_condition" "slow_ssr" {
  policy_id = newrelic_alert_policy.page.id
  name      = "${var.page_name} slow SSR (p95)"
  type      = "static"
  nrql {
    query = "SELECT percentile(duration, 95) FROM Transaction WHERE request.uri LIKE '${var.url_pattern}'"
  }
  critical {
    operator              = "above"
    threshold             = 2000
    threshold_duration    = 300
    threshold_occurrences = "all"
  }
}

# Degradation — real-user LCP p75.
resource "newrelic_nrql_alert_condition" "slow_lcp" {
  policy_id = newrelic_alert_policy.page.id
  name      = "${var.page_name} slow LCP (p75)"
  type      = "static"
  nrql {
    query = "SELECT percentile(largestContentfulPaint, 75) FROM PageViewTiming WHERE pageUrl LIKE '${var.url_pattern}'"
  }
  critical {
    operator              = "above"
    threshold             = 2.5
    threshold_duration    = 600
    threshold_occurrences = "all"
  }
}

# -----------------------------------------------------------------------------
# NEW RELIC: Workflow -> Webhook destination (the Lambda Function URL)
# -----------------------------------------------------------------------------
resource "newrelic_notification_destination" "webhook" {
  name = "${var.page_name}-lambda-webhook"
  type = "WEBHOOK"
  property {
    key   = "url"
    value = aws_lambda_function_url.incident.function_url
  }
  # Custom header carrying the HMAC is set on the channel payload template.
}

resource "newrelic_notification_channel" "webhook" {
  name           = "${var.page_name}-webhook-channel"
  type           = "WEBHOOK"
  destination_id = newrelic_notification_destination.webhook.id
  product        = "IINT"
  property {
    key   = "payload"
    value = jsonencode({
      issueId  = "{{issueId}}"
      title    = "{{annotations.title.[0]}}"
      priority = "{{priority}}"
      state    = "{{state}}"
      issueUrl = "{{issuePageUrl}}"
    })
  }
}

resource "newrelic_workflow" "page" {
  name                  = "${var.page_name}-health-workflow"
  muting_rules_handling = "NOTIFY_ALL_ISSUES"
  issues_filter {
    name = "policy-filter"
    type = "FILTER"
    predicate {
      attribute = "labels.policyIds"
      operator  = "EXACTLY_MATCHES"
      values    = [newrelic_alert_policy.page.id]
    }
  }
  destination {
    channel_id = newrelic_notification_channel.webhook.id
  }
}

# -----------------------------------------------------------------------------
# AWS: secrets, Lambdas, Function URL, EventBridge schedule, DLQ
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "nr" { name = "${var.page_name}/page-monitor" }
resource "aws_secretsmanager_secret_version" "nr" {
  secret_id = aws_secretsmanager_secret.nr.id
  secret_string = jsonencode({
    NR_API_KEY          = var.nr_api_key
    WEBHOOK_HMAC_SECRET = "CHANGE_ME"
    SES_FROM            = var.ses_from
    ALERT_RECIPIENTS    = var.recipients
    DIGEST_RECIPIENTS   = var.recipients
  })
}

resource "aws_sqs_queue" "dlq" { name = "${var.page_name}-report-dlq" }

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals { type = "Service", identifiers = ["lambda.amazonaws.com"] }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.page_name}-report-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "perms" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.nr.arn]
  }
  statement {
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_role_policy" "perms" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.perms.json
}

locals {
  env = {
    SECRET_ARN         = aws_secretsmanager_secret.nr.arn
    NR_ACCOUNT_ID      = tostring(var.nr_account_id)
    # Single-page handlers pin their NRQL to this path; fleet handlers use PAGE_TYPE.
    MONITORED_PAGE_PATH = "/investments/nippon-india-taiwan-equity-fund-g-growth"
    PAGE_TYPE           = "mf-detail"
  }
}

# Build artifact: zip your compiled handlers (esbuild -> dist/) into report.zip.
resource "aws_lambda_function" "incident" {
  function_name    = "${var.page_name}-incident-report"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "incident-alert-email.lambda.handler"
  filename         = "report.zip"
  source_code_hash = filebase64sha256("report.zip")
  timeout          = 15
  environment { variables = local.env }
  dead_letter_config { target_arn = aws_sqs_queue.dlq.arn }
}

resource "aws_lambda_function_url" "incident" {
  function_name      = aws_lambda_function.incident.function_name
  authorization_type = "NONE" # HMAC verified in-code; use AWS_IAM if NR can sign SigV4
}

resource "aws_lambda_function" "digest" {
  function_name    = "${var.page_name}-scheduled-digest"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "single-page-daily-digest.lambda.handler"
  filename         = "report.zip"
  source_code_hash = filebase64sha256("report.zip")
  timeout          = 30
  environment {
    variables = merge(local.env, { DIGEST_PERIOD = "SINCE 1 day ago" })
  }
}

resource "aws_scheduler_schedule" "digest" {
  name                         = "${var.page_name}-daily-digest"
  schedule_expression          = "cron(0 9 * * ? *)" # 09:00 UTC daily
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.digest.arn
    role_arn = aws_iam_role.scheduler.arn
  }
}

resource "aws_iam_role" "scheduler" {
  name = "${var.page_name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = "sts:AssumeRole"
      Principal = { Service = "scheduler.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = "lambda:InvokeFunction"
      Resource = aws_lambda_function.digest.arn
    }]
  })
}

output "incident_webhook_url" {
  value = aws_lambda_function_url.incident.function_url
}
