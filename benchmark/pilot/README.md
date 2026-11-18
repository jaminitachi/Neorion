# Neorion pilot

The graph generator is Neorion at `e14a026badf54958e64ef4360402ba393766670a`. The held-out checkouts live under the sibling `bench-repos` directory. The pinned commits are recorded in `pilot.py`.

| Repository | Commit |
| --- | --- |
| vercel/ai-chatbot | `a8989b522fa3672a2ae52f053105e40993b36ca1` |
| mfts/papermark | `ed19717ec02a1ac79aecf5569159aa9d2d869312` |

From the Neorion root, with extension dependencies installed and both pinned checkouts present:

```sh
python3 benchmark/pilot/pilot.py verify
npm --prefix extension run compile
node extension/test/run.cjs ../bench-repos/ai-chatbot
node extension/test/run.cjs ../bench-repos/papermark
node benchmark/pilot/contexts.cjs
python3 benchmark/pilot/pilot.py run
python3 benchmark/pilot/pilot.py summary
```

The verifier recomputes each answer from tracked paths or source at the pinned commits and checks the frozen SHA-256. The CLI runner uses the logged-in Claude subscription, invokes Opus from an empty working directory with tools disabled, and sends prompts on stdin to accommodate the full Papermark graph. The matrix is shuffled with seed 20261119 and stops at the first CLI failure. The summary uses the reported CLI token counts, including cached input. The two complete tracked path lists are smaller than their graphs. Condition D measures the full plain listing at its available size, so B vs. D does not isolate context representation at equal token counts.
