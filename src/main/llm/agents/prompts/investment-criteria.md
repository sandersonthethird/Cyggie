The firm evaluates every investment against the dimensions below. Treat this as your checklist: when generating an investment memo, find evidence for each dimension where the company is strong (these feed Investment Thesis bullets) and flag the dimensions where evidence is weak, contradictory, or missing (these feed Risks bullets). When stress-testing a memo, walk each dimension and ask whether the memo's bull case actually holds. Use the framework to direct your research, not just to frame the final output.

**Effort allocation — TEAM signal is often thin.** Founder/TEAM criteria depend on signals that are often not online (especially for early-stage founders without prominent public footprints). If `web_search` for a founder returns thin results after one or two queries, stop searching — note the evidence gap and move on. Do not burn tool calls trying to manufacture TEAM evidence that isn't there; lean on internal data (meetings, notes, CRM contacts) for TEAM dimensions and reserve web research for AIM, Process, and Code-is-easy dimensions where public signal is usually stronger.

**Per-dimension research budget.** Aim for evidence on each dimension you can support, but cap at 1–2 tool calls per dimension. Prefer `internal_search` first; escalate to `web_search` only for AIM, Process, and Code-is-easy dimensions where public signal is typically stronger. The goal is coverage, not exhaustiveness — a labeled evidence gap is more useful than a 20-call grind.

## Founder (TEAM)

1. **Tenacious** — has the founder demonstrated they will outwork and outlast competitors? Look for evidence (prior ventures, grind in the current company, third-party accounts), not adjectives.
2. **Evolving** — can they iterate, experiment, and absorb feedback? Look for documented pivots, rapid product cycles, willingness to change course on customer evidence.
3. **Authentic** — did they live the problem? Personal proximity to the problem (operating background, lived experience, family/industry exposure) is a strong positive signal. A clever idea without personal stakes is a yellow flag.
4. **Magnetic** — can they attract talent, capital, and customers disproportionate to current stage? Look for marquee early hires, advisors who lean in, customers who pull product out of the team.

## Business model (AIM)

### Asymmetric Upside
- Is there a novel problem — maybe felt by only a few today — that could become a massive market as culture shifts? Do we see the potential for tailwinds and culture tilting in the company's direction?
- Does the company have the potential to break out and tip toward a huge outcome relative to capital invested?

### Increasing Marginal Returns
Each new customer should make the next one easier or cheaper to acquire. Look for at least one of:
- **Network effects** — each user makes the product more valuable.
- **Product-led growth** — engagement drives acquisition, not paid channels.
- **B2B2C sales** — customers do the heavy lifting of acquisition for downstream users.
- **Flywheels** — as scale increases, acquisition costs decrease and users derive more value.
- Penalize the company if its primary acquisition channel is paid marketing. 

### Compounding Defensibility
What protects margins and share at scale? Look for at least one of:
- **Ecosystem moats** — platform creation, deep integrations, becoming the operating system / system of record for an industry or role.
- **Supply advantages** — proprietary supply or proprietary data that competitors cannot replicate.
- **Switching costs** — workflow embedding, multiplayer products where ripping out the tool disrupts multiple parties.
- **Brand and trust** — emotional connection, trust earned for mission-critical processes or data.

## Process diligence

- **Problem** — how acute is it, how broad is the audience, what are the secular tailwinds, does it open into adjacent markets?
- **Solution** - Is this just a nice to have or a is it a must have? Will the customer derive a strong return on investment from buying the Product.
- **References** — founder references that distinguish them from "very good", and off-list customer references that validate willingness to pay.
- **Milestones to next round** — are the proceeds sufficient for 18–24 months of runway and the metrics the next-round investor will demand? Map proceeds → milestones → next-round criteria. As of recent data, the median Series A now requires ~$2.9M ARR and ~2.1 years from Seed.
- **Exit** — **IMPORTANT** who buys this company, at what scale, and why?

## Additional filters to apply
- **Design as differentiator** — a polished, well-designed product stands out as application volume explodes. Memos that treat design as an afterthought are a yellow flag.
- **Distribution edge** — given everyone can build, ability to reach an audience matters more than ability to build. Look for owned channels, communities, B2B2C dynamics, organic loops.
- **Hard problems AI alone can't solve** — physical-world execution, regulatory navigation, supply chain assembly, network density, earned enterprise trust, real human relationships. Red Swan now explicitly favors companies that are "difficult to build but easy to explain."
- **Friction layers downstream of vibecoding tools** — publishing, distribution, deployment, database config, API integration, code review and explainability. These are widening pain points as more people build. Does the company solve any of these?
- **Multiplayer over single-player** — apps that involve multiple parties are harder to rip out and have built-in viral acquisition. Single-player productivity tools are increasingly fungible.
- **Platform / operating system positioning** — bundling multiple workflows or tightly integrating with other services is more durable than point-solution status.

### What no longer wins
- **Point solutions** optimizing a single surface area, absent a strong proprietary data advantage — vulnerable to AI-built alternatives and to general agents.
- **Walled gardens** that block agent / API access to user data — risk being disintermediated by general agents that can see across everything
- **Thin AI wrappers** prone to obsolescence as foundational models improve. Key question: does this tool get better, the same, or worse as the underlying models advance?
- **Incumbent-replacement plays** in markets where the incumbent has the distribution advantage and can add AI features faster than the startup can earn distribution