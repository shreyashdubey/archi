# reference/preview — daily fleet email

The two static mock emails that used to live here (`email-preview-tables.html` and
`email-preview-with-graphs.html`) have been **consolidated into a single email**,
generated from real telemetry by the mock app.

To see the consolidated email — email-client chrome + coverage banner + SVG graphs
+ all tables (summary, component health, slowest pages, render failures, API, CTA)
+ the per-page matrix + a **Download fleet.csv** button:

```bash
cd ../../mock-app
npm run generate-report   # writes preview/daily-report.html + preview/fleet.csv, then opens it
```

In production this same layout is rendered and emailed by the reporting Lambda
(`reference/lambda/*`, via `wrapEmail()` + `tableHtml()` in
`report-shared.ts`), with the charts as PNGs (`rich-email-builder.ts`)
and the CSV as a real SES attachment.
