# inline-ai Specification

## Purpose

Specifies the inline AI block in the markdown editor — the fence
language `ai`, the editor command that inserts it, the streaming
endpoint, the rate limit, and the system prompt.

## Requirements

### Requirement: The AI block is a fenced code block with language `ai`

The AI block is a Markdown fenced code block whose info string is `ai`.
The body is JSON of the form `{"configId": "…", "prompt": "…"}` —
`configId` identifies which provider / model from the user's settings,
`prompt` is the user's request to the model.

#### Scenario: An `ai` fence renders as the AI block, not a code block

- **WHEN** the buffer contains a ` ```ai ` fence with a JSON body
- **THEN** the rendered output is the AI block (textarea + Run / Stop),
  not a `<pre><code>` code block

#### Scenario: A non-`ai` language renders as a code block

- **WHEN** the buffer contains a fence whose info string is anything
  other than `ai` (e.g. `ts`, `bash`)
- **THEN** the rendered output is the standard code block

### Requirement: Space on an empty block inserts an AI fence

The slash command is one entry-point; the Space-on-empty-line gesture
is the other. The latter is the auto-insert that turns a blank line
into a ready-to-fill AI block.

#### Scenario: Space on an empty line inserts the fence

- **WHEN** the cursor is on an empty line and the user presses Space
- **THEN** the buffer gains:

  ````
  ```ai
  {"configId":"","prompt":""}

  ```
  ````

- **AND** the cursor is placed inside the JSON body for editing

### Requirement: The AI stream endpoint is `POST /api/ai/stream`

`/api/ai/stream` accepts the parsed JSON from the block, resolves the
config (and the API key, by config id) from the vault, calls the
provider, and streams the response token-by-token back to the client.

#### Scenario: A valid request streams text

- **WHEN** the client posts a valid `{ configId, prompt }` JSON
- **THEN** the response is `text/event-stream`
- **AND** the chunks arrive as `data: …\n\n` SSE frames
- **AND** the final frame is `data: [DONE]`

#### Scenario: A request without a matching config is rejected

- **WHEN** the client posts a `configId` that does not exist in the
  vault
- **THEN** the response is `400`
- **AND** the body is JSON with an `error` field
- **AND** no streaming starts

### Requirement: The rate limit caps the user at 10 requests per minute

The endpoint enforces 10 requests per minute per session, sliding
window. Excess requests get `429`.

#### Scenario: The 11th request in a minute is refused

- **WHEN** the user has made 10 successful AI requests in the last
  60 seconds
- **THEN** the 11th request returns `429`
- **AND** the response body explains the cap

### Requirement: The system prompt is "to the point only"

Every AI call carries a fixed system prompt that tells the model to be
terse and to skip any preamble ("Sure!", "Here is…", etc.). Users do
not see this prompt and cannot change it.

#### Scenario: The response is direct

- **WHEN** the user submits a request like `buatkan puisi`
- **THEN** the streamed response is a poem
- **AND** it does not start with a greeting, a confirmation, or any
  meta-text
