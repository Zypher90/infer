# Infer - The AI Meeting Co-Pilot

A real-time multimodal agent that listens to a live meeting, transcribes it as it happens, extracts action items incrementally, and automatically creates tickets in Linear for high-confidence commitments — with a human-in-the-loop safety gate for anything ambiguous.

## The problem

Action items discussed in meetings routinely get lost — nobody writes them down consistently, and by the time someone does, details (who owns it, what the deadline was) have drifted. This project builds a pipeline that captures commitments the moment they're spoken, tracks them reliably as the conversation evolves, and turns clear ones into real tracked work automatically.

## Architecture

```
┌─────────────┐   audio chunks    ┌──────────────┐   audio stream   ┌───────────┐
│   Browser   │ ───────────────►  │  Node Server │ ───────────────► │ Deepgram  │
│ (mic capture│                   │   (relay)    │                  │  (STT)    │
│  + UI)      │ ◄───────────────  │              │ ◄─────────────── │           │
└─────────────┘  transcript/state └──────┬───────┘   live transcript └───────────┘
                                          │
                                          │ debounced final transcript
                                          ▼
                                  ┌───────────────┐
                                  │ Meeting State  │  incremental reconciliation
                                  │  (Gemini LLM)  │  (add / update / no-op)
                                  └───────┬───────┘
                                          │ new/updated action items
                                          ▼
                                  ┌───────────────┐
                                  │  Confidence    │  named owner + concrete task?
                                  │    Gate        │
                                  └───┬───────┬───┘
                                confident   uncertain
                                      │           │
                                      ▼           ▼
                              ┌──────────┐  ┌─────────────┐
                              │  Linear   │  │ Needs review │
                              │  (ticket) │  │  (UI only)   │
                              └──────────┘  └─────────────┘
```

**Data flow, end to end:**
1. Browser captures mic audio (`MediaRecorder`, 16kHz mono, 250ms chunks) and streams it over a WebSocket
2. Our Node server relays those chunks to Deepgram's streaming STT API over a second WebSocket, holding the API key server-side
3. Interim and final transcripts stream back through the same relay to the browser for live display
4. Final transcript segments are debounced (3s of silence) and batched, then sent to an LLM-based **state reconciliation** step
5. The reconciliation step updates a persistent meeting-state object — adding new action items or updating existing ones in place, rather than re-deriving the whole list from scratch each time
6. Each new/updated item is passed through a **confidence gate**: a focused LLM judgment on whether the owner and task are concrete enough to act on automatically
7. Confident items trigger a real Linear ticket via their GraphQL API; uncertain items surface in the UI for manual approval

## Key technical decisions

**Incremental state reconciliation instead of full-transcript reprocessing.** Re-sending the entire growing transcript on every update doesn't scale — cost and latency grow with meeting length, and re-deriving the item list from scratch repeatedly produces near-duplicate, drifting extractions. Instead, the LLM call receives only the *current compact state* plus the *new* transcript chunk, and is explicitly instructed to add, update, or no-op — the same shape as a reducer (`(state, action) => newState`), with the LLM performing the reduction.

**Confidence gating as a separate, focused step.** Extraction and "is this safe to act on automatically" are deliberately two different LLM calls rather than one combined judgment — asking a model to extract and self-assess reliability in a single pass is less reliable than separating concerns. The gating rule was tightened during development from a soft instruction ("be conservative") to an explicit binary condition (owner must be a specifically named person) after the evaluation harness caught a gating error — see Evaluation below.

**Debounced batching over per-segment processing.** Reconciling on every final transcript segment risks overlapping, out-of-order LLM calls during active speech. Debouncing (processing only after a pause in final segments) guarantees at most one reconciliation call in flight and naturally batches fragments into coherent chunks.

**A relay server, not direct browser-to-API connections.** The browser never talks to Deepgram directly — API keys stay server-side, and the relay pattern (client ↔ our server ↔ third-party service) is the same shape used for the Linear integration, keeping all secrets in one place.

**Batched evaluation calls.** The evaluation harness originally made one LLM call per extracted/ground-truth pair for matching, plus one per item for confidence judging — quickly hitting free-tier rate limits. Restructuring to one batched call per test case (matching the full extracted list against the full ground-truth list at once) cut the call count by roughly 4x with no loss of functionality.

## Evaluation

Rather than relying on manual spot-checks, correctness is measured against a hand-labeled test set covering four scenarios: a single clear item, a multi-item case including an in-place update, a deliberately vague item (owner unspecified), and a pure-discussion case with no action items at all (testing against hallucination). Since extracted text doesn't match ground truth word-for-word, matching is done via an LLM-based semantic comparison rather than string equality.

| Metric | Result |
|---|---|
| Precision | 100% |
| Recall | 100% |
| F1 | 100% |
| Confidence-gating accuracy | 75% → tightened prompt applied, pending re-verification |

The gating miss (a vague, unowned item nearly auto-ticketed) was traced to an underspecified prompt ("be conservative") rather than a model capability limit; replacing it with an explicit binary rule (owner must be a named person, full stop) is expected to close the gap — a concrete example of the harness doing its job: catching a real failure mode before it reached a live demo.

## Tech stack

- **Audio capture**: Browser `MediaRecorder` + `getUserMedia`
- **Streaming transcription**: Deepgram (`nova-2`, WebSocket streaming API)
- **LLM reasoning**: Google Gemini (`gemini-3.5-flash`), structured output via schema-constrained generation
- **Agent actions**: Linear GraphQL API (ticket creation)
- **Server**: Node.js, Express, `ws` (WebSocket relay)

## Setup

```bash
npm install
```

Create a `.env` file:
```
DEEPGRAM_API_KEY=your_key
GEMINI_API_KEY=your_key
LINEAR_API_KEY=your_key
LINEAR_TEAM_KEY=YOUR_TEAM_KEY
```

Run the server:
```bash
npm start
```

Open `public-stage2.html` in a browser, click **Start**, and speak naturally. Action items appear as they're extracted; confident ones create real Linear tickets automatically, others surface for manual review.

Run the evaluation harness independently:
```bash
node eval-test.js
```

## Roadmap / future work

- **Native platform integration** — a Zoom App using Realtime Media Streams (RTMS) would eliminate the need for users to actively use a separate interface, integrating directly into meetings already happening on Zoom
- **Self-hosted STT** (Whisper via `faster-whisper` or `whisper.cpp`) — removes per-minute transcription cost and external dependency, at the cost of owning streaming-latency tuning and hosting
- **Next.js frontend** — component-based UI, deployable, for a production-grade demo
- **Multi-tenant SaaS architecture** — user accounts, persistent meeting history in Postgres, per-org data isolation, usage-based billing, and horizontal scaling of WebSocket connections via a shared state layer (e.g. Redis pub/sub) across multiple server instances
