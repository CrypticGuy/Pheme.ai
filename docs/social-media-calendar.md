# Pheme Social Media Calendar (4 weeks, draft for review)

**Goal:** share insight into why human sign-off matters for AI agents, and share the plan for Pheme as it moves from early preview to wider use.
**Channels:** LinkedIn (primary), X (short form), GitHub Discussions (build log).
**Cadence:** 3 posts per week (Mon / Wed / Fri). Weeks alternate between insight and plan.
**Voice:** plain, specific, honest about the early-preview status. No hype.

## Week 1: The problem (insight)
| Day | Channel | Post | Format |
|---|---|---|---|
| Mon | LinkedIn, X | Agents write plans, migrations and PRs faster than people can read them. The bottleneck is now the decision, not the work. | Short text post |
| Wed | LinkedIn | "Who actually signed off?" How screenshots and copy-paste make approvals unclear. | Carousel (3 slides) |
| Fri | X | Poll: how does your team hand agent output to a human today? | Poll |

## Week 2: The principle (insight)
| Day | Channel | Post | Format |
|---|---|---|---|
| Mon | LinkedIn, X | "No agent can approve." Why there is no tool the model can call to record a verdict. | Text + diagram |
| Wed | LinkedIn | Fails closed: if a form can't be shown, Pheme refuses instead of accepting "type approve in chat." | Short text |
| Fri | X | Review text is untrusted data, never instructions. A one-line prompt-injection example. | Thread (3 posts) |

## Week 3: The product (plan)
| Day | Channel | Post | Format |
|---|---|---|---|
| Mon | LinkedIn, X | Demo: ask Claude for feedback from a teammate, they pick approve / request changes / comment in a form, the answer comes back with their name. | 45s screen recording |
| Wed | GitHub Discussions | Quick start: `pheme join`, `pheme connect`, `claude-pheme` in five minutes. | Walkthrough |
| Fri | X | Architecture in one image: local bridge, outbound HTTPS only, Supabase Edge Function. | Sequence diagram |

## Week 4: The roadmap (plan)
| Day | Channel | Post | Format |
|---|---|---|---|
| Mon | LinkedIn | Honest limits: research-preview Channels, small-team scale, not a permission system. | Text |
| Wed | GitHub Discussions | Roadmap: pagination, retention, rate limiting. Ask for feedback. | Discussion post |
| Fri | LinkedIn, X | Call for early testers: small teams who want to try human-in-the-loop reviews. | Text + link |

## Measures
Link clicks to the repo, GitHub stars and clones, testers who complete `pheme join`, replies to the Week 1 poll.

## Open questions for review
1. Are LinkedIn, X and GitHub Discussions the right channels?
2. Is 3 posts per week sustainable?
3. Is the "early preview, honest limits" tone right for launch?
4. Any claims here you'd want checked before we post?
