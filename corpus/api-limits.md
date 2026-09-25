---
id: api-limits
version: 1
effective_date: 2025-01-01
superseded_by: null
access: public
---
# API Rate Limits

The public API allows 100 requests per minute on the Starter plan and 1,000 requests per minute on the Pro plan. Enterprise API limits are set per contract. Requests over the rate limit receive HTTP status 429 with a Retry-After header. API keys can be rotated from the Developer settings page.
