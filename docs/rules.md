# Capital — rules as implemented (rules `capital-1.1.0`, content `content-1.0.2`)

This is the player-facing summary of what the engine actually does. Numbers are the shipped defaults.

## Setup and goal
2–4 seats. Everyone starts in Financial with $500,000, no debt, reputation 60. Quick = 12 years, Standard = 20.
Highest **adjusted net worth** after the final close wins: net worth + $100 × reputation − restart grants received.
Ties: higher unadjusted net worth, then lower debt, then a shared win. Nobody is eliminated.

## A year
1. **Open.** The pending regime and events are published; macro values move halfway to the regime's targets; prices reprice;
   one auction lot is announced; floating loans reset.
2. **Turns.** The starting seat rotates each year. 3 action points (AP) each; commands resolve one at a time.
3. **Deals.** In order: open proposals are answered, any tender offer is answered and resolved, the auction runs.
   Unanswered proposals expire.
4. **Results.** Each company: growth, revenue, margin, profit; corporate interest; dividends pro rata; dividend-rights
   redirects. Each property: occupancy, rent, costs, net rent to the owner. Cash interest on the lowest spendable balance.
5. **Obligations.** Loan interest and principal fall due. Shortfalls become named arrears and open a rescue window.
6. **Close.** Net worth is recorded. Next year's news is drawn (hidden) and the next year opens.

## Map and actions
Districts: Financial, Wall Street, Industrial, Tech, Energy, Real Estate, Downtown. Edges: Financial–Wall Street,
Financial–Industrial, Financial–Real Estate, Financial–Downtown, Wall Street–Tech, Tech–Industrial, Industrial–Energy,
Energy–Real Estate, Real Estate–Downtown.

| Action | Where | AP |
|---|---|---|
| Move one edge | anywhere | 1 |
| Buy/sell public shares, launch a tender | Wall Street | 1 |
| Research a sector | Wall Street or a district hosting that sector | 1 |
| Borrow, refinance, build relationships (+3 reputation, once a year) | Financial | 1 |
| Repay loan principal | anywhere | 1 |
| Buy/sell a private business or property with the bank, upgrade property | the asset's district | 1 |
| Set payout (0/25/50/75%), reinvest, repay or refinance company debt (one per company per year, control needed) | company district | 1 |
| Propose a trade, player loan or dividend-rights contract; list an asset for next year's auction | anywhere | 1 |
| Withdraw a proposal, end turn | anywhere | 0 |
| Accept/reject, tender response, bid/pass | deals window | 0 |

At most 2 open proposals per seat and 8 proposals + withdrawals per year.

## Prices
- **Company equity** = max(EBIT, 5% of revenue) × multiple + company cash − company debt − corporate arrears, floored at $10,000.
  Multiple = base + 2×(expected growth − base growth) − rate sensitivity × (policy rate − 4%) − 0.01 × risk, clamped to 3–14.
- **Share price** = equity ÷ 10,000 × market mood × sector mood × company mood, clamped to $0.50–$1,000. Private businesses
  have no mood: they are valued at fair equity.
- **Orders** fill at the listed price ± 0.5% spread ± size impact (1% per 5% of the company you have traded this year,
  capped at 12%). The listed price does not move with orders. No shorting, no margin.
- **Private business:** bank sells 100% at fair + 5%; buys back at 75% (60% in a Crisis or a rescue).
- **Property** = max(net rent, $1,000) ÷ cap rate; cap rate = base + (policy rate − 4%)/2 + 0.02% × credit tightness − 0.8%.
  Bank sells at fair + 5%, buys back at 80% (65% in a Crisis or a rescue). Upgrade: $30,000 for +$4,000 rent, +$1,000 cost, twice.
- **Synergy:** controlling Harbor Logistics or Dockside Freight while owning Harbor Warehouse adds 1% margin, once.

## Debt
Bank loans: ≥ $10,000, 3 or 5 years, fixed or floating, equal annual principal, first payment at the current close.
Rate = policy rate + tier spread (1/2/4/7% by post-funding leverage) + 0.05% per reputation point below 60 +
0.02% × credit tightness + 0.5% if fixed, clamped 4–15%. Approval is judged on the balance sheet **after** funding:
debt ≤ 70% of assets and ≤ 1.5× net worth; total debt ≤ unsecured ceiling (($100,000 + 20% of net worth) × (100 − credit)/100)
+ pledged collateral (shares 50%, property 60%, private business 35%); cash + 20% of shares ≥ next year's service;
80% of forecast income ≥ half of annual interest. Refinancing costs 1% and re-approves everything.
A secured loan whose principal exceeds 1.25× its collateral's value has the excess called at the next close.

**Rescue:** up to three decisions (sell at distress prices, repay, refinance, propose a rescue deal, or stop).
**Automatic restructuring** if still unpaid: pledged collateral is sold, then other assets, until arrears are covered; what is
still in default is cut by 50% into a two-year 0% loan; −20 reputation; no new bank credit for two years. With no cash and no
assets left, one $50,000 restart grant per match (deducted from the final score).

## Deals
Spot trades of any mix of cash, shares, business units and property titles at any price. The proposer's side is reserved
until answered. Acceptance rechecks everything and settles atomically. Pledged assets can be traded only if the cash received
repays the loan they secure, in the same transaction. Binding contracts: player loans (0–20%, 1–5 years) and dividend rights
(1–100% of the seller's actual dividends from one company for 1–3 closes). Everything said in chat or aloud is non-binding.

**Auction:** one lot a year (a queued player listing, else the next bank-owned property or private business), reserve 80% of
fair for bank lots, $5,000 minimum raise, bids escrowed from cash, passing is permanent.
**Tender offer:** ≥ 110% of market, full cash escrow, a minimum and maximum share count. The bank float tenders; players
choose. Under the minimum: refund and −5 reputation. Over the maximum: pro-rata fill.
**Control** needs strictly more than 50% of units.

## Economy
Six regimes (Recovery, Expansion, Boom, Stagflation, Recession, Crisis) with the transition table from the specification.
Round 1 never opens in Crisis; three straight Crisis years force Recovery. One macro event each year and a 50% chance of one
sector/company event. Rate Shock and Credit Freeze together are capped at 5% of the macro draw and cannot appear in years 1–2.
Rate Shock needs an Inflation Surprise in the previous three years. No event repeats within three years (Quiet Year excepted).

## Reputation
+3 build relationships (once a year); +1 for a completed binding loan or dividend-rights contract (once a year, +3 per match);
+2 a year for controlling a profitable company with no arrears; −20 restructuring; −5 failed tender. Range 0–100.
No penalty for lying.
