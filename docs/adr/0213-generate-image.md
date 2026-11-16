# 0213. `generate_image`: pictures for every brain, on the workspace's own key

- Status: Accepted (2026-11-15; built: providers, the Model Gateway, the tool, the run policy, the shared client's activity words). The providers' requests are checked against the OpenAI SDK's own types and a scripted transport; no picture has been made against a real provider yet (§8).
- Date: 2026-11-15
- Extends: ADR 0007 (Model Gateway), ADR 0012 (budget reservation and usage), ADR 0025 (files in the Drive), ADR 0032 §"The runner keeps a copy" (Codex's own image tool), ADR 0053 (who is behind a run), ADR 0141 (a person's monthly limit)

## Context

People ask agents for pictures: a cover, an illustration for a post, a mock-up, an icon. Only an agent on a Codex plan can make one today, with Codex's own image tool on the person's ChatGPT plan (ADR 0032). An agent on a model brain (Claude, GPT, Gemini through the API) or on any other computer brain can't, and says so. OpenAI's Images API makes pictures on an OpenAI key, and Google serves the same API for Gemini's image model on its OpenAI-compatible address, so one adapter covers both on keys workspaces already add for their agents.

A picture costs money with every call, and far more per call than most text: it must go through the gateway like a model call (held on the budget before, recorded after), and a run nobody watches must not spend on it because of something it read.

## Decision

### 1. Providers behind one interface (`packages/providers/src/images.ts`)

`ImageProvider.generate({ model, prompt, shape, signal }, key) → { bytes, contentType, model, inputTokens, outputTokens }`. Two adapters on the OpenAI Images API (`POST …/images/generations`, `n: 1`, base64 in the answer, never a link to fetch): `createOpenAIImages` (`api.openai.com/v1`, `quality: "medium"`, `output_format: "png"`) and `createGeminiImages` (`generativelanguage.googleapis.com/v1beta/openai`, `response_format: "b64_json"`, which OpenAI's GPT image models refuse). Shapes, not sizes: `square` 1024×1024, `portrait` 1024×1536, `landscape` 1536×1024. The bytes are checked where they arrive: a PNG, JPEG or WebP by their first bytes, at most 10 MB decoded (`imageFromBase64`); anything else is a `ProviderError` and is charged nothing. A refusal names the provider, its HTTP status and the model; the provider's own words go in `said` (masked like every provider's by the gateway). Tests use `createFakeImages` (`@agenteschat/providers/testing`), which makes a 1×1 PNG.

The model is the provider's, not a setting: `gpt-image-2` on OpenAI (gpt-image-1 was shut down on 2026-10-23) and `gemini-2.5-flash-image` on Gemini (`IMAGE_MODEL_OF`). Each has a price per picture by shape (`IMAGE_MODELS`, nano-USD), read on 2026-11-15: gpt-image-2 at `medium` $0.053 square and $0.041 portrait or landscape (OpenAI's image generation guide, its output cost table; the prompt's few text tokens are left out); gemini-2.5-flash-image $0.039 a picture up to 1024×1024 on the Standard tier (Google AI Studio's price page). That price is what the budget holds and what is recorded; the tokens a provider reports are recorded beside it, never priced.

### 2. Through the Model Gateway (`gateway.generateImage`, `gateway.imageProvider`)

Which provider: the first of `IMAGE_PROVIDERS` (OpenAI, then Gemini) the server has and the workspace holds a key of its own for (its default key of that provider, else its newest), read without decrypting anything so a listing can ask (`imageProvider`). Never the platform's key (`PlatformCredentials`): a picture is the workspace's spend, and on agentes.chat Cloud the platform would otherwise pay for it. The agent's own credential is not used either: it points at its text model's provider, which may be neither.

A call, in order: `assertCanWork` (a held or suspended workspace, a held agent); the person's limit (ADR 0141); a **slot** (§3); the picture's price **reserved** on the agent's month under the same row lock as a model call's reservation (`reserveAmount`, which shares `lockedPeriod` with `reserve`), `BudgetExceededError` when it doesn't fit, before any provider is asked; the provider, within two minutes (`IMAGE_TIMEOUT_MS`) and the run's own signal; then one statement records the `usage_records` row (`kind` `agent`, `provider`, `model`, `requested_model` the image model, `cost_nano_usd` the price), settles the reservation, adds to the agent's month and the person's (`settleCall`, which takes the requested model now), and the 80%/100% notices fire as for any call. A failure settles the reservation at 0 and gives the slot back: nothing is charged for a picture that didn't come. The reply's own usage line (`usageFor` in `messages.ts`) leaves picture rows out, as it leaves web searches out: it names the agent's model and its tokens, while the usage pages show the picture as a row of its own model.

### 3. Limits: a reply's and a day's, one slot each

`image_generations` (migration 0291): one row per picture asked for, `pending` → `done` or `failed`, with `org_id`, `agent_id`, `run_id`, provider, model and cost. A slot is taken under a transaction-scoped advisory lock per workspace (`images:<org>`) after counting, so calls the model makes at once can't all pass:

- **A reply** (`run_id`): at most `IMAGES_PER_RUN_MAX` = 4. A call without a run (a mission task's through the bridge) has only the day's limit.
- **A day** (the workspace's, whichever agent): at most `IMAGES_PER_DAY` (env, default 50; 0 turns image generation off on the server and takes the tool away) in the **last 24 hours**, as `uploadBytesPerDay` counts (ADR 0079), not since midnight in some time zone.

Pictures being made count. A slot `pending` for longer than the call's timeout plus a minute belongs to a process that died and no longer counts; a `failed` one never does. Past a limit the call is a `TooManyError` (`images.per_run`, `images.per_day`) and no provider is asked. The rows go with their workspace and their agent (foreign keys, cascade).

### 4. The tool (`packages/engine/src/image-tools.ts`)

`generate_image` (`prompt` up to 4000 characters, `shape`, `title`, `shared_drive`), scope `drive:write` (it saves a Drive file; listed on the agent's access page under the Drive). One tool source for every brain: the model loop lists it and the computer brains reach it through the runner's bridge like any of our tools, so an agent on Claude Code, Codex, Gemini or OpenCode makes pictures the same way. Listed only while `imageProvider` names one: an agent never spends a turn learning it can't.

The picture is saved with `createFileArtifact` (a `file`, untrusted, its width and height read from its header), placed with the run's conversation or, with `shared_drive`, in the workspace's Drive, and the result's `data.artifact` puts its card on the reply, as `upload_file`'s does. The model reads only that it was made and where; it is never shown the picture (it asked for it, and a picture's tokens would cost again). A picture made but not saved (a storage limit) says so, so the agent tells the person before making another.

The apps read it as Codex's image tool is read (ADR 0032): its activity is `creatingImage` ("making an image"), the live run draws the picture's place while it is made (`makingImage`), and its quiet line leaves the reply's tools block to the card.

### 5. Who may (ADR 0053, addendum 2026-11-15)

The run policy has a kind of its own, `paid`, read by name before the scope tables (its scope is the Drive's, whose writes a routine makes unasked): a person's run and the agent's own work (unattended, not fed by a routine) use it as any tool; a routine's run and a run a routine's reading feeds get `approve`, so a person's card comes before any provider is asked. That card is the permission: "Aprovar sempre", an agent set to "Nunca perguntar" (ADR 0173) and a routine's own job lift it as they lift any card. A widget's refresh never makes one. An agent that always asks asks for every picture.

## Consequences

- Every brain can make pictures on keys workspaces already have, and the spend is on the same budget, usage pages and person's limit as the agent's text.
- A routine that wants a weekly cover asks a person every week until someone approves it for good.
- A server with no OpenAI or Gemini key in a workspace shows no `generate_image` there: Anthropic-only workspaces gain nothing until they add one.
- The prices in §1 are a copy of the providers' price pages and must be checked before billing on them; a provider that changes its price is charged at the old one until the table is updated.
- Google deprecated gemini-2.5-flash-image (shut down on 2027-03-15, its page recommends Gemini 3.1 Flash Lite Image): `IMAGE_MODEL_OF.gemini` moves before then.

## Later

- A setting to pick the provider and model per workspace (and a backup provider when the first one says nothing started: no key, unreachable, 401, 402, 403, 429), OpenRouter's and xAI's image models, and a workspace's own endpoint (ADR 0146).
- The day's limit as a workspace limit the operator API sets (ADR 0079), next to storage and uploads, instead of one number for the server.
- Editing a picture or making variations from one in the Drive; transparent backgrounds.
- Codex's own image tool counting toward the reply's limit.

## Not verified

- No picture has been made against OpenAI or Google with this code: the request shapes are checked against the OpenAI SDK's types (7.33.0) and a scripted transport, and Google's OpenAI-compatible images address against its documentation as last read, including that it takes `size`.
- That gpt-image-2 takes `quality: "medium"` and `output_format: "png"` is read from OpenAI's guide and SDK types, not from a call.
