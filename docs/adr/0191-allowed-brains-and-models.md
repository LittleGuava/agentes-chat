# 0191. Allowed brains and models: a workspace's rule on what its agents think with

- Status: Accepted (2026-11-15; built: the rule, its checks on the server, the settings route, the web's settings card and picker. Not yet: the phone app's agent page and settings card.)
- Date: 2026-11-15
- Extends: ADR 0032 (brains), ADR 0007 (the Model Gateway), ADR 0085 (roles and permissions), ADR 0087 (OpenRouter), ADR 0146 (a workspace's own endpoint)

## Context

An agent's owner chooses what it thinks with: the API brain on a model of any provider the workspace has a key for, or a computer brain (Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, Copilot) on a computer. A team often can't allow all of them: a provider its contracts don't cover, a model too dear for everyday work, a CLI the company hasn't approved. Today an admin can only remove keys, which also takes them from the work that may use them, and nothing at all stops a computer brain.

## Decision

1. **One rule per workspace**, `organization_settings.allowed_brains` (jsonb, null: nothing restricted; migration `allowed_brains`). Its shape, `BrainPolicy` (`packages/engine/src/brain-policy.ts`):

   ```ts
   interface BrainPolicy {
     brains: BrainKind[] | null;    // the brains agents may think with; null: every brain
     providers: string[] | null;    // the API brain's providers (`PROVIDER_IDS`, `custom` and `openrouter` included); null: every provider
     models: string[] | null;       // the API brain's models (catalog, OpenRouter or endpoint ids); null: every model of an allowed provider
   }
   ```

   Every list restricts; none adds. A model is allowed when the API brain is (`brains` null or with `model`), its provider is, and it is listed (or `models` is null). An empty list is refused when saved (`brains: []` would leave agents nothing to think with: take the keys away instead), and so is a model whose provider the rule leaves out. The rule is read through `orgBrainPolicy` (cached per org, dropped by `updateOrgSettings`); the checks are pure functions (`brainAllowed`, `modelAllowed`, `brainPolicyRefusal`).

2. **Who sets it.** `GET`/`PATCH …/organizations/{orgId}/settings` carry it as `allowedBrains` (`BrainPolicy | null`; null lifts it). Changing it needs `configure`, as every workspace setting; reading it, `read`, since every member's picker explains it. Each change is audited (`organization.brain_policy_changed`, with before and after). Admins are not exempt: the rule is on the workspace, not on a person.

3. **The server is the source of truth.** Three checks, none of which a client can skip:
   - **The Model Gateway** (`gateway.stream`): an agent's model call outside the rule is refused before its key is read and anything reserved (`ValidationError` `brain.not_allowed`), so whatever path asked (a run, a stand-in, an approval's call) gets the same refusal, and nothing is billed.
   - **The executor** (`resolveBrain`): a computer brain outside the rule is `unavailable` with the code `not_allowed`, and the run fails at once with the rule's words. It never waits (nothing would end the wait) and never stands in on the API brain: a team that blocks a CLI didn't ask for its agents to answer on a paid key instead. This covers the agent's brain, a mission's and the right hand's, which all resolve there.
   - **Saving** (`setAgentBrain`, `setMissionBrain`): a choice outside the rule is refused (`brain.not_allowed`) whoever saves it. A choice saved before the rule stays as it is: tightening the rule never rewrites agents, it only stops their runs, and their page says why.

4. **Automático under the rule.** Automático is what a new agent thinks with, so a rule that broke it would break every default agent. Its line (`autoLine`) is the agent's key's provider, else the workspace's: when that provider isn't allowed, the newest live key of an allowed provider gives the line instead. On that line the tier's model is taken only when allowed, else the allowed model of that provider nearest the tier (`nearestTier`); with none, Automático has no model and the run fails with the rule's words, as for a fixed model.

5. **What the apps show.** The brain view (`GET …/agents/{id}/brain`) marks a brain outside the rule `available: false, reason: "not_allowed"`, and its `machines` carry the same, so "Quem pensa" shows it greyed with the reason, and the API's model rows outside the rule read "Not allowed in this workspace" and can't be picked (`modelChoices` with the rule). Settings › AI has a card for admins: the brains, the providers, and optionally the models of those providers.

## What stays out

- **The workspace's own calls** (`gateway.complete`: the router, summaries, reflection, the talker, the judge, Jev) are chosen by admins in their own settings, not by agents' owners, and keep working: the router chain falls back across providers by design (ADR 0074). Later: refuse a router or summary model outside the rule when it is saved.
- **Coding plans' makers.** `providers` and `models` restrict the API brain, billed per call. A computer brain is allowed or not as a whole: Claude Code on a DeepSeek coding plan is Claude Code. Later: a rule per plan (`planOf(account.provider)`).
- **Computer brains' models** (`opus`, a Codex model): later, as `brain:model` entries.
- **The phone app**: its new agent screen greys out the API models the rule leaves out (`modelChoices` with the rule) and a refused save shows the rule's words; the agent page's own rows and a settings card come later.
