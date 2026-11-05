// Cumulative Billing Statement Template — Typst
// ─────────────────────────────────────────────────────────────────────────────
// Fields consumed from data_file (JSON):
//   document_meta  { title, contract_no, bill_no, date }
//   line_items[]   { index, description, unit, quantity, rate, amount }
//   summary        { subtotal, tax_rate_pct, tax_amount, grand_total,
//                    contract_value, previous_cumulative, current_claim }
// ─────────────────────────────────────────────────────────────────────────────

#import "@preview/tablex:0.0.8": tablex

#let data    = json(sys.inputs.at("data_file"))
#let meta    = data.document_meta
#let items   = data.line_items
#let summary = data.summary

#set page(
  paper: "a4",
  margin: (top: 20mm, bottom: 25mm, left: 20mm, right: 15mm),
  header: [
    #set text(size: 8pt, fill: luma(100))
    #grid(
      columns: (1fr, auto),
      [Contract No: #meta.contract_no · Bill No: #str(meta.bill_no)],
      [Page #counter(page).display("1 of 1", both: true)]
    )
    #line(length: 100%, stroke: 0.5pt)
  ],
  footer: [
    #line(length: 100%, stroke: 0.5pt)
    #set text(size: 8pt, fill: luma(100))
    #align(center)[DocEngine · #datetime.today().display() · Digitally Signed]
  ]
)

#set text(font: "Linux Libertine", size: 9pt)

#align(center)[
  #text(weight: "bold", size: 13pt)[CUMULATIVE BILLING STATEMENT]
  #linebreak()
  #text(size: 10pt)[#meta.title]
]

#v(4mm)
#grid(
  columns: (auto, 1fr, auto, 1fr),
  gutter: 4mm,
  [*Contract No:*], [#meta.contract_no],
  [*Bill No:*],     [#str(meta.bill_no)],
  [*Date:*],        [#meta.date],
  [],               [],
)
#v(6mm)

#tablex(
  columns: (2em, 1fr, 3em, 5em, 6em, 7em),
  repeat-header: true,
  fill: (col, row) => if row == 0 { luma(230) } else if calc.odd(row) { luma(248) } else { white },
  align: (col, _) => if col >= 3 { right } else { left },
  stroke: 0.5pt,
  [*S.No*], [*Description*], [*Unit*], [*Quantity*], [*Rate (₹)*], [*Amount (₹)*],
  ..items.map(item => (
    [#item.index], [#item.description], [#item.unit],
    [#str(item.quantity)], [#str(item.rate)], [#str(item.amount)],
  )).flatten()
)

#v(6mm)
#align(right)[
  #table(
    columns: (14em, 9em),
    stroke: none,
    fill: (_, row) => if calc.odd(row) { luma(248) } else { white },
    align: (col, _) => if col == 1 { right } else { left },
    [Sub-total],                    [₹ #summary.subtotal],
    [GST @ #summary.tax_rate_pct%], [₹ #summary.tax_amount],
    table.hline(stroke: 1pt),
    [*Grand Total (This Bill)*],    [*₹ #summary.grand_total*],
    table.hline(stroke: 0.5pt),
    [Contract Value],               [₹ #summary.contract_value],
    [Cumulative Up to Previous Bill],[₹ #summary.previous_cumulative],
    table.hline(stroke: 1pt),
    [*Current Cumulative Claim*],   [*₹ #summary.current_claim*],
  )
]

#v(12mm)
#grid(
  columns: (1fr, 1fr, 1fr),
  gutter: 5mm,
  align(center)[#line(length: 80%, stroke: 0.5pt) \ Contractor],
  align(center)[#line(length: 80%, stroke: 0.5pt) \ Junior Engineer],
  align(center)[#line(length: 80%, stroke: 0.5pt) \ Executive Engineer],
)
