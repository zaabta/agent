# Custom Tool Registry API

All registry endpoints require a bearer token and the configured installation owner (`INSTALLATION_OWNER_USER_ID`). Agent execution can use enabled tools for authenticated accounts. These endpoints manage custom API integrations only; built-in Agent tools are not listed or modified.

Tools start disabled. They issue HTTP GET requests only. Credentials are AES-256-GCM encrypted at rest, omitted from API responses and prompts, and redacted from returned tool data if an upstream API echoes the credential.

## Create and update

~~~http
POST /api/agent/custom-tools
PUT /api/agent/custom-tools/{id}
Content-Type: application/json
~~~

Basic request:

~~~json
{
  "name": "weather_lookup",
  "description": "Get current weather for a city.",
  "endpoint": "https://api.example.com/v1/weather",
  "parameters": [
    { "name": "city", "type": "string", "required": true, "description": "City name", "queryParameter": "q" },
    { "name": "units", "type": "string", "required": false, "queryParameter": "units" }
  ]
}
~~~

`displayName` is optional and defaults to `name`. `parameters` supports up to 20 top-level `string`, `number`, `integer`, or `boolean` parameters. Each has a unique name, optional description, required flag, and optional query parameter name (defaults to the parameter name). The backend generates a strict input JSON Schema and query mapping. Model-generated arguments are validated against that schema before the request; they cannot change the configured host, path, method, or headers.

Advanced schema request fields remain supported for existing clients. Use `inputSchema` with `queryMappings` instead of `parameters`; supplying both forms is rejected. `outputSchema` is optional. When omitted, the endpoint may return any JSON object within the response cap; when supplied, the response must match the restricted JSON Schema. Schemas must use root type `object`, support at most 8 levels and 40 properties per object, and reject `$ref`, patterns, combinators, and executable keywords.

Optional authentication:

~~~json
{
  "auth": {
    "headerName": "X-API-Key",
    "secret": "write-only credential"
  }
}
~~~

`auth.headerName` accepts `Authorization` or `X-API-Key`; `prefix` is optional. Omit `auth` to disable authentication. On update, omit `auth` to remove it; provide `auth` with a new secret to rotate; or provide the saved header/prefix without a secret to preserve the credential. A saved secret is never returned.

Advanced safety limits accept `timeoutMs` from 500 to 30000 and `maxResponseBytes` from 256 to 1000000. Defaults are 10000 and 65536.

Create returns the detail shape with `enabled:false`. The response includes `endpoint`, normalized `parameters`, schemas, limits, and `authSecretConfigured`; it never includes the credential or ciphertext. `configurationVersion` increments on edits and enable/disable so plans based on stale configurations are rejected.

## Endpoint and SSRF policy

New tools use a full HTTPS URL. Embedded username/password, query, fragment, path escapes, dot-segment paths, metadata hostnames, and non-HTTPS protocols are rejected. At registration and enablement, DNS is resolved and every returned IPv4/IPv6 address must be globally routable. At execution, DNS is resolved again, all results are checked, and the HTTP connection is pinned to a validated address while TLS verification uses the configured hostname. Redirect responses are rejected. Requests have a timeout and bounded response body. DNS failures and non-public results fail closed.

Existing profile/path tools remain executable for compatibility. `CUSTOM_TOOL_CONNECTION_PROFILES` and `GET /api/agent/custom-tools/connections` remain available to existing records and clients; new tools do not require a profile. The prior `allowed_result_sources` database column is retained for existing data, but it is no longer accepted or returned by the API, included in Planner context, or used during execution.

## List, detail, enable, disable, delete

~~~http
GET    /api/agent/custom-tools
GET    /api/agent/custom-tools/{id}
PATCH  /api/agent/custom-tools/{id}/enabled
DELETE /api/agent/custom-tools/{id}
~~~

The list is newest-first and contains custom records only; an empty registry returns `[]`. Detail returns 404 for archived or unknown IDs. Enable body:

~~~json
{ "enabled": true }
~~~

Enablement rechecks the endpoint policy. Execution rechecks enabled state and configuration version. Delete is a soft archive that disables the tool, removes its credential, and preserves execution history.

## Test execution and logs

~~~http
POST /api/agent/custom-tools/{id}/test
GET  /api/agent/custom-tools/{id}/executions?limit=50&offset=0
~~~

Test body: `{ "sampleInput": { "city": "Istanbul" } }`. Tests can run while disabled and use the same request, SSRF, schema, timeout, and response-size policies as Agent execution. The response is sanitized and bounded. Execution history contains metadata only: tool/version IDs, request/conversation/user IDs, duration, success, safe error category, test flag, and timestamp. It never stores arguments, response bodies, URLs, or credentials. `limit` is clamped to 1–100.

## Planner behavior

For each workflow request, the Planner receives a bounded catalog of enabled, non-archived custom tools, including name, description, and input schema. It can select one using a dedicated `custom_tool` operation. The runtime checks the selected ID against that request's catalog and the executor rechecks enabled state, configuration version, and arguments. A custom call receives only its schema-validated arguments; built-in results, previous tool outputs, documents, spreadsheets, and conversation history are never forwarded to it. Custom tools are not chained with built-in operations.

## Common error categories

Validation errors return HTTP 400 (`INVALID_TOOL_NAME`, `INVALID_ENDPOINT`, `ADDRESS_NOT_ALLOWED`, `INVALID_PARAMETERS`, `INVALID_PARAMETER`, `INVALID_QUERY_PARAMETER`, `INVALID_SCHEMA`, `INVALID_ARGUMENTS`, `INVALID_TIMEOUT`, `INVALID_RESPONSE_LIMIT`). Duplicate names return 409 `TOOL_NAME_EXISTS`; missing/archived IDs return 404 `CUSTOM_TOOL_NOT_FOUND`; non-owner access returns 403 `INSTALLATION_OWNER_REQUIRED`; missing owner configuration returns 503 `INSTALLATION_OWNER_NOT_CONFIGURED`. Safe runtime categories include `DNS_FAILURE`, `ADDRESS_NOT_ALLOWED`, `REDIRECT_REJECTED`, `TIMEOUT`, `RESPONSE_TOO_LARGE`, `OUTPUT_SCHEMA_MISMATCH`, and `HTTP_STATUS`; response bodies and upstream error details are not returned in execution logs.
