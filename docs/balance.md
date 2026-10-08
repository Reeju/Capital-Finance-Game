# Balance: what was measured

Synthetic AI-vs-AI matches only. A thousand matches say nothing about whether the game is fun; they find broken numbers.
Raw summaries: `balance-report-12.json`, `balance-report-20.json` (regenerate with `pnpm simulate 1000 12|20`).

## Method
1,000 Quick and 1,000 Standard matches, seeds `balance-<rounds>-<n>`, cycling 14 line-ups: the three archetypes in rotated
seats, mixes with three scripted baselines (cash only, buy-the-market stocks only, property only), and four mirror
line-ups (identical policies) to isolate seat order. Audits ran on every 25th match; all passed. No AI command was rejected.

## Tuning applied (content `1.0.2`)
1. **Base growth × 0.6** against the specification table. With the table as written, a stocks-only player compounded at
   about 19% a year over 12 years, well above the 6–15% hypothesis, and prices hit the $1,000 ceiling in Quick games.
2. **CloudForge Studio multiple 5 → 7** (inside the specification's 4–7 range for private firms). At 5 it was a clear
   first-pick prize: the first seat ended 15–20% richer in mirror matches.

## Results after tuning

| | Quick (12) | Standard (20) | Flag threshold |
|---|---|---|---|
| Stock price growth per year, p10 / median / p90 | 5.1% / 9.3% / 14.9% | 4.9% / 8.3% / 12.6% | hypothesis 6–15% total return |
| Net-worth growth: stocks-only baseline | 13.5% | 12.2% | |
| Net-worth growth: property-only baseline | 6.4% | 7.2% | hypothesis 5–12% |
| Net-worth growth: cash-only baseline | 2.3% | 2.3% | hypothesis 0–3% |
| Net-worth growth: Grace / Alex / Victor | 14.0 / 16.0 / 16.7% | 12.8 / 14.1 / 14.7% | |
| Win rate in mixed line-ups: Grace / Alex / Victor | 7% / 43% / 75% | 4% / 47% / 74% | > 60% |
| Players restructured | 0.6% | 0.4% | > 15% |
| Turns with no action | 9.6% | 10.0% | > 20% |
| Runaway leader by year 4 | 0% | 0% | > 25% |
| First seat wins, mirror line-ups (2–4 seats mixed) | 58% | 63% | fair share ≈ 30–40% |
| Final prices at the $1,000 ceiling | 0 | 661 of 6,000 | |

## Open flags (not fixed)
1. **Leverage plus control wins.** Victor wins about three quarters of mixed AI line-ups. Asset returns (13–17%) sit well
   above borrowing costs (roughly 6–9%) and restructuring is rare, so debt is not risky enough. Candidate levers: wider
   spreads, tighter credit ceilings, bigger rate/sentiment shocks. Needs human playtests before choosing.
2. **First-seat advantage remains.** Much reduced by the CloudForge change (the Grace mirror is now even) but the Alex
   mirror still favours seat 1. The cause is first pick of scarce assets in year 1. Candidate levers: put the best private
   business up as the year-1 auction lot, or stagger bank offers.
3. **ByteForge hits the $1,000 price ceiling in about two thirds of Standard games** (661 ceiling prices in 1,000 matches; an
   earlier 200-match probe showed ByteForge was the only stock affected). Retained cash plus
   ~11% growth compounds past $10 million of equity by year 15–20. Above the ceiling the excess value is not counted.
   Raising its payout did not fix it. Candidate levers: growth that fades with size, a higher ceiling, or share splits.
   This needs a design decision; it was not papered over.
4. **Grace rarely wins** against the other archetypes; her profile may simply be too cautious for this economy.
5. Private-business returns were not measured separately from portfolios.
